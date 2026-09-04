/**
 * Issue #2251 — the override's finalization is idempotent over a record that is
 * ALREADY terminal, and the abort-not-completed retraction it emits on a lost
 * CAS names only what it can actually observe.
 *
 * `finalizeOverriddenProbeRetainedLanes` runs after `clearPrWorkflowGateState`
 * returns, i.e. after the session-state mutation lock has been released. Between
 * the settlement that decided a lane was retained and the finalization that
 * abandons it, something else — the lazy-maintenance sweep inside
 * `recordPendingDelegation`, a second operator, a directory-wide sweep — can
 * already have driven that record terminal `stale`.
 *
 * This pins the behaviour that makes that harmless, and nothing more: the
 * finalize sweep is narrowed to `pending`/`running`, so an already-`stale`
 * record is skipped rather than re-written, the ledger gains no line, the folded
 * read still yields exactly one record at exactly one status, and the disclosure
 * reports what it OBSERVED (finalized, restartable) rather than what this call
 * caused.
 *
 * It does NOT prove anything about lock ordering. The finalization genuinely
 * runs outside the session-state mutation lock; what is pinned here is that
 * re-running it over an already-finalized record is a no-op, which is why that
 * window is survivable — not that the window is closed.
 *
 * The second `describe` below pins a related but distinct claim: the
 * `pr_workflow_abort_not_completed` retraction event written when the
 * CAS-guarded clear itself fails. `settlePresumedStalePrWorkflowLanes` durably
 * sweeps probe-DEAD past-horizon lanes to terminal `stale` BEFORE the clear
 * runs, so in a mixed batch (one probe-retained lane, one probe-dead lane) this
 * abort DID finalize a record even though the clear failed and the override
 * never ran. The disclosure must not claim otherwise.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BACKGROUND_DELEGATIONS_FILE } from '../../../src/background/pending-delegations.js';
import { closeProjectDb } from '../../../src/db/project-db.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { writeStateWhileLocked } from '../../../src/pr-review/persistence.js';
import {
	backdatePrWorkflowLane,
	laneStatusOnDisk,
	laneSubagentSessionId,
	recordOpenPrWorkflowLane,
	STALE_LANE_AGE_MS,
} from '../../helpers/pr-workflow-lane-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'idempotent-override-controller';
let directory = '';
let restoreClock: () => void = () => {};
/**
 * Captured at module-import time so `afterEach` restores the ORIGINAL bindings
 * rather than hand-written replacements that would silently diverge from the
 * real implementations.
 */
const originals = {
	resolveCurrentGitHead: gateInternals.resolveCurrentGitHead,
	resolveCurrentGitHeadAsync: gateInternals.resolveCurrentGitHeadAsync,
	resolveIsWorkingTreeClean: gateInternals.resolveIsWorkingTreeClean,
	resolveIsWorkingTreeCleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

/** Every raw line of the delegation ledger, unfolded. */
async function readLedgerLines(): Promise<string[]> {
	const raw = await fs.readFile(
		path.join(directory, '.swarm', BACKGROUND_DELEGATIONS_FILE),
		'utf-8',
	);
	return raw.split('\n').filter((line) => line.trim().length > 0);
}

/** Every event appended to `.swarm/events.jsonl`, parsed. */
async function readEvents(): Promise<Array<Record<string, unknown>>> {
	const raw = await fs.readFile(
		path.join(directory, '.swarm', 'events.jsonl'),
		'utf-8',
	);
	return raw
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('pr-workflow-override-idempotence-');
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveCurrentGitHeadAsync = async () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.getSessionOps = () => null;
});

afterEach(async () => {
	restoreClock();
	// `resetTrackedStateCache()` reassigns `getSessionOps`,
	// `sweepStaleDelegationsAsync` and `beforeAbortClear` to their NAMED module
	// bindings, so those three are restored rather than re-implemented. The git
	// seams are not part of that reset, so they come back from `originals`.
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originals.resolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync =
		originals.resolveCurrentGitHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originals.resolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originals.resolveIsWorkingTreeCleanAsync;
	closeProjectDb(directory);
	await fs.rm(directory, { recursive: true, force: true });
});

describe('the override finalization is a no-op over an already-terminal record', () => {
	test('a record finalized between the clear and the finalize is neither rewritten nor mis-disclosed', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		await recordOpenPrWorkflowLane(
			directory,
			SESSION_ID,
			'lane-alive',
			'c-idem',
		);
		await backdatePrWorkflowLane(directory, 'c-idem', STALE_LANE_AGE_MS);
		// Past the horizon and answering `busy` forever: the probe retains it, so the
		// human-only force path is the only thing that can clear this gate.
		gateInternals.getSessionOps = () => ({
			status: async () => ({
				data: { [laneSubagentSessionId('c-idem')]: { type: 'busy' } },
			}),
		});

		let ledgerLinesAtHandoff: string[] = [];
		// The interleaving. `beforeAbortClear` is the last seam before the
		// CAS-guarded clear, and the finalization runs strictly after that clear —
		// so a record driven terminal here is already `stale` by the time the
		// override's own sweep reaches it. Kept PAST the horizon deliberately: the
		// only thing sparing it from a second write is the sweep's STATUS filter,
		// never its age.
		gateInternals.beforeAbortClear = async () => {
			await backdatePrWorkflowLane(
				directory,
				'c-idem',
				STALE_LANE_AGE_MS,
				'stale',
			);
			ledgerLinesAtHandoff = await readLedgerLines();
		};

		const summary = await abortPrWorkflow(directory, SESSION_ID, {
			kind: 'force',
			reason: 'lane wedged busy forever',
		});

		// The seam ran, so the comparison below is against a real snapshot rather
		// than an empty array that would make `toEqual` vacuous.
		expect(ledgerLinesAtHandoff.length).toBeGreaterThan(0);
		// THE assertion: the finalize sweep appended nothing. `sweepStaleLocked`
		// filters on `pending`/`running` here, so an already-`stale` record is
		// skipped entirely — no transition line, and no compaction either (that runs
		// only when at least one record was swept). Byte-for-byte, not just a count,
		// so a rewrite that happened to preserve the line count still fails.
		expect(await readLedgerLines()).toEqual(ledgerLinesAtHandoff);
		// The folded read stays coherent: one record, one terminal status.
		expect(laneStatusOnDisk(directory, 'c-idem')).toBe('stale');
		// The disclosure states what the read-back OBSERVED, not what this abort
		// caused — the record IS terminal and its output IS gone, so naming it is
		// correct even though another writer is what made it so.
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'force abort overrode 1 lane(s)',
		);
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'Their delegation records were finalized (correlationId: c-idem); whatever those lanes still produce is no longer collectable.',
		);
		// And it must not ALSO describe the same lane as left intact — the two
		// clauses are mutually exclusive per record, and a double-counting
		// regression would read to an operator as two contradictory instructions.
		expect(summary.probeRetentionOverrideDisclosure).not.toContain(
			'were NOT finalized',
		);
		// No open record remains, so the restartability claim is true and stated.
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'A new PR workflow can now be started for this session.',
		);
		expect(summary.probeRetentionOverrideDisclosure).not.toContain('WARNING:');
		// The reversible half still succeeded: the gate is gone.
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();
	});
});

describe('a lost CAS in a mixed batch retracts precisely, not vacuously', () => {
	test('a probe-dead lane in the batch is finalized by settlement even though the clear failed', async () => {
		// The falsifying shape for the retraction disclosure. `lane-alive` is
		// probe-RETAINED (the probe answers `busy` forever), so only the human-only
		// override could ever finalize it — and the override runs strictly after a
		// successful clear, so a failed clear means it never ran. `lane-dead` is
		// probe-DEAD (the probe answers `idle`), so the settlement sweep that runs
		// BEFORE the clear durably flips it to terminal `stale` regardless of
		// whether the clear that follows succeeds. A single-lane fixture (as the
		// restart suite's CAS test uses) can never distinguish "this abort
		// finalized nothing" from "this abort finalized nothing IT is responsible
		// for" — this fixture can, because `lane-dead` proves the former claim
		// false while the override still finalized nothing.
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		await recordOpenPrWorkflowLane(
			directory,
			SESSION_ID,
			'lane-alive',
			'c-mix-alive',
		);
		await recordOpenPrWorkflowLane(
			directory,
			SESSION_ID,
			'lane-dead',
			'c-mix-dead',
		);
		await backdatePrWorkflowLane(directory, 'c-mix-alive', STALE_LANE_AGE_MS);
		await backdatePrWorkflowLane(directory, 'c-mix-dead', STALE_LANE_AGE_MS);
		gateInternals.getSessionOps = () => ({
			status: async () => ({
				data: {
					[laneSubagentSessionId('c-mix-alive')]: { type: 'busy' },
					[laneSubagentSessionId('c-mix-dead')]: { type: 'idle' },
				},
			}),
		});
		// The seam runs AFTER settlement (which already swept `c-mix-dead` to
		// `stale`) and immediately before the CAS-guarded clear — the same
		// technique the restart suite's F1 test uses to force a lost
		// compare-and-swap without touching production code.
		gateInternals.beforeAbortClear = async () => {
			const current = await readPrWorkflowGateState(directory, SESSION_ID);
			if (!current) throw new Error('expected active workflow state');
			await writeStateWhileLocked(directory, current);
		};

		await expect(
			abortPrWorkflow(directory, SESSION_ID, {
				kind: 'force',
				reason: 'lane wedged busy forever, mixed batch',
			}),
		).rejects.toThrow(/changed during terminal completion/i);

		// Settlement's own durable sweep finalized the probe-dead lane BEFORE the
		// clear ran — this abort really did finalize a record.
		expect(laneStatusOnDisk(directory, 'c-mix-dead')).toBe('stale');
		// The retained lane is untouched: the override runs only after a
		// successful clear, and this clear failed.
		expect(laneStatusOnDisk(directory, 'c-mix-alive')).toBe('pending');

		const retraction = (await readEvents()).find(
			(event) => event.type === 'pr_workflow_abort_not_completed',
		);
		expect(retraction).toMatchObject({
			probeRetentionOverrideFinalized: false,
		});
		const disclosure = String(retraction?.disclosure ?? '');
		// THE falsifying assertion. The prior wording ("This abort finalized no
		// delegation record") is false here: `c-mix-dead` IS a delegation record,
		// and this very abort's settlement pass finalized it to `stale` moments
		// before the clear failed. Only the override-scoped claim is true under
		// every interleaving.
		expect(disclosure).not.toContain(
			'This abort finalized no delegation record',
		);
		expect(disclosure).toContain(
			'The probe-retention override finalized no record',
		);
		// The settlement-batch caveat that makes the narrower claim honest: other
		// lanes in the SAME batch (like `c-mix-dead`) may already be finalized as
		// presumed-stale, independent of any concurrent second abort.
		expect(disclosure).toContain(
			'Other lanes in the same settlement batch may already have been finalized as presumed-stale',
		);
		expect(disclosure).toContain(
			'revalidate the lane records rather than assuming they are untouched',
		);
	});
});
