const ERROR_PREFIX = /^(?:[A-Za-z]*Error:\s*)+/;

/** The first non-empty line of an error text, without the error-class prefixes that wrapping repeats. */
export function firstErrorLine(text: string | null): string | null {
  const line = (text ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '');
  if (line === undefined) return null;
  const stripped = line.replace(ERROR_PREFIX, '').trim();
  return stripped === '' ? line : stripped;
}
