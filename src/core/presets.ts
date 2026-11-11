import type { FaultKind, Intensity, ScopeMode } from './types.js';

export const STRYKER_MUTATORS = [
  'ArithmeticOperator',
  'ArrayDeclaration',
  'ArrowFunction',
  'AssignmentOperator',
  'BlockStatement',
  'BooleanLiteral',
  'CallExpression',
  'ConditionalExpression',
  'EqualityOperator',
  'LogicalOperator',
  'MethodExpression',
  'ObjectLiteral',
  'OptionalChaining',
  'Regex',
  'StringLiteral',
  'UnaryOperator',
  'UpdateOperator',
] as const;

export type MutatorName = (typeof STRYKER_MUTATORS)[number];

const POKE_MUTATORS: readonly MutatorName[] = [
  'ConditionalExpression',
  'EqualityOperator',
  'LogicalOperator',
  'BooleanLiteral',
  'BlockStatement',
  'UnaryOperator',
];

const PROD_MUTATORS: readonly MutatorName[] = [
  ...POKE_MUTATORS,
  'ArithmeticOperator',
  'OptionalChaining',
  'MethodExpression',
  'UpdateOperator',
  'AssignmentOperator',
];

export interface Preset {
  readonly intensity: Intensity;
  readonly name: 'Poke' | 'Prod' | 'Shake';
  readonly budgetMs: number;
  readonly mutationShare: number;
  readonly scopeMode: ScopeMode;
  readonly testOnlyDepth: number;
  readonly testOnlyFileCap: number;
  readonly mutators: readonly MutatorName[];
  readonly maxBatches: number;
  readonly estimatedMutantsPerLine: number;
  readonly maxFaultedCallSites: number;
  readonly faultKinds: readonly FaultKind[];
  readonly testsPerCallSite: number;
  readonly findingsShown: number;
}

const MINUTE_MS = 60_000;

export const PRESETS: Readonly<Record<Intensity, Preset>> = {
  1: {
    intensity: 1,
    name: 'Poke',
    budgetMs: 2 * MINUTE_MS,
    mutationShare: 0.7,
    scopeMode: 'changed-lines',
    testOnlyDepth: 1,
    testOnlyFileCap: 10,
    mutators: POKE_MUTATORS,
    maxBatches: 1,
    estimatedMutantsPerLine: 1,
    maxFaultedCallSites: 3,
    faultKinds: ['blackhole'],
    testsPerCallSite: 1,
    findingsShown: 3,
  },
  2: {
    intensity: 2,
    name: 'Prod',
    budgetMs: 5 * MINUTE_MS,
    mutationShare: 0.7,
    scopeMode: 'enclosing-functions',
    testOnlyDepth: 2,
    testOnlyFileCap: 25,
    mutators: PROD_MUTATORS,
    maxBatches: 2,
    estimatedMutantsPerLine: 2,
    maxFaultedCallSites: 8,
    faultKinds: ['blackhole', 'http-500'],
    testsPerCallSite: 2,
    findingsShown: 5,
  },
  3: {
    intensity: 3,
    name: 'Shake',
    budgetMs: 10 * MINUTE_MS,
    mutationShare: 0.65,
    scopeMode: 'enclosing-functions',
    testOnlyDepth: 2,
    testOnlyFileCap: 50,
    mutators: STRYKER_MUTATORS,
    maxBatches: 3,
    estimatedMutantsPerLine: 3,
    maxFaultedCallSites: 20,
    faultKinds: ['blackhole', 'http-500', 'malformed-json', 'connection-refused'],
    testsPerCallSite: 3,
    findingsShown: 5,
  },
};

export function excludedMutators(preset: Preset): MutatorName[] {
  return STRYKER_MUTATORS.filter((name) => !preset.mutators.includes(name));
}

export interface StaticDecisionInput {
  readonly intensity: Intensity;
  readonly staticRegionLines: number;
  readonly fullSuiteMs: number;
  readonly mutationBudgetMs: number;
}

export interface StaticDecision {
  readonly ignoreStatic: boolean;
  readonly reason: string;
}

const MAX_STATIC_LINES = 20;
const STATIC_MUTANTS_PER_LINE = 3;
const STATIC_BUDGET_SHARE = 0.25;

export function decideIgnoreStatic(input: StaticDecisionInput): StaticDecision {
  if (input.intensity !== 3) {
    return { ignoreStatic: true, reason: `static mutants are only tested at ${PRESETS[3].name}` };
  }
  if (input.staticRegionLines > MAX_STATIC_LINES) {
    return {
      ignoreStatic: true,
      reason: `${input.staticRegionLines} static lines in scope exceed the limit of ${MAX_STATIC_LINES}`,
    };
  }
  const estimatedMs = input.staticRegionLines * STATIC_MUTANTS_PER_LINE * input.fullSuiteMs;
  const allowedMs = input.mutationBudgetMs * STATIC_BUDGET_SHARE;
  if (estimatedMs > allowedMs) {
    return {
      ignoreStatic: true,
      reason: `testing static mutants is estimated at ${Math.round(estimatedMs)} ms, over the ${Math.round(allowedMs)} ms allowed`,
    };
  }
  return { ignoreStatic: false, reason: 'static mutants fit the budget' };
}
