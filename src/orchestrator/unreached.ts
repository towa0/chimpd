import { rangeForLine, type ScopeRange } from '../core/index.js';
import type { OutgoingCall } from '../diff-scoper/index.js';
import type { FaultRunResult } from '../fault-run/index.js';
import type { Item } from './types.js';

/** Whether call-site discovery ran to the end, so that a call it did not see was not reached. */
export function discoveryFinished(result: FaultRunResult): boolean {
  return result.status === 'completed' || result.results.length > 0 || result.skipped.length > 0;
}

/** The calls found in the source that discovery never saw: no test made them, so they were not faulted. */
export function unreachedCalls(calls: readonly OutgoingCall[], result: FaultRunResult, ranges: readonly ScopeRange[]): Item[] {
  const seen = [...result.results.map(({ site }) => site), ...result.skipped.map(({ site }) => site)];
  const conflicting = result.conflicts.length > 0 ? ', or only from a test file that replaces it' : '';
  return calls
    .filter((call) => !seen.some((site) => site.file === call.file && site.line >= call.line && site.line <= call.endLine))
    .map((call) => {
      const changed = rangeForLine(ranges, call.file, call.line)?.kind === 'changed';
      const what = changed ? `changed call to ${call.callee}` : `call to ${call.callee} in a changed function`;
      return {
        source: 'fault',
        file: call.file,
        line: call.line,
        reason: `${what} at ${call.file}:${call.line} is not reached by any test${conflicting}`,
      };
    });
}
