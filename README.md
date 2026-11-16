# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/highwill/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/highwill/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process: git smart HTTP
(protocol v2 upload-pack, v0 receive-pack), the REST v3 API, GraphQL v4, and an MCP
endpoint over its own in-memory store. No UI, no outside services, no git binary.

Built for the [github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01)
on make.fun.

## Run

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must point at the trial env; the program binds an ephemeral port,
registers it, serves until the env says done, then exits 0.
