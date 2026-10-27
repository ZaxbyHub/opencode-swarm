/**
 * Frozen acceptance checks for issue #2963 — partially-failed
 * `/swarm reset-session` recovery contract (independent check author,
 * Phase 2.5). These tests ARE the frozen spec handed to the implementer.
 *
 * Scenario under test: a partially-failed `/swarm reset-session` (SQLite
 * `clearSnapshotRows` throws) leaves the per-root coordination entry
 * `{state:'closing', settled:true}` BY DESIGN (fail-closed containment).
 * The wedge itself is correct — the defects are the SILENCE around it.
 *
 * Per-check verdicts, stated truthfully at BOTH ends:
 * - AC1 strand advisory:        RED at base, GREEN after the fix.
 * - AC1 status guidance:        RED at base, GREEN after the fix.
 * - AC4 bounded stop advisory:  RED at base, GREEN after the fix.
 * - AC5 closing discrimination: RED at base, GREEN after the fix.
 * - AC5 unsettled settle-wait:  PRESERVING — GREEN at base and after the fix.
 * - AC3 successful re-run:      PRESERVING — GREEN at base and after the fix.
 * AC2 (containment rejection still matches /closing for reset-session/i) is
 * pinned by the EXISTING tests/unit/commands/reset-session.test.ts; here it
 * is only a strand-helper precondition sanity.
 *
 * Test-isolation facts (frozen for the implementer): the advisory buffer is
 * global module state — every counting test starts with
 * clearDeferredWarnings() and filters by topic regex so ambient advisories
 * cannot pollute counts. Each test uses a fresh canonicalMkdtemp root so the
 * writer's once-per-root flag (fix-owned module state keyed by root) never
 * collides across tests. No raw clock reads anywhere in this file — static
 * literals only (writtenAt: 1), per the repo test-clock gate.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { handleRecoverCommand } from '../../../src/commands/recover';
import {
	_internals,
	handleResetSessionCommand,
} from '../../../src/commands/reset-session';
import { canonicalProjectKey } from '../../../src/db/canonical-project';
import { closeProjectDb } from '../../../src/db/project-db.js';
import {
	formatStatusMarkdown,
	type StatusData,
} from '../../../src/services/status-service.js';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import {
	_snapshotCoordinationInternals,
	ensureSnapshotCoordinationReady,
} from '../../../src/session/snapshot-coordination-init.js';
import { writeSnapshotRows } from '../../../src/session/snapshot-store.js';
import {
	SNAPSHOT_PROJECTION_FILE,
	writeSnapshot,
} from '../../../src/session/snapshot-writer.js';
import { resetSwarmState, swarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let testDir: string;

beforeEach(() => {
	resetSwarmState();
	testDir = canonicalMkdtemp('snapshot-coordination-recovery-');
	mkdirSync(path.join(testDir, '.swarm', 'session'), { recursive: true });
});

afterEach(() => {
	closeProjectDb(testDir);
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
	// Shared-bun-process hygiene: the advisory buffer and the coordination
	// entries map are global module state — clear both so nothing leaks to
	// sibling test files in the shared test-runner process.
	clearDeferredWarnings();
	_snapshotCoordinationInternals.entries.delete(canonicalProjectKey(testDir));
});

/**
 * Advisory-topic filters (semantic, not exact-string): the fix owns the
 * wording; the checks pin that every stop advisory (a) names the
 * reset-session recovery, (b) names the durable persistence layer, and
 * (c) states that it stopped. All three parts are required so bare
 * closing-state vocabulary alone can never satisfy a positive assertion.
 */
const NAMES_RESET_SESSION_RE = /reset-session/;
const PERSISTENCE_RE = /persistence/i;
const DESCRIBES_STOP_RE = /persistence|snapshot/i;
const STOP_VERB_RE = /stop/i;

/** AC1 strand-time advisory: recovery + persistence layer + stop verb. */
function isResetStopAdvisory(warning: string): boolean {
	return (
		NAMES_RESET_SESSION_RE.test(warning) &&
		PERSISTENCE_RE.test(warning) &&
		STOP_VERB_RE.test(warning)
	);
}

/** AC4 writer-path advisory: same conjunction, snapshot-alt middle term. */
function isWriterStopAdvisory(warning: string): boolean {
	return (
		NAMES_RESET_SESSION_RE.test(warning) &&
		DESCRIBES_STOP_RE.test(warning) &&
		STOP_VERB_RE.test(warning)
	);
}

/** Static seed (no clock reads) — mirrors the pinned reset-session fixture. */
function seedSnapshotRows(dir: string): void {
	writeSnapshotRows(dir, {
		version: 3,
		writtenAt: 1,
		toolAggregates: {},
		activeAgent: {},
		delegationChains: {},
		agentSessions: {},
	});
}

/**
 * Reproduce the partially-failed reset from the issue: the SQLite authority
 * clear throws, so reset-session keeps the closing guard installed
 * (fail-closed containment BY DESIGN) and the root stays wedged until a
 * successful re-run. Restores the seam before returning so later steps in
 * the calling test exercise the real store. Sanity-verifies AC2 (still
 * fails closed for new coordination work) and returns the failed output.
 */
async function strandClosingGuard(dir: string): Promise<string> {
	seedSnapshotRows(dir);
	const originalClear = _internals.clearSnapshotRows;
	_internals.clearSnapshotRows = () => {
		throw new Error('simulated SQLite failure');
	};
	try {
		const result = await handleResetSessionCommand(dir, []);
		expect(result).toContain('Failed to clear SQLite session snapshot');
		// AC2 precondition sanity (pinned by reset-session.test.ts): the
		// wedged root still rejects new coordination work.
		await expect(ensureSnapshotCoordinationReady(dir)).rejects.toThrow(
			/closing for reset-session/i,
		);
		return result;
	} finally {
		_internals.clearSnapshotRows = originalClear;
	}
}

/** StatusData fixture mirroring tests/unit/services/status-coordination.test.ts. */
function baseStatus(): StatusData {
	return {
		hasPlan: true,
		currentPhase: 'Phase 1',
		completedTasks: 0,
		totalTasks: 1,
		agentCount: 1,
		isLegacy: false,
		turboMode: false,
		contextBudgetPct: null,
		compactionCount: 0,
		lastSnapshotAt: null,
	};
}

describe('#2963 reset-session partial-failure recovery contract', () => {
	test('partially-failed reset emits an operational advisory naming the recovery', async () => {
		// AC1 strand-time advisory. RED at base, GREEN after the fix: at base
		// the failed reset is only rendered in command output (plus a
		// debug-gated log); the fix must additionally emit exactly one
		// always-visible operational advisory via the advisoryWarn channel
		// (observed here through getDeferredWarnings) that names re-running
		// /swarm reset-session as the working recovery. The filter requires
		// ALL THREE semantics: the recovery (/reset-session/), the layer
		// (/persistence/i), and the stop (/stop/i).
		clearDeferredWarnings();
		const result = await strandClosingGuard(testDir);
		expect(result).toContain('Failed to clear SQLite session snapshot');
		const relevant = getDeferredWarnings().filter(isResetStopAdvisory);
		// Exactly one bounded emission at strand time.
		expect(relevant).toHaveLength(1);
		// The advisory must prove ACTIONABLE recovery text — it names the
		// action "re-run ... reset-session", not just topic vocabulary.
		expect(relevant[0]).toMatch(/re-run[^\n]*reset-session/);
	});

	test('writeSnapshot closing stop is loud exactly once per root', async () => {
		// AC4 bounded writer-path advisory. RED at base, GREEN after the fix:
		// at base writeSnapshot's catch only calls the debug-gated log, so
		// durable snapshot writes silently stop (zero advisories); the fix is
		// loud at most once per root across repeated failed writes.
		await strandClosingGuard(testDir);
		const projectionPath = path.join(
			testDir,
			'.swarm',
			SNAPSHOT_PROJECTION_FILE,
		);
		expect(existsSync(projectionPath)).toBe(false);

		clearDeferredWarnings();
		// No throw escapes writeSnapshot (its catch is internal fail-open).
		await expect(writeSnapshot(testDir, swarmState)).resolves.toBeUndefined();
		await expect(writeSnapshot(testDir, swarmState)).resolves.toBeUndefined();

		// Exactly ONE writer-path advisory total across both calls.
		const stopAdvisories = getDeferredWarnings().filter(isWriterStopAdvisory);
		expect(stopAdvisories).toHaveLength(1);
		// The writer-path advisory must name the action too ("re-run ...
		// reset-session"), not just the stop topic.
		expect(stopAdvisories[0]).toMatch(/re-run[^\n]*reset-session/);
		// The wedge still holds: no projection may appear while closing.
		expect(existsSync(projectionPath)).toBe(false);

		// Recovery via successful re-run clears the wedge; a subsequent
		// successful writeSnapshot resumes durable writes with no new
		// advisory (bounded: the stop is not re-announced once recovered).
		const retry = await handleResetSessionCommand(testDir, []);
		expect(retry).toContain('authoritative session snapshot row');
		clearDeferredWarnings();
		await expect(writeSnapshot(testDir, swarmState)).resolves.toBeUndefined();
		expect(existsSync(projectionPath)).toBe(true);
		const postRecovery = getDeferredWarnings().filter(isWriterStopAdvisory);
		expect(postRecovery).toHaveLength(0);
	});

	test('recover --coordination closing settled renders the closing-specific recovery', async () => {
		// AC5 discriminating half. RED at base, GREEN after the fix: at base
		// recover --coordination renders ONE refusal text for every failure —
		// the settle-wait advice is inapplicable for a settled closing entry
		// and the working recovery (re-run /swarm reset-session) is named
		// nowhere. The fix must render closing-specific output.
		await strandClosingGuard(testDir);
		const output = await handleRecoverCommand(testDir, ['--coordination']);
		expect(output).not.toContain('wait for that underlying attempt to settle');
		expect(output).toMatch(/reset-session/);
		// Actionable phrase required: 're-run' adjacent to 'reset-session' on
		// one line. The base refusal text contains 'closing for reset-session'
		// but never 're-run', so the state vocabulary alone must not satisfy
		// the positive assertions.
		expect(output).toMatch(
			/re-run[^\n]*reset-session|reset-session[^\n]*re-run/i,
		);
	});

	test('recover --coordination unsettled entry keeps the settle-wait advice', async () => {
		// AC5 preserving half. PRESERVING — GREEN at base and after the fix:
		// for a genuinely UNSETTLED entry the settle-wait advice is correct
		// and must stay. Synthesizes the entry directly in the coordination
		// map (never settles; deleted in finally to avoid cross-test
		// pollution of the module-level entries map).
		const root = canonicalProjectKey(testDir);
		_snapshotCoordinationInternals.entries.set(root, {
			attemptId: 1,
			generation: 1,
			state: 'timed_out',
			settled: false,
			underlying: new Promise(() => {}),
		});
		try {
			const output = await handleRecoverCommand(testDir, ['--coordination']);
			expect(output).toContain('wait for that underlying attempt to settle');
		} finally {
			_snapshotCoordinationInternals.entries.delete(root);
		}
	});

	test('renderCoordinationStatus differentiates closing settled', () => {
		// AC1 status guidance. RED at base, GREEN after the fix: at base
		// renderCoordinationStatus appends the generic unsettled-attempt
		// guidance for EVERY state, including closing (settled); the fix must
		// render closing-specific guidance naming /swarm reset-session.
		const output = formatStatusMarkdown({
			...baseStatus(),
			coordination: {
				state: 'closing',
				attemptId: 1,
				generation: 1,
				settled: true,
				closingReason: 'reset-cleanup-failed',
			},
		});
		expect(output).not.toContain(
			'an unsettled timed-out attempt must finish before retry',
		);
		expect(output).toMatch(/reset-session/);
		// Closing-specific guidance must be actionable: 're-run' adjacent to
		// 'reset-session' on one line, not just the state vocabulary.
		expect(output).toMatch(/re-run[^\n]*reset-session/);
	});

	test('status keeps the generic recovery line for unsettled timed_out coordination', () => {
		// Companion to the closing-status check above (deliberately named so
		// the -t filter 'renderCoordinationStatus differentiates closing
		// settled' selects ONLY the closing one). PRESERVING — GREEN at base
		// and after the fix: an unsettled timed_out entry keeps the generic
		// recovery line.
		const output = formatStatusMarkdown({
			...baseStatus(),
			coordination: {
				state: 'timed_out',
				attemptId: 1,
				generation: 1,
				settled: false,
			},
		});
		expect(output).toContain(
			'an unsettled timed-out attempt must finish before retry',
		);
	});

	test('a successful re-run clears the wedge and resumes durable writes', async () => {
		// AC3. PRESERVING — GREEN at base and after the fix: a successful
		// re-run of /swarm reset-session clears the closing wedge and durable
		// writes resume (writeSnapshot writes the projection again).
		await strandClosingGuard(testDir);
		const retry = await handleResetSessionCommand(testDir, []);
		expect(retry).toContain('authoritative session snapshot row');
		// The wedge is gone: coordination readiness succeeds again.
		await expect(
			ensureSnapshotCoordinationReady(testDir),
		).resolves.toBeUndefined();
		const projectionPath = path.join(
			testDir,
			'.swarm',
			SNAPSHOT_PROJECTION_FILE,
		);
		await expect(writeSnapshot(testDir, swarmState)).resolves.toBeUndefined();
		expect(existsSync(projectionPath)).toBe(true);
	});
});
