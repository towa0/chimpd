import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineSetupOrderSuite } from '../helpers/setup-order-suite.js';

const here = dirname(fileURLToPath(import.meta.url));

defineSetupOrderSuite('4.1.12', resolve(here, 'vitest-4/node_modules/vitest'));
