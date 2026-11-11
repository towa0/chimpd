import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface CheckerDecision {
  readonly enabled: boolean;
  readonly reason: string | null;
  /** Version of the typescript copy the checker would load, when it can be resolved. */
  readonly typescriptVersion: string | null;
  readonly typescriptPath: string | null;
}

const require = createRequire(import.meta.url);

function readVersion(manifestPath: string): string {
  return (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version: string }).version;
}

export function strykerVersion(): string {
  return readVersion(require.resolve('@stryker-mutator/core/package.json'));
}

/**
 * The checker imports `typescript` as a bare specifier, so it loads whichever copy resolves
 * from its own install location. That copy must still have the classic compiler API.
 */
export function resolveCheckerTypeScript(): { version: string; path: string } | null {
  try {
    const checkerEntry = require.resolve('@stryker-mutator/typescript-checker');
    const manifest = createRequire(checkerEntry).resolve('typescript/package.json');
    return { version: readVersion(manifest), path: path.dirname(manifest) };
  } catch {
    return null;
  }
}

export function decideChecker(
  targetRoot: string,
  resolved: { version: string; path: string } | null = resolveCheckerTypeScript(),
  tsconfigFile = 'tsconfig.json',
): CheckerDecision {
  const typescriptVersion = resolved?.version ?? null;
  const typescriptPath = resolved?.path ?? null;
  const disabled = (reason: string): CheckerDecision => ({
    enabled: false,
    reason,
    typescriptVersion,
    typescriptPath,
  });

  if (resolved === null) return disabled('type checker disabled: typescript could not be resolved');
  const major = Number(resolved.version.split('.')[0]);
  if (!(major < 7)) return disabled(`type checker disabled: target uses TypeScript ${major}`);
  if (!fs.existsSync(path.join(targetRoot, tsconfigFile))) {
    return disabled(`type checker disabled: ${tsconfigFile} not found`);
  }
  return { enabled: true, reason: null, typescriptVersion, typescriptPath };
}
