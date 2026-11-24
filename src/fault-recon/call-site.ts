import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestFile, rangeForLine, toPosix, WORK_DIR_NAME, type ScopeRange } from '../core/index.js';

export interface StackFrame {
  /** Absolute path with forward slashes. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly functionName: string | null;
}

export interface ProjectFrame {
  /** Repo-relative path with forward slashes. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly functionName: string | null;
}

const FRAME = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

function frameFile(location: string): string | null {
  const withoutQuery = location.replace(/\?.*$/, '');
  if (withoutQuery.startsWith('file://')) return toPosix(fileURLToPath(withoutQuery));
  return path.isAbsolute(withoutQuery) ? toPosix(withoutQuery) : null;
}

export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    const match = FRAME.exec(line);
    if (match === null) continue;
    const file = frameFile(match[2] ?? '');
    if (file === null) continue;
    frames.push({
      file,
      line: Number(match[3]),
      column: Number(match[4]),
      functionName: match[1] ?? null,
    });
  }
  return frames;
}

function isProjectFile(relative: string): boolean {
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const segments = relative.split('/');
  if (segments.includes('node_modules') || segments[0] === WORK_DIR_NAME) return false;
  return !isTestFile(relative);
}

/** The frames in the target's own source files, innermost first. */
export function projectFrames(frames: readonly StackFrame[], targetRoot: string): ProjectFrame[] {
  const result: ProjectFrame[] = [];
  for (const frame of frames) {
    const file = toPosix(path.relative(targetRoot, frame.file));
    if (isProjectFile(file)) result.push({ ...frame, file });
  }
  return result;
}

export function callSiteKey(frame: ProjectFrame): string {
  return `${frame.file}:${frame.line}:${frame.column}`;
}

export interface ScopedFrame {
  readonly frame: ProjectFrame;
  readonly range: ScopeRange;
}

/** The innermost project frame that lies in a scope range: a call is in scope when changed code is anywhere on its stack. */
export function scopedFrame(frames: readonly ProjectFrame[], ranges: readonly ScopeRange[]): ScopedFrame | null {
  for (const frame of frames) {
    const range = rangeForLine(ranges, frame.file, frame.line);
    if (range !== null) return { frame, range };
  }
  return null;
}

/** Whether a call is the one a faulted run targets: made at the site, and through code in scope. */
export function targetsSite(stack: string, mode: { readonly targetRoot: string; readonly siteKey: string; readonly ranges: readonly ScopeRange[] }): boolean {
  const frames = projectFrames(parseStack(stack), mode.targetRoot);
  const innermost = frames[0];
  return innermost !== undefined && callSiteKey(innermost) === mode.siteKey && scopedFrame(frames, mode.ranges) !== null;
}
