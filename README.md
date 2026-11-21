# chimpd

Checks the code a branch changed in a TypeScript project tested with Vitest. It answers two questions, limited to what the diff touched:

- Do the tests catch bugs in the changed code? It mutates the changed lines with Stryker and reports the mutants the tests let through.
- Does the changed code survive a dependency that stops answering? It holds every outgoing `fetch`, `http` and `https` request the changed code makes, as a server that accepts the connection and never replies, and reports calls that hang, mishandle the abort or are never awaited. This black hole is the only fault it injects.

It runs within a fixed time budget and reports only what the diff touched.

## Requirements

- Node.js 22.12 or later
- git, with the base ref available locally (for example `origin/main` after a fetch)
- A project tested with Vitest 4.1 or later, below 6, with a `vitest.config.*` or `vite.config.*` at its root, in the `node` or `jsdom` environment
- TypeScript sources

## Install

```sh
npm install --save-dev chimpd
```

## Usage

```sh
npx chimpd run --level poke
npx chimpd run --level prod --base origin/develop --json > report.json
npx chimpd run --level shake --strict --cwd packages/api
```

| Option | Meaning |
| --- | --- |
| `--level poke\|prod\|shake` | The preset; required. |
| `--base <ref>` | The ref the branch is compared against, through its merge base with `HEAD`. Default `origin/main`. |
| `--json` | Print the JSON report instead of text. |
| `--strict` | Exit 2 whenever anything in scope was not checked. |
| `--verbose` | Pass on what the project's own tests print. It goes to stderr, so `--json` output stays clean. Without it, that output is discarded. |
| `--seed <n>` | An integer from 0 to 2147483647, recorded in the report. |
| `--cwd <dir>` | The project to check. Default the current directory. |

Uncommitted and untracked files count as part of the branch. When only test files changed, the mutation phase mutates the source files those tests import, and only mutants that a changed test runs are reported. In that case the fault phase does not run.

Tooling and config files are kept out of scope and listed in the report as not checked: any `*.config.*` TypeScript file (`vitest.config.ts`, `vite.config.mts`, `eslint.config.ts`, `stryker.config.mts` and the like), `stryker.conf.*`, and `vitest.workspace.*` or `vite.workspace.*`.

## Presets

| | Poke | Prod | Shake |
| --- | --- | --- | --- |
| Budget | 2 min | 5 min | 10 min |
| Mutation share of the budget | 70% | 70% | 65% |
| Mutation scope | changed lines | changed lines and their enclosing functions | changed lines and their enclosing functions |
| Mutators | 6 | 11 | all 17 |
| Static mutants (module-level constants) | skipped | skipped | tested when at most 20 lines are in scope |
| Call sites faulted, at most | 3 | 8 | 20 |
| Tests run per call site, at most | 1 | 2 | 3 |
| Findings shown in the text report | 3 | 5 | 5 |

The mutation phase runs first. The fault phase gets whatever budget is left, including time the mutation phase did not use. A phase with nothing in scope gives its whole share to the other one. Call sites and mutation batches are ordered by a severity prior based on file and function names (payments, auth, storage and similar), so the most sensitive code is checked first when the budget is tight.

## Verdicts

Every finding has a severity from 0 to 100: a base score for its kind plus up to 25 points for a sensitive location. 70 and above is high, 50 to 69 medium, below 50 low.

Mutation phase:

| Result | Meaning |
| --- | --- |
| `survived` (finding, base 55) | Tests ran the mutated code and still passed. |
| `no-coverage` (finding, base 45) | No test runs the mutated code. |
| killed or timed out | A test caught the mutant. Counted as checked. |
| compile or runtime error | The mutant could not run. Listed as invalid with whether it failed to compile or crashed the runner, and the first error line. Not a finding, and a gap in coverage. |
| not tested, ignored | Listed as skipped, with the reason. |

Before any mutant runs, Stryker runs the tests related to the changed files with no mutant active. If any of them fails, no mutant is judged: the mutation phase is `inconclusive` with the reason "the target's own tests fail before any mutant runs", and its files are listed as not mutated.

Stryker's Vitest runner reports no coverage at all when no test executes any mutant of a batch, and Stryker then runs every test against each mutant, which would report them as survivors. chimpd reports those mutants as `no-coverage` instead, unless one of the batch's mutants was killed, which would mean coverage collection itself failed.

Fault phase, for each call site:

| Result | Meaning |
| --- | --- |
| `hang-no-timeout` (finding, base 70) | The call has no timeout of its own; it waits as long as the runtime's transport defaults allow. |
| `abort-mishandled` (finding, base 65) | The call's own timeout fired, but the test failed or an error escaped. |
| `timeout-exceeds-budget` (finding, base 50) | The call has a timeout, but it did not fire within the fault deadline (2 s). |
| `fire-and-forget` (finding, base 40) | The test passed while the request was still pending; nothing waits for it. |
| handled | The call's timeout fired and the test passed. Counted as checked. |
| inconclusive | No reliable verdict; listed with the reason. |

Call sites are found by running the tests, so a call no test makes would leave no trace. To close that gap, chimpd also reads the changed code for direct calls to `fetch` (also as `globalThis.fetch`), `http.request`, `http.get`, `https.request` and `https.get`, under any import style. Each one the tests never reached is listed as not checked: "changed call to fetch at src/a.ts:12 is not reached by any test". Calls through a client library such as axios are not read from the source; they are faulted when a test makes them.

## Output

The text report shows the diff scope, a coverage summary, the findings most severe first, everything that was skipped or inconclusive with its reason, test files that replace HTTP entry points, the phase outcomes, and a result line. It is plain text, without color. Errors are shown by their first line only; the JSON report keeps the full error.

`--json` prints a report with `"schemaVersion": 1`. The version is raised on any change that removes, renames or retypes a field; new fields may appear without a version change. Top-level fields:

- `status` and `statusReason`: see [Run status](#run-status); the reason is set for `inconclusive` and `nothing-checkable`
- `exitCode`, `strict`, `error`
- `level`, `preset`, `budgetMs`, `spentMs`, `seed`
- `git`: base, merge base, head, and whether the tree had uncommitted changes
- `scope`: changed source and test files, ignored files with their reason, notes
- `phases`: one entry per phase, with its status, reason, the full error as `detail` when it failed, budget and time spent
- `findings`: every finding, with its severity and its mutation or fault detail
- `coverage`: `checked` counts, plus `invalid`, `skipped`, `inconclusive` and `conflicts`, each item with its reason

Every duration is in whole milliseconds. Nothing in scope is dropped silently: whatever was not checked appears under `coverage` and in the text report.

## Run status

| Status | Meaning | Exit code |
| --- | --- | --- |
| `completed` | Everything in scope was checked. The only status the text report calls clean. | 0, or 1 with findings |
| `partial` | Something in scope was not checked, but the run checked something else. The report lists every gap. | 0 or 1 by findings; 2 with `--strict` |
| `inconclusive` | A phase failed, or nothing in scope could be checked, for example when every mutant was invalid ("no mutant in scope could run"). | 2 |
| `nothing-checkable` | Source was in scope, but the change produces no mutant at this level and makes no outgoing call, as with a change to types or comments. | 0; 2 with `--strict` |
| `nothing-in-scope` | The branch changed no TypeScript source or test file. | 0 |
| `error` | The run could not be carried out: not a git repository, missing base ref, no Vitest config, an unsupported Vitest, bad arguments. | 2 |

Gaps that make a run partial include call sites over the preset cap, a budget that ran out after some results, a test file that replaces `fetch`, a call site with no verdict, an invalid mutant, and a changed call that no test reaches.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | No findings, and the run is `completed`, `partial`, `nothing-checkable` or `nothing-in-scope`. |
| 1 | At least one finding, and the run is `completed` or `partial`. |
| 2 | The run is `inconclusive` or `error`; with `--strict`, also `partial` or `nothing-checkable`. |

## Known limits

- Vitest and TypeScript only.
- Under the `happy-dom` environment the fault phase is inconclusive: happy-dom replaces `fetch` and `Request` with its own, which chimpd cannot fault yet. Custom environments that replace them are reported as a patch.
- The only fault is the black hole (a server that never answers). Error responses, malformed bodies and refused connections are not injected yet, although the presets already name them.
- A test file that replaces `fetch` or the `http` entry points itself, for example with a mock library, prevents faulting for the calls made under it. It is reported as a conflict.
- Concurrent tests that reach the same call site are inconclusive, because a held request cannot be attributed to one of them.
- The first call made after the fault deadline has released a test is inconclusive.
- Calls made at import time or from hooks are never faulted. Their sites are reported as inconclusive.
- The seed is recorded but does not change anything yet; no phase is randomized.
- The Stryker type checker uses chimpd's own TypeScript 6, also for projects on TypeScript 7. The checker's version check tests that copy, not the project's. A project that does not type-check under it is mutated without the checker.
- A mutant on a type guard, such as `typeof value !== 'string'`, usually fails to compile once mutated, so a change made only of such lines can end with no mutant checked. Those mutants are listed as invalid with the compiler's first error, and such a run is `inconclusive`.
- A failing test is only noticed when it is related to the changed files, because Stryker runs only those tests. A failing test elsewhere in the suite does not stop the mutation phase, and no mutant is judged against it.
- Projects with a custom Vitest runner are not tested.
- When deciding whether to test static mutants at Shake, the test baseline is not known yet, so only the 20-line limit applies.
