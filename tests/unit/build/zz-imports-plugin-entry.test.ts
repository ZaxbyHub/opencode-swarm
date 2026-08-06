/**
 * Regression guard for cross-file `mock.module` pollution in tests/unit/build/.
 *
 * `discovery-profiles.test.ts` and `discovery-profiles-adversarial.test.ts`
 * replace `src/lang/profiles` via `mock.module`, which leaks into every later
 * file in Bun's shared test-runner process (AGENTS.md invariant 7). When those
 * mocks were partial (providing `LANGUAGE_REGISTRY.get` but not `getAll`), any
 * file in this directory that transitively imported `src/index.ts` crashed at
 * module-evaluation time with `LANGUAGE_REGISTRY.getAll is not a function`
 * (`src/tools/repo-graph/builder.ts`, module scope).
 *
 * The filename intentionally sorts last so the import happens *after* those
 * mocks are installed. If this file starts failing to import, a sibling has
 * reintroduced a non-spreading `mock.module`.
 */

import { describe, expect, it } from 'bun:test';
import OpenCodeSwarm from '../../../src/index.js';

describe('plugin entry imports cleanly after sibling mock.module calls', () => {
	it('evaluates src/index.ts without a polluted language registry', () => {
		expect(typeof OpenCodeSwarm).toBe('object');
		expect(typeof OpenCodeSwarm.server).toBe('function');
	});
});
