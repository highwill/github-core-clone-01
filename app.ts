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

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { viewerIdentity } from './scenario.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const requestId = `req-${(++sendJson.counter).toString(16)}-${Date.now().toString(36)}`;
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

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  const requestId = `req-${(++sendJson.counter).toString(16)}-${Date.now().toString(36)}`;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((s) => s !== '');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!isAuthorized(req)) {
        sendError(res, 401, 'Bad credentials');
        return;
      }

      const url = new URL(req.url ?? '/', 'http://entry');
      const segments = segmentsOf(path);
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
        const result = handleGraphQL(store, base, viewerIdentity().viewer.login, body);
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
        const result = handleMcp(store, viewerIdentity().viewer.login, base, raw.toString('utf8'));
        sendJson(res, result.status, result.body);
        return;
      }

      // GraphQL and MCP land here once their modules exist.
      sendError(res, 404, 'Not Found');
    })().catch((error: unknown) => {
      try {
        sendError(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
      } catch {
        // The response already went out; nothing to do.
      }
    });
  });
}
