// The forge's store: everything lives in memory, keyed for the workloads.
// No filesystem writes happen on any request path — the trial mounts /bot
// read-only, and the perf workloads (2,000 sequential reads, 200 writes) must
// stay at Map-lookup cost.

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
}

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: 'open' | 'closed';
  readonly labels: string[];
  readonly comments: IssueComment[];
  /** Monotonic creation order, so created-asc/desc sorts are stable. */
  readonly seq: number;
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface Pull {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  readonly head: { ref: string; sha: string };
  readonly base: { ref: string; sha: string };
  /** The base tip at PR creation: the merge-base reference for conflict checks. */
  readonly baseTipAtCreate: string;
  readonly files: PullFile[];
  readonly seq: number;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  /** oid (hex) -> object. */
  readonly objects: Map<string, GitObject>;
  /** Full ref (refs/heads/...) -> oid (hex). */
  readonly refs: Map<string, string>;
  /** Label name -> { name, color }. */
  readonly labels: Map<string, { name: string; color: string }>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  /** Creation order across issues and pulls (sort stability). */
  seq: number;
  /** Cached fetch packs: key `${tip}:${depth}` -> pack bytes (deterministic build). */
  readonly packCache: Map<string, Buffer>;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  /** Deterministic clock for commits the forge builds itself (contents API, merges). */
  private commitClock = 1_735_689_600;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: 0,
      packCache: new Map(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  /** The next deterministic commit timestamp (seconds), for forge-built commits. */
  nextCommitTime(): number {
    this.commitClock += 1;
    return this.commitClock;
  }
}
