import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  git,
  isDeclarationFile,
  isTestFile,
  isTypeScriptFile,
  mergeBase,
  resolveSha,
  type ScopeKind,
  type ScopeRange,
} from '../core/index.js';
import { parseUnifiedDiff, type FileDiff, type Hunk } from './parse-diff.js';
import { analyzeSource, type LineSpan, type SourceShape } from './source-shape.js';

export { parseUnifiedDiff } from './parse-diff.js';
export type { FileDiff, Hunk } from './parse-diff.js';

export type ScopeMode = 'changed-lines' | 'enclosing-functions';

export interface DiffScopeOptions {
  readonly repoRoot: string;
  readonly mode: ScopeMode;
  readonly base?: string;
  readonly ignoreWhitespace?: boolean;
}

export type IgnoredReason = 'not-typescript' | 'declaration-file' | 'deleted' | 'binary';

export interface IgnoredFile {
  readonly file: string;
  readonly reason: IgnoredReason;
}

export interface ScopeNote {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface DiffScope {
  readonly base: string;
  readonly mergeBase: string;
  readonly head: string;
  readonly ranges: readonly ScopeRange[];
  readonly changedSourceFiles: readonly string[];
  readonly changedTestFiles: readonly string[];
  readonly ignoredFiles: readonly IgnoredFile[];
  readonly notes: readonly ScopeNote[];
}

export const DEFAULT_BASE = 'origin/main';

const KIND_ORDER: Record<ScopeKind, number> = { changed: 0, 'enclosing-function': 1, 'deletion-expanded': 2 };

function compareRanges(a: ScopeRange, b: ScopeRange): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.startLine - b.startLine || a.endLine - b.endLine || KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
}

function rangeKey(range: ScopeRange): string {
  return `${range.file}:${range.startLine}:${range.endLine}:${range.kind}:${range.staticRegion}`;
}

function lineRange(file: string, span: LineSpan, kind: ScopeKind, staticRegion: boolean): ScopeRange {
  return { file, startLine: span.startLine, endLine: span.endLine, kind, staticRegion };
}

function changedRanges(file: string, hunk: Hunk, shape: SourceShape): ScopeRange[] {
  const ranges: ScopeRange[] = [];
  const last = Math.min(hunk.newStart + hunk.newLines - 1, shape.lineCount);
  let runStart = hunk.newStart;
  for (let line = hunk.newStart; line <= last; line += 1) {
    const staticRegion = shape.isStaticLine(line);
    if (line === last || shape.isStaticLine(line + 1) !== staticRegion) {
      ranges.push({ file, startLine: runStart, endLine: line, kind: 'changed', staticRegion });
      runStart = line + 1;
    }
  }
  return ranges;
}

function expandedRanges(file: string, hunk: Hunk, shape: SourceShape): ScopeRange[] {
  const spans = new Map<string, LineSpan>();
  const last = Math.min(hunk.newStart + hunk.newLines - 1, shape.lineCount);
  for (let line = hunk.newStart; line <= last; line += 1) {
    const span = shape.enclosingFunction(line);
    if (span !== null) spans.set(`${span.startLine}:${span.endLine}`, span);
  }
  return [...spans.values()].map((span) => lineRange(file, span, 'enclosing-function', false));
}

function deletionRange(file: string, hunk: Hunk, shape: SourceShape): ScopeRange | ScopeNote {
  const enclosing = shape.functionAroundGapAfter(hunk.newStart);
  if (enclosing !== null) {
    return lineRange(file, enclosing, 'deletion-expanded', false);
  }
  const statement = shape.statementForGapAfter(hunk.newStart);
  if (statement !== null) {
    return lineRange(file, statement, 'deletion-expanded', true);
  }
  return { file, line: Math.max(hunk.newStart, 1), message: 'deleted top-level code, nothing to mutate' };
}

function scopeFile(file: string, diff: FileDiff, shape: SourceShape, mode: ScopeMode) {
  const ranges: ScopeRange[] = [];
  const notes: ScopeNote[] = [];
  for (const hunk of diff.hunks) {
    if (hunk.newLines === 0) {
      const result = deletionRange(file, hunk, shape);
      if ('kind' in result) ranges.push(result);
      else notes.push(result);
      continue;
    }
    ranges.push(...changedRanges(file, hunk, shape));
    if (mode === 'enclosing-functions') ranges.push(...expandedRanges(file, hunk, shape));
  }
  return { ranges, notes };
}

function ignoredReason(diff: FileDiff, file: string): IgnoredReason | null {
  if (diff.newPath === null) return 'deleted';
  if (diff.binary) return 'binary';
  if (!isTypeScriptFile(file)) return 'not-typescript';
  if (isDeclarationFile(file)) return 'declaration-file';
  return null;
}

export async function scopeDiff(options: DiffScopeOptions): Promise<DiffScope> {
  const { repoRoot, mode } = options;
  const base = options.base ?? DEFAULT_BASE;
  const mergeBaseSha = await mergeBase(repoRoot, base);
  const head = await resolveSha(repoRoot, 'HEAD');

  const diffArgs = ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--relative'];
  if (options.ignoreWhitespace ?? true) diffArgs.push('-w');
  diffArgs.push('--src-prefix=a/', '--dst-prefix=b/', mergeBaseSha, '--');
  const files = parseUnifiedDiff(await git(repoRoot, diffArgs));

  const ranges = new Map<string, ScopeRange>();
  const notes: ScopeNote[] = [];
  const changedSourceFiles: string[] = [];
  const changedTestFiles: string[] = [];
  const ignoredFiles: IgnoredFile[] = [];

  for (const diff of files) {
    const file = diff.newPath ?? diff.oldPath;
    if (file === null || (diff.hunks.length === 0 && !diff.binary && diff.newPath !== null)) continue;
    const reason = ignoredReason(diff, file);
    if (reason !== null) {
      ignoredFiles.push({ file, reason });
      continue;
    }
    if (isTestFile(file)) {
      changedTestFiles.push(file);
      continue;
    }
    changedSourceFiles.push(file);
    const shape = analyzeSource(file, await readFile(path.join(repoRoot, file), 'utf8'));
    const scoped = scopeFile(file, diff, shape, mode);
    for (const range of scoped.ranges) ranges.set(rangeKey(range), range);
    notes.push(...scoped.notes);
  }

  return {
    base,
    mergeBase: mergeBaseSha,
    head,
    ranges: [...ranges.values()].sort(compareRanges),
    changedSourceFiles: changedSourceFiles.sort(),
    changedTestFiles: changedTestFiles.sort(),
    ignoredFiles: ignoredFiles.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
    notes: notes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)),
  };
}
