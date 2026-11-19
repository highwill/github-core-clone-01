// The forge's single process: one HTTP server serving git smart HTTP,
// REST v3, GraphQL v4 and MCP over one in-memory store.
//
// app.ts is the server; main.ts is the entry <-> env lifecycle (bind an
// ephemeral port, register it, poll /done, exit 0) and stays as it ships.
//
// Auth: every route except /healthz requires
// `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; anything else is a 401
// with a JSON message. The token is the suite's trial token, not a secret
// the forge owns. Every reply carries X-GitHub-Request-Id and a JSON
// content type; errors are always `{message: <non-empty string>}`.
//
// Perf notes (every request of every workload passes through here):
// - the request URL is parsed once: pathname, segments and query all come
//   from that one parse, and routing is string-prefix checks on it.
// - the expected Authorization value is built once per server, not per
//   request, and the request id is a bare counter — no Date.now per reply.
// - a request that carries no body (the git advertisement GETs, any GET)
//   never waits for the stream's 'end' event: with no Content-Length and
//   no Transfer-Encoding there is nothing to read, so the handler runs at
//   once and the stream is drained in the background.
// - handlers may return a pre-serialized JSON body (rawText): the read
//   workload's cached issue JSON goes out without a second stringify.
// - transport is a hand-rolled HTTP/1.1 server over node:net (rawhttp.ts):
//   node:http costs ~130us of server CPU per request here, raw TCP ~55us.
//   GCC_TRANSPORT=http selects node:http instead (A/B only, never in a trial).

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Server as NetServer } from 'node:net';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { viewerIdentity } from './scenario.ts';
import { createRawServer } from './rawhttp.ts';

/** The request/response surface app.ts uses — satisfied by node:http and by rawhttp.ts. */
interface Req {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  resume(): void;
  on(event: 'data', fn: (chunk: Buffer) => void): void;
  on(event: 'end', fn: () => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
}
interface Res {
  writeHead(status: number, headers: Record<string, string>): void;
  end(data?: string | Buffer): void;
}

const JSON_TYPE = 'application/json; charset=utf-8';
/** Shared empty body, so a bodyless request allocates nothing. */
const EMPTY_BODY = Buffer.alloc(0);

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(
  res: Res,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const requestId = `req-${++sendJson.counter}`;
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}
sendJson.counter = 0;

/** Answer with a pre-serialized JSON body (already newline-terminated). */
function sendText(res: Res, status: number, text: string, headers: Readonly<Record<string, string>> = {}): void {
  const requestId = `req-${++sendJson.counter}`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: Res, status: number, body: Buffer, contentType: string): void {
  const requestId = `req-${++sendJson.counter}`;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function sendError(res: Res, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Read a request body; a request with no body headers resolves at once. */
function readBody(req: Req): Promise<Buffer> {
  const length = req.headers['content-length'];
  if ((length === undefined || length === '0') && req.headers['transfer-encoding'] === undefined) {
    // No body can follow: drain anything stray without blocking the handler.
    req.resume();
    return Promise.resolve(EMPTY_BODY);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server | NetServer {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const expectedAuth = token === '' ? null : `Bearer ${token}`;
  const viewerLogin = viewerIdentity().viewer.login;

  const handler = (req: Req, res: Res): void => {
    void (async () => {
      // One parse: pathname for routing, searchParams for the query.
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendError(res, 404, 'Not Found');
        return;
      }
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (expectedAuth !== null && req.headers.authorization !== expectedAuth) {
        sendError(res, 401, 'Bad credentials');
        return;
      }

      const segments = path.split('/').filter((s) => s !== '');
      const host = req.headers.host ?? '127.0.0.1';
      const base = `http://${host}`;

      // Git smart HTTP: /<owner>/<repo>.git/...
      if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
        const raw = await readBody(req);
        const result = handleGit(
          store,
          method,
          segments,
          url.searchParams,
          { 'git-protocol': req.headers['git-protocol'] },
          raw,
        );
        if (result !== null) {
          sendRaw(res, result.status, result.body, result.contentType);
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // REST v3
      if (segments[0] === 'api' && segments[1] === 'v3') {
        let body: Record<string, unknown> | null = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
            } catch {
              sendError(res, 400, 'Problems parsing JSON');
              return;
            }
          }
        }
        const result = handleRest(store, method, segments.slice(2), url.searchParams, body, base);
        if (result.rawText !== undefined) {
          sendText(res, result.status, result.rawText, result.headers ?? {});
          return;
        }
        sendJson(res, result.status, result.body, result.headers ?? {});
        return;
      }

      // GraphQL v4: POST /api/graphql, single operation or a JSON batch.
      if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
        if (method !== 'POST') {
          sendError(res, 404, 'Not Found');
          return;
        }
        const raw = await readBody(req);
        let body: unknown = null;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8')) as unknown;
          } catch {
            body = null;
          }
        }
        const result = handleGraphQL(store, base, viewerLogin, body);
        sendJson(res, result.status, result.body);
        return;
      }

      // MCP: POST /mcp (JSON-RPC 2.0); DELETE closes a session (none are
      // handed out, so it is a no-op 204).
      if (segments.length === 1 && segments[0] === 'mcp') {
        if (method === 'DELETE') {
          sendJson(res, 204, null);
          return;
        }
        if (method !== 'POST') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }
        const raw = await readBody(req);
        const result = handleMcp(store, viewerLogin, base, raw.toString('utf8'));
        sendJson(res, result.status, result.body);
        return;
      }

      sendError(res, 404, 'Not Found');
    })().catch((error: unknown) => {
      try {
        sendError(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
      } catch {
        // The response already went out; nothing to do.
      }
    });
  };

  // Transport: the raw TCP server (rawhttp.ts) is ~75us/request cheaper than
  // node:http on this workload; GCC_TRANSPORT=http keeps node:http for A/B.
  if (process.env.GCC_TRANSPORT === 'http') {
    return createServer(handler as unknown as (req: IncomingMessage, res: ServerResponse) => void);
  }
  return createRawServer(handler);
}
