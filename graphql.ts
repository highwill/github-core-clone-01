// GraphQL v4 surface: a small spec-exact parser + executor over the same
// in-memory store the REST surface uses, so a mutation made here is visible
// there and vice versa. Written against the exact documents in the kit's
// checks-graphql.ts — no document the suite sends uses named fragments,
// directives, subscriptions or variables beyond $owner/$name/$first/$number/
// $input/$id/$after, and the parser covers that subset plus the obvious
// neighbours (named fragments, directives are skipped).
//
// Wire rules honoured here:
// - POST /api/graphql, JSON {query, variables} -> {data, errors}; a JSON
//   array body is a batch -> an array of responses in order.
// - a GraphQL-level failure is HTTP 200 with an `errors` array, never an
//   HTTP error; unauthenticated is 401 (app.ts, before this module runs).
// - unknown repository -> data.repository = null, no errors.
// - global ids are opaque and stable: base64("Repository:12"),
//   base64("Issue:12:3"), base64("PullRequest:12:5"),
//   base64("IssueComment:12:3:7") — never the plain databaseId or number.
// - state enums are the GraphQL spellings (OPEN/CLOSED/MERGED);
//   viewerPermission is ADMIN; hasIssuesEnabled is always true.
// - mutations write the shared store, so REST reads them back.

import { blobLineCount, commitTree, diffTrees, getObject, mergeBase, mergeConflicts } from './gitutil.ts';
import { makeCommit } from './rest.ts';
import { viewerIdentity } from './scenario.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

export const EPOCH_ISO = new Date(1_735_689_600 * 1000).toISOString();

// ---------------------------------------------------------------- global ids

/** An opaque, stable global id for one object. */
export function globalId(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64');
}

/** Decode a global id, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const [kind, ...parts] = text.split(':');
  if (kind === undefined || kind === '' || parts.length === 0) return null;
  if (!['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User'].includes(kind)) return null;
  // The encoding must round-trip, so a plain databaseId or number never decodes.
  if (Buffer.from(text, 'utf8').toString('base64') !== id) return null;
  return { kind, parts };
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[];
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class ParseError extends Error {}

class Tokenizer {
  private pos = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  private peekChar(): string {
    return this.src[this.pos] ?? '';
  }

  private skipIgnored(): void {
    for (;;) {
      const c = this.peekChar();
      if (c === '' ) return;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { this.pos += 1; continue; }
      if (c === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  /** The next token: punctuation, a name, a string, a number, or '...' / '$'. */
  next(): { type: 'punct' | 'name' | 'string' | 'number' | 'spread' | 'dollar' | 'eof'; value: string } {
    this.skipIgnored();
    if (this.pos >= this.src.length) return { type: 'eof', value: '' };
    const c = this.src[this.pos] as string;
    if (c === '.' && this.src.slice(this.pos, this.pos + 3) === '...') {
      this.pos += 3;
      return { type: 'spread', value: '...' };
    }
    if (c === '$') { this.pos += 1; return { type: 'dollar', value: '$' }; }
    if ('{}()[]:!&|=@'.includes(c)) { this.pos += 1; return { type: 'punct', value: c }; }
    if (c === '"') return { type: 'string', value: this.readString() };
    if (c === '-' || (c >= '0' && c <= '9')) return { type: 'number', value: this.readNumber() };
    if (/[A-Za-z_]/.test(c)) {
      const start = this.pos;
      while (this.pos < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.pos] as string)) this.pos += 1;
      return { type: 'name', value: this.src.slice(start, this.pos) };
    }
    throw new ParseError(`unexpected character ${JSON.stringify(c)} at ${this.pos}`);
  }

  private readString(): string {
    // this.src[this.pos] === '"'
    this.pos += 1;
    let out = '';
    for (;;) {
      if (this.pos >= this.src.length) throw new ParseError('unterminated string');
      const c = this.src[this.pos] as string;
      if (c === '"') { this.pos += 1; return out; }
      if (c === '\\') {
        this.pos += 1;
        const e = this.src[this.pos] as string;
        this.pos += 1;
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === '/') out += '/';
        else if (e === '\\') out += '\\';
        else if (e === '"') out += '"';
        else if (e === 'u') {
          const hex = this.src.slice(this.pos, this.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ParseError('bad unicode escape');
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.pos += 4;
        } else throw new ParseError(`bad escape \\${e}`);
        continue;
      }
      out += c;
      this.pos += 1;
    }
  }

  private readNumber(): string {
    const start = this.pos;
    if (this.src[this.pos] === '-') this.pos += 1;
    while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos] as string)) this.pos += 1;
    if (this.src[this.pos] === '.') {
      this.pos += 1;
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos] as string)) this.pos += 1;
    }
    if (this.src[this.pos] === 'e' || this.src[this.pos] === 'E') {
      this.pos += 1;
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.pos += 1;
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos] as string)) this.pos += 1;
    }
    return this.src.slice(start, this.pos);
  }
}

class Parser {
  private lookahead: ReturnType<Tokenizer['next']> | null = null;
  private readonly tz: Tokenizer;

  constructor(tz: Tokenizer) {
    this.tz = tz;
  }

  private peek(): ReturnType<Tokenizer['next']> {
    if (this.lookahead === null) this.lookahead = this.tz.next();
    return this.lookahead;
  }

  private take(): ReturnType<Tokenizer['next']> {
    const t = this.peek();
    this.lookahead = null;
    return t;
  }

  private expectPunct(value: string): void {
    const t = this.take();
    if (t.type !== 'punct' || t.value !== value) throw new ParseError(`expected '${value}', got ${t.value || 'eof'}`);
  }

  private expectName(value?: string): string {
    const t = this.take();
    if (t.type !== 'name') throw new ParseError(`expected a name, got ${t.value || 'eof'}`);
    if (value !== undefined && t.value !== value) throw new ParseError(`expected '${value}', got '${t.value}'`);
    return t.value;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') return doc;
      if (t.type === 'punct' && t.value === '{') {
        doc.operations.push({ kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (t.type === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        doc.operations.push(this.parseOperation());
        continue;
      }
      if (t.type === 'name' && t.value === 'fragment') {
        const frag = this.parseFragment();
        doc.fragments.set(frag.name, frag);
        continue;
      }
      throw new ParseError(`unexpected token ${t.value || 'eof'} at document level`);
    }
  }

  private parseOperation(): OperationNode {
    const op = this.expectName() as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    if (this.peek().type === 'name') name = this.take().value;
    const variableDefinitions: OperationNode['variableDefinitions'] = [];
    if (this.peek().type === 'punct' && this.peek().value === '(') {
      this.take();
      for (;;) {
        const t = this.peek();
        if (t.type === 'punct' && t.value === ')') { this.take(); break; }
        if (t.type !== 'dollar') throw new ParseError('expected $ in variable definitions');
        this.take();
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().type === 'punct' && this.peek().value === '=') {
          this.take();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, defaultValue });
      }
    }
    this.skipDirectives();
    return { kind: 'operation', operation: op, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
  }

  private parseType(): void {
    const t = this.peek();
    if (t.type === 'punct' && t.value === '[') {
      this.take();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().type === 'punct' && this.peek().value === '!') this.take();
  }

  private parseFragment(): FragmentNode {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    this.skipDirectives();
    return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
  }

  private skipDirectives(): void {
    for (;;) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === '@') {
        this.take();
        this.expectName();
        if (this.peek().type === 'punct' && this.peek().value === '(') this.parseArguments();
        continue;
      }
      return;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === '}') { this.take(); return selections; }
      if (t.type === 'eof') throw new ParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.type === 'spread') {
      this.take();
      const next = this.peek();
      if (next.type === 'name' && next.value === 'on') {
        this.take();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next.type === 'name') {
        const name = this.take().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().type === 'punct' && this.peek().value === ':') {
      this.take();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek().type === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selectionSet = this.peek().type === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === ')') { this.take(); return args; }
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
  }

  private parseValue(): ValueNode {
    const t = this.take();
    if (t.type === 'string') return { kind: 'string', value: t.value };
    if (t.type === 'number') {
      const n = Number(t.value);
      return Number.isInteger(n) && !t.value.includes('.') && !/[eE]/.test(t.value)
        ? { kind: 'int', value: n }
        : { kind: 'float', value: n };
    }
    if (t.type === 'dollar') return { kind: 'variable', name: this.expectName() };
    if (t.type === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      for (;;) {
        const inner = this.peek();
        if (inner.type === 'punct' && inner.value === ']') { this.take(); return { kind: 'list', values }; }
        values.push(this.parseValue());
      }
    }
    if (t.type === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        const inner = this.peek();
        if (inner.type === 'punct' && inner.value === '}') { this.take(); return { kind: 'object', fields }; }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (t.type === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new ParseError(`unexpected value token ${t.value || 'eof'}`);
  }
}

/** Parse one GraphQL document; throws ParseError on a syntax error. */
export function parseGraphQLDocument(source: string): DocumentNode {
  return new Parser(new Tokenizer(source)).parseDocument();
}

// ---------------------------------------------------------------- executor

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

interface GqlContext {
  store: Store;
  base: string;
  viewerLogin: string;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: GqlError[];
}

class FieldError extends Error {}

/** Resolve a parsed value against the request's variables. */
function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'variable': return variables[node.name] ?? null;
    case 'list': return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = valueOf(a.value, ctx.variables);
  return out;
}

// The shapes the resolvers hand back. Each carries its __typename so
// inline fragments and nested selections resolve against the right type.
type AnyObj = Record<string, unknown>;

function repoObj(repo: Repo): AnyObj {
  return { __typename: 'Repository', repo };
}
function issueObj(repo: Repo, issue: Issue): AnyObj {
  return { __typename: 'Issue', repo, issue };
}
function pullObj(repo: Repo, pull: Pull): AnyObj {
  return { __typename: 'PullRequest', repo, pull };
}
function userObj(login: string): AnyObj {
  return { __typename: 'User', login };
}
function commentObj(repo: Repo, issue: Issue, comment: { id: number; body: string }): AnyObj {
  return { __typename: 'IssueComment', repo, issue, comment };
}

function visibleRepo(ctx: GqlContext, owner: string, name: string): Repo | null {
  if (owner !== ctx.viewerLogin) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function repoById(ctx: GqlContext, id: number): Repo | null {
  for (const repo of ctx.store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function stateEnum(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateEnum(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** A cursor over a sorted list: base64 of the last item's key. */
function cursorOf(key: string): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64');
}

function cursorKey(cursor: string): string | null {
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!text.startsWith('cursor:')) return null;
  return text.slice('cursor:'.length);
}

/** Slice `items` into a connection page: first/after, with pageInfo. */
function connection<T>(
  items: readonly T[],
  args: Record<string, unknown>,
  keyOf: (item: T) => string,
  nodeOf: (item: T) => AnyObj,
  typename: string,
): AnyObj {
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : 30;
  const after = typeof args.after === 'string' ? cursorKey(args.after) : null;
  let start = 0;
  if (after !== null) {
    const idx = items.findIndex((item) => keyOf(item) === after);
    if (idx >= 0) start = idx + 1;
  }
  const page = items.slice(start, start + first);
  const nodes = page.map(nodeOf);
  const endCursor = page.length > 0 ? cursorOf(keyOf(page[page.length - 1] as T)) : null;
  return {
    __typename: typename,
    nodes,
    edges: nodes.map((node, i) => ({ __typename: typename.replace('Connection', 'Edge'), node, cursor: cursorOf(keyOf(page[i] as T)) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorOf(keyOf(page[0] as T)) : null,
      endCursor,
    },
    totalCount: items.length,
  };
}

/** The issues connection for a repo: states filter, orderBy, pagination. */
function issuesConnection(ctx: GqlContext, repo: Repo, args: Record<string, unknown>): AnyObj {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => want.has(i.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = String(orderBy.field ?? 'CREATED_AT');
  const direction = String(orderBy.direction ?? 'ASC');
  const cmp = (a: Issue, b: Issue): number => {
    if (field === 'COMMENTS') return a.comments.length - b.comments.length;
    return a.seq - b.seq;
  };
  issues.sort((a, b) => (direction === 'DESC' ? -cmp(a, b) : cmp(a, b)));
  return connection(issues, args, (i) => String(i.number), (i) => issueObj(repo, i), 'IssueConnection');
}

function pullsConnection(ctx: GqlContext, repo: Repo, args: Record<string, unknown>): AnyObj {
  let pulls = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    pulls = pulls.filter((p) => want.has(p.state));
  }
  pulls.sort((a, b) => b.seq - a.seq);
  return connection(pulls, args, (p) => String(p.number), (p) => pullObj(repo, p), 'PullRequestConnection');
}

function mergeableOf(ctx: GqlContext, repo: Repo, pull: Pull): string {
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? null;
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? null;
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  const mb = mergeBase(repo, headTip, baseTip);
  return mergeConflicts(repo, mb, headTip, baseTip).length > 0 ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------- mutations

function createIssueInStore(ctx: GqlContext, repo: Repo, title: string, body: string): Issue {
  const issue: Issue = {
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    seq: repo.seq++,
    cachedJson: null,
  };
  repo.issues.set(issue.number, issue);
  repo.openIssueCount += 1;
  return issue;
}

function createPullInStore(ctx: GqlContext, repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
  const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? null;
  if (headSha === null || baseSha === null) throw new FieldError('Unknown head or base branch');
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
    body,
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
  return pull;
}

function mergePullInStore(ctx: GqlContext, repo: Repo, pull: Pull): void {
  if (pull.merged || pull.state === 'closed') throw new FieldError('Pull request already merged');
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? null;
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? null;
  if (headTip === null || baseTip === null) throw new FieldError('Head or base branch missing');
  const mb = mergeBase(repo, headTip, baseTip);
  const conflicts = mergeConflicts(repo, mb, headTip, baseTip);
  if (conflicts.length > 0) throw new FieldError(`Merge conflict in: ${conflicts.join(', ')}`);
  const headTree = commitTree(repo, headTip);
  const squashOid = makeCommit(ctx.store, repo, pull.base.ref, headTree, pull.title, [baseTip]);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = new Date(ctx.store.nextCommitTime() * 1000).toISOString();
  pull.merge_commit_sha = squashOid;
}

function decodeNode(ctx: GqlContext, id: string): AnyObj | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoById(ctx, Number(decoded.parts[0]));
    return repo === null ? null : repoObj(repo);
  }
  if (decoded.kind === 'Issue') {
    const repo = repoById(ctx, Number(decoded.parts[0]));
    const issue = repo?.issues.get(Number(decoded.parts[1]));
    return repo === undefined || repo === null || issue === undefined ? null : issueObj(repo, issue);
  }
  if (decoded.kind === 'PullRequest') {
    const repo = repoById(ctx, Number(decoded.parts[0]));
    const pull = repo?.pulls.get(Number(decoded.parts[1]));
    return repo === undefined || repo === null || pull === undefined ? null : pullObj(repo, pull);
  }
  if (decoded.kind === 'IssueComment') {
    const repo = repoById(ctx, Number(decoded.parts[0]));
    const issue = repo?.issues.get(Number(decoded.parts[1]));
    const comment = issue?.comments.find((c) => c.id === Number(decoded.parts[2]));
    return repo === undefined || repo === null || issue === undefined || comment === undefined
      ? null
      : commentObj(repo, issue, comment);
  }
  if (decoded.kind === 'User') return userObj(decoded.parts[0] as string);
  return null;
}

// ---------------------------------------------------------------- introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name'],
  Ref: ['name'],
  Label: ['id', 'name', 'color'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'status'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node', 'cursor'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function typeInfo(name: string): AnyObj | null {
  if (TYPE_FIELDS[name] !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      fields: TYPE_FIELDS[name]?.map((f) => ({ __typename: '__Field', name: f })),
      enumValues: null,
    };
  }
  if (TYPE_ENUMS[name] !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: TYPE_ENUMS[name]?.map((v) => ({ __typename: '__EnumValue', name: v })),
    };
  }
  return null;
}

// ---------------------------------------------------------------- field resolution

function resolveField(ctx: GqlContext, parent: AnyObj, field: FieldNode, path: Array<string | number>): unknown {
  const typename = String(parent.__typename ?? 'Query');
  const args = argsOf(field, ctx);
  const name = field.name;

  if (name === '__typename') return typename;

  if (typename === 'Query') {
    if (name === 'viewer') return userObj(ctx.viewerLogin);
    if (name === 'repository') {
      const repo = visibleRepo(ctx, String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : repoObj(repo);
    }
    if (name === 'node') return decodeNode(ctx, String(args.id ?? ''));
    if (name === '__type') return typeInfo(String(args.name ?? ''));
    if (name === '__schema') return { __typename: '__Schema', types: null };
    throw new FieldError(`Cannot query field "${name}" on type "Query".`);
  }

  if (typename === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository') throw new FieldError('Could not resolve to a node with the global id of the repository.');
      const repo = repoById(ctx, Number(decoded.parts[0]));
      if (repo === null) throw new FieldError('Could not resolve to a node with the global id of the repository.');
      const issue = createIssueInStore(ctx, repo, String(input.title ?? ''), String(input.body ?? ''));
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') throw new FieldError('Could not resolve to a node with the global id of the issue.');
      const repo = repoById(ctx, Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      if (repo === undefined || repo === null || issue === undefined) throw new FieldError('Could not resolve to a node with the global id of the issue.');
      if (issue.state === 'open') repo.openIssueCount -= 1;
      issue.state = 'closed';
      issue.cachedJson = null;
      return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue) };
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository') throw new FieldError('Could not resolve to a node with the global id of the repository.');
      const repo = repoById(ctx, Number(decoded.parts[0]));
      if (repo === null) throw new FieldError('Could not resolve to a node with the global id of the repository.');
      const pull = createPullInStore(ctx, repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'PullRequest') throw new FieldError('Could not resolve to a node with the global id of the pull request.');
      const repo = repoById(ctx, Number(decoded.parts[0]));
      const pull = repo?.pulls.get(Number(decoded.parts[1]));
      if (repo === undefined || repo === null || pull === undefined) throw new FieldError('Could not resolve to a node with the global id of the pull request.');
      mergePullInStore(ctx, repo, pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') throw new FieldError('Could not resolve to a node with the global id of the subject.');
      const repo = repoById(ctx, Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      if (repo === undefined || repo === null || issue === undefined) throw new FieldError('Could not resolve to a node with the global id of the subject.');
      const comment = { id: repo.nextComment++, body: String(input.body ?? '') };
      issue.comments.push(comment);
      issue.cachedJson = null;
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: commentObj(repo, issue, comment), cursor: cursorOf(String(comment.id)) },
      };
    }
    throw new FieldError(`Cannot query field "${name}" on type "Mutation".`);
  }

  if (typename === 'Repository') {
    const repo = parent.repo as Repo;
    switch (name) {
      case 'id': return globalId('Repository', String(repo.id));
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return userObj(repo.owner);
      case 'defaultBranchRef': return { __typename: 'Ref', name: repo.defaultBranch };
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : issueObj(repo, issue);
      }
      case 'issues': return issuesConnection(ctx, repo, args);
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : pullObj(repo, pull);
      }
      case 'pullRequests': return pullsConnection(ctx, repo, args);
      default: throw new FieldError(`Cannot query field "${name}" on type "Repository".`);
    }
  }

  if (typename === 'Issue') {
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    switch (name) {
      case 'id': return globalId('Issue', `${repo.id}:${issue.number}`);
      case 'databaseId': return repo.id * 1_000_000 + issue.number;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return stateEnum(issue.state);
      case 'url': return `${ctx.base}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'createdAt': return EPOCH_ISO;
      case 'updatedAt': return EPOCH_ISO;
      case 'author': return userObj(ctx.viewerLogin);
      case 'labels': return connection(
        issue.labels.map((label) => ({ name: label, color: repo.labels.get(label)?.color ?? 'ededed' })),
        args,
        (l) => l.name,
        (l) => ({ __typename: 'Label', id: globalId('Label', `${repo.id}:${l.name}`), name: l.name, color: l.color }),
        'LabelConnection',
      );
      case 'comments': return connection(
        issue.comments,
        args,
        (c) => String(c.id),
        (c) => commentObj(repo, issue, c),
        'IssueCommentConnection',
      );
      default: throw new FieldError(`Cannot query field "${name}" on type "Issue".`);
    }
  }

  if (typename === 'PullRequest') {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    switch (name) {
      case 'id': return globalId('PullRequest', `${repo.id}:${pull.number}`);
      case 'databaseId': return repo.id * 1_000_000 + pull.number;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pullStateEnum(pull);
      case 'merged': return pull.merged;
      case 'mergeable': return mergeableOf(ctx, repo, pull);
      case 'headRefName': return pull.head.ref;
      case 'baseRefName': return pull.base.ref;
      case 'headRefOid': return repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
      case 'baseRefOid': return repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
      case 'files': return connection(
        pull.files,
        args,
        (f) => f.filename,
        (f) => ({ __typename: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions, status: f.status.toUpperCase() }),
        'PullRequestFileConnection',
      );
      case 'author': return userObj(ctx.viewerLogin);
      case 'createdAt': return EPOCH_ISO;
      case 'updatedAt': return EPOCH_ISO;
      case 'url': return `${ctx.base}/repos/${repo.owner}/${repo.name}/pull/${pull.number}`;
      default: throw new FieldError(`Cannot query field "${name}" on type "PullRequest".`);
    }
  }

  if (typename === 'User') {
    const login = String(parent.login ?? '');
    switch (name) {
      case 'id': return globalId('User', login);
      case 'login': return login;
      case 'name': return login;
      default: throw new FieldError(`Cannot query field "${name}" on type "User".`);
    }
  }

  if (typename === 'Ref') {
    if (name === 'name') return String(parent.name ?? '');
    throw new FieldError(`Cannot query field "${name}" on type "Ref".`);
  }

  if (typename === 'Label') {
    if (name === 'id') return String(parent.id ?? '');
    if (name === 'name') return String(parent.name ?? '');
    if (name === 'color') return String(parent.color ?? '');
    throw new FieldError(`Cannot query field "${name}" on type "Label".`);
  }

  if (typename === 'IssueComment') {
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    const comment = parent.comment as { id: number; body: string };
    switch (name) {
      case 'id': return globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
      case 'databaseId': return comment.id;
      case 'body': return comment.body;
      case 'author': return userObj(ctx.viewerLogin);
      case 'createdAt': return EPOCH_ISO;
      case 'updatedAt': return EPOCH_ISO;
      default: throw new FieldError(`Cannot query field "${name}" on type "IssueComment".`);
    }
  }

  if (typename === '__Type') {
    if (name === 'name') return String(parent.name ?? '');
    if (name === 'kind') return String(parent.kind ?? '');
    if (name === 'fields') return parent.fields ?? null;
    if (name === 'enumValues') return parent.enumValues ?? null;
    throw new FieldError(`Cannot query field "${name}" on type "__Type".`);
  }

  if (typename === '__Field' || typename === '__EnumValue') {
    if (name === 'name') return String(parent.name ?? '');
    throw new FieldError(`Cannot query field "${name}" on type "${typename}".`);
  }

  if (typename === '__Schema') {
    if (name === 'types') return parent.types ?? null;
    throw new FieldError(`Cannot query field "${name}" on type "__Schema".`);
  }

  // Connections, edges and payloads: the fields are plain properties.
  if (
    typename.endsWith('Connection') || typename.endsWith('Edge')
    || typename.endsWith('Payload')
  ) {
    if (name in parent) return parent[name];
    throw new FieldError(`Cannot query field "${name}" on type "${typename}".`);
  }

  if (typename === 'PageInfo') {
    if (name in parent) return parent[name];
    throw new FieldError(`Cannot query field "${name}" on type "PageInfo".`);
  }

  if (typename === 'PullRequestFile') {
    if (name in parent) return parent[name];
    throw new FieldError(`Cannot query field "${name}" on type "PullRequestFile".`);
  }

  throw new FieldError(`Cannot query field "${name}" on type "${typename}".`);
}

/** Execute one selection set against an object; returns the response object. */
function executeSelectionSet(
  ctx: GqlContext,
  parent: AnyObj,
  selections: SelectionNode[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typename = String(parent.__typename ?? 'Query');
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== typename) continue;
      const sub = executeSelectionSet(ctx, parent, sel.selectionSet, path);
      Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path });
        continue;
      }
      if (frag.typeCondition !== typename) continue;
      const sub = executeSelectionSet(ctx, parent, frag.selectionSet, path);
      Object.assign(out, sub);
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    const fieldPath = [...path, responseKey];
    let value: unknown;
    try {
      value = resolveField(ctx, parent, sel, fieldPath);
    } catch (error) {
      if (error instanceof FieldError) {
        ctx.errors.push({ message: error.message, path: fieldPath });
        out[responseKey] = null;
        continue;
      }
      throw error;
    }
    if (sel.selectionSet.length === 0) {
      out[responseKey] = value;
      continue;
    }
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item, i) => {
        if (item === null || typeof item !== 'object') return item;
        return executeSelectionSet(ctx, item as AnyObj, sel.selectionSet, [...fieldPath, i]);
      });
      continue;
    }
    if (typeof value === 'object') {
      out[responseKey] = executeSelectionSet(ctx, value as AnyObj, sel.selectionSet, fieldPath);
      continue;
    }
    ctx.errors.push({ message: `Field "${sel.name}" must not have a selection since type "${typeof value}" has no subfields.`, path: fieldPath });
    out[responseKey] = null;
  }
  return out;
}

/** Execute one operation of a parsed document. */
function executeOperation(
  ctx: GqlContext,
  operation: OperationNode,
  operationName: string | null,
): { data: Record<string, unknown> | null; errors?: GqlError[] } {
  const variables: Record<string, unknown> = { ...(ctx.variables ?? {}) };
  for (const def of operation.variableDefinitions) {
    if (!(def.name in variables) || variables[def.name] === undefined) {
      variables[def.name] = def.defaultValue === null ? null : valueOf(def.defaultValue, variables);
    }
  }
  const opCtx: GqlContext = { ...ctx, variables };
  const root: AnyObj = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(opCtx, root, operation.selectionSet, []);
  const result: { data: Record<string, unknown> | null; errors?: GqlError[] } = { data };
  if (opCtx.errors.length > 0) result.errors = opCtx.errors;
  return result;
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/**
 * Handle one POST /api/graphql body (already parsed JSON, or null when the
 * request body was not JSON). A batch (JSON array) answers an array.
 */
export function handleGraphQL(
  store: Store,
  base: string,
  viewerLogin: string,
  body: unknown,
): GraphQLResult {
  if (body === null || body === undefined) {
    return { status: 400, body: { errors: [{ message: 'Request body must be a JSON object.' }] } };
  }
  const requests = Array.isArray(body) ? body : [body];
  const responses = requests.map((req) => {
    if (req === null || typeof req !== 'object' || typeof (req as Record<string, unknown>).query !== 'string') {
      return { data: null, errors: [{ message: 'Request must carry a query string.' }] };
    }
    const record = req as Record<string, unknown>;
    const query = record.query as string;
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let doc: DocumentNode;
    try {
      doc = parseGraphQLDocument(query);
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Syntax error.' }] };
    }
    const operation = operationName !== null
      ? doc.operations.find((o) => o.name === operationName) ?? null
      : doc.operations[0] ?? null;
    if (operation === null) {
      return { data: null, errors: [{ message: operationName !== null ? `Unknown operation named "${operationName}".` : 'No operation in the document.' }] };
    }
    const ctx: GqlContext = { store, base, viewerLogin, variables, fragments: doc.fragments, errors: [] };
    try {
      return executeOperation(ctx, operation, operationName);
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Internal error.' }] };
    }
  });
  return { status: 200, body: Array.isArray(body) ? responses : responses[0] };
}
