import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { rangeForLine, type ScopeRange } from '../core/index.js';

export type OutgoingCallee = 'fetch' | 'http.request' | 'http.get' | 'https.request' | 'https.get';

/** A call to an entry point the fault phase can fault, found in the source rather than at runtime. */
export interface OutgoingCall {
  /** Repo-relative path with forward slashes. */
  readonly file: string;
  /** The line of the callee name, which is where a stack frame of the call points. */
  readonly line: number;
  readonly endLine: number;
  readonly callee: OutgoingCallee;
}

type HttpModule = 'http' | 'https';

const HTTP_MODULES: ReadonlyMap<string, HttpModule> = new Map([
  ['http', 'http'],
  ['node:http', 'http'],
  ['https', 'https'],
  ['node:https', 'https'],
]);

const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);
const HTTP_METHODS = new Set(['request', 'get']);

interface Bindings {
  readonly modules: Map<string, HttpModule>;
  readonly functions: Map<string, OutgoingCallee>;
}

function httpModuleOf(node: ts.Expression | undefined): HttpModule | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node)) return HTTP_MODULES.get(node.text) ?? null;
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1
  ) {
    return httpModuleOf(node.arguments[0]);
  }
  return null;
}

function bindName(bindings: Bindings, module: HttpModule, imported: string, local: string): void {
  if (HTTP_METHODS.has(imported)) bindings.functions.set(local, `${module}.${imported}` as OutgoingCallee);
}

function collectBindings(source: ts.SourceFile): Bindings {
  const bindings: Bindings = { modules: new Map(), functions: new Map() };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const module = httpModuleOf(node.moduleSpecifier);
      const clause = node.importClause;
      if (module !== null && clause !== undefined) {
        if (clause.name !== undefined) bindings.modules.set(clause.name.text, module);
        const named = clause.namedBindings;
        if (named !== undefined && ts.isNamespaceImport(named)) bindings.modules.set(named.name.text, module);
        if (named !== undefined && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            bindName(bindings, module, (element.propertyName ?? element.name).text, element.name.text);
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const module = httpModuleOf(node.moduleReference.expression);
      if (module !== null) bindings.modules.set(node.name.text, module);
    } else if (ts.isVariableDeclaration(node)) {
      const module = httpModuleOf(node.initializer);
      if (module !== null && ts.isIdentifier(node.name)) bindings.modules.set(node.name.text, module);
      if (module !== null && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const imported = element.propertyName !== undefined && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
          bindName(bindings, module, imported, element.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

function calleeOf(expression: ts.Expression, bindings: Bindings): { callee: OutgoingCallee; name: ts.Node } | null {
  if (ts.isIdentifier(expression)) {
    if (expression.text === 'fetch') return { callee: 'fetch', name: expression };
    const bound = bindings.functions.get(expression.text);
    return bound === undefined ? null : { callee: bound, name: expression };
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const owner = expression.expression.text;
    const method = expression.name.text;
    if (method === 'fetch' && GLOBAL_OBJECTS.has(owner)) return { callee: 'fetch', name: expression.name };
    const module = bindings.modules.get(owner);
    if (module !== undefined && HTTP_METHODS.has(method)) {
      return { callee: `${module}.${method}` as OutgoingCallee, name: expression.name };
    }
  }
  return null;
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** Calls to fetch and to the http and https request entry points whose callee is on a line in scope. */
export function findOutgoingCalls(targetRoot: string, ranges: readonly ScopeRange[]): OutgoingCall[] {
  const calls: OutgoingCall[] = [];
  for (const file of [...new Set(ranges.map((range) => range.file))].sort()) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(targetRoot, file), 'utf8');
    } catch {
      continue;
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
    const bindings = collectBindings(source);
    const lineOf = (position: number): number => source.getLineAndCharacterOfPosition(position).line + 1;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const found = calleeOf(node.expression, bindings);
        if (found !== null) {
          const line = lineOf(found.name.getStart(source));
          if (rangeForLine(ranges, file, line) !== null) {
            calls.push({ file, line, endLine: lineOf(node.getEnd()), callee: found.callee });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}
