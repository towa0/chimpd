import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { isDeclarationFile, isTestFile, isTypeScriptFile, toPosix } from '../core/index.js';

export interface ModuleInfo {
  /** Absolute paths of the modules this file imports at run time, type-only imports left out. */
  readonly imports: readonly string[];
  /** Absolute paths of the modules this file replaces with `vi.mock` or `vi.doMock`. */
  readonly mocks: readonly string[];
  /** True when the module does nothing but re-export from other modules. */
  readonly isBarrel: boolean;
}

export interface ModuleGraph {
  readonly sourceRoot: string;
  info(file: string): ModuleInfo;
  /** First-party source: under the source root, TypeScript, not a test, declaration, or build output. */
  isSource(file: string): boolean;
  relative(file: string): string;
}

const FALLBACK_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function loadCompilerOptions(targetRoot: string, tsconfigFile: string): { options: ts.CompilerOptions; configDir: string } {
  const configPath = path.resolve(targetRoot, tsconfigFile);
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configPath)) return { options: FALLBACK_OPTIONS, configDir: targetRoot };
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, configDir, undefined, configPath);
  return { options: parsed.options, configDir };
}

function allTypeOnly(elements: readonly { readonly isTypeOnly: boolean }[]): boolean {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings) && allTypeOnly(bindings.elements);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return clause !== undefined && ts.isNamedExports(clause) && allTypeOnly(clause.elements);
}

function isDynamicImport(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function literalArgument(call: ts.CallExpression): string | null {
  const [argument] = call.arguments;
  return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : null;
}

function mockedSpecifier(node: ts.Node): string | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const { expression: owner, name } = node.expression;
  if (!ts.isIdentifier(owner) || owner.text !== 'vi' || !['mock', 'doMock'].includes(name.text)) return null;
  const [argument] = node.arguments;
  // Vitest also accepts `vi.mock(import('./module.js'))`.
  if (argument !== undefined && isDynamicImport(argument)) return literalArgument(argument);
  return literalArgument(node);
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

export function createModuleGraph(targetRoot: string, tsconfigFile = 'tsconfig.json'): ModuleGraph {
  const root = path.resolve(targetRoot);
  const { options, configDir } = loadCompilerOptions(root, tsconfigFile);
  const sourceRoot = path.resolve(options.rootDir ?? configDir);
  const outDir = options.outDir === undefined ? null : path.resolve(options.outDir);
  const resolutionCache = ts.createModuleResolutionCache(root, (file) => file, options);
  const infos = new Map<string, ModuleInfo>();

  function resolve(specifier: string, containingFile: string): string | null {
    const { resolvedModule } = ts.resolveModuleName(specifier, containingFile, options, ts.sys, resolutionCache);
    if (resolvedModule === undefined || resolvedModule.isExternalLibraryImport === true) return null;
    return path.resolve(resolvedModule.resolvedFileName);
  }

  function analyze(file: string): ModuleInfo {
    const text = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
    const imports = new Set<string>();
    const mocks = new Set<string>();
    const add = (target: Set<string>, specifier: string | null): void => {
      const resolved = specifier === null ? null : resolve(specifier, file);
      if (resolved !== null) target.add(resolved);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        if (!isTypeOnlyImport(node) && ts.isStringLiteralLike(node.moduleSpecifier)) add(imports, node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier !== undefined && !isTypeOnlyExport(node) && ts.isStringLiteralLike(specifier)) add(imports, specifier.text);
      } else {
        const mocked = mockedSpecifier(node);
        if (mocked !== null) add(mocks, mocked);
        else if (isDynamicImport(node)) add(imports, literalArgument(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    const { statements } = sourceFile;
    const isBarrel =
      statements.length > 0 &&
      statements.every((statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined);
    return { imports: [...imports].sort(), mocks: [...mocks].sort(), isBarrel };
  }

  return {
    sourceRoot,
    info(file) {
      const absolute = path.resolve(file);
      let info = infos.get(absolute);
      if (info === undefined) {
        info = analyze(absolute);
        infos.set(absolute, info);
      }
      return info;
    },
    isSource(file) {
      const absolute = path.resolve(file);
      const relative = toPosix(path.relative(root, absolute));
      return (
        isInside(sourceRoot, absolute) &&
        !relative.split('/').includes('node_modules') &&
        (outDir === null || !isInside(outDir, absolute)) &&
        isTypeScriptFile(relative) &&
        !isDeclarationFile(relative) &&
        !isTestFile(relative)
      );
    },
    relative: (file) => toPosix(path.relative(root, path.resolve(file))),
  };
}
