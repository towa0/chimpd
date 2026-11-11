import { afterAll, beforeAll, expect, it } from 'vitest';
import { sendNotification } from '../src/notifications.js';

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = () => Promise.resolve(new Response(null, { status: 202 }));
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

it('reports a delivered notification', async () => {
  expect(await sendNotification('http://notifications.invalid', 'hello')).toBe(true);
});
