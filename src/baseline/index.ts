export { applyIgnores } from './apply.js';
export type { IgnoreInput, IgnoreOutcome } from './apply.js';
export {
  BASELINE_FILE,
  BASELINE_VERSION,
  BaselineError,
  entryKey,
  loadBaseline,
  parseBaseline,
  repositoryPath,
  serializeBaseline,
  targetPath,
} from './file.js';
export type { Baseline, BaselineEntry, FaultEntry, MutationEntry } from './file.js';
export { SourceStatements } from './statement.js';
export type { IgnoreDirective, StatementInfo } from './statement.js';
