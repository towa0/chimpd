import { describe, expect, it } from 'vitest';
import { colorEnabled, stripAnsi, visibleLength } from '../../src/terminal/color.js';

describe('colour decision', () => {
  it('colours a TTY and nothing else by default', () => {
    expect(colorEnabled({ flag: undefined, env: {}, isTTY: true })).toBe(true);
    expect(colorEnabled({ flag: undefined, env: {}, isTTY: false })).toBe(false);
  });

  it('lets the flags win over everything', () => {
    expect(colorEnabled({ flag: false, env: { FORCE_COLOR: '1' }, isTTY: true })).toBe(false);
    expect(colorEnabled({ flag: true, env: { NO_COLOR: '1' }, isTTY: false })).toBe(true);
  });

  it('lets FORCE_COLOR force or turn off colour, and win over NO_COLOR', () => {
    expect(colorEnabled({ flag: undefined, env: { FORCE_COLOR: '1' }, isTTY: false })).toBe(true);
    expect(colorEnabled({ flag: undefined, env: { FORCE_COLOR: '0' }, isTTY: true })).toBe(false);
    expect(colorEnabled({ flag: undefined, env: { FORCE_COLOR: '1', NO_COLOR: '1' }, isTTY: true })).toBe(true);
  });

  it('turns colour off for NO_COLOR and a dumb terminal, but not for an empty NO_COLOR', () => {
    expect(colorEnabled({ flag: undefined, env: { NO_COLOR: '1' }, isTTY: true })).toBe(false);
    expect(colorEnabled({ flag: undefined, env: { TERM: 'dumb' }, isTTY: true })).toBe(false);
    expect(colorEnabled({ flag: undefined, env: { NO_COLOR: '' }, isTTY: true })).toBe(true);
  });
});

describe('escape sequences', () => {
  it('take no columns and strip away', () => {
    expect(visibleLength('\u001b[1m\u001b[35mabc\u001b[39m\u001b[22m')).toBe(3);
    expect(stripAnsi('\u001b[1m\u001b[32mok\u001b[39m\u001b[22m')).toBe('ok');
  });
});
