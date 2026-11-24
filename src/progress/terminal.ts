import type { Palette } from '../terminal/color.js';
import type { ProgressListener } from './events.js';
import { applyEvent, INITIAL_STATE, phaseFooter, phaseHeader, renderStatus, type ProgressState } from './render.js';

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const CLEAR_LINE = '\u001b[2K';
const UP_ONE = '\u001b[1A';
const REDRAW_MS = 100;

/** What the progress display needs from the terminal; the CLI hands in stderr. */
export interface ProgressTerminal {
  write(text: string): void;
  columns(): number;
  /** Returns a function that stops listening. */
  onResize(listener: () => void): () => void;
  /** Runs `restore` when the process exits, is interrupted or is terminated; returns a function that stops that. */
  onExit(restore: () => void): () => void;
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ProgressDisplay {
  readonly listener: ProgressListener;
  /** Clears the status line and shows the cursor again; safe to call more than once. */
  stop(): void;
}

export function startProgress(terminal: ProgressTerminal, palette: Palette): ProgressDisplay {
  let state: ProgressState = INITIAL_STATE;
  let drawn = 0;
  let stopped = false;

  // A line drawn wider than the terminal now is, after a resize, has wrapped onto rows above the cursor.
  function clear(): string {
    const rows = drawn === 0 ? 1 : Math.ceil(drawn / Math.max(1, terminal.columns()));
    drawn = 0;
    return `\r${CLEAR_LINE}${`${UP_ONE}${CLEAR_LINE}`.repeat(rows - 1)}`;
  }

  function draw(): void {
    if (stopped) return;
    const line = renderStatus(state, { now: terminal.now(), columns: terminal.columns() });
    terminal.write(`${clear()}${line}`);
    drawn = line.length;
  }

  function restore(): void {
    if (stopped) return;
    stopped = true;
    terminal.write(`${clear()}${SHOW_CURSOR}`);
  }

  terminal.write(HIDE_CURSOR);
  const timer = terminal.setInterval(() => {
    if (state.phase !== null) draw();
  }, REDRAW_MS);
  const stopResize = terminal.onResize(() => {
    if (state.phase !== null) draw();
  });
  const stopExit = terminal.onExit(restore);

  return {
    listener(event) {
      if (stopped) return;
      if (event.type === 'phase-start') {
        terminal.write(`${clear()}${phaseHeader(event, palette)}\n`);
        state = applyEvent(state, event);
        draw();
      } else if (event.type === 'phase-end') {
        state = applyEvent(state, event);
        terminal.write(`${clear()}${phaseFooter(event, palette)}\n`);
      } else {
        state = applyEvent(state, event);
        draw();
      }
    },
    stop() {
      terminal.clearInterval(timer);
      stopResize();
      stopExit();
      restore();
    },
  };
}
