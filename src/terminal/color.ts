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

const SGR = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** The text as it shows on screen: escape sequences take no columns. */
export function visibleLength(text: string): number {
  return text.replace(SGR, '').length;
}

export function stripAnsi(text: string): string {
  return text.replace(SGR, '');
}
