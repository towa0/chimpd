import { expect, it } from 'vitest';
import compat from '../../vitest.compat.config.js';
import main from '../../vitest.config.js';

interface TestOptions {
  readonly dangerouslyIgnoreUnhandledErrors?: unknown;
  readonly projects?: readonly { readonly test?: TestOptions }[];
}

function ignoring(options: TestOptions | undefined): unknown[] {
  if (options === undefined) return [];
  const own = options.dangerouslyIgnoreUnhandledErrors === undefined ? [] : [options.dangerouslyIgnoreUnhandledErrors];
  return [...own, ...(options.projects ?? []).flatMap((project) => ignoring(project.test))];
}

it('lets an unhandled rejection fail every test run', () => {
  expect(ignoring((main as { test?: TestOptions }).test)).toEqual([]);
  expect(ignoring((compat as { test?: TestOptions }).test)).toEqual([]);
});
