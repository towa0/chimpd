const SENSITIVE_TERMS = [
  'auth',
  'authentication',
  'authorization',
  'authorize',
  'token',
  'session',
  'permission',
  'password',
  'pay',
  'charge',
  'refund',
  'price',
  'amount',
  'balance',
  'invoice',
];

const STORAGE_TERMS = ['db', 'repo', 'repository', 'save', 'insert', 'update', 'delete', 'migrate'];

const SUFFIXES = ['', 's', 'es', 'ing', 'ed', 'ment', 'ments'];

export const SENSITIVE_PRIOR = 15;
export const STORAGE_PRIOR = 10;

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter((token) => token !== '')
    .map((token) => token.toLowerCase());
}

function matchesAny(tokens: readonly string[], terms: readonly string[]): boolean {
  return tokens.some((token) => terms.some((term) => SUFFIXES.some((suffix) => token === term + suffix)));
}

export function priorOf(...names: readonly string[]): number {
  const tokens = names.flatMap(tokenize);
  return (
    (matchesAny(tokens, SENSITIVE_TERMS) ? SENSITIVE_PRIOR : 0) + (matchesAny(tokens, STORAGE_TERMS) ? STORAGE_PRIOR : 0)
  );
}
