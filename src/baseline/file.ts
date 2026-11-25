import fs from 'node:fs';
import path from 'node:path';
import { FAULT_FINDING_KINDS, git, toPosix, type FaultFindingKind } from '../core/index.js';
import { BruiseError } from '../orchestrator/target.js';

export const BASELINE_FILE = 'bruise-baseline.json';
export const BASELINE_VERSION = 1;

export interface MutationEntry {
  readonly source: 'mutation';
  /** Path from the repository root, with forward slashes. */
  readonly file: string;
  readonly mutator: string;
  readonly replacement: string;
  /** Hash of the normalized source of the innermost statement around the mutant. */
  readonly statement: string;
  readonly reason: string | null;
}

export interface FaultEntry {
  readonly source: 'fault';
  readonly file: string;
  readonly function: string | null;
  readonly kind: FaultFindingKind;
  readonly reason: string | null;
}

export type BaselineEntry = MutationEntry | FaultEntry;

export interface Baseline {
  /** Absolute path of the baseline file at the repository root. */
  readonly path: string;
  /** The target directory relative to the repository root; empty at the root. */
  readonly prefix: string;
  readonly present: boolean;
  readonly entries: readonly BaselineEntry[];
}

export class BaselineError extends BruiseError {}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(entry: Json, key: string, where: string): string {
  const value = entry[key];
  if (typeof value !== 'string' || value === '') throw new BaselineError(`${where}: "${key}" must be a non-empty string`);
  return value;
}

function reasonOf(entry: Json, where: string): string | null {
  const value = entry.reason;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BaselineError(`${where}: "reason" must be a string or null`);
  return value.trim() === '' ? null : value;
}

function onlyKeys(entry: Json, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(entry).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new BaselineError(`${where}: unknown field ${unknown.map((key) => `"${key}"`).join(', ')}`);
}

function parseEntry(value: unknown, index: number, name: string): BaselineEntry {
  const where = `${name}: entry ${index + 1}`;
  if (!isObject(value)) throw new BaselineError(`${where} is not an object`);
  if (value.source === 'mutation') {
    onlyKeys(value, ['source', 'file', 'mutator', 'replacement', 'statement', 'reason'], where);
    const replacement = value.replacement;
    if (typeof replacement !== 'string') throw new BaselineError(`${where}: "replacement" must be a string`);
    return {
      source: 'mutation',
      file: text(value, 'file', where),
      mutator: text(value, 'mutator', where),
      replacement,
      statement: text(value, 'statement', where),
      reason: reasonOf(value, where),
    };
  }
  if (value.source === 'fault') {
    onlyKeys(value, ['source', 'file', 'function', 'kind', 'reason'], where);
    const fn = value.function;
    if (fn !== null && (typeof fn !== 'string' || fn === '')) throw new BaselineError(`${where}: "function" must be a non-empty string or null`);
    const kind = value.kind;
    if (typeof kind !== 'string' || !(FAULT_FINDING_KINDS as readonly string[]).includes(kind)) {
      throw new BaselineError(`${where}: "kind" must be one of ${FAULT_FINDING_KINDS.join(', ')}`);
    }
    return { source: 'fault', file: text(value, 'file', where), function: fn, kind: kind as FaultFindingKind, reason: reasonOf(value, where) };
  }
  throw new BaselineError(`${where}: "source" must be "mutation" or "fault"`);
}

/** Reads a baseline file's text; anything it cannot fully understand is an error, never skipped. */
export function parseBaseline(content: string, name: string = BASELINE_FILE): BaselineEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new BaselineError(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) throw new BaselineError(`${name} must hold a JSON object`);
  if (parsed.version !== BASELINE_VERSION) {
    throw new BaselineError(`${name} has version ${JSON.stringify(parsed.version)}; this version of bruise reads baseline version ${BASELINE_VERSION}`);
  }
  onlyKeys(parsed, ['version', 'entries'], name);
  if (!Array.isArray(parsed.entries)) throw new BaselineError(`${name}: "entries" must be an array`);
  return parsed.entries.map((entry, index) => parseEntry(entry, index, name));
}

export function entryKey(entry: BaselineEntry): string {
  return entry.source === 'mutation'
    ? JSON.stringify([entry.source, entry.file, entry.mutator, entry.replacement, entry.statement])
    : JSON.stringify([entry.source, entry.file, entry.function, entry.kind]);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function serializeBaseline(entries: readonly BaselineEntry[]): string {
  const ordered = entries.toSorted((a, b) => compareText(a.file, b.file) || compareText(entryKey(a), entryKey(b)));
  const written = ordered.map((entry) =>
    entry.source === 'mutation'
      ? { source: entry.source, file: entry.file, mutator: entry.mutator, replacement: entry.replacement, statement: entry.statement, reason: entry.reason }
      : { source: entry.source, file: entry.file, function: entry.function, kind: entry.kind, reason: entry.reason },
  );
  return `${JSON.stringify({ version: BASELINE_VERSION, entries: written }, null, 2)}\n`;
}

export async function repositoryRoot(targetRoot: string): Promise<string> {
  return path.resolve((await git(targetRoot, ['rev-parse', '--show-toplevel'])).trim());
}

export async function loadBaseline(targetRoot: string): Promise<Baseline> {
  const root = await repositoryRoot(targetRoot);
  const file = path.join(root, BASELINE_FILE);
  const prefix = toPosix(path.relative(fs.realpathSync.native(root), fs.realpathSync.native(targetRoot)));
  if (!fs.existsSync(file)) return { path: file, prefix, present: false, entries: [] };
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new BaselineError(`${BASELINE_FILE} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: file, prefix, present: true, entries: parseBaseline(content) };
}

/** The target-relative path of a repository-relative baseline path; null when it lies outside the target. */
export function targetPath(prefix: string, file: string): string | null {
  if (prefix === '') return file;
  return file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : null;
}

export function repositoryPath(prefix: string, file: string): string {
  return prefix === '' ? file : `${prefix}/${file}`;
}
