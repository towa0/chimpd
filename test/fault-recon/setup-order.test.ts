import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { defineSetupOrderSuite } from '../helpers/setup-order-suite.js';

const require = createRequire(import.meta.url);

defineSetupOrderSuite('5.1.0', dirname(require.resolve('vitest/package.json')));
