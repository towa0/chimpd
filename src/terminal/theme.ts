import type { SeverityLevel } from '../severity/index.js';

export type Paint = (text: string) => string;

/** Semantic colour roles for terminal output, in the 16 basic ANSI colours so terminal themes keep contrast. */
export interface Theme {
  readonly enabled: boolean;
  readonly bold: Paint;
  /** Secondary text, borders and reasons. */
  readonly dim: Paint;
  /** The name, findings and surviving mutants. */
  readonly brand: Paint;
  /** The header and section titles. */
  readonly title: Paint;
  /** Killed, handled, completed. */
  readonly good: Paint;
  /** Partial, not tested, excluded, inconclusive. */
  readonly warning: Paint;
  /** Exit 2, a tool error or a failed phase. */
  readonly error: Paint;
  readonly severity: Readonly<Record<SeverityLevel, Paint>>;
  readonly barFill: Paint;
  readonly barTrack: Paint;
  readonly spinner: Paint;
}

const ESC = '\u001b[';

function sgr(open: number, close: number): Paint {
  return (text) => (text === '' ? text : `${ESC}${open}m${text}${ESC}${close}m`);
}

function both(outer: Paint, inner: Paint): Paint {
  return (text) => outer(inner(text));
}

const BOLD = sgr(1, 22);
const DIM = sgr(2, 22);
const RED = sgr(31, 39);
const GREEN = sgr(32, 39);
const YELLOW = sgr(33, 39);
const BLUE = sgr(34, 39);
const MAGENTA = sgr(35, 39);

export const THEMED: Theme = {
  enabled: true,
  bold: BOLD,
  dim: DIM,
  brand: MAGENTA,
  title: both(BOLD, MAGENTA),
  good: GREEN,
  warning: YELLOW,
  error: RED,
  severity: { high: both(BOLD, MAGENTA), medium: BLUE, low: YELLOW },
  barFill: MAGENTA,
  barTrack: DIM,
  spinner: MAGENTA,
};

const none: Paint = (text) => text;

export const PLAIN: Theme = {
  enabled: false,
  bold: none,
  dim: none,
  brand: none,
  title: none,
  good: none,
  warning: none,
  error: none,
  severity: { high: none, medium: none, low: none },
  barFill: none,
  barTrack: none,
  spinner: none,
};

export function themeFor(enabled: boolean): Theme {
  return enabled ? THEMED : PLAIN;
}
