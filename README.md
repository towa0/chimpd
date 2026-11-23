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
npx chimpd baseline --level prod
npx chimpd baseline --level prod --prune
```

| Option | Meaning |
| --- | --- |
| `--level poke\|prod\|shake` | The preset; required. |
| `--plan` | `run` only. Print what the run would do and run nothing; see [Plan](#plan). |
| `--prune` | `baseline` only. Remove baseline entries that match nothing in scope any more; see [Baseline and ignores](#baseline-and-ignores). |
| `--base <ref>` | The ref the branch is compared against, through its merge base with `HEAD`. Default `origin/main`. |
| `--json` | `run` only. Print the JSON report instead of text. |
| `--strict` | `run` only. Exit 2 whenever anything in scope was not checked. |
| `--verbose` | Pass on what the project's own tests print. It goes to stderr, so `--json` output stays clean. Without it, that output is discarded. |
| `--seed <n>` | An integer from 0 to 2147483647 that decides ties when a cap or the budget forces a choice; see [Seed](#seed). Without it, chimpd picks one and prints it in the report. |
| `--cwd <dir>` | The project to check. Default the current directory. |

Uncommitted and untracked files count as part of the branch. When only test files changed, the mutation phase mutates the source files those tests import, and only mutants that a changed test runs are reported. In that case the fault phase does not run.

Tooling and config files are kept out of scope and listed in the report as not checked: any `*.config.*` TypeScript file (`vitest.config.ts`, `vite.config.mts`, `eslint.config.ts`, `stryker.config.mts` and the like), `stryker.conf.*`, and `vitest.workspace.*` or `vite.workspace.*`.

## Plan

```sh
npx chimpd run --plan --level prod
npx chimpd run --plan --level shake --seed 7 --json > plan.json
```

`--plan` takes the same flags as a run, runs no mutant, no test and no fault, and writes nothing to the working tree. It prints:

- the files in scope, and every ignored file with its reason;
- the number of mutants each file would get. Stryker's own instrumenter generates them in memory, with the preset's mutators, and counts the ones that start on a scoped line. When a file cannot be instrumented, its count is shown as unavailable with the reason. Mutants in module-level code are counted apart, because Stryker decides which mutants are static only after a test run;
- the mutation batches in the order a run with the same seed would run them;
- the changed outgoing calls found in the source. A run finds call sites by running the tests, so calls through client libraries are missing here;
- the preset, its caps and the budget split;
- a time estimate, labelled as an estimate, with how it was derived. It assumes 10 s of Stryker start and dry run per batch, 0.5 s per mutant, a 10 s call-site discovery run, and, per call site up to the cap, the 2 s fault deadline plus 1 s per test. When a file's mutant count is unavailable, it uses the preset's guess of mutants per scoped line for that file instead. Each part is capped at its share of the budget. None of these costs is measured.

The plan also says when a run would stop with a tool error, for example when no Vitest config is found or `chimpd-baseline.json` cannot be read. The installed Vitest version is not checked, because that means loading it.

The exit code is 0 whenever the plan could be computed, and 2 when it could not: outside a git repository, a base ref that does not resolve, bad arguments. `--json` prints `"report": "plan"` with its own `"schemaVersion": 1`, versioned apart from the run report under the same rules: `status`, `exitCode`, `error`, `level`, `preset`, `seed`, `git`, `scope`, `vitestConfig`, `runWouldFail`, `mutation`, `faults`, `budget` and `estimate`, which carries `"isEstimate": true` and its `derivation`.

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

## Seed

When a cap or the budget forces chimpd to choose, the seed decides between items of equal rank and nothing else:

- Call sites over the preset cap: sites are ranked by severity prior; among sites of equal prior, the seed decides which are faulted and which are skipped as over the cap.
- Tests per call site: the cheapest tests by their unfaulted duration come first; the seed only orders tests of equal duration.
- Files in a test-only run over the file cap: closest to a changed test first, then the most sensitive; the seed orders files of equal distance and prior.
- Mutation batches: files are ranked by severity prior; the seed orders files of equal prior, which decides which files a short budget leaves untested.

A more sensitive item is never dropped in favour of a less sensitive one. The same seed, diff and config give the same selection and order. Each choice depends on the seed and the items' identities only, not on the order discovery found them in. The order of mutants inside one Stryker batch is Stryker's own and is not seeded. Without `--seed`, chimpd picks a seed at random and prints it in the report, so a run can be repeated with `--seed`.

## Baseline and ignores

Some findings are accepted on purpose: an equivalent mutant that no test can kill, or a survivor the team has decided to live with. They can be set aside without being hidden. An ignored finding never counts toward the exit code, and it is always reported: the text report says "N findings ignored (baseline: a, inline: b)" and `--json` lists each one under `ignored`, with `ignoredBy` and `ignoreReason`.

### Baseline file

`chimpd baseline --level <name>` runs the same check as `chimpd run` with the same flags, prints its report, and writes the current findings to `chimpd-baseline.json` at the repository root. Commit that file; it is not under `.chimpd/`. When the run is `inconclusive` or `error`, nothing is written and the command exits 2.

```json
{
  "version": 1,
  "entries": [
    {
      "source": "mutation",
      "file": "src/discount.ts",
      "mutator": "EqualityOperator",
      "replacement": "orderTotal > 120",
      "statement": "3f9c0d1e2a4b5c6d",
      "reason": "equivalent: totals are whole multiples of 50"
    },
    { "source": "fault", "file": "src/telemetry.ts", "function": "trackEvent", "kind": "fire-and-forget", "reason": null }
  ]
}
```

- A mutation entry names the file from the repository root, the mutator, the replacement, and a hash of the innermost statement around the mutant. Before hashing, the statement is printed without comments, whitespace and trailing commas, so edits elsewhere in the file, moved lines and reformatting do not invalidate the entry. A change to the statement itself does.
- A fault entry names the file, the function the call is made from (`null` for an anonymous function) and the finding kind.
- `reason` is optional; add one by hand. Running `chimpd baseline` again keeps every entry and its reason, and adds the new findings.
- A file that is not valid JSON, has a version other than 1, or holds an entry chimpd does not understand, such as an unknown field, is a tool error (exit 2) for `run` and for `baseline`. It is never skipped.

Entries that matched nothing are reported, never as an error:

- Stale: the entry no longer matches anything in scope. A mutation entry is stale when its file is gone, when its statement no longer exists in a file in scope, or when its mutant was killed. A fault entry is stale when its function's call was faulted again and got another verdict. `chimpd baseline --prune` removes stale entries, and nothing else.
- Not evaluated: the entry's statement is in scope, but its mutant was not tested or not generated at this level, so the run cannot tell. These are listed and kept.

An entry for code outside the scope is left alone.

### Inline ignores

```ts
// chimpd-ignore: the cache key is never empty here, so this branch is equivalent
if (key.length === 0) {
```

A `// chimpd-ignore: <reason>` comment on the line directly above a statement sets aside the findings inside that statement, nested statements included, for both mutants and fault call sites. The reason is required. A comment without one, `// chimpd-ignore` or `// chimpd-ignore:` with nothing after it, is not honoured: when the comment, or the line under it, is in scope, it is reported as an `invalid-ignore` finding at the comment, which counts toward the exit code like any other finding. When an inline comment and a baseline entry both match, the finding counts as ignored inline.

## Verdicts

Every finding has a severity from 0 to 100: a base score for its kind plus up to 25 points for a sensitive location. 70 and above is high, 50 to 69 medium, below 50 low. An `invalid-ignore` finding, an ignore comment without a reason, has base 50.

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

The text report shows the diff scope, a coverage summary, the findings most severe first, how many findings were ignored and by what, stale and not-evaluated baseline entries, everything that was skipped or inconclusive with its reason, test files that replace HTTP entry points, the phase outcomes, and a result line. It is plain text, without color. Errors are shown by their first line only; the JSON report keeps the full error.

`--json` prints a report with `"schemaVersion": 1`. The version is raised on any change that removes, renames or retypes a field; new fields may appear without a version change, and so may new values of an enumerated field, such as the `invalid-ignore` finding kind. Top-level fields:

- `status` and `statusReason`: see [Run status](#run-status); the reason is set for `inconclusive` and `nothing-checkable`
- `exitCode`, `strict`, `error`
- `level`, `preset`, `budgetMs`, `spentMs`, `seed`
- `git`: base, merge base, head, and whether the tree had uncommitted changes
- `scope`: changed source and test files, ignored files with their reason, notes
- `phases`: one entry per phase, with its status, reason, the full error as `detail` when it failed, budget and time spent
- `findings`: every finding that counts, with its severity and its mutation or fault detail; a mutation finding carries the `statement` hash a baseline entry would use
- `ignored`: every finding the baseline or an inline comment set aside, with `ignoredBy` (`baseline` or `inline`) and `ignoreReason`
- `baseline`: whether `chimpd-baseline.json` exists, its number of entries, and its `stale` and `notEvaluated` entries; `null` when the run stopped before reading it
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
| 0 | No findings, and the run is `completed`, `partial`, `nothing-checkable` or `nothing-in-scope`. Ignored findings do not count. |
| 1 | At least one finding that is not ignored, and the run is `completed` or `partial`. |
| 2 | The run is `inconclusive` or `error`; with `--strict`, also `partial` or `nothing-checkable`. |

## Known limits

- Vitest and TypeScript only.
- Under the `happy-dom` environment the fault phase is inconclusive: happy-dom replaces `fetch` and `Request` with its own, which chimpd cannot fault yet. Custom environments that replace them are reported as a patch.
- The only fault is the black hole (a server that never answers). Error responses, malformed bodies and refused connections are not injected yet, although the presets already name them.
- A test file that replaces `fetch` or the `http` entry points itself, for example with a mock library, prevents faulting for the calls made under it. It is reported as a conflict.
- Concurrent tests that reach the same call site are inconclusive, because a held request cannot be attributed to one of them.
- The first call made after the fault deadline has released a test is inconclusive.
- Calls made at import time or from hooks are never faulted. Their sites are reported as inconclusive.
- The seed orders mutation batches but not the mutants inside a batch, whose order is Stryker's.
- The Stryker type checker uses chimpd's own TypeScript 6, also for projects on TypeScript 7. The checker's version check tests that copy, not the project's. A project that does not type-check under it is mutated without the checker.
- A mutant on a type guard, such as `typeof value !== 'string'`, usually fails to compile once mutated, so a change made only of such lines can end with no mutant checked. Those mutants are listed as invalid with the compiler's first error, and such a run is `inconclusive`.
- A failing test is only noticed when it is related to the changed files, because Stryker runs only those tests. A failing test elsewhere in the suite does not stop the mutation phase, and no mutant is judged against it.
- Projects with a custom Vitest runner are not tested.
- When deciding whether to test static mutants at Shake, the test baseline is not known yet, so only the 20-line limit applies.
- A baseline entry hashes the innermost statement, so for a mutant in an `if` condition, any change to the `if` statement, its body included, invalidates the entry. Two identical mutants in one statement share one entry.
- A fault baseline entry only becomes stale when its function's call is faulted again; an entry for a function that no test reaches any more stays until it is removed by hand.
