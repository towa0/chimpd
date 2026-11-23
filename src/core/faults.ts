import type { FaultFindingKind, FaultKind } from './types.js';

/** The fault kind each fault finding comes from. */
export const FINDING_FAULT_KIND: Readonly<Record<FaultFindingKind, FaultKind>> = {
  'hang-no-timeout': 'blackhole',
  'abort-mishandled': 'blackhole',
  'timeout-exceeds-budget': 'blackhole',
  'fire-and-forget': 'blackhole',
  'refusal-mishandled': 'connection-refused',
  'error-status-ignored': 'http-500',
  'error-status-mishandled': 'http-500',
  'malformed-json-mishandled': 'malformed-json',
};

export const FAULT_FINDING_KINDS = Object.keys(FINDING_FAULT_KIND) as readonly FaultFindingKind[];
