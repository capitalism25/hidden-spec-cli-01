# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/capitalism25/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/capitalism25/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format — applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool-call edits to a tree of files, atomically.

## Run it

```sh
node main.ts [options] [PATCH]
```

`mend` reads a patch in one of four formats (auto-detected, or forced with `--format=unified|search-replace|v4a|json`), finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, fully whitespace-insensitive), and writes every change or none. `--check` previews without writing, `--strict` matches exactly. See `SPEC.md` for the full contract; `node check.ts` runs the 100 public practice checks.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1gnt66ze&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
