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
 *
 * SCOPE — this is a LOCAL-ONLY guard, deliberately, on two counts:
 *   1. CI (`scripts/ci/run-unit-tests-local.ts`) runs every test file in its
 *      own process, so the sibling mocks are never installed alongside this
 *      file and it passes trivially there. It bites only on a shared-process
 *      run such as `bun test tests/unit/build/`.
 *   2. `bun test --randomize` reorders files, which can schedule this one
 *      before the `discovery-*` mocks install and render it inert for that run.
 * Neither is a defect to fix here; both are limits on what a green run proves.
 */

import { describe, expect, it } from 'bun:test';
import OpenCodeSwarm from '../../../src/index.js';

describe('plugin entry imports cleanly after sibling mock.module calls', () => {
	it('evaluates src/index.ts without a polluted language registry', () => {
		expect(typeof OpenCodeSwarm).toBe('object');
		expect(typeof OpenCodeSwarm.server).toBe('function');
	});
});
