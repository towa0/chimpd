import ts from 'typescript';

export interface LineSpan {
  readonly startLine: number;
  readonly endLine: number;
}

interface Span extends LineSpan {
  readonly start: number;
  readonly end: number;
}

export interface SourceShape {
  readonly lineCount: number;
  /** True when the line's code sits at module top level, outside every function and class member. */
  isStaticLine(line: number): boolean;
  enclosingFunction(line: number): LineSpan | null;
  /** The smallest function that contains the gap between `line` and the line after it. */
  functionAroundGapAfter(line: number): LineSpan | null;
  /** The top-level statement to attribute a deletion after `line` to, or null in an empty file. */
  statementForGapAfter(line: number): LineSpan | null;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body !== undefined
  );
}

function isClassMember(node: ts.Node): boolean {
  return ts.isPropertyDeclaration(node) || ts.isClassStaticBlockDeclaration(node);
}

// `const f = () => {}` reads as a function to its author, so the whole statement is the unit.
function functionUnit(node: ts.Node): ts.Node {
  const declaration = node.parent;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer === node) {
    const list = declaration.parent;
    if (ts.isVariableDeclarationList(list) && list.declarations.length === 1 && ts.isVariableStatement(list.parent)) {
      return list.parent;
    }
  }
  if (ts.isPropertyDeclaration(declaration) && declaration.initializer === node) return declaration;
  return node;
}

function scriptKind(fileName: string): ts.ScriptKind {
  return fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function smallest<T extends LineSpan>(spans: readonly T[], size: (span: T) => number): T | null {
  let best: T | null = null;
  for (const span of spans) {
    if (best === null || size(span) < size(best)) best = span;
  }
  return best;
}

export function analyzeSource(fileName: string, text: string): SourceShape {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const lineStarts = sourceFile.getLineStarts();
  const lineOf = (position: number): number => sourceFile.getLineAndCharacterOfPosition(position).line + 1;

  function spanOf(node: ts.Node): Span {
    const start = node.getStart(sourceFile);
    return { start, end: node.end, startLine: lineOf(start), endLine: lineOf(node.end) };
  }

  const functions: Span[] = [];
  const nonStatic: Span[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const span = spanOf(functionUnit(node));
      functions.push(span);
      nonStatic.push(span);
    } else if (isClassMember(node)) {
      nonStatic.push(spanOf(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const statements = sourceFile.statements.map(spanOf);

  function codePosition(line: number): number {
    const start = lineStarts[line - 1] ?? text.length;
    const end = lineStarts[line] ?? text.length;
    const indent = text.slice(start, end).search(/\S/);
    return indent === -1 ? start : start + indent;
  }

  const containsPosition = (position: number) => (span: Span) => span.start <= position && position < span.end;
  const containsGapAfter = (line: number) => (span: LineSpan) => span.startLine <= line && span.endLine > line;
  const byLength = (span: Span): number => span.end - span.start;

  return {
    lineCount: lineStarts.length,
    isStaticLine: (line) => !nonStatic.some(containsPosition(codePosition(line))),
    enclosingFunction: (line) => smallest(functions.filter(containsPosition(codePosition(line))), byLength),
    functionAroundGapAfter: (line) => smallest(functions.filter(containsGapAfter(line)), byLength),
    statementForGapAfter(line) {
      return (
        statements.find(containsGapAfter(line)) ??
        statements.find((statement) => statement.startLine > line) ??
        statements.at(-1) ??
        null
      );
    },
  };
}
