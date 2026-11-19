// rawhttp.ts — minimal HTTP/1.1 server over node:net.
//
// Why: node:http costs ~130us of server CPU per request on this workload
// (measured: canned node:http server 130us/req vs raw TCP 55us/req for the
// same canned 500B JSON). The bench is 2750 sequential requests, so the
// transport is a real share of every workload. This server implements only
// the HTTP/1.1 subset the kit's undici client uses, with the same
// (req, res) surface app.ts already uses:
//
//   req: method, url, headers (lower-cased keys), resume(), on('data'|'end'|'error')
//   res: writeHead(status, headers), end(data?)
//
// Semantics preserved from node:http:
// - keep-alive by default on HTTP/1.1 (close on `Connection: close`, and on
//   HTTP/1.0 unless `Connection: keep-alive`)
// - Content-Length bodies and chunked bodies (chunked is parsed, though the
//   client sends Content-Length)
// - pipelining: requests on one socket are answered strictly in order
// - `Expect: 100-continue` is answered as soon as the headers are in, before
//   the body is read
// - a 5s idle keep-alive timeout, matching node:http's default
//
// The body is fully buffered before the handler runs, so readBody's stream
// interface is emulated by firing 'data' then 'end' synchronously when the
// listeners are registered.

import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';

export interface RawRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  resume(): void;
  on(event: 'data', fn: (chunk: Buffer) => void): void;
  on(event: 'end', fn: () => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
}

export interface RawResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(data?: string | Buffer): void;
}

type Handler = (req: RawRequest, res: RawResponse) => void;

const REASONS: Record<number, string> = {
  100: 'Continue',
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  500: 'Internal Server Error',
};

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const KEEP_ALIVE_TIMEOUT_MS = 5000;

interface ParsedRequest {
  method: string;
  url: string;
  version: string;
  headers: Record<string, string>;
  body: Buffer;
  keepAlive: boolean;
}

function parseChunked(buf: Buffer): { body: Buffer; consumed: number } | null {
  // Returns null when the buffer does not yet hold the whole chunked body.
  // consumed === -1 signals a malformed chunk stream.
  const chunks: Buffer[] = [];
  let pos = 0;
  for (;;) {
    const lineEnd = buf.indexOf(CRLF, pos);
    if (lineEnd === -1) return null;
    const sizeText = buf.subarray(pos, lineEnd).toString('ascii').split(';', 1)[0]!.trim();
    const size = parseInt(sizeText, 16);
    if (Number.isNaN(size) || size < 0) return { body: Buffer.alloc(0), consumed: -1 };
    pos = lineEnd + 2;
    if (size === 0) {
      // Trailer headers until an empty line.
      const trailerEnd = buf.indexOf(HEADER_END, pos);
      if (trailerEnd === -1) {
        if (buf.subarray(pos, pos + 2).equals(CRLF)) return { body: Buffer.concat(chunks), consumed: pos + 2 };
        return null;
      }
      return { body: Buffer.concat(chunks), consumed: trailerEnd + 4 };
    }
    if (pos + size + 2 > buf.length) return null;
    chunks.push(buf.subarray(pos, pos + size));
    pos += size + 2;
  }
}

/** Try to parse one complete request out of `buf`; null when incomplete. */
function tryParse(buf: Buffer): { req: ParsedRequest; consumed: number } | null {
  const headEnd = buf.indexOf(HEADER_END);
  if (headEnd === -1) return null;
  const head = buf.subarray(0, headEnd).toString('latin1');
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const parts = requestLine.split(' ');
  if (parts.length < 3) return { req: null as unknown as ParsedRequest, consumed: -1 };
  const method = parts[0]!;
  const url = parts[1]!;
  const version = parts[2]!;
  if (!method || !url || !/^HTTP\/\d\.\d$/.test(version)) {
    return { req: null as unknown as ParsedRequest, consumed: -1 };
  }
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  const bodyStart = headEnd + 4;
  const conn = (headers['connection'] ?? '').toLowerCase();
  const keepAlive = version === 'HTTP/1.1' ? conn !== 'close' : conn === 'keep-alive';
  const te = headers['transfer-encoding'];
  if (te !== undefined && te.toLowerCase().includes('chunked')) {
    const chunked = parseChunked(buf.subarray(bodyStart));
    if (chunked === null) return null;
    if (chunked.consumed === -1) return { req: null as unknown as ParsedRequest, consumed: -1 };
    return {
      req: { method, url, version, headers, body: chunked.body, keepAlive },
      consumed: bodyStart + chunked.consumed,
    };
  }
  const len = headers['content-length'] === undefined ? 0 : parseInt(headers['content-length'], 10);
  if (Number.isNaN(len) || len < 0) return { req: null as unknown as ParsedRequest, consumed: -1 };
  if (buf.length < bodyStart + len) return null;
  return {
    req: { method, url, version, headers, body: buf.subarray(bodyStart, bodyStart + len), keepAlive },
    consumed: bodyStart + len,
  };
}

export function createRawServer(handler: Handler): NetServer {
  const server = createNetServer((socket: Socket) => {
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    // Requests parsed off this socket, answered strictly in order.
    const queue: ParsedRequest[] = [];
    let busy = false;
    let destroyed = false;
    let expectSent = false;

    // One idle timer for the socket's life; it only destroys a socket that
    // is idle (no request in flight, nothing queued).
    socket.setTimeout(KEEP_ALIVE_TIMEOUT_MS);
    socket.on('timeout', () => {
      if (!busy && queue.length === 0) socket.destroy();
    });

    const dispatchNext = () => {
      if (busy || destroyed) return;
      const parsed = queue.shift();
      if (parsed === undefined) return;
      busy = true;

      const req: RawRequest = {
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        resume() {},
        on(event: 'data' | 'end' | 'error', fn: (arg?: unknown) => void) {
          // The body is already buffered; fire in registration order.
          if (event === 'data') {
            if (parsed.body.length > 0) fn(parsed.body);
          } else if (event === 'end') {
            fn();
          }
          // 'error' never fires: the body is in hand.
        },
      };

      let status = 200;
      let headHeaders: Record<string, string> = {};
      let headSent = false;
      const res: RawResponse = {
        writeHead(s: number, h: Record<string, string>) {
          status = s;
          headHeaders = h;
          headSent = true;
        },
        end(data?: string | Buffer) {
          if (destroyed) {
            busy = false;
            dispatchNext();
            return;
          }
          const body: Buffer =
            data === undefined ? Buffer.alloc(0) : typeof data === 'string' ? Buffer.from(data) : data;
          const reason = REASONS[status] ?? 'OK';
          let head = `HTTP/1.1 ${status} ${reason}\r\n`;
          let hasLength = false;
          let hasConnection = false;
          for (const key of Object.keys(headHeaders)) {
            const lk = key.toLowerCase();
            if (lk === 'content-length') hasLength = true;
            if (lk === 'connection') hasConnection = true;
            head += `${key}: ${headHeaders[key]}\r\n`;
          }
          if (!hasLength && body.length > 0) head += `Content-Length: ${body.length}\r\n`;
          if (!hasLength && body.length === 0 && status !== 204 && status !== 304) {
            head += 'Content-Length: 0\r\n';
          }
          if (!hasConnection) head += `Connection: ${parsed.keepAlive ? 'keep-alive' : 'close'}\r\n`;
          head += '\r\n';
          const out = body.length === 0 ? Buffer.from(head) : Buffer.concat([Buffer.from(head), body]);
          const keep = parsed.keepAlive;
          socket.write(out, () => {
            busy = false;
            if (!keep) {
              socket.end();
            } else {
              dispatchNext();
            }
          });
        },
      };

      try {
        handler(req, res);
      } catch {
        if (!headSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        }
        res.end('{"message":"Internal Server Error"}\n');
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (destroyed) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        const parsed = tryParse(buf);
        if (parsed === null) {
          // Headers may be in with an outstanding 100-continue: answer it
          // now, before the client will send the body.
          if (!expectSent) {
            const headEnd = buf.indexOf(HEADER_END);
            if (headEnd !== -1) {
              const head = buf.subarray(0, headEnd).toString('latin1');
              if (/^expect:\s*100-continue/im.test(head)) {
                socket.write('HTTP/1.1 100 Continue\r\n\r\n');
                expectSent = true;
              }
            }
          }
          return;
        }
        if (parsed.req === null || parsed.consumed === -1) {
          // Malformed request line / headers: answer 400 and close.
          socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
          socket.end();
          destroyed = true;
          return;
        }
        buf = buf.subarray(parsed.consumed);
        expectSent = false;
        queue.push(parsed.req);
        dispatchNext();
      }
    });
    socket.on('error', () => {
      destroyed = true;
    });
    socket.on('close', () => {
      destroyed = true;
    });
  });
  return server;
}
