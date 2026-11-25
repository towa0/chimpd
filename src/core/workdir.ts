import fs from 'node:fs';
import path from 'node:path';

export const WORK_DIR_NAME = '.bruise';

/** Creates the one directory bruise may write to in a target, hidden from the target's git status. */
export function ensureWorkDir(targetRoot: string): string {
  const workDir = path.join(targetRoot, WORK_DIR_NAME);
  fs.mkdirSync(workDir, { recursive: true });
  const ignoreFile = path.join(workDir, '.gitignore');
  if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n');
  return workDir;
}

function removeLink(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch {
    // Windows removes a directory junction with rmdir; neither call follows the link.
    fs.rmdirSync(target);
  }
}

/** Deletes a directory tree without ever descending into a symlink or junction. */
export function removeTree(target: string): void {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (stat.isSymbolicLink()) {
    removeLink(target);
    return;
  }
  if (!stat.isDirectory()) {
    fs.rmSync(target, { force: true, maxRetries: 5, retryDelay: 50 });
    return;
  }
  for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry));
  fs.rmdirSync(target, { maxRetries: 5, retryDelay: 50 });
}
