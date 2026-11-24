export type Env = Readonly<Record<string, string | undefined>>;

export interface ColorDecision {
  /** --color is true, --no-color is false; undefined without either flag. */
  readonly flag: boolean | undefined;
  readonly env: Env;
  readonly isTTY: boolean;
}

/** Flags first, then FORCE_COLOR, then NO_COLOR and a dumb terminal; otherwise colour only on a TTY. */
export function colorEnabled({ flag, env, isTTY }: ColorDecision): boolean {
  if (flag !== undefined) return flag;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '') return force !== '0' && force !== 'false';
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return isTTY;
}

export interface Palette {
  readonly enabled: boolean;
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly red: (text: string) => string;
  readonly green: (text: string) => string;
  readonly yellow: (text: string) => string;
  /** For what needs the reader's attention, such as a surviving mutant or a finding. */
  readonly highlight: (text: string) => string;
}

const ESC = '\u001b[';

function wrap(open: string, close: string): (text: string) => string {
  return (text) => (text === '' ? text : `${ESC}${open}m${text}${ESC}${close}m`);
}

export const PLAIN: Palette = {
  enabled: false,
  bold: (text) => text,
  dim: (text) => text,
  red: (text) => text,
  green: (text) => text,
  yellow: (text) => text,
  highlight: (text) => text,
};

export const COLORS: Palette = {
  enabled: true,
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  highlight: (text) => wrap('1', '22')(wrap('31', '39')(text)),
};

export function paletteFor(enabled: boolean): Palette {
  return enabled ? COLORS : PLAIN;
}

const SGR = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** The text as it shows on screen: escape sequences take no columns. */
export function visibleLength(text: string): number {
  return text.replace(SGR, '').length;
}

export function stripAnsi(text: string): string {
  return text.replace(SGR, '');
}
