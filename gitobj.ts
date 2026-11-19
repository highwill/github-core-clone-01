// Git object layer: SHA-1 ids, tree/commit encoding, packfile read/write,
// pkt-line framing. Pure git formats, implemented on node:crypto + node:zlib
// only — the trial has no git binary, so the forge is its own git.
//
// Packs this forge writes carry full objects only, never deltas: every git
// client accepts them, and the bytes are deterministic for a given object set
// (fixed order, fixed zlib level), which keeps the clone workload cacheable.
//
// Hot-path note: the fetch closure walks the same 200-commit history on
// every one of the clone workload's 50 concurrent fetches. Objects are
// immutable by oid, so a commit's parsed headers are cached per object map
// (commitInfo) and never parsed twice; the same holds for nothing else,
// because trees in these workloads are one-entry and cheap to re-parse.

import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjectType } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The git object id of `type` + `data`: sha1("<type> <len>\0" + data). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function storeObject(repo: { objects: Map<string, GitObject> }, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: { objects: Map<string, GitObject> }, oid: string): GitObject | undefined {
  return repo.objects.get(oid.toLowerCase());
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's entries (mode SP name NUL 20-byte oid). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Encode tree entries (sorted by name, directories as `name/`). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/**
 * A commit's parsed headers, cached per object map. Git objects are
 * immutable by oid, so the first parse of an oid is the only one: the
 * fetch closure and the ancestry walk both re-read the same commits on
 * every operation of a workload, and this is what keeps that O(1) after
 * the first pass. The cache is keyed by the repo's objects map, so two
 * repos never share entries and a deleted repo's cache is collectable.
 */
const commitInfoCache = new WeakMap<Map<string, GitObject>, Map<string, CommitInfo>>();

export function commitInfo(objects: Map<string, GitObject>, oid: string): CommitInfo | null {
  let perRepo = commitInfoCache.get(objects);
  if (perRepo === undefined) {
    perRepo = new Map<string, CommitInfo>();
    commitInfoCache.set(objects, perRepo);
  }
  let info = perRepo.get(oid);
  if (info !== undefined) return info;
  const obj = objects.get(oid.toLowerCase());
  if (obj === undefined || obj.type !== 'commit') return null;
  info = parseCommit(obj.data);
  perRepo.set(oid, info);
  return info;
}

// ---------------------------------------------------------------- tags

export interface TagInfo {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object's headers and message. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Encode a commit object. */
export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  timestamp: number;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  const ident = (name: string, email: string): string => `${name} <${email}> ${info.timestamp} +0000`;
  lines.push(`author ${ident(info.authorName, info.authorEmail)}`);
  lines.push(`committer ${ident(info.committerName, info.committerEmail)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

// ---------------------------------------------------------------- packfiles

interface PackEntry {
  readonly type: ObjectType;
  readonly data: Buffer;
}

/** Encode one object's header: type + size as git's variable-length integer. */
function objectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let s = size;
  let first = (typeCode << 4) | (s & 0x0f);
  s >>>= 4;
  if (s > 0) first |= 0x80;
  bytes.push(first);
  while (s > 0) {
    let b = s & 0x7f;
    s >>>= 7;
    if (s > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/**
 * Write a packfile of full objects (no deltas), in the order given.
 * Deterministic: same objects in the same order give the same bytes.
 */
export function writePack(objects: readonly PackEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  chunks.push(head);
  for (const obj of objects) {
    const code = TYPE_CODES[obj.type];
    chunks.push(objectHeader(code, obj.data.length));
    chunks.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta to a base object, returning the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++] ?? 0;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error(`delta base size ${srcSize} != ${base.length}`);
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++] ?? 0;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++] ?? 0;
      if (op & 0x02) offset |= (delta[pos++] ?? 0) << 8;
      if (op & 0x04) offset |= (delta[pos++] ?? 0) << 16;
      if (op & 0x08) offset |= (delta[pos++] ?? 0) << 24;
      if (op & 0x10) size = delta[pos++] ?? 0;
      if (op & 0x20) size |= (delta[pos++] ?? 0) << 8;
      if (op & 0x40) size |= (delta[pos++] ?? 0) << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  if (total !== dstSize) throw new Error(`delta result size ${total} != ${dstSize}`);
  return Buffer.concat(out);
}

/** Parse a packfile into objects (oid -> {type, data}), resolving deltas. */
export function parsePack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let pos = 12;
  const readSize = (): { typeCode: number; size: number } => {
    const first = pack[pos++] ?? 0;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while ((byte & 0x80) !== 0) {
      byte = pack[pos++] ?? 0;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return { typeCode, size };
  };
  const readOffset = (): number => {
    let byte = pack[pos++] ?? 0;
    let offset = byte & 0x7f;
    while ((byte & 0x80) !== 0) {
      byte = pack[pos++] ?? 0;
      offset = ((offset + 1) << 7) | (byte & 0x7f);
    }
    return offset;
  };
  for (let n = 0; n < count; n += 1) {
    const start = pos;
    const { typeCode, size } = readSize();
    let type: ObjectType;
    let data: Buffer;
    if (typeCode === 6) {
      // OFS_DELTA: base at start - offset
      const offset = readOffset();
      const { data: inflated, used } = inflatedBytesUsed(pack, pos);
      pos += used;
      const base = byOffset.get(start - offset);
      if (base === undefined) throw new Error('ofs-delta with unknown base');
      data = applyDelta(base.data, inflated);
      type = base.type;
    } else if (typeCode === 7) {
      // REF_DELTA: base by oid
      const baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { data: inflated, used } = inflatedBytesUsed(pack, pos);
      pos += used;
      const base = objects.get(baseOid);
      if (base === undefined) throw new Error('ref-delta with unknown base');
      data = applyDelta(base.data, inflated);
      type = base.type;
    } else {
      type = CODE_TYPES[typeCode] as ObjectType;
      if (type === undefined) throw new Error(`unknown object type ${typeCode}`);
      const { data: inflated, used } = inflatedBytesUsed(pack, pos);
      pos += used;
      if (inflated.length !== size) throw new Error(`object size ${inflated.length} != header ${size}`);
      data = inflated;
    }
    const oid = hashObject(type, data);
    const obj: GitObject = { type, data };
    objects.set(oid, obj);
    byOffset.set(start, obj);
  }
  return objects;
}

/**
 * How many input bytes the zlib stream starting at `pos` consumed.
 * `inflateSync` with `{ info: true }` returns the engine, whose
 * `bytesWritten` is the input consumed — one inflate, exact, no probing.
 */
function inflatedBytesUsed(pack: Buffer, pos: number): { data: Buffer; used: number } {
  const out = inflateSync(pack.subarray(pos), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: out.buffer, used: out.engine.bytesWritten };
}

// ---------------------------------------------------------------- pkt-line

/** Encode a payload as one pkt-line (4 hex length incl. the 4, then bytes). */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');
export const RESPONSE_END_PKT = Buffer.from('0002', 'ascii');

/** Split a pkt-line stream into frames: {data} | 'flush' | 'delim' | 'response-end'. */
export function parsePktLines(buf: Buffer): Array<{ kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' }> {
  const frames: Array<{ kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' }> = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      frames.push({ kind: 'flush' });
      pos += 4;
    } else if (len === 1) {
      frames.push({ kind: 'delim' });
      pos += 4;
    } else if (len === 2) {
      frames.push({ kind: 'response-end' });
      pos += 4;
    } else {
      if (pos + len > buf.length) break;
      frames.push({ kind: 'data', data: buf.subarray(pos + 4, pos + len) });
      pos += len;
    }
  }
  return frames;
}

/** A fresh 20-byte random id, for request ids (not object ids). */
export function randomHex(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}
