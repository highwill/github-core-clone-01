// MCP surface: the Model Context Protocol endpoint at POST /mcp, speaking
// the 2026-07-28 revision the kit's mcp-client.ts negotiates (server/
// discover first, then the legacy initialize handshake for a pre-discover
// server — which this one is not, but the handshake is answered anyway).
// The same in-memory store the REST and GraphQL surfaces use, so a repo or
// issue created over MCP is the same object over REST.
//
// Wire rules honoured here:
// - every POST is one JSON-RPC 2.0 request answered by one JSON body
//   (the client also reads SSE, but a plain JSON body is the transport's
//   other legal answer); notifications (no id) get HTTP 202, no body.
// - a body that is not JSON answers HTTP 400 with JSON-RPC -32700.
// - an unknown method or tool answers -32601; a tools/call missing its
//   required arguments answers -32602; a tool that ran and failed answers
//   a result with isError:true.
// - tools/list is a static array, byte-identical on every call.
// - unauthenticated is 401 (app.ts, before this module runs).
// - the six tools the suite needs: create_repo, get_repo, create_issue,
//   list_issues, create_pull_request, merge_pull_request. Their argument
//   names are the canonical github-mcp-server names, so the suite's
//   argument mapping lands exactly.

import { blobLineCount, commitTree, diffTrees, getObject, mergeBase, mergeConflicts } from './gitutil.ts';
import { makeCommit } from './rest.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28'] as const;

const EPOCH_ISO = new Date(1_735_689_600 * 1000).toISOString();

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'The state of the issues to list.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch of the pull request.' },
        base: { type: 'string', description: 'The base branch of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
]);

// ---------------------------------------------------------------- tool results

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): { status: number; body: unknown } {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** A successful tool call: the object as JSON text and as structured content. */
function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

/** A tool that ran and failed: isError:true with the reason as text. */
function toolFail(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function repoJson(repo: Repo, base: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `repo-${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    html_url: `${base}/repos/${repo.owner}/${repo.name}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
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
    labels: [],
    user: { login: repo.owner, id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    html_url: `${base}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull, base: string): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: `pr-${repo.id}-${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${repo.owner}:${pull.base.ref}` },
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    html_url: `${base}/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------- tool dispatch

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredMissing(args: Record<string, unknown>, required: readonly string[]): string[] {
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function callTool(
  store: Store,
  viewerLogin: string,
  base: string,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw { code: -32601, message: `Method not found: no tool named "${name}".` };
  const missing = requiredMissing(args, tool.inputSchema.required);
  if (missing.length > 0) {
    throw { code: -32602, message: `Invalid params: missing required argument(s): ${missing.join(', ')}.` };
  }

  const owner = String(args.owner ?? viewerLogin);
  const repoName = String(args.repo ?? args.name ?? '');

  if (name === 'create_repo') {
    const repoNameArg = String(args.name ?? '');
    if (store.getRepo(viewerLogin, repoNameArg) !== undefined) {
      return toolFail(`Repository ${viewerLogin}/${repoNameArg} already exists.`);
    }
    const repo = store.createRepo(viewerLogin, repoNameArg, {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    return toolOk(repoJson(repo, base));
  }

  const repo = store.getRepo(owner, repoName) ?? null;
  if (repo === null) return toolFail(`Repository ${owner}/${repoName} not found.`);

  if (name === 'get_repo') return toolOk(repoJson(repo, base));

  if (name === 'create_issue') {
    const issue: Issue = {
      number: repo.nextIssue++,
      title: String(args.title ?? ''),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: repo.seq++,
    };
    repo.issues.set(issue.number, issue);
    return toolOk(issueJson(repo, issue, base));
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((i) => i.state === state);
    issues.sort((a, b) => b.seq - a.seq);
    return toolOk(issues.map((i) => issueJson(repo, i, base)));
  }

  if (name === 'create_pull_request') {
    const headRef = String(args.head ?? '').split(':').pop() ?? '';
    const baseRef = String(args.base ?? '').split(':').pop() ?? '';
    const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? null;
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? null;
    if (headSha === null || baseSha === null) return toolFail('Unknown head or base branch.');
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
      title: String(args.title ?? ''),
      body: typeof args.body === 'string' ? args.body : '',
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
    return toolOk(pullJson(repo, pull, base));
  }

  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return toolFail(`Pull request #${number} not found.`);
    if (pull.merged || pull.state === 'closed') return toolFail('Pull request already merged.');
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? null;
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? null;
    if (headTip === null || baseTip === null) return toolFail('Head or base branch missing.');
    const mb = mergeBase(repo, headTip, baseTip);
    const conflicts = mergeConflicts(repo, mb, headTip, baseTip);
    if (conflicts.length > 0) return toolFail(`Merge conflict in: ${conflicts.join(', ')}.`);
    const headTree = commitTree(repo, headTip);
    const squashOid = makeCommit(store, repo, pull.base.ref, headTree, pull.title, [baseTip]);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = new Date(store.nextCommitTime() * 1000).toISOString();
    pull.merge_commit_sha = squashOid;
    return toolOk({ ...pullJson(repo, pull, base), sha: squashOid, merged: true, message: 'Pull request successfully merged' });
  }

  throw { code: -32601, message: `Method not found: no tool named "${name}".` };
}

// ---------------------------------------------------------------- entry point

export interface McpResult {
  status: number;
  body: unknown | null;
}

/**
 * Handle one POST /mcp body (raw text). Returns the HTTP status and the
 * JSON-RPC body, or a null body for a notification (HTTP 202).
 */
export function handleMcp(
  store: Store,
  viewerLogin: string,
  base: string,
  bodyText: string,
): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(parsed)) {
    return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object.');
  }
  const id: JsonRpcId = parsed.id === undefined ? null : (parsed.id as JsonRpcId);
  const isNotification = parsed.id === undefined;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};

  if (method === '') {
    if (isNotification) return { status: 202, body: null };
    return rpcError(id, -32600, 'Invalid Request: missing method.');
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL v4 and MCP tools over one store.',
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_SUPPORTED_VERSIONS[0];
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered as (typeof MCP_SUPPORTED_VERSIONS)[number])
      ? offered
      : MCP_SUPPORTED_VERSIONS[0];
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      const result = callTool(store, viewerLogin, base, toolName, args);
      return rpcResult(id, result);
    } catch (error) {
      if (isRecord(error) && typeof error.code === 'number') {
        return rpcError(id, error.code, String(error.message ?? 'Error.'));
      }
      return rpcError(id, -32603, error instanceof Error ? error.message : 'Internal error.');
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}.`);
}
