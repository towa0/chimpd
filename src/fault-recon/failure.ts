import path from 'node:path';
import { isTestFile, toPosix, WORK_DIR_NAME, type FailureEvidence } from '../core/index.js';
import { parseStack } from './call-site.js';

const MAX_CAUSE_DEPTH = 5;
const MAX_ERROR_LENGTH = 200;

type Origin = 'project' | 'test' | 'other';

interface Raised {
  readonly origin: Origin;
  readonly at: string | null;
}

function raisedBy(error: object, targetRoot: string): Raised {
  const { stack } = error as { stack?: unknown };
  if (typeof stack !== 'string') return { origin: 'other', at: null };
  const frame = parseStack(stack)[0];
  if (frame === undefined) return { origin: 'other', at: null };
  const file = toPosix(path.relative(targetRoot, frame.file));
  if (file === '' || file.startsWith('..') || path.isAbsolute(file)) return { origin: 'other', at: null };
  const segments = file.split('/');
  if (segments.includes('node_modules') || segments[0] === WORK_DIR_NAME) return { origin: 'other', at: null };
  return isTestFile(file) ? { origin: 'test', at: null } : { origin: 'project', at: `${file}:${frame.line}` };
}

export function errorLine(error: unknown): string {
  const { name, message } = typeof error === 'object' && error !== null ? (error as { name?: unknown; message?: unknown }) : {};
  const text = typeof message === 'string' ? `${typeof name === 'string' ? name : 'Error'}: ${message}` : String(error);
  const line = text.split('\n').find((entry) => entry.trim() !== '')?.trim() ?? text;
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 3)}...` : line;
}

export interface TracedFailure {
  readonly evidence: FailureEvidence;
  /** The fault's own error the failure led back to; set for fault-escaped only. */
  readonly faultError: object | null;
}

/**
 * Judges a failure by its error: the fault's own error, or one wrapping it that no project or test code
 * raised, escaped; an error project code or the test raised says the fault was dealt with before it.
 */
export function traceFailure(
  error: unknown,
  via: FailureEvidence['via'],
  targetRoot: string,
  isFaultError: (value: object) => boolean,
): TracedFailure {
  const evidence = { via, error: errorLine(error), raisedAt: null };
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) break;
    if (isFaultError(current)) return { evidence: { ...evidence, kind: 'fault-escaped' }, faultError: current };
    if ((current as { name?: unknown }).name === 'AssertionError') return { evidence: { ...evidence, kind: 'raised-by-test' }, faultError: null };
    const raised = raisedBy(current, targetRoot);
    if (raised.origin === 'project') return { evidence: { ...evidence, kind: 'raised-by-project', raisedAt: raised.at }, faultError: null };
    if (raised.origin === 'test') return { evidence: { ...evidence, kind: 'raised-by-test' }, faultError: null };
    current = (current as { cause?: unknown }).cause;
  }
  return { evidence: { ...evidence, kind: 'unattributed' }, faultError: null };
}
