import path from 'node:path';

export function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const TEST_FILE = /\.(test|spec)\.[cm]?tsx?$/;

export function isTypeScriptFile(file: string): boolean {
  return TYPESCRIPT_FILE.test(file);
}

export function isDeclarationFile(file: string): boolean {
  return DECLARATION_FILE.test(file);
}

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file) || file.split('/').includes('__tests__');
}
