export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export type EntryType = 'file' | 'symlink' | 'submodule';

export interface FileDiff {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly binary: boolean;
  readonly entryType: EntryType;
  readonly hunks: readonly Hunk[];
}

interface OpenFile {
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  entryType: EntryType;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const MODE_LINE = /^(?:new file mode|deleted file mode|new mode|index [0-9a-f]+\.\.[0-9a-f]+) (\d{6})$/;

const SIMPLE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

// Git wraps a path in double quotes and escapes bytes when it contains quotes, backslashes, or control characters.
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const next = body.charAt(index + 1);
    bytes.push(SIMPLE_ESCAPES[next] ?? next.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

function headerPath(line: string, prefix: string): string | null {
  // Git appends a tab to header paths that contain spaces.
  const raw = unquoteGitPath(line.slice(4).replace(/\t$/, ''));
  if (raw === '/dev/null') return null;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function entryTypeOf(mode: string): EntryType | null {
  if (mode === '160000') return 'submodule';
  if (mode === '120000') return 'symlink';
  return null;
}

export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: OpenFile[] = [];
  let current: OpenFile | undefined;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of diff.split('\n')) {
    // Hunk bodies are consumed by count: a removed line such as "-- note" prints as "--- note".
    if (oldRemaining > 0 || newRemaining > 0) {
      if (line.startsWith('-')) oldRemaining -= 1;
      else if (line.startsWith('+')) newRemaining -= 1;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      current = { oldPath: null, newPath: null, binary: false, entryType: 'file', hunks: [] };
      files.push(current);
      continue;
    }
    if (current === undefined) continue;

    const mode = MODE_LINE.exec(line);
    if (mode !== null) {
      current.entryType = entryTypeOf(mode[1] ?? '') ?? current.entryType;
    } else if (line.startsWith('rename from ')) {
      current.oldPath = unquoteGitPath(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      current.newPath = unquoteGitPath(line.slice('rename to '.length));
    } else if (line.startsWith('--- ')) {
      current.oldPath = headerPath(line, 'a/');
    } else if (line.startsWith('+++ ')) {
      current.newPath = headerPath(line, 'b/');
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      current.binary = true;
    } else {
      const match = HUNK_HEADER.exec(line);
      if (match === null) continue;
      const hunk: Hunk = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
      };
      current.hunks.push(hunk);
      oldRemaining = hunk.oldLines;
      newRemaining = hunk.newLines;
    }
  }
  return files;
}
