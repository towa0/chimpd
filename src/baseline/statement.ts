import { createHash } from 'node:crypto';
import ts from 'typescript';

/** A statement, or class member, that encloses a position: its hash and where it starts and ends. */
export interface StatementInfo {
  readonly hash: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface IgnoreDirective {
  /** One-based line of the comment. */
  readonly line: number;
  /** null when the comment has no reason, which makes it invalid. */
  readonly reason: string | null;
}

const HASH_LENGTH = 16;
const DIRECTIVE = /^\s*\/\/\s*chimpd-ignore(?![\w-])(.*)$/;

function scriptKind(fileName: string): ts.ScriptKind {
  if (/\.[cm]?tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.[cm]?jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isAnchor(node: ts.Node): boolean {
  return (ts.isStatement(node) && !ts.isBlock(node)) || ts.isClassElement(node);
}

/** The parsed source of one file, with the statements that enclose each position. */
export class SourceStatements {
  readonly #file: ts.SourceFile;
  readonly #printer = ts.createPrinter({ removeComments: true });
  readonly #hashes = new Map<ts.Node, string>();
  readonly #lines: readonly string[];

  constructor(fileName: string, text: string) {
    this.#file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
    this.#lines = text.split(/\r?\n/);
  }

  /** Enclosing statements of a one-based line and column, innermost first. */
  enclosing(line: number, column: number): StatementInfo[] {
    const lineCount = this.#file.getLineStarts().length;
    if (line < 1 || line > lineCount) return [];
    const position = this.#file.getPositionOfLineAndCharacter(line - 1, Math.max(0, column - 1));
    const chain: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (position < node.getStart(this.#file) || position >= node.getEnd()) return;
      if (isAnchor(node)) chain.push(node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(this.#file, visit);
    return chain.reverse().map((node) => this.#info(node));
  }

  /** Every statement and class member in the file. */
  all(): StatementInfo[] {
    const found: StatementInfo[] = [];
    const visit = (node: ts.Node): void => {
      if (isAnchor(node)) found.push(this.#info(node));
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(this.#file, visit);
    return found;
  }

  /** The chimpd-ignore comments of the file, valid or not. */
  directives(): IgnoreDirective[] {
    const found: IgnoreDirective[] = [];
    this.#lines.forEach((text, index) => {
      const match = DIRECTIVE.exec(text);
      if (match === null) return;
      const reason = /^:\s*(\S.*?)\s*$/.exec(match[1] ?? '')?.[1] ?? null;
      found.push({ line: index + 1, reason });
    });
    return found;
  }

  #info(node: ts.Node): StatementInfo {
    let hash = this.#hashes.get(node);
    if (hash === undefined) {
      const printed = this.#printer.printNode(ts.EmitHint.Unspecified, node, this.#file);
      // A formatter that reflows a statement over lines changes spacing and trailing commas, never the code.
      const normalized = printed
        .replace(/\s+/g, ' ')
        .replace(/\s*([()[\]{},;])\s*/g, '$1')
        .replace(/,([)\]}])/g, '$1');
      hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
      this.#hashes.set(node, hash);
    }
    const start = this.#file.getLineAndCharacterOfPosition(node.getStart(this.#file)).line + 1;
    const end = this.#file.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return { hash, startLine: start, endLine: end };
  }
}
