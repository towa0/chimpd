const globals = globalThis as Record<PropertyKey, unknown>;
globals.fixtureSetupSawBruise = globals[Symbol.for('bruise.setup')] === true;
