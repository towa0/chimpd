import { describe, expect, it } from 'vitest';
import { renderHeader, showHeader } from '../../src/terminal/header.js';
import { stripAnsi } from '../../src/terminal/color.js';
import { PLAIN, THEMED } from '../../src/terminal/theme.js';

describe('header line', () => {
  it('is one ASCII line with the name, the version and the tagline', () => {
    expect(renderHeader('1.2.3', PLAIN)).toBe('bruise 1.2.3  find the soft spots in your tests\n\n');
  });

  it('puts the name in bold brand colour and the rest dim, and is the plain line without the codes', () => {
    const themed = renderHeader('1.2.3', THEMED);
    expect(themed).toBe('\u001b[1m\u001b[35mbruise 1.2.3\u001b[39m\u001b[22m  \u001b[2mfind the soft spots in your tests\u001b[22m\n\n');
    expect(stripAnsi(themed)).toBe(renderHeader('1.2.3', PLAIN));
  });

  it('shows only on an interactive stderr, and never with --json, --no-banner or in CI', () => {
    const shown = { stderrIsTTY: true, json: false, banner: true, env: {} };
    expect(showHeader(shown)).toBe(true);
    expect(showHeader({ ...shown, stderrIsTTY: false })).toBe(false);
    expect(showHeader({ ...shown, json: true })).toBe(false);
    expect(showHeader({ ...shown, banner: false })).toBe(false);
    expect(showHeader({ ...shown, env: { CI: 'true' } })).toBe(false);
    expect(showHeader({ ...shown, env: { CI: '' } })).toBe(true);
    expect(showHeader({ ...shown, env: { NO_COLOR: '1' } })).toBe(true);
  });
});
