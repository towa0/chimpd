import type { FaultFindingKind, MutantStatus } from '../core/types.js';
import { MAX_PRIOR } from './prior.js';

export { MAX_PRIOR, priorOf, SENSITIVE_PRIOR, STORAGE_PRIOR, tokenize } from './prior.js';

export type MutationFindingKind = 'survived' | 'no-coverage';

/** invalid-ignore: a chimpd-ignore comment without a reason, which is reported instead of honoured. */
export type FindingKind = MutationFindingKind | FaultFindingKind | 'invalid-ignore';

export type SeverityLevel = 'high' | 'medium' | 'low';

export interface Severity {
  /** 0 to 100; base plus prior. */
  readonly score: number;
  readonly level: SeverityLevel;
  readonly base: number;
  readonly prior: number;
}

/**
 * What a finding costs before its location is weighed. A call that can hang forever outranks a
 * mutant that survived, which outranks code no test runs at all, which outranks a slow deadline.
 */
export const BASE_SCORES: Readonly<Record<FindingKind, number>> = {
  'hang-no-timeout': 70,
  'abort-mishandled': 65,
  survived: 55,
  'timeout-exceeds-budget': 50,
  'no-coverage': 45,
  'fire-and-forget': 40,
  'invalid-ignore': 50,
};

export const HIGH_SEVERITY = 70;
export const MEDIUM_SEVERITY = 50;
export const MAX_SCORE = 100;

export function mutationFindingKind(status: MutantStatus): MutationFindingKind | null {
  if (status === 'Survived') return 'survived';
  if (status === 'NoCoverage') return 'no-coverage';
  return null;
}

export function levelOf(score: number): SeverityLevel {
  if (score >= HIGH_SEVERITY) return 'high';
  if (score >= MEDIUM_SEVERITY) return 'medium';
  return 'low';
}

export function severityOf(kind: FindingKind, prior: number): Severity {
  const base = BASE_SCORES[kind];
  const bounded = Math.max(0, Math.min(MAX_PRIOR, prior));
  const score = Math.min(MAX_SCORE, base + bounded);
  return { score, level: levelOf(score), base, prior: bounded };
}
