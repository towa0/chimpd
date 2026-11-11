import ts from 'typescript';

export interface LineSpan {
  readonly startLine: number;
  readonly endLine: number;
}

interface Span extends LineSpan {
  readonly start: number;
  readonly end: number;
}

interface StatementSpan extends Span {
  readonly declaresCode: boolean;
}

interface ClassSpan extends Span {
  readonly members: readonly Span[];
}

export interface DeletionTarget extends LineSpan {
  readonly staticRegion: boolean;
}

export interface SourceShape {
  readonly lineCount: number;
  /** True when the line's code sits at module top level, outside every function and class member. */
  isStaticLine(line: number): boolean;
  enclosingFunction(line: number): LineSpan | null;
  /**
   * Where to attribute lines deleted after `line`: the smallest enclosing function, else the
   * adjacent class member, else the adjacent top-level statement, or what turned out empty.
   */
  deletionTargetAfter(line: number): DeletionTarget | 'empty-class' | 'empty-file';
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

function isCodeMember(node: ts.Node): boolean {
  return isFunctionLike(node) || ts.isPropertyDeclaration(node) || ts.isClassStaticBlockDeclaration(node);
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

function smallest<T extends Span>(spans: readonly T[]): T | null {
  let best: T | null = null;
  for (const span of spans) {
    if (best === null || span.end - span.start < best.end - best.start) best = span;
  }
  return best;
}

function adjacent<T extends LineSpan>(spans: readonly T[], line: number): T | null {
  return spans.find((span) => span.startLine > line) ?? spans.findLast((span) => span.endLine <= line) ?? null;
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
  const classes: ClassSpan[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const span = spanOf(functionUnit(node));
      functions.push(span);
      nonStatic.push(span);
    } else if (isCodeMember(node)) {
      nonStatic.push(spanOf(node));
    } else if (ts.isClassLike(node)) {
      classes.push({ ...spanOf(node), members: node.members.filter(isCodeMember).map(spanOf) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const statements: StatementSpan[] = sourceFile.statements.map((statement) => ({
    ...spanOf(statement),
    declaresCode: ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement),
  }));

  function codePosition(line: number): number {
    const start = lineStarts[line - 1] ?? text.length;
    const end = lineStarts[line] ?? text.length;
    const indent = text.slice(start, end).search(/\S/);
    return indent === -1 ? start : start + indent;
  }

  const containsPosition = (position: number) => (span: Span) => span.start <= position && position < span.end;
  const containsGapAfter = (line: number) => (span: LineSpan) => span.startLine <= line && span.endLine > line;
  const isStaticLine = (line: number): boolean => !nonStatic.some(containsPosition(codePosition(line)));
  const lines = ({ startLine, endLine }: LineSpan): LineSpan => ({ startLine, endLine });

  return {
    lineCount: lineStarts.length,
    isStaticLine,
    enclosingFunction(line) {
      const found = smallest(functions.filter(containsPosition(codePosition(line))));
      return found === null ? null : lines(found);
    },
    deletionTargetAfter(line) {
      const enclosing = smallest(functions.filter(containsGapAfter(line)));
      if (enclosing !== null) return { ...lines(enclosing), staticRegion: false };

      const owner = smallest(classes.filter(containsGapAfter(line)));
      if (owner !== null) {
        const member = adjacent(owner.members, line);
        return member === null ? 'empty-class' : { ...lines(member), staticRegion: false };
      }

      const statement = statements.find(containsGapAfter(line)) ?? adjacent(statements, line);
      if (statement === null) return 'empty-file';
      return {
        ...lines(statement),
        staticRegion: !statement.declaresCode && isStaticLine(statement.startLine),
      };
    },
  };
}
