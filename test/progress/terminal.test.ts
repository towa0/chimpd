import { describe, expect, it } from 'vitest';
import { startProgress, type ProgressTerminal } from '../../src/progress/terminal.js';
import { PLAIN } from '../../src/terminal/theme.js';
import { recorded, RECORDED } from '../helpers/progress-events.js';

const HIDE = '\u001b[?25l';
const SHOW = '\u001b[?25h';
const CLEAR = '\u001b[2K';
const UP = '\u001b[1A';

interface FakeTty extends ProgressTerminal {
  output: string;
  columnsNow: number;
  time: number;
  tick(): void;
  resize(columns: number): void;
  exit(): void;
  readonly listening: { resize: number; exit: number; timers: number };
}

function fakeTty(columns = 80): FakeTty {
  let tickCallback: (() => void) | null = null;
  let resizeListener: (() => void) | null = null;
  let exitListener: (() => void) | null = null;
  const tty: FakeTty = {
    output: '',
    columnsNow: columns,
    time: 0,
    listening: { resize: 0, exit: 0, timers: 0 },
    write(text) {
      tty.output += text;
    },
    columns: () => tty.columnsNow,
    onResize(listener) {
      resizeListener = listener;
      tty.listening.resize += 1;
      return () => {
        resizeListener = null;
        tty.listening.resize -= 1;
      };
    },
    onExit(restore) {
      exitListener = restore;
      tty.listening.exit += 1;
      return () => {
        exitListener = null;
        tty.listening.exit -= 1;
      };
    },
    now: () => tty.time,
    setInterval(callback) {
      tickCallback = callback;
      tty.listening.timers += 1;
      return 1;
    },
    clearInterval() {
      tickCallback = null;
      tty.listening.timers -= 1;
    },
    tick: () => tickCallback?.(),
    resize(next) {
      tty.columnsNow = next;
      resizeListener?.();
    },
    exit: () => exitListener?.(),
  };
  return tty;
}

/** What the screen shows: each write after a carriage return or a clear replaces the line. */
function screen(output: string): string[] {
  const lines: string[] = [''];
  for (const part of output.replaceAll(HIDE, '').replaceAll(SHOW, '').split(/(\r|\n|\u001b\[2K|\u001b\[1A)/)) {
    if (part === '\n') lines.push('');
    else if (part === UP) lines.pop();
    else if (part === '\r' || part === CLEAR) lines[lines.length - 1] = '';
    else lines[lines.length - 1] += part;
  }
  return lines;
}

describe('progress display', () => {
  it('hides the cursor, draws headers, a status line redrawn in place and footers, and shows the cursor when it stops', () => {
    const tty = fakeTty();
    const display = startProgress(tty, PLAIN);
    expect(tty.output).toBe(HIDE);
    for (const event of RECORDED.slice(0, 4)) {
      tty.time = event.at;
      display.listener(event);
    }
    expect(screen(tty.output)).toEqual([
      '== Mutation phase, budget 84.0 s ==',
      '| [##########----------] 5/10 mutants  61.2 s / 84.0 s  src/live/statuses.ts',
    ]);
    tty.time = 80_000;
    display.listener(recorded(4));
    display.stop();
    expect(screen(tty.output)).toEqual(['== Mutation phase, budget 84.0 s ==', '   mutation completed in 80.0 s', '']);
    expect(tty.output.endsWith(SHOW)).toBe(true);
    expect(tty.listening).toEqual({ resize: 0, exit: 0, timers: 0 });
  });

  it('turns the spinner on its timer while a phase runs, and draws nothing on it between phases', () => {
    const tty = fakeTty();
    const display = startProgress(tty, PLAIN);
    tty.tick();
    expect(tty.output).toBe(HIDE);
    display.listener(recorded(0));
    tty.time = 100;
    tty.tick();
    expect(screen(tty.output).at(-1)).toBe('/ starting Stryker and its dry run  0.1 s / 84.0 s');
    display.stop();
  });

  it('restores the cursor and clears the line when the process exits or is interrupted, and only once', () => {
    const tty = fakeTty();
    const display = startProgress(tty, PLAIN);
    display.listener(recorded(0));
    tty.exit();
    expect(tty.output.endsWith(`\r${CLEAR}${SHOW}`)).toBe(true);
    const length = tty.output.length;
    display.listener(recorded(1));
    display.stop();
    expect(tty.output.length).toBe(length);
  });

  it('clears the rows a line wrapped onto when the terminal gets narrower, then fits the new width', () => {
    const tty = fakeTty(120);
    const display = startProgress(tty, PLAIN);
    for (const event of RECORDED.slice(0, 4)) {
      tty.time = event.at;
      display.listener(event);
    }
    const before = tty.output.length;
    // The 76-column line wraps onto two rows of a 40-column terminal, so the redraw goes up one row first.
    tty.resize(40);
    expect(tty.output.slice(before)).toBe(`\r${CLEAR}${UP}${CLEAR}| [###--] 5/10 mutants  61.2 s / 84.0 s`);
    display.stop();
  });
});
