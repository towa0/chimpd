import type { PhaseName } from '../orchestrator/types.js';
import type { Palette } from '../terminal/color.js';
import type { ProgressEvent } from './events.js';

export interface ProgressState {
  readonly phase: PhaseName | null;
  readonly startedAt: number;
  readonly budgetMs: number;
  readonly done: number;
  readonly total: number | null;
  readonly current: string | null;
}

export const INITIAL_STATE: ProgressState = { phase: null, startedAt: 0, budgetMs: 0, done: 0, total: null, current: null };

export function applyEvent(state: ProgressState, event: ProgressEvent): ProgressState {
  switch (event.type) {
    case 'phase-start':
      return { phase: event.phase, startedAt: event.at, budgetMs: event.budgetMs, done: 0, total: null, current: null };
    case 'mutant-tested':
      return { ...state, done: event.tested, total: event.total, current: event.file };
    case 'site-faulted':
      return { ...state, done: event.done, total: event.total, current: `${event.file}:${event.line} (${event.kind})` };
    case 'phase-end':
      return { ...INITIAL_STATE };
  }
}

const SPINNER = ['|', '/', '-', '\\'];
const SPINNER_STEP_MS = 100;
const PHASE_TITLES: Readonly<Record<PhaseName, string>> = { mutation: 'Mutation phase', faults: 'Fault phase' };

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/** The line printed once when a phase starts, above the live status line. */
export function phaseHeader(event: Extract<ProgressEvent, { type: 'phase-start' }>, palette: Palette): string {
  return palette.bold(`== ${PHASE_TITLES[event.phase]}, budget ${seconds(event.budgetMs)} ==`);
}

/** The line printed once when a phase ends, in place of its status line. */
export function phaseFooter(event: Extract<ProgressEvent, { type: 'phase-end' }>, palette: Palette): string {
  const paint = event.status === 'completed' ? palette.green : event.status === 'error' ? palette.red : palette.yellow;
  return `   ${event.phase} ${paint(event.status)} in ${seconds(event.spentMs)}`;
}

function waitingLabel(state: ProgressState): string {
  if (state.phase === 'mutation') return 'starting Stryker and its dry run';
  return 'discovering call sites';
}

function bar(done: number, total: number, width: number): string {
  const filled = total === 0 ? width : Math.min(width, Math.round((done / total) * width));
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

/** Cuts text to the width from the left, so the end of a path, the part that tells files apart, stays. */
function fitLeft(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  return width <= 3 ? text.slice(-width) : `...${text.slice(-(width - 3))}`;
}

export interface Frame {
  readonly now: number;
  /** Columns of the terminal; the line always stays at least one column short of it, so it never wraps. */
  readonly columns: number;
}

/** The live status line, in plain ASCII, as a pure function of the state, the clock and the terminal width. */
export function renderStatus(state: ProgressState, frame: Frame): string {
  if (state.phase === null) return '';
  const max = Math.max(1, frame.columns - 1);
  const spinner = SPINNER[Math.floor(Math.max(0, frame.now - state.startedAt) / SPINNER_STEP_MS) % SPINNER.length] ?? '|';
  const unit = state.phase === 'mutation' ? 'mutants' : 'runs';
  const time = `${seconds(frame.now - state.startedAt)} / ${seconds(state.budgetMs)}`;
  const counted = state.done > 0 || state.total !== null;
  const count = counted ? `${state.done}/${state.total ?? '?'} ${unit}` : waitingLabel(state);
  const essentials = `${spinner} ${count}  ${time}`;
  if (essentials.length > max) return `${spinner} ${count}`.slice(0, max);
  let line = essentials;
  const barWidth = Math.min(20, max - essentials.length - 3);
  if (counted && state.total !== null && barWidth >= 5) line = `${spinner} ${bar(state.done, state.total, barWidth)} ${count}  ${time}`;
  const room = max - line.length - 2;
  if (state.current !== null && room >= 8) line = `${line}  ${fitLeft(state.current, room)}`;
  return line;
}
