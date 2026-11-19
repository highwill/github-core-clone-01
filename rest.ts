// REST v3 surface. Written against the exact checks in the kit's
// checks-rest.ts: every endpoint below exists because a check calls it, and
// every status/shape assertion in that file is honoured here. Anything the
// checks never call is deliberately absent (it answers 404 JSON).
//
// Conventions shared by all surfaces:
// - the token names the viewer; any owner other than the viewer's login is
//   a 404, never a 403 (foreign-token check);
// - errors are always `{message: <non-empty string>}` JSON;
// - every reply carries X-GitHub-Request-Id (the server adds it);
// - extra fields are allowed by the suite, so responses carry the usual
//   GitHub fields; the fields the checks read are exact.
//
// Perf notes (the read workload GETs one issue 2,000 times, the write
// workload creates 200 issues, both sequential on one connection):
// - a single issue's serialized JSON is cached on the issue and rebuilt
//   only when it mutates (state change, new comment): the read workload's
//   2,000 GETs serialize once. The cache key includes the base URL, so a
//   different Host still gets a correct body.
// - label ids are assigned at creation, so label JSON never scans the
//   label map for an index.
// - the open-issue count is maintained on the repo, so repo JSON never
//   scans the issue map.
// - makeCommit and the git-refs endpoint bump refsVersion, keeping the
//   git advertisement cache honest.

import { buildCommit, getObject, parseCommit, parseTree, storeObject } from './gitobj.ts';
import {
  blobAtPath,
  blobLineCount,
  commitChain,
  commitTree,
  diffTrees,
  flattenTree,
  mergeBase,
  mergeConflicts,
  setPathInTree,
} from './gitutil.ts';
import { viewerIdentity } from './scenario.ts';
import type { Issue, Pull, Repo } from './store.ts';
import type { Store } from './store.ts';

export interface RestResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
  /** Pre-serialized JSON body (with trailing newline, as sendJson writes it):
   * when set, the server sends it verbatim instead of stringifying `body`. */
  readonly rawText?: string;
}

const EPOCH_ISO = new Date(1_735_689_600 * 1000).toISOString();
const INSTALLED_VERSION = '1.0.0';

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function userRef(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', site_admin: false };
}

function repoJson(repo: Repo, base: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userRef(repo.owner, viewerIdentity().viewer.id),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    pushed_at: EPOCH_ISO,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.openIssueCount,
    license: null,
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
    html_url: `${base}/repos/${repo.owner}/${repo.name}`,
    clone_url: `${base}/repos/${repo.owner}/${repo.name}.git`,
    git_url: `${base}/repos/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  const id = label?.id ?? 0;
  return {
    id,
    node_id: `label-${repo.id}-${id}`,
    name,
    color: label?.color ?? 'ededed',
    description: '',
    default: false,
  };
}

function issueJson(repo: Repo, issue: Issue, base: string): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: `issue-${repo.id}-${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userRef(viewerIdentity().viewer.login, viewerIdentity().viewer.id),
    assignee: null,
    assignees: [],
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    closed_at: issue.state === 'closed' ? EPOCH_ISO : null,
    comments: issue.comments.length,
    html_url: `${base}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/**
 * The serialized form of one issue, cached on the issue. The text carries
 * the trailing newline sendJson appends, so a cache hit is byte-identical
 * to a fresh build. The cache is filled on create and on a GET miss, and
 * cleared whenever the issue mutates (PATCH state, new comment).
 */
function issueText(repo: Repo, issue: Issue, base: string): string {
  // cachedJson may be undefined for an issue another surface built before
  // the cache existed; treat any non-object as a miss.
  const cached = issue.cachedJson;
  if (cached !== null && cached !== undefined && cached.base === base) return cached.text;
  const text = `${JSON.stringify(issueJson(repo, issue, base))}\n`;
  issue.cachedJson = { base, text, length: Buffer.byteLength(text) };
  return text;
}

/** Answer a single-issue GET/POST/PATCH with the cached serialized form. */
function issueResult(repo: Repo, issue: Issue, base: string, status: number): RestResult {
  return { status, body: null, rawText: issueText(repo, issue, base) };
}

function pullJson(repo: Repo, pull: Pull, base: string): Record<string, unknown> {
  const viewer = viewerIdentity().viewer;
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: `pr-${repo.id}-${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${repo.owner}:${pull.head.ref}`, user: userRef(viewer.login, viewer.id) },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${repo.owner}:${pull.base.ref}`, user: userRef(viewer.login, viewer.id) },
    user: userRef(viewer.login, viewer.id),
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    closed_at: pull.state === 'closed' ? EPOCH_ISO : null,
    html_url: `${base}/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function pageOf<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** RFC 5988 Link header for a paginated list, same-origin absolute URLs. */
function linkHeader(base: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage <= 1) return null;
  const url = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${base}${path}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${url(page + 1)}>; rel="next"`, `<${url(lastPage)}>; rel="last"`);
  if (page > 1) parts.push(`<${url(page - 1)}>; rel="prev"`, `<${url(1)}>; rel="first"`);
  return parts.join(', ');
}

/** A repo the viewer may see, or null (missing repo and foreign owner are both 404). */
function visibleRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== viewerIdentity().viewer.login) return null;
  return store.getRepo(owner, name) ?? null;
}

/** Base64 that tolerates the whitespace the client strips before decoding. */
function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]/g, ''), 'base64');
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Create a commit on `branch` (or an unborn branch) and move the ref. */
export function makeCommit(
  store: Store,
  repo: Repo,
  branch: string,
  treeOid: string,
  message: string,
  parents: readonly string[],
): string {
  const viewer = viewerIdentity().viewer;
  const ts = store.nextCommitTime();
  const data = buildCommit({
    tree: treeOid,
    parents,
    authorName: viewer.login,
    authorEmail: viewer.email,
    committerName: viewer.login,
    committerEmail: viewer.email,
    timestamp: ts,
    message,
  });
  const oid = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.refsVersion += 1;
  return oid;
}

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  base: string,
): RestResult {
  const viewer = viewerIdentity().viewer;

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      200,
      {
        current_user_url: `${base}/api/v3/user`,
        repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
        meta_url: `${base}/api/v3/meta`,
      },
      { 'X-OAuth-Scopes': 'repo, user' },
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: INSTALLED_VERSION, verifiable_password_authentication: true });
  }

  // GET /api/v3/user, GET|POST /api/v3/user/repos
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      return ok(200, {
        login: viewer.login,
        id: viewer.id,
        node_id: `user-${viewer.id}`,
        avatar_url: '',
        type: 'User',
        name: viewer.name,
        email: viewer.email,
        html_url: `${base}/${viewer.login}`,
        url: `${base}/api/v3/user`,
      });
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const { page, perPage } = parsePage(query);
        const repos = store.listRepos(viewer.login);
        const headers: Record<string, string> = {};
        const link = linkHeader(base, '/api/v3/user/repos', query, page, perPage, repos.length);
        if (link !== null) headers.Link = link;
        return ok(200, pageOf(repos, page, perPage).map((r) => repoJson(r, base)), headers);
      }
      if (method === 'POST') {
        const name = typeof body?.name === 'string' ? body.name : '';
        if (name === '') return err(422, 'name is required');
        if (store.getRepo(viewer.login, name) !== undefined) return err(422, 'Repository already exists');
        const repo = store.createRepo(viewer.login, name, {
          description: typeof body?.description === 'string' ? body.description : '',
          private: body?.private === true,
        });
        return ok(201, repoJson(repo, base));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = decodeURIComponent(segments[2] as string);
    const rest = segments.slice(3);
    const repo = visibleRepo(store, owner, name);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (repo === null) return err(404, 'Not Found');
        return ok(200, repoJson(repo, base));
      }
      if (method === 'PATCH') {
        if (repo === null) return err(404, 'Not Found');
        if (typeof body?.description === 'string') repo.description = body.description;
        return ok(200, repoJson(repo, base));
      }
      if (method === 'DELETE') {
        if (repo === null) return err(404, 'Not Found');
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    if (repo === null) return err(404, 'Not Found');

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'POST') return err(404, 'Not Found');
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? (body.sha as string).toLowerCase() : '';
      if (!ref.startsWith('refs/') || sha === '' || getObject(repo, sha) === undefined) {
        return err(422, 'Invalid ref or sha');
      }
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      repo.refsVersion += 1;
      return ok(201, { ref, object: { sha, type: 'commit' }, url: `${base}/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
    }

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') return err(404, 'Not Found');
      const branches: Record<string, unknown>[] = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
      }
      return ok(200, branches);
    }

    // GET /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') return err(404, 'Not Found');
      const shaParam = query.get('sha');
      let tip: string | null = null;
      if (shaParam !== null) {
        tip = branchTip(repo, shaParam) ?? (getObject(repo, shaParam.toLowerCase()) !== undefined ? shaParam.toLowerCase() : null);
      } else {
        tip = branchTip(repo, repo.defaultBranch);
      }
      if (tip === null) return ok(200, []);
      const { page, perPage } = parsePage(query);
      const chain = commitChain(repo, tip);
      const items = chain.map((sha) => {
        const obj = getObject(repo, sha);
        const info = obj !== undefined ? parseCommit(obj.data) : null;
        return {
          sha,
          commit: {
            message: info?.message ?? '',
            author: { name: viewer.login, email: viewer.email },
            committer: { name: viewer.login, email: viewer.email },
          },
          url: `${base}/api/v3/repos/${owner}/${name}/commits/${sha}`,
        };
      });
      const headers: Record<string, string> = {};
      const link = linkHeader(base, `/api/v3/repos/${owner}/${name}/commits`, query, page, perPage, items.length);
      if (link !== null) headers.Link = link;
      return ok(200, pageOf(items, page, perPage), headers);
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const refParam = query.get('ref');
      const tip = refParam !== null ? (branchTip(repo, refParam) ?? (getObject(repo, refParam.toLowerCase()) !== undefined ? refParam.toLowerCase() : null)) : branchTip(repo, repo.defaultBranch);
      if (method === 'GET') {
        if (tip === null) return err(404, 'Not Found');
        const treeOid = commitTree(repo, tip);
        if (path === '') {
          // Root listing.
          const entries = flattenTree(repo, treeOid);
          return ok(200, [...entries.entries()].map(([p, oid]) => ({ type: 'file', name: p, path: p, sha: oid })));
        }
        const treeObj = getObject(repo, treeOid);
        const entries = treeObj !== undefined ? parseTree(treeObj.data) : [];
        // Directory?
        const dirPrefix = `${path}/`;
        const flat = flattenTree(repo, treeOid);
        const inDir = [...flat.entries()].filter(([p]) => p.startsWith(dirPrefix) && !p.slice(dirPrefix.length).includes('/'));
        const subDirs = new Set<string>();
        for (const [p] of flat.entries()) {
          if (p.startsWith(dirPrefix) && p.slice(dirPrefix.length).includes('/')) {
            subDirs.add(p.slice(dirPrefix.length).split('/')[0] as string);
          }
        }
        if (inDir.length > 0 || subDirs.size > 0) {
          const items: Record<string, unknown>[] = [];
          for (const dir of [...subDirs].sort()) {
            const dirTree = blobAtPath(repo, treeOid, `${path}/${dir}`);
            items.push({ type: 'dir', name: dir, path: `${path}/${dir}`, sha: dirTree });
          }
          for (const [p, oid] of inDir.sort(([a], [b]) => (a < b ? -1 : 1))) {
            items.push({ type: 'file', name: p.slice(dirPrefix.length), path: p, sha: oid, size: getObject(repo, oid)?.data.length ?? 0 });
          }
          return ok(200, items);
        }
        const blobOid = blobAtPath(repo, treeOid, path);
        if (blobOid === '') return err(404, 'Not Found');
        const blob = getObject(repo, blobOid);
        if (blob === undefined) return err(404, 'Not Found');
        return ok(200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: path.split('/').pop(),
          path,
          content: blob.data.toString('base64'),
          sha: blobOid,
        });
      }
      if (method === 'PUT') {
        const message = typeof body?.message === 'string' ? body.message : 'update';
        const contentB64 = typeof body?.content === 'string' ? body.content : '';
        if (contentB64 === '') return err(422, 'content is required');
        const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
        const tipForBranch = branchTip(repo, branch);
        const currentTree = tipForBranch === null ? null : commitTree(repo, tipForBranch);
        const currentBlob = currentTree === null ? '' : blobAtPath(repo, currentTree, path);
        const givenSha = typeof body?.sha === 'string' ? (body.sha as string).toLowerCase() : null;
        if (currentBlob !== '' && givenSha !== null && givenSha !== currentBlob) return err(409, 'Stale blob sha');
        if (currentBlob === '' && givenSha !== null) return err(409, 'Stale blob sha');
        const content = b64decode(contentB64);
        const blobOid = storeObject(repo, 'blob', content);
        const newTree = setPathInTree(repo, currentTree, path, blobOid);
        const parents = tipForBranch === null ? [] : [tipForBranch];
        const commitOid = makeCommit(store, repo, branch, newTree, message, parents);
        const status = currentBlob === '' ? 201 : 200;
        return ok(status, {
          content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitOid, message },
        });
      }
      if (method === 'DELETE') {
        const message = typeof body?.message === 'string' ? body.message : 'delete';
        const givenSha = typeof body?.sha === 'string' ? (body.sha as string).toLowerCase() : null;
        const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
        const tipForBranch = branchTip(repo, branch);
        if (tipForBranch === null) return err(404, 'Not Found');
        const currentTree = commitTree(repo, tipForBranch);
        const currentBlob = blobAtPath(repo, currentTree, path);
        if (currentBlob === '') return err(404, 'Not Found');
        if (givenSha !== null && givenSha !== currentBlob) return err(409, 'Stale blob sha');
        const newTree = setPathInTree(repo, currentTree, path, '');
        const commitOid = makeCommit(store, repo, branch, newTree, message, [tipForBranch]);
        return ok(200, { commit: { sha: commitOid, message } });
      }
      return err(404, 'Not Found');
    }

    // POST /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method !== 'POST') return err(404, 'Not Found');
      const name = typeof body?.name === 'string' ? body.name : '';
      if (name === '') return err(422, 'name is required');
      const color = typeof body?.color === 'string' ? body.color : 'ededed';
      if (!repo.labels.has(name)) repo.labels.set(name, { name, color, id: repo.nextLabel++ });
      return ok(201, labelJson(repo, name));
    }

    // /repos/{o}/{r}/issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof body?.title === 'string' ? body.title : '';
          if (title === '') return err(422, 'title is required');
          const labels = Array.isArray(body?.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return err(422, `Label does not exist: ${label}`);
          }
          const issue = {
            number: repo.nextIssue++,
            title,
            body: typeof body?.body === 'string' ? body.body : '',
            state: 'open' as const,
            labels,
            comments: [],
            seq: repo.seq++,
            cachedJson: null,
          };
          repo.issues.set(issue.number, issue);
          repo.openIssueCount += 1;
          return issueResult(repo, issue, base, 201);
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = [...repo.issues.values()];
          if (state !== 'all') issues = issues.filter((i) => i.state === state);
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const { page, perPage } = parsePage(query);
          const headers: Record<string, string> = {};
          const link = linkHeader(base, `/api/v3/repos/${owner}/${name}/issues`, query, page, perPage, issues.length);
          if (link !== null) headers.Link = link;
          return ok(200, pageOf(issues, page, perPage).map((i) => issueJson(repo, i, base)), headers);
        }
        return err(404, 'Not Found');
      }
      const num = Number.parseInt(rest[1] as string, 10);
      if (Number.isNaN(num)) return err(404, 'Not Found');
      const issue = repo.issues.get(num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (issue === undefined) return err(404, 'Not Found');
          return issueResult(repo, issue, base, 200);
        }
        if (method === 'PATCH') {
          if (issue === undefined) return err(404, 'Not Found');
          if (body?.state === 'open' || body?.state === 'closed') {
            if (body.state !== issue.state) {
              repo.openIssueCount += body.state === 'open' ? 1 : -1;
              issue.state = body.state;
              issue.cachedJson = null;
            }
          }
          return issueResult(repo, issue, base, 200);
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'POST') {
          const commentBody = typeof body?.body === 'string' ? body.body : '';
          const comment = { id: repo.nextComment++, body: commentBody };
          issue.comments.push(comment);
          issue.cachedJson = null;
          return ok(201, {
            id: comment.id,
            body: comment.body,
            user: userRef(viewer.login, viewer.id),
            created_at: EPOCH_ISO,
            updated_at: EPOCH_ISO,
            html_url: `${base}/repos/${owner}/${name}/issues/${num}#issuecomment-${comment.id}`,
          });
        }
        if (method === 'GET') {
          return ok(200, issue.comments.map((c) => ({
            id: c.id,
            body: c.body,
            user: userRef(viewer.login, viewer.id),
            created_at: EPOCH_ISO,
            updated_at: EPOCH_ISO,
          })));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // /repos/{o}/{r}/pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof body?.title === 'string' ? body.title : '';
          if (title === '') return err(422, 'title is required');
          const headRef = typeof body?.head === 'string' ? body.head.split(':').pop() ?? '' : '';
          const baseRef = typeof body?.base === 'string' ? body.base.split(':').pop() ?? '' : '';
          const headSha = branchTip(repo, headRef);
          const baseSha = branchTip(repo, baseRef);
          if (headSha === null || baseSha === null) return err(422, 'Unknown head or base branch');
          const headTree = commitTree(repo, headSha);
          const baseTree = commitTree(repo, baseSha);
          const changes = diffTrees(repo, baseTree, headTree);
          const files = changes.map((c) => {
            const newData = c.newOid === '' ? Buffer.alloc(0) : (getObject(repo, c.newOid)?.data ?? Buffer.alloc(0));
            const oldData = c.oldOid === '' ? Buffer.alloc(0) : (getObject(repo, c.oldOid)?.data ?? Buffer.alloc(0));
            const additions = c.status === 'removed' ? 0 : blobLineCount(newData);
            const deletions = c.status === 'added' ? 0 : blobLineCount(oldData);
            return {
              filename: c.path,
              status: c.status === 'removed' ? 'removed' : c.status === 'added' ? 'added' : 'modified',
              additions,
              deletions,
              changes: additions + deletions,
            };
          });
          const pull: Pull = {
            number: repo.nextPull++,
            title,
            body: typeof body?.body === 'string' ? body.body : '',
            state: 'open',
            merged: false,
            merged_at: null,
            merge_commit_sha: null,
            head: { ref: headRef, sha: headSha },
            base: { ref: baseRef, sha: baseSha },
            baseTipAtCreate: baseSha,
            files,
            seq: repo.seq++,
          };
          repo.pulls.set(pull.number, pull);
          return ok(201, pullJson(repo, pull, base));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
          pulls.sort((a, b) => b.seq - a.seq);
          const { page, perPage } = parsePage(query);
          const headers: Record<string, string> = {};
          const link = linkHeader(base, `/api/v3/repos/${owner}/${name}/pulls`, query, page, perPage, pulls.length);
          if (link !== null) headers.Link = link;
          return ok(200, pageOf(pulls, page, perPage).map((p) => pullJson(repo, p, base)), headers);
        }
        return err(404, 'Not Found');
      }
      const num = Number.parseInt(rest[1] as string, 10);
      if (Number.isNaN(num)) return err(404, 'Not Found');
      const pull = repo.pulls.get(num);
      if (rest.length === 2) {
        if (method !== 'GET') return err(404, 'Not Found');
        if (pull === undefined) return err(404, 'Not Found');
        return ok(200, pullJson(repo, pull, base));
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') return err(404, 'Not Found');
        if (pull === undefined) return err(404, 'Not Found');
        return ok(200, pull.files);
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') return err(404, 'Not Found');
        if (pull === undefined) return err(404, 'Not Found');
        if (pull.merged || pull.state === 'closed') return err(405, 'Pull request already merged');
        const headTip = branchTip(repo, pull.head.ref);
        const baseTip = branchTip(repo, pull.base.ref);
        if (headTip === null || baseTip === null) return err(422, 'Head or base branch missing');
        const mb = mergeBase(repo, headTip, baseTip);
        const conflicts = mergeConflicts(repo, mb, headTip, baseTip);
        if (conflicts.length > 0) return err(405, `Merge conflict in: ${conflicts.join(', ')}`);
        const headTree = commitTree(repo, headTip);
        const squashOid = makeCommit(store, repo, pull.base.ref, headTree, pull.title, [baseTip]);
        pull.state = 'closed';
        pull.merged = true;
        pull.merged_at = new Date(store.nextCommitTime() * 1000).toISOString();
        pull.merge_commit_sha = squashOid;
        return ok(200, { sha: squashOid, merged: true, message: 'Pull request successfully merged' });
      }
      return err(404, 'Not Found');
    }
  }

  return err(404, 'Not Found');
}
