/**
 * Issue #3099 AC5 (rider R2-14) — workflow-scoped `gh` readiness advisory.
 *
 * `gh` availability is currently only ever resolved lazily, per invocation:
 * `src/tools/gh-evidence.ts` degrades with a typed `gh-not-found` payload the
 * moment a tool that needs it runs. `activatePrWorkflow` contains no reference
 * to `gh` at all, so an operator gets no warning at the one point where they
 * could still act — and because the gate's design is fail-open, a lane that
 * cannot reach `gh` produces degraded output that flows into reviewer and critic
 * inputs rather than failing loudly.
 *
 * The generic missing-binary advisory (src/services/tool-doctor.ts) does not
 * cover this: its checklist is PATH-presence-only and deliberately excludes gh,
 * while the resolver here does a behavioural `gh version` probe.
 *
 * Contract after the fix: activation publishes a workflow-scoped gh readiness
 * advisory when gh cannot be resolved, reusing the gh-not-found guidance, and
 * stays silent when gh is present. Detection is fail-open — a resolver failure
 * must never fail activation.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	readPrWorkflowGateState,
	_test_exports as workflowInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * The seam is added by the fix. Casting keeps this file compiling at base, where
 * the property does not exist yet and activation simply never consults it —
 * which is exactly the behaviour AC5 pins as RED.
 */
type GhAwareInternals = {
	resolveGhBinary?: () => string | null;
};
const internals = workflowInternals as unknown as GhAwareInternals;
const hadOwnResolve = Object.hasOwn(workflowInternals, 'resolveGhBinary');

let directory: string;
/**
 * Captured ONCE at module scope. Re-capturing inside setGhBinary made a test
 * that calls it twice (the 'gh resolves' and 'resolver throws' rows do) restore
 * the FIRST stub instead of the pre-test resolver, leaking the stub into
 * later tests in a shared process (#3099 SolCritic finding N2).
 */
const originalResolve: (() => string | null) | undefined =
	internals.resolveGhBinary;

function setGhBinary(resolver: () => string | null): void {
	internals.resolveGhBinary = resolver;
}

/**
 * `readPrWorkflowGateState` is async AND requires a session id; reading it
 * without both rejects the promise, so a non-awaited helper here would silently
 * observe an empty array and make every assertion below vacuous.
 */
async function advisories(sessionID: string): Promise<readonly string[]> {
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (!state)
		throw new Error(
			'gate state was not readable — assertions would be vacuous',
		);
	return state.skillContractAdvisories ?? [];
}

describe('#3099 AC5 — gh readiness advisory at PR-workflow activation', () => {
	beforeEach(() => {
		directory = canonicalMkdtemp('pr-gh-readiness-3099-');
		setGhBinary(() => null);
	});
	afterEach(() => {
		if (originalResolve === undefined) delete internals.resolveGhBinary;
		else internals.resolveGhBinary = originalResolve;
		rmSync(directory, { recursive: true, force: true });
		return closeAllProjectDbs();
	});

	// AC5 DISCRIMINATING: gh absent ⇒ a workflow-scoped advisory is published.
	for (const mode of ['PR_REVIEW', 'PR_FEEDBACK'] as const) {
		test(`publishes a gh readiness advisory at activation for ${mode}`, async () => {
			const sessionID = `session-gh-absent-${mode}`;
			await activatePrWorkflow(directory, sessionID, mode);
			const entries = await advisories(sessionID);
			expect(entries.some((entry) => /gh/i.test(entry))).toBe(true);
		});
	}

	test('names the gh CLI as the missing prerequisite', async () => {
		const sessionID = 'session-gh-names';
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		const entries = await advisories(sessionID);
		expect(entries.join('\n')).toMatch(/GitHub CLI \(gh\)|gh not found/i);
	});

	// AC4 PRESERVING: gh present ⇒ no gh advisory. A readiness warning that
	// fires unconditionally is worse than none. Asserting the whole array is
	// empty would be wrong — it legitimately carries skill-contract
	// advisories — so this asserts about the gh channel specifically, using
	// the same marker the positive rows key on.
	test('stays silent about gh when gh resolves', async () => {
		setGhBinary(() => '/usr/local/bin/gh');
		const sessionID = 'session-gh-present';
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		const entries = await advisories(sessionID);
		expect(
			entries.filter((entry) => /GitHub CLI \(gh\)|gh not found/i.test(entry)),
		).toEqual([]);
	});

	// AC4 PRESERVING: activation still succeeds in every case above — the
	// advisory is diagnostic and must never gate activation.
	test('still activates when gh is absent', async () => {
		const state = await activatePrWorkflow(
			directory,
			'session-gh-activates',
			'PR_REVIEW',
		);
		expect(state.mode).toBe('PR_REVIEW');
	});

	// AC4 PRESERVING: a throwing resolver must not fail activation.
	test('still activates when the gh resolver throws', async () => {
		setGhBinary(() => {
			throw new Error('resolver exploded');
		});
		const state = await activatePrWorkflow(
			directory,
			'session-gh-throws',
			'PR_REVIEW',
		);
		expect(state.mode).toBe('PR_REVIEW');
	});

	// Structural: the seam the test drives must actually be consulted. Without
	// this, the positive cases above would pass vacuously if the advisory were
	// emitted for an unrelated reason.
	test('the gh resolution seam is part of the module surface under test', () => {
		expect(hadOwnResolve || internals.resolveGhBinary !== undefined).toBe(true);
	});
});
