import { SETUP_MARKER } from './marker.js';

const globals = globalThis as { [SETUP_MARKER]?: true };
globals[SETUP_MARKER] = true;
