import type { FaultFindingKind, FaultKind } from './types.js';

/** The fault kind each fault finding comes from. */
export const FINDING_FAULT_KIND: Readonly<Record<FaultFindingKind, FaultKind>> = {
  'hang-no-timeout': 'blackhole',
  'abort-mishandled': 'blackhole',
  'fire-and-forget': 'blackhole',
  'refusal-mishandled': 'connection-refused',
  'error-status-ignored': 'http-500',
  'error-status-mishandled': 'http-500',
  'malformed-json-mishandled': 'malformed-json',
};

/** How a function is named among the changed code a call site was reached through: "file function", or "file:line" when it has no name. */
export function functionLabel(file: string, line: number, functionName: string | null): string {
  return functionName === null ? `${file}:${line}` : `${file} ${functionName}`;
}

/** The changed functions a site was reached through other than its own, which the site's location already names. */
export function otherCallers(
  reachedFrom: readonly string[],
  site: { readonly file: string; readonly line: number; readonly functionName: string | null },
): string[] {
  const own = functionLabel(site.file, site.line, site.functionName);
  return reachedFrom.filter((caller) => caller !== own);
}

export const FAULT_FINDING_KINDS = Object.keys(FINDING_FAULT_KIND) as readonly FaultFindingKind[];
