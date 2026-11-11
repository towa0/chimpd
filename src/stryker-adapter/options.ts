import { excludedMutators, WORK_DIR_NAME, type Preset } from '../core/index.js';
import { mutatePatterns, type Batch } from './batches.js';
import { STREAM_REPORTER, type StrykerOptions } from './worker.js';

export const STRYKER_TEMP_DIR = `${WORK_DIR_NAME}/stryker-tmp`;

export interface OptionsInput {
  readonly batch: Batch;
  readonly preset: Preset;
  readonly ignoreStatic: boolean;
  readonly checkerEnabled: boolean;
  readonly pluginPath: string;
  readonly concurrency?: number;
  readonly vitestConfigFile?: string;
}

type LogLevel = NonNullable<StrykerOptions['logLevel']>;

// Stryker types the level as an enum that only its api package exports; the value is this string.
const LOG_OFF = 'off' as LogLevel;

export function buildStrykerOptions(input: OptionsInput): StrykerOptions {
  return {
    mutate: mutatePatterns(input.batch),
    mutator: { excludedMutations: excludedMutators(input.preset) },
    testRunner: 'vitest',
    ...(input.vitestConfigFile === undefined ? {} : { vitest: { configFile: input.vitestConfigFile } }),
    checkers: input.checkerEnabled ? ['typescript'] : [],
    coverageAnalysis: 'perTest',
    ignoreStatic: input.ignoreStatic,
    reporters: [STREAM_REPORTER],
    appendPlugins: [input.pluginPath],
    tempDirName: STRYKER_TEMP_DIR,
    cleanTempDir: 'always',
    ignorePatterns: [WORK_DIR_NAME],
    incremental: false,
    logLevel: LOG_OFF,
    fileLogLevel: LOG_OFF,
    allowConsoleColors: false,
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
  };
}
