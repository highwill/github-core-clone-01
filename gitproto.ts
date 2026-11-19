// Git smart-HTTP surface: protocol v2 upload-pack (ls-refs, fetch), v0
// upload-pack advertisement, and v0 receive-pack (push). Written against
// the exact client in the kit's git-client.ts and the 30 checks in
// checks-git.ts — the client is the spec, so every line below answers a
// behaviour that client can observe.
//
// Paths: /<owner>/<repo>.git/info/refs?service=... and
// /<owner>/<repo>.git/git-upload-pack | git-receive-pack. A repo that does
// not exist (or belongs to another login) answers 404; the server never
// invents a repository — repos are created through REST.
//
// Fetch semantics (the part that decides conformance):
// - the object set is closure(wants, depth) minus closure(haves); a want
//   may be a tag (its target closes with it); depth limits commit
//   generations (1 = the wanted commits only, their trees and blobs);
// - shallow-info names the delivered commits at the depth boundary, and
//   unshallow names the client's old boundaries whose parents are now
//   delivered; a full fetch sends no shallow-info;
// - acks: the client sends `done` in the same request, so a fetch with
//   haves answers NAK (no negotiation round) and the pack;
// - when nothing is new, no packfile section is sent at all.
// Packs carry full objects only (no deltas): deterministic bytes, and the
// client's readPack verifies the trailer and every SHA-1.
//
// Push semantics:
// - the pack is unpacked first (objects are stored even for refused refs);
// - per ref, in command order: create needs an absent ref, delete needs a
//   present ref, update needs old == current and new a descendant of old;
//   anything else is `ng <ref> non-fast-forward` and moves nothing;
// - the report is `unpack ok` + one ok/ng line per command, framed in
//   sideband band 1 when the client asked for side-band-64k.
//
// Perf notes (the clone workload runs 50 concurrent depth-1 fetches of a
// 200-commit repo, the push workload 200 sequential receive-packs):
// - the v2 capability advertisement never changes: one constant buffer.
// - the v0 advertisement depends only on the refs: cached per repo and
//   rebuilt only when refsVersion moves (a push or a ref create).
// - the fetch closure's generation BFS used to walk the whole history on
//   every fetch; it now stops at the depth boundary (a depth-1 fetch reads
//   one generation) and is skipped entirely for a full fetch, where no
//   shallow-info is ever emitted; its queue is an index pointer, not
//   shift(). Commit headers come from gitobj's per-map cache, so the
//   repeated walks over one history parse each commit once.

import { commitInfo, getObject, hashObject, parseCommit, parsePack, parseTag, parseTree, pktLine, FLUSH_PKT, writePack } from './gitobj.ts';
import type { GitObject } from './store.ts';
import type { Repo, Store } from './store.ts';
import { isAncestor } from './gitutil.ts';
import { viewerIdentity } from './scenario.ts';

const AGENT = 'github-core-clone/1.0';
const ZERO_OID = '0000000000000000000000000000000000000000';
/** Largest pack chunk inside one sideband pkt-line (pkt-line max 65520). */
const SIDEBAND_CHUNK = 65515;

export interface GitResult {
  readonly status: number;
  readonly body: Buffer;
  readonly contentType: string;
}

function gitError(status: number, message: string): GitResult {
  return { status, body: Buffer.from(JSON.stringify({ message }), 'utf8'), contentType: 'application/json; charset=utf-8' };
}

function pktText(text: string): Buffer {
  return pktLine(text);
}

function visibleRepo(store: Store, owner: string, repoName: string): Repo | null {
  if (owner !== viewerIdentity().viewer.login) return null;
  return store.getRepo(owner, repoName) ?? null;
}

/** All refs of a repo, sorted by name. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The commit a tag object points at (itself when the object is a commit). */
function peelToCommit(repo: Repo, oid: string): string | null {
  const obj = getObject(repo, oid);
  if (obj === undefined) return null;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') {
    const tag = parseTag(obj.data);
    return peelToCommit(repo, tag.object);
  }
  return null;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

/** The v2 capability advertisement: constant bytes, built once. */
const V2_UPLOAD_ADVERTISEMENT: Buffer = (() => {
  const lines = [
    '# service=git-upload-pack\n',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow unborn\n',
    'object-format=sha1\n',
  ];
  const parts: Buffer[] = [];
  parts.push(pktText(lines[0] as string));
  parts.push(FLUSH_PKT);
  for (const line of lines.slice(1)) parts.push(pktText(line));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
})();

function buildV0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `upload-pack side-band-64k ofs-delta thin-pack multi_ack shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [];
  parts.push(pktText(`# service=${service}\n`));
  parts.push(FLUSH_PKT);
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  const firstLine =
    refs.length === 0
      ? `${ZERO_OID} capabilities^{}\u0000${caps}\n`
      : `${mainTip} HEAD\u0000${caps}\n`;
  parts.push(pktText(firstLine));
  for (const ref of refs) {
    parts.push(pktText(`${ref.oid} ${ref.name}\n`));
    const obj = getObject(repo, ref.oid);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== null) parts.push(pktText(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/**
 * The v0 advertisement for a repo and service, cached while the refs stand
 * still. A push advertises before every receive-pack, and the bytes only
 * change when a ref moves, which bumps refsVersion at the mutation site.
 */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const cached = repo.adCache.get(service);
  if (cached !== undefined && cached.version === repo.refsVersion) return cached.body;
  const body = buildV0Advertisement(repo, service);
  repo.adCache.set(service, { version: repo.refsVersion, body });
  return body;
}

// ---------------------------------------------------------------------------
// fetch closure
// ---------------------------------------------------------------------------

interface ClosureOptions {
  readonly depth?: number;
  readonly exclude: ReadonlySet<string>;
  /** The client's current shallow boundary (its `shallow` lines). */
  readonly clientShallow: ReadonlySet<string>;
}

/**
 * The objects the client already holds, as implied by its `haves` and its
 * current shallow boundary (`clientShallow`): the full closure of each have,
 * except the walk stops descending past a commit in the shallow list — a
 * shallow-listed commit's own tree and blobs are held, but its parents are
 * not (that is exactly what a deepen fetch is for: the ancestors past the
 * boundary are the objects the client still needs).
 *
 * With no shallow list (a full clone) this is the plain full closure, so an
 * incremental fetch re-sends nothing the client has.
 */
function heldSet(repo: Repo, haves: readonly string[], clientShallow: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const addTreeDeep = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    const obj = getObject(repo, treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    out.add(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') addTreeDeep(entry.oid);
      else out.add(entry.oid);
    }
  };
  const addCommitDeep = (oid: string): void => {
    const obj = getObject(repo, oid);
    if (obj === undefined || out.has(oid)) return;
    if (obj.type === 'tag') {
      out.add(oid);
      addCommitDeep(parseTag(obj.data).object);
      return;
    }
    if (obj.type !== 'commit') {
      out.add(oid);
      return;
    }
    out.add(oid);
    const info = commitInfo(repo.objects, oid);
    if (info === null) return;
    addTreeDeep(info.tree);
    if (clientShallow.has(oid)) return; // the boundary: parents are not held
    for (const parent of info.parents) addCommitDeep(parent);
  };
  for (const have of haves) addCommitDeep(have);
  return out;
}

/** The full object closure of `tips` (commits, trees, blobs, tags). */
function fullClosure(repo: Repo, tips: readonly string[]): Set<string> {
  return heldSet(repo, tips, new Set());
}

/**
 * The objects a fetch must deliver: the closure of `wants` (commits limited
 * to `depth` generations when set, plus their trees and blobs; tags close
 * through their target) minus everything reachable from `exclude` (haves).
 * Returns the object map plus, per delivered commit, its generation (0 =
 * a wanted commit) for the shallow boundary, computed by a shortest-path
 * BFS from the wants over the delivered commits.
 *
 * The generations map is only read when a depth is set (the shallow-info
 * block), and only generations up to depth - 1 are ever read: the BFS
 * stops expanding past the boundary, so a depth-1 fetch of a 200-commit
 * repo reads one generation instead of walking the whole history. A full
 * fetch skips the BFS entirely.
 */
function fetchClosure(
  repo: Repo,
  wants: readonly string[],
  options: ClosureOptions,
): { objects: Map<string, GitObject>; generations: Map<string, number> } {
  const objects = new Map<string, GitObject>();
  const excluded = heldSet(repo, [...options.exclude], options.clientShallow);

  const addObject = (oid: string): boolean => {
    if (excluded.has(oid) || objects.has(oid)) return false;
    const obj = getObject(repo, oid);
    if (obj === undefined) return false;
    objects.set(oid, obj);
    return true;
  };

  const addTree = (treeOid: string): void => {
    if (!addObject(treeOid)) return;
    const obj = getObject(repo, treeOid);
    if (obj === undefined) return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else addObject(entry.oid);
    }
  };

  // The walk descends THROUGH held commits: a deepen fetch's want is
  // itself a have, and its parents are exactly what must be delivered.
  // Exclusion decides what goes into the pack, never where the walk goes.
  const visited = new Map<string, number>();
  const addCommit = (oid: string, gen: number): void => {
    const obj = getObject(repo, oid);
    if (obj === undefined) return;
    const seen = visited.get(oid);
    if (seen !== undefined && seen <= gen) return;
    visited.set(oid, gen);
    if (obj.type === 'tag') {
      addObject(oid);
      const target = parseTag(obj.data).object;
      const targetObj = getObject(repo, target);
      if (targetObj !== undefined && targetObj.type === 'commit') addCommit(target, gen);
      else if (targetObj !== undefined) addObject(target);
      return;
    }
    if (obj.type !== 'commit') {
      addObject(oid);
      return;
    }
    if (options.depth !== undefined && gen >= options.depth) return;
    addObject(oid);
    const info = commitInfo(repo.objects, oid);
    if (info === null) return;
    addTree(info.tree);
    for (const parent of info.parents) addCommit(parent, gen + 1);
  };

  for (const want of wants) addCommit(want, 0);

  // Shortest-path generations over the commit graph from the wants (a
  // want's own generation is 0 even when the want itself is already held,
  // as in a deepen fetch). Only generations up to depth - 1 are ever read,
  // and a full fetch reads none — so the BFS expands no further than the
  // boundary and is skipped outright without a depth. The queue is an
  // index pointer: shift() would make this walk quadratic in the history.
  const generations = new Map<string, number>();
  if (options.depth !== undefined) {
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const want of wants) {
      const obj = getObject(repo, want);
      if (obj === undefined) continue;
      if (obj.type === 'tag') queue.push({ oid: parseTag(obj.data).object, gen: 0 });
      else if (obj.type === 'commit') queue.push({ oid: want, gen: 0 });
    }
    for (let head = 0; head < queue.length; head += 1) {
      const { oid, gen } = queue[head] as { oid: string; gen: number };
      if (generations.has(oid)) continue;
      generations.set(oid, gen);
      if (gen >= (options.depth as number) - 1) continue;
      const info = commitInfo(repo.objects, oid);
      if (info === null) continue;
      for (const parent of info.parents) queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  return { objects, generations };
}

// ---------------------------------------------------------------------------
// ls-refs / fetch request parsing
// ---------------------------------------------------------------------------

interface ParsedLines {
  readonly lines: string[];
  readonly ok: boolean;
}

function parseRequestLines(body: Buffer): ParsedLines {
  const lines: string[] = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const len = parseInt(body.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) return { lines, ok: false };
    if (len === 0) return { lines, ok: true }; // flush: end of the argument section
    if (len === 1) {
      // delim: the argument section continues after it
      pos += 4;
      continue;
    }
    if (len === 2) return { lines, ok: true }; // response-end
    if (pos + len > body.length) return { lines, ok: false };
    lines.push(body.subarray(pos + 4, pos + len).toString('utf8'));
    pos += len;
  }
  return { lines, ok: false };
}

/** The offset just past the first flush pkt-line in `body` (-1 when absent). */
function afterFirstFlush(body: Buffer): number {
  let pos = 0;
  while (pos + 4 <= body.length) {
    const len = parseInt(body.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) return -1;
    if (len === 0) return pos + 4;
    if (len === 1 || len === 2) {
      pos += 4;
      continue;
    }
    if (pos + len > body.length) return -1;
    pos += len;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// ls-refs
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, lines: readonly string[]): GitResult {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const line of lines.slice(1)) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD') && symrefs) {
    if (mainTip !== undefined) parts.push(pktText(`${mainTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    else parts.push(pktText(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const obj = getObject(repo, ref.oid);
    if (peel && obj !== undefined && obj.type === 'tag') {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktText(`${line}\n`));
  }
  parts.push(FLUSH_PKT);
  return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

function handleFetch(repo: Repo, lines: readonly string[]): GitResult {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  for (const line of lines.slice(1)) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) clientShallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (!Number.isNaN(n)) depth = n;
    }
    // deepen-since / deepen-not / thin-pack / no-progress / ofs-delta /
    // filter / agent / object-format / done: accepted, no effect here.
  }
  if (wants.length === 0) {
    return { status: 200, body: FLUSH_PKT, contentType: 'application/x-git-upload-pack-result' };
  }
  const { objects, generations } = fetchClosure(repo, wants, { depth, exclude: new Set(haves), clientShallow: new Set(clientShallow) });
  const parts: Buffer[] = [];

  if (haves.length > 0) {
    parts.push(pktText('acknowledgments\n'));
    parts.push(pktText('NAK\n'));
    parts.push(Buffer.from('0001', 'ascii')); // delim
  }

  if (depth !== undefined) {
    const shallow: string[] = [];
    for (const [oid, gen] of generations) {
      if (gen === depth - 1 && objects.has(oid)) shallow.push(oid);
    }
    const unshallow: string[] = [];
    for (const oid of clientShallow) {
      if (shallow.includes(oid)) continue;
      const info = commitInfo(repo.objects, oid);
      if (info === null) continue;
      const deliveredOrHeld = new Set([...objects.keys(), ...haves]);
      if (info.parents.every((p) => deliveredOrHeld.has(p))) unshallow.push(oid);
    }
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktText('shallow-info\n'));
      for (const oid of shallow) parts.push(pktText(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktText(`unshallow ${oid}\n`));
      parts.push(Buffer.from('0001', 'ascii')); // delim
    }
  }

  if (objects.size > 0) {
    // A fresh fetch (no haves, no shallow boundary) is fully determined by
    // its wants and depth, and objects are immutable by oid — so the pack
    // for one (wants, depth) is the same bytes every time. The clone
    // workload runs 50 identical depth-1 clones of one tip: the first
    // builds the pack, the other 49 reuse it. A push clears the cache
    // (receive-pack), and a new tip is a different key anyway.
    const cacheKey = haves.length === 0 && clientShallow.length === 0
      ? `fetch:${[...wants].sort().join(',')}:${depth ?? 'full'}`
      : null;
    let pack: Buffer | undefined;
    if (cacheKey !== null) pack = repo.packCache.get(cacheKey);
    if (pack === undefined) {
      const entries = [...objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, obj]) => ({ type: obj.type, data: obj.data }));
      pack = writePack(entries);
      if (cacheKey !== null) repo.packCache.set(cacheKey, pack);
    }
    parts.push(pktText('packfile\n'));
    for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
      const chunk = pack.subarray(off, Math.min(pack.length, off + SIDEBAND_CHUNK));
      const payload = Buffer.concat([Buffer.from([1]), chunk]);
      parts.push(pktLine(payload));
    }
  }
  parts.push(FLUSH_PKT);
  return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): GitResult {
  const flushAt = afterFirstFlush(body);
  if (flushAt < 0) return gitError(400, 'malformed receive-pack request');
  const { lines, ok } = parseRequestLines(body.subarray(0, flushAt));
  if (!ok || lines.length === 0) return gitError(400, 'malformed receive-pack request');

  const commands: PushCommand[] = [];
  let wantSideband = false;
  let wantReport = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] as string).replace(/\n$/, '');
    let caps = '';
    let text = raw;
    const nul = raw.indexOf('\u0000');
    if (nul >= 0) {
      text = raw.slice(0, nul);
      caps = raw.slice(nul + 1);
    }
    const parts = text.split(' ');
    if (parts.length !== 3) return gitError(400, 'malformed push command');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    commands.push({ oldOid: oldOid.toLowerCase(), newOid: newOid.toLowerCase(), ref });
    if (i === 0 && caps !== '') {
      const tokens = caps.split(' ');
      wantSideband = tokens.includes('side-band-64k');
      wantReport = tokens.includes('report-status') || tokens.includes('report-status-v2');
    }
  }
  if (commands.length === 0) return gitError(400, 'no push commands');

  // Unpack first: objects land even when a ref is refused.
  const packBytes = body.subarray(flushAt);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const parsed = parsePack(packBytes);
      for (const [oid, obj] of parsed) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : 'unpack failed';
    }
  }

  const reportLines: string[] = [];
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(command.ref);
          repo.refsVersion += 1;
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists\n`);
        } else if (getObject(repo, command.newOid) === undefined) {
          reportLines.push(`ng ${command.ref} missing object\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          repo.refsVersion += 1;
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      // Update.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      } else if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else if (getObject(repo, command.newOid) === undefined) {
        reportLines.push(`ng ${command.ref} missing object\n`);
      } else if (command.newOid === current || isAncestor(repo, command.newOid, current)) {
        repo.refs.set(command.ref, command.newOid);
        repo.refsVersion += 1;
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      }
    }
    repo.packCache.clear();
  }

  const reportStream = Buffer.concat(reportLines.map((line) => pktText(line)));
  let responseBody: Buffer;
  if (wantSideband) {
    const parts: Buffer[] = [];
    for (let off = 0; off < reportStream.length; off += SIDEBAND_CHUNK) {
      const chunk = reportStream.subarray(off, Math.min(reportStream.length, off + SIDEBAND_CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(FLUSH_PKT);
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = Buffer.concat([reportStream, FLUSH_PKT]);
  }
  void wantReport;
  return { status: 200, body: responseBody, contentType: 'application/x-git-receive-pack-result' };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Handle a git smart-HTTP request. Returns null when the path is not a git
 * path (the caller then answers its own 404).
 */
export function handleGit(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): GitResult | null {
  if (segments.length < 2) return null;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return null;
  const owner = segments[0] as string;
  const repoName = repoSegment.slice(0, -'.git'.length);
  const service = segments[2] as string | undefined;

  const repo = visibleRepo(store, owner, repoName);
  if (repo === null) return gitError(404, 'Not Found');

  if (method === 'GET' && service === 'info' && segments[3] === 'refs') {
    const requested = query.get('service');
    if (requested === 'git-upload-pack') {
      const v2 = (headers['git-protocol'] as string | undefined) === 'version=2';
      if (v2) return { status: 200, body: V2_UPLOAD_ADVERTISEMENT, contentType: 'application/x-git-upload-pack-advertisement' };
      return { status: 200, body: v0Advertisement(repo, 'git-upload-pack'), contentType: 'application/x-git-upload-pack-advertisement' };
    }
    if (requested === 'git-receive-pack') {
      return { status: 200, body: v0Advertisement(repo, 'git-receive-pack'), contentType: 'application/x-git-receive-pack-advertisement' };
    }
    return gitError(404, 'Not Found');
  }

  if (method === 'POST' && service === 'git-upload-pack') {
    try {
      const { lines, ok } = parseRequestLines(body);
      if (!ok || lines.length === 0) return gitError(400, 'malformed upload-pack request');
      const first = (lines[0] as string).replace(/\n$/, '');
      if (first === 'command=ls-refs') return handleLsRefs(repo, lines);
      if (first === 'command=fetch') return handleFetch(repo, lines);
      return gitError(400, `unknown upload-pack command ${JSON.stringify(first)}`);
    } catch {
      return gitError(400, 'malformed upload-pack request');
    }
  }

  if (method === 'POST' && service === 'git-receive-pack') {
    try {
      return handleReceivePack(repo, body);
    } catch {
      return gitError(400, 'malformed receive-pack request');
    }
  }

  return null;
}

export { hashObject };
