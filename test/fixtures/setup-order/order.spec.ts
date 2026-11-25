/// <reference types="vitest/globals" />

test('bruise setup ran before the fixture setup file', () => {
  expect((globalThis as Record<PropertyKey, unknown>).fixtureSetupSawBruise).toBe(true);
});
