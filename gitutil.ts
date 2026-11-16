// Git graph helpers over the store: tree read/write by path, commit
// ancestry, diffs, merge-base, and the three-way conflict test the pull
// merge endpoint uses. All pure functions of the stored objects.

import { buildTree, getObject, hashObject, parseCommit, parseTag, parseTree, storeObject } from './gitobj.ts';
import type { Repo } from './store.ts';
import type { GitObject, ObjectType } from './store.ts';

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  /** Blob oid at the new side ('' when removed). */
  readonly newOid: string;
  /** Blob oid at the old side ('' when added). */
  readonly oldOid: string;
}

/** Read a blob's oid at `path` in the tree rooted at `treeOid` ('' when absent). */
export function blobAtPath(repo: Repo, treeOid: string, path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = getObject(repo, current);
    if (obj === undefined || obj.type !== 'tree') return '';
    const entries = parseTree(obj.data);
    const part = parts[i] as string;
    const entry = entries.find((e) => e.name === part);
    if (entry === undefined) return '';
    if (i === parts.length - 1) return entry.mode === '40000' ? '' : entry.oid;
    current = entry.oid;
  }
  return '';
}

/** The flat file map of a tree: path -> blob oid (recursive). */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const obj = getObject(repo, treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, oid] of flattenTree(repo, entry.oid, path)) out.set(p, oid);
    } else {
      out.set(path, entry.oid);
    }
  }
  return out;
}

/**
 * A new tree oid equal to `treeOid` with `path` set to `blobOid`
 * (blobOid '' removes the path). Creates intermediate trees as needed.
 */
export function setPathInTree(repo: Repo, treeOid: string | null, path: string, blobOid: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  const build = (currentOid: string | null, depth: number): string => {
    const entries = currentOid === null ? [] : parseTree(getObject(repo, currentOid)?.data ?? Buffer.alloc(0));
    const part = parts[depth] as string;
    const last = depth === parts.length - 1;
    const next: typeof entries = [];
    let found = false;
    for (const entry of entries) {
      if (entry.name !== part) {
        next.push(entry);
        continue;
      }
      found = true;
      if (last) {
        if (blobOid !== '') next.push({ mode: '100644', name: part, oid: blobOid });
        // else: drop the entry (removal)
      } else {
        const childOid = entry.mode === '40000' ? entry.oid : '';
        const rebuilt = build(childOid === '' ? null : childOid, depth + 1);
        // Prune a directory the removal emptied, like git does.
        const rebuiltObj = getObject(repo, rebuilt);
        if (rebuiltObj !== undefined && parseTree(rebuiltObj.data).length > 0) {
          next.push({ mode: '40000', name: part, oid: rebuilt });
        }
      }
    }
    if (!found) {
      if (last) {
        if (blobOid !== '') next.push({ mode: '100644', name: part, oid: blobOid });
      } else {
        const rebuilt = build(null, depth + 1);
        const rebuiltObj = getObject(repo, rebuilt);
        if (rebuiltObj !== undefined && parseTree(rebuiltObj.data).length > 0) {
          next.push({ mode: '40000', name: part, oid: rebuilt });
        }
      }
    }
    const data = buildTree(next);
    return storeObject(repo, 'tree', data);
  };
  return build(treeOid, 0);
}

/** Walk first-parent ancestry from a commit, newest first, with a step cap. */
export function commitChain(repo: Repo, tipOid: string, cap = 10000): string[] {
  const out: string[] = [];
  let current: string | null = tipOid;
  const seen = new Set<string>();
  while (current !== null && current !== '' && !seen.has(current) && out.length < cap) {
    seen.add(current);
    out.push(current);
    const obj = getObject(repo, current);
    if (obj === undefined || obj.type !== 'commit') break;
    const info = parseCommit(obj.data);
    current = info.parents.length > 0 ? (info.parents[0] as string) : null;
  }
  return out;
}

/** The set of commits reachable from `tipOid` (all parents), capped. */
/**
 * Whether `ancestor` is reachable from `descendant` by following commit
 * parents (a merge walks every parent). Stops the moment the ancestor is
 * found, so a fast-forward check on a linear history costs the distance
 * between the two tips, not a walk of the whole history — the push
 * workload pushes one commit at a time onto the previous tip, so this is
 * one step where reachableSet would walk every commit so far.
 */
export function isAncestor(repo: Repo, descendant: string, ancestor: string): boolean {
  if (descendant === ancestor) return true;
  const seen = new Set<string>([descendant]);
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const obj = getObject(repo, oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (target === ancestor) return true;
      if (!seen.has(target)) {
        seen.add(target);
        stack.push(target);
      }
      continue;
    }
    if (obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

export function reachableSet(repo: Repo, tipOid: string, cap = 100000): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [tipOid];
  while (stack.length > 0 && seen.size < cap) {
    const oid = stack.pop() as string;
    if (oid === '' || seen.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return seen;
}

/** The merge-base of two tips: the newest commit reachable from both (first-parent order of `a`). */
export function mergeBase(repo: Repo, aTip: string, bTip: string): string | null {
  const bSet = reachableSet(repo, bTip);
  for (const oid of commitChain(repo, aTip)) {
    if (bSet.has(oid)) return oid;
  }
  return null;
}

/** File-level diff between two tree oids: added/modified/removed entries. */
export function diffTrees(repo: Repo, oldTreeOid: string | null, newTreeOid: string | null): FileChange[] {
  const oldMap = oldTreeOid === null ? new Map<string, string>() : flattenTree(repo, oldTreeOid);
  const newMap = newTreeOid === null ? new Map<string, string>() : flattenTree(repo, newTreeOid);
  const changes: FileChange[] = [];
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  for (const path of [...paths].sort()) {
    const oldOid = oldMap.get(path) ?? '';
    const newOid = newMap.get(path) ?? '';
    if (oldOid === newOid) continue;
    if (oldOid === '') changes.push({ path, status: 'added', newOid, oldOid });
    else if (newOid === '') changes.push({ path, status: 'removed', newOid, oldOid });
    else changes.push({ path, status: 'modified', newOid, oldOid });
  }
  return changes;
}

/**
 * Three-way conflict test for merging `headTip` into `baseTip` with merge-base
 * `base`: a file changed on the head side since the base, whose base-side
 * content also moved since the base, conflicts.
 */
export function mergeConflicts(repo: Repo, baseOid: string | null, headTip: string, baseTip: string): string[] {
  const headInfo = getObject(repo, headTip);
  const baseInfo = getObject(repo, baseTip);
  if (headInfo === undefined || baseInfo === undefined) return [];
  const baseTree = baseOid === null ? null : parseCommit(getObject(repo, baseOid)?.data ?? Buffer.alloc(0)).tree;
  const headTree = parseCommit(headInfo.data).tree;
  const tipTree = parseCommit(baseInfo.data).tree;
  const headChanges = diffTrees(repo, baseTree, headTree);
  const tipMap = flattenTree(repo, tipTree);
  const baseMap = baseTree === null ? new Map<string, string>() : flattenTree(repo, baseTree);
  const conflicts: string[] = [];
  for (const change of headChanges) {
    const tipOid = tipMap.get(change.path) ?? '';
    const baseOidForPath = baseMap.get(change.path) ?? '';
    if (tipOid !== baseOidForPath) conflicts.push(change.path);
  }
  return conflicts;
}

/** The tree oid of a commit ('' when the commit is missing). */
export function commitTree(repo: Repo, commitOid: string): string {
  const obj = getObject(repo, commitOid);
  if (obj === undefined || obj.type !== 'commit') return '';
  return parseCommit(obj.data).tree;
}

/** Line counts of a blob, for pull-file additions/deletions. */
export function blobLineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export type { GitObject, ObjectType };
export { hashObject, storeObject, getObject };
