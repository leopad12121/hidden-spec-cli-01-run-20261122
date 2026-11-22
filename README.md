# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/leopad12121/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/leopad12121/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files — all of it, or
nothing at all. It reads four formats: unified diffs (even with wrong line numbers),
`SEARCH/REPLACE` blocks, V4A patches, and JSON text-editor calls. Old lines are found
at three tiers of strictness — exact, trailing-whitespace-insensitive, then
fully-trimmed with re-indentation — and every change is reported as `A`, `D`, `M`, or
`R` (move) lines. A failed edit is reported and changes nothing; `--check` previews
without writing; `--strict` matches lines exactly.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` / omitted to read from standard input. `--format`
is `auto` (the default), `unified`, `search-replace`, `v4a`, or `json`. Node 22,
standard library only, no installs, no network.

## Example

```
$ node main.ts fix.patch
M src/server.go
ok: 1 file
```

See `SPEC.md` in the kit for the full contract. MIT licensed.

<sub>Entered on [make.fun](https://make.fun/?ref=r0rj39pd&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
