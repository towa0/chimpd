import { describe, expect, it } from 'vitest';
import { BANANA_LINES, renderBanner, showBanner } from '../../src/terminal/banner.js';
import { COLORS, PLAIN, stripAnsi } from '../../src/terminal/color.js';

const ASCII = /^[\n\x20-\x7e]*$/;

describe('banner', () => {
  it('draws the 14-line banana in plain ASCII with the name and version in its empty top corner, within 44 columns', () => {
    expect(BANANA_LINES).toHaveLength(14);
    const text = renderBanner('1.2.3', PLAIN);
    expect(text).toMatch(ASCII);
    const lines = text.split('\n');
    expect(lines[1]).toBe('//\\           chimpd 1.2.3');
    expect(lines[2]).toBe('V  \\          mutants and faults');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(44);
      expect(line).toBe(line.trimEnd());
    }
  });

  it('colours the banana yellow when colour is on, and is the same text without the codes', () => {
    const coloured = renderBanner('1.2.3', COLORS);
    expect(coloured).toContain('\u001b[33m');
    expect(stripAnsi(coloured)).toBe(renderBanner('1.2.3', PLAIN));
  });

  it('shows only on an interactive stderr, and never with --json, --no-banner, CI or NO_COLOR', () => {
    const shown = { stderrIsTTY: true, json: false, banner: true, env: {} };
    expect(showBanner(shown)).toBe(true);
    expect(showBanner({ ...shown, stderrIsTTY: false })).toBe(false);
    expect(showBanner({ ...shown, json: true })).toBe(false);
    expect(showBanner({ ...shown, banner: false })).toBe(false);
    expect(showBanner({ ...shown, env: { CI: 'true' } })).toBe(false);
    expect(showBanner({ ...shown, env: { NO_COLOR: '1' } })).toBe(false);
    expect(showBanner({ ...shown, env: { CI: '' } })).toBe(true);
  });
});
