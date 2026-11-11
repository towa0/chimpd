/// <reference types="vitest/globals" />

test('chimpd setup ran before the fixture setup file', () => {
  expect((globalThis as Record<PropertyKey, unknown>).fixtureSetupSawChimpd).toBe(true);
});
