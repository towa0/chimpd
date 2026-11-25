import type { Env } from './color.js';
import type { Theme } from './theme.js';

export const TAGLINE = 'find the soft spots in your tests';

export interface HeaderConditions {
  readonly stderrIsTTY: boolean;
  readonly json: boolean;
  /** False with --no-banner. */
  readonly banner: boolean;
  readonly env: Env;
}

/** Shown on an interactive stderr only: never in CI, with --json or with --no-banner. */
export function showHeader(conditions: HeaderConditions): boolean {
  const ci = conditions.env.CI;
  return conditions.stderrIsTTY && !conditions.json && conditions.banner && (ci === undefined || ci === '');
}

export function renderHeader(version: string, theme: Theme): string {
  return `${theme.title(`bruise ${version}`)}  ${theme.dim(TAGLINE)}\n\n`;
}
