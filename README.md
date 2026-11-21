# chimpd

Checks the code a branch changed in a TypeScript project tested with Vitest. It answers two questions, limited to what the diff touched:

- Do the tests catch bugs in the changed code? It mutates the changed lines with Stryker and reports the mutants the tests let through.
- Does the changed code survive a dependency that stops answering? It holds every outgoing `fetch` and `http.request` the changed code makes, as a server that accepts the connection and never replies, and reports calls that hang, mishandle the abort or are never awaited.

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
| compile or runtime error | The mutant could not run. Listed as invalid with whether it failed to compile or crashed the runner, and the first error line. Not a finding. |
| not tested, ignored | Listed as skipped, with the reason. |

Fault phase, for each call site:

| Result | Meaning |
| --- | --- |
| `hang-no-timeout` (finding, base 70) | The call has no timeout of its own; it waits as long as the runtime's transport defaults allow. |
| `abort-mishandled` (finding, base 65) | The call's own timeout fired, but the test failed or an error escaped. |
| `timeout-exceeds-budget` (finding, base 50) | The call has a timeout, but it did not fire within the fault deadline (2 s). |
| `fire-and-forget` (finding, base 40) | The test passed while the request was still pending; nothing waits for it. |
| handled | The call's timeout fired and the test passed. Counted as checked. |
| inconclusive | No reliable verdict; listed with the reason. |

## Output

The text report shows the diff scope, a coverage summary, the findings most severe first, everything that was skipped or inconclusive with its reason, test files that replace HTTP entry points, the phase outcomes, and a result line. It is plain text, without color.

`--json` prints a report with `"schemaVersion": 1`. The version is raised on any change that removes, renames or retypes a field; new fields may appear without a version change. Top-level fields:

- `status`: `completed`, `partial`, `inconclusive`, `nothing-in-scope` or `error`
- `exitCode`, `strict`, `error`
- `level`, `preset`, `budgetMs`, `spentMs`, `seed`
- `git`: base, merge base, head, and whether the tree had uncommitted changes
- `scope`: changed source and test files, ignored files, notes
- `phases`: one entry per phase, with its status, reason, budget and time spent
- `findings`: every finding, with its severity and its mutation or fault detail
- `coverage`: `checked` counts, plus `invalid`, `skipped`, `inconclusive` and `conflicts`, each item with its reason

Nothing in scope is dropped silently. Whatever was not checked appears under `coverage` and in the text report.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | No findings. |
| 1 | At least one finding. |
| 2 | A tool error (not a git repository, missing base ref, no Vitest config, an unsupported Vitest, bad arguments), a phase that failed, or a run that could not check anything in scope. |

A partial run exits by its findings, 0 or 1. Examples of a partial run: call sites over the preset cap, a budget that ran out after some results, a test file that replaces `fetch`, or a call site with no verdict. The report lists every gap. With `--strict`, a partial run exits 2.

## Known limits

- Vitest and TypeScript only.
- Under the `happy-dom` environment the fault phase is inconclusive: happy-dom replaces `fetch` and `Request` with its own, which chimpd cannot fault yet. Custom environments that replace them are reported as a patch.
- The only fault is the black hole (a server that never answers). Error responses, malformed bodies and refused connections are not injected yet, although the presets already name them.
- A test file that replaces `fetch` or the `http` entry points itself, for example with a mock library, prevents faulting for the calls made under it. It is reported as a conflict.
- Call sites in projects with a custom Vitest runner are inconclusive, because the runner's own test seam cannot be relied on to separate the test body from its hooks.
- Concurrent tests that reach the same call site are inconclusive, because a held request cannot be attributed to one of them.
- The first call made after the fault deadline has released a test is inconclusive.
- Calls made at import time or from hooks are never faulted. Their sites are reported as inconclusive.
- The seed is recorded but does not change anything yet; no phase is randomized.
- The Stryker type checker uses chimpd's own TypeScript 6, also for projects on TypeScript 7.
- A mutant on a type guard, such as `typeof value !== 'string'`, usually fails to compile once mutated, so a change made only of such lines can end with no mutant checked. Those mutants are listed as invalid with the compiler's first error.
- When deciding whether to test static mutants at Shake, the test baseline is not known yet, so only the 20-line limit applies.
