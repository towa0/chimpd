export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export interface FileDiff {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly binary: boolean;
  readonly hunks: readonly Hunk[];
}

interface OpenFile {
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function headerPath(line: string, prefix: string): string | null {
  // Git appends a tab to header paths that contain spaces.
  const raw = line.slice(4).replace(/\t$/, '');
  if (raw === '/dev/null') return null;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
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
      current = { oldPath: null, newPath: null, binary: false, hunks: [] };
      files.push(current);
      continue;
    }
    if (current === undefined) continue;

    if (line.startsWith('rename from ')) current.oldPath = line.slice('rename from '.length);
    else if (line.startsWith('rename to ')) current.newPath = line.slice('rename to '.length);
    else if (line.startsWith('--- ')) current.oldPath = headerPath(line, 'a/');
    else if (line.startsWith('+++ ')) current.newPath = headerPath(line, 'b/');
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') current.binary = true;
    else {
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
