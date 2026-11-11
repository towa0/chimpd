const globals = globalThis as Record<PropertyKey, unknown>;
globals.fixtureSetupSawChimpd = globals[Symbol.for('chimpd.setup')] === true;
