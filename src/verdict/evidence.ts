import type { FailureEvidence } from '../core/index.js';

/** Why a failure that is not the fault's own error says nothing against the code's handling of it. */
export function notEscapedBecause(failure: FailureEvidence): string {
  return failure.kind === 'raised-by-project'
    ? `the code raised its own error at ${failure.raisedAt ?? 'an unknown place'}: ${failure.error}`
    : `the test failed on its own check: ${failure.error}`;
}

/** The fault's error, named by subject, as it surfaced. */
export function escapedReason(subject: string, failure: FailureEvidence): string {
  return failure.via === 'unhandled'
    ? `${subject} escaped as an unhandled rejection or error event: ${failure.error}`
    : `${subject} escaped the code and failed the test: ${failure.error}`;
}

export function unattributedReason(fault: string, failure: FailureEvidence): string {
  return `the test failed on an error that is neither ${fault} nor raised by project or test code: ${failure.error}`;
}
