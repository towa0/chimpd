import { expect } from 'vitest';
import type { FailureEvidence, FailureKind } from '../../src/core/index.js';

export const FAILURE_KINDS: readonly (FailureKind | null)[] = [null, 'fault-escaped', 'raised-by-project', 'raised-by-test', 'unattributed'];

export function failureOf(kind: FailureKind, error: string, overrides: Partial<FailureEvidence> = {}): FailureEvidence {
  return { kind, via: 'test', error, raisedAt: kind === 'raised-by-project' ? 'src/rates.ts:7' : null, ...overrides };
}

export function failureLike(evidence: Partial<FailureEvidence>): FailureEvidence {
  return expect.objectContaining(evidence) as FailureEvidence;
}
