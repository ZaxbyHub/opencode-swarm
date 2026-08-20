/**
 * Issue #2251 — a force override must leave the session RESTARTABLE.
 *
 * The override clears the gate over lanes the liveness probe reported alive.
 * `countOpenPrWorkflowLanes` (`src/tools/prepare-pr-workflow-checkout.ts`) counts
 * every `pending`/`running` `swarm-pr-*` record of the session with NO age filter
 * and NO horizon, and is not routed through the settlement — so leaving those
 * records `pending` traded an unexitable gate for an un-restartable session:
 * `prepare_pr_workflow_checkout` refused forever, since the retained lane never
 * terminates (that is the very hypothesis the override exists for).
 *
 * This suite drives the real tool against a real Git repository. The refusal is
 * asserted BEFORE the override as well as its absence after — without that half
 * the test would pass against an implementation where the block never existed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	abortPrWorkflow,
	activatePrWorkflow,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executePreparePrWorkflowCheckout } from '../../../src/tools/prepare-pr-workflow-checkout.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';
import {
	backdatePrWorkflowLane,
	laneStatusOnDisk,
	laneSubagentSessionId,
	recordOpenPrWorkflowLane,
	STALE_LANE_AGE_MS,
} from '../../helpers/pr-workflow-lane-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'restart-controller';
const DIRTY_PATH = 'unrelated.txt';
const GIT_TIMEOUT_MS = 30_000;
let directory = '';
let restoreClock: () => void = () => {};

async function expectGitSuccess(args: string[]): Promise<void> {
	const proc = bunSpawn(['git', ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: GIT_TIMEOUT_MS,
	});
	const [exitCode, stderr] = await Promise.all([
		proc.exited,
		proc.stderr.text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
	}
}

async function initializeRepository(): Promise<void> {
	await expectGitSuccess(['init', '-b', 'main']);
	await expectGitSuccess(['config', 'user.email', 'test@example.com']);
	await expectGitSuccess(['config', 'user.name', 'Restart Test']);
	await fs.writeFile(
		path.join(directory, '.git', 'info', 'exclude'),
		'.swarm/\n',
	);
	await fs.writeFile(path.join(directory, DIRTY_PATH), 'base\n', 'utf-8');
	await expectGitSuccess(['add', '.']);
	await expectGitSuccess(['commit', '-m', 'initial']);
	// The one path checkout preparation is asked to preserve. `assertExactDirtyPathSet`
	// requires the requested set to be EXACTLY the dirty set, so nothing else may move.
	await fs.writeFile(path.join(directory, DIRTY_PATH), 'edited\n', 'utf-8');
}

async function prepareCheckout(): Promise<{
	success: boolean;
	message?: string;
}> {
	return JSON.parse(
		await executePreparePrWorkflowCheckout({ paths: [DIRTY_PATH] }, directory, {
			sessionID: SESSION_ID,
		}),
	);
}

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

beforeEach(async () => {
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('pr-workflow-force-restart-');
	gateInternals.resetTrackedStateCache();
	await initializeRepository();
});

afterEach(async () => {
	restoreClock();
	// This IS the seam restore for every seam these suites replace —
	// `getSessionOps`, `sweepStaleDelegationsAsync` and `beforeAbortClear`.
	// `resetTrackedStateCache()` reassigns each to its NAMED module binding
	// (`defaultGetSessionOps`, the imported `sweepStaleDelegations`, `undefined`),
	// never to a hand-rewritten literal, so it restores rather than re-implements.
	// Hand-rolled restores here would be a second copy of those bindings and
	// exactly the pollution they are meant to prevent. It also runs on the failure
	// path, which the inline `beforeAbortClear = undefined` in the CAS test (kept
	// because that test's retry depends on it mid-test) does not.
	gateInternals.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('force override restores a restartable session', () => {
	test('prepare_pr_workflow_checkout is refused before the override and succeeds after it', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		await recordOpenPrWorkflowLane(
			directory,
			SESSION_ID,
			'lane-alive',
			'c-restart',
		);
		backdatePrWorkflowLane(directory, 'c-restart', STALE_LANE_AGE_MS);
		// The lane is past the horizon AND its session answers `busy` forever: the
		// probe retains it, so nothing settles it and no age ever will.
		gateInternals.getSessionOps = () => ({
			status: async () => ({
				data: { [laneSubagentSessionId('c-restart')]: { type: 'busy' } },
			}),
		});

		const blocked = await prepareCheckout();
		expect(blocked.success).toBe(false);
		expect(blocked.message).toContain(
			'checkout preparation is refused while 1 PR workflow lane(s) are in flight',
		);

		const summary = await abortPrWorkflow(directory, SESSION_ID, {
			kind: 'force',
			reason: 'lane wedged busy forever',
		});
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'force abort overrode 1 lane(s)',
		);
		// Terminal on disk — the durable half of the fix, not just the message.
		expect(laneStatusOnDisk(directory, 'c-restart')).toBe('stale');

		// The session can now run a fresh PR workflow. Without the finalization this
		// second call still reports the same BLOCKED refusal, with no way out short
		// of hand-editing the ledger.
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		const restarted = await prepareCheckout();
		expect(restarted.message).toBeUndefined();
		expect(restarted.success).toBe(true);
	});

	test('the override finalizes only its own session, never another session sharing the store', async () => {
		// The scoping constraint. The override narrows the sweep to exactly the
		// correlationIds THIS session's settlement reasoned about; a directory-wide
		// pass would also finalize a neighbouring session's overdue records, which
		// no operator asked about and which are counted by that session's own gate.
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		await recordOpenPrWorkflowLane(
			directory,
			SESSION_ID,
			'lane-mine',
			'c-mine',
		);
		await recordOpenPrWorkflowLane(
			directory,
			'other-session',
			'lane-theirs',
			'c-theirs',
		);
		// Backdated only after BOTH records exist, so no ordering assumption about
		// the lazy maintenance sweep inside `recordPendingDelegation` is baked in.
		backdatePrWorkflowLane(directory, 'c-mine', STALE_LANE_AGE_MS);
		backdatePrWorkflowLane(directory, 'c-theirs', STALE_LANE_AGE_MS);
		gateInternals.getSessionOps = () => ({
			status: async () => ({
				data: { [laneSubagentSessionId('c-mine')]: { type: 'busy' } },
			}),
		});

		await abortPrWorkflow(directory, SESSION_ID, {
			kind: 'force',
			reason: 'lane wedged busy forever',
		});

		expect(laneStatusOnDisk(directory, 'c-mine')).toBe('stale');
		expect(laneStatusOnDisk(directory, 'c-theirs')).toBe('pending');
	});
});

describe('the irreversible half is conditional on the reversible half (F1)', () => {
	test('a lost CAS on the clear destroys nothing, and the retry is a real override', async () => {
		// The finalization is irreversible — a `stale` record is never collected
		// again — while `clearPrWorkflowGateState` is CAS-guarded and can legitimately
		// throw. Finalizing FIRST meant a lost compare-and-swap left a provably-live
		// lane already abandoned, with an error naming neither the lane nor the
		// override, and the operator's retry then read as an ordinary force abort
		// over nothing.
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		await recordOpenPrWorkflowLane(
			directory,
			SESSION_ID,
			'lane-alive',
			'c-cas',
		);
		backdatePrWorkflowLane(directory, 'c-cas', STALE_LANE_AGE_MS);
		gateInternals.getSessionOps = () => ({
			status: async () => ({
				data: { [laneSubagentSessionId('c-cas')]: { type: 'busy' } },
			}),
		});
		const statePath = path.join(
			directory,
			'.swarm',
			gateInternals.workflowGateStateRelativePath(SESSION_ID),
		);
		// The concurrent mutation between the durable audit append and the clear.
		gateInternals.beforeAbortClear = async () => {
			const current = JSON.parse(await fs.readFile(statePath, 'utf-8'));
			await fs.writeFile(
				statePath,
				JSON.stringify({ ...current, revision: current.revision + 1 }),
				'utf-8',
			);
		};

		await expect(
			abortPrWorkflow(directory, SESSION_ID, {
				kind: 'force',
				reason: 'lane wedged busy forever',
			}),
		).rejects.toThrow(/changed during terminal completion/i);

		// THE assertion: nothing was destroyed. The lane's record is still open, so
		// its transcript is still collectable.
		expect(laneStatusOnDisk(directory, 'c-cas')).toBe('pending');
		const retraction = (await readEvents()).find(
			(event) => event.type === 'pr_workflow_abort_not_completed',
		);
		expect(retraction).toMatchObject({
			probeRetentionOverrideLanes: ['c-cas'],
			probeRetentionOverrideFinalized: false,
		});
		expect(retraction?.disclosure).toContain(
			'No delegation record was finalized',
		);

		// And the retry is a COMPLETE override, not a no-op force abort over lanes
		// a failed attempt already abandoned. Without this half the test would pass
		// against an implementation that reordered but lost retained-lane detection
		// on the retry path.
		gateInternals.beforeAbortClear = undefined;
		const retry = await abortPrWorkflow(directory, SESSION_ID, {
			kind: 'force',
			reason: 'retry after the losing compare-and-swap',
		});
		expect(retry.openLanes).toBe(1);
		expect(retry.probeRetainedLanes).toEqual(['lane-alive']);
		expect(retry.probeRetentionOverrideDisclosure).toContain(
			'force abort overrode 1 lane(s)',
		);
		expect(retry.probeRetentionOverrideDisclosure).toContain('lane-alive');
		expect(laneStatusOnDisk(directory, 'c-cas')).toBe('stale');
	});
});

describe('the override discloses restartability it can actually verify (F2)', () => {
	test('a settled-but-unswept lane in a mixed batch is named instead of claimed restartable', async () => {
		// `sweepStaleDelegations` swallows a store-lock timeout and returns 0, so the
		// ordinary settlement sweep can silently no-op: a lane this abort REPORTS as
		// settled stays `pending` on disk. `countOpenPrWorkflowLanes` is age-blind
		// and horizon-blind, so it refuses the next checkout preparation exactly like
		// an unfinalized retained lane — the very refusal this override exists to
		// remove. A read-back over only the OVERRIDDEN correlationIds cannot see it,
		// and every other override test uses an all-retained batch.
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		await recordOpenPrWorkflowLane(
			directory,
			SESSION_ID,
			'lane-alive',
			'c-alive',
		);
		await recordOpenPrWorkflowLane(
			directory,
			SESSION_ID,
			'lane-dead',
			'c-dead',
		);
		backdatePrWorkflowLane(directory, 'c-alive', STALE_LANE_AGE_MS);
		backdatePrWorkflowLane(directory, 'c-dead', STALE_LANE_AGE_MS);
		gateInternals.getSessionOps = () => ({
			status: async () => ({
				data: {
					[laneSubagentSessionId('c-alive')]: { type: 'busy' },
					[laneSubagentSessionId('c-dead')]: { type: 'idle' },
				},
			}),
		});
		// Discriminated on the option the two call sites differ by: the settlement
		// sweep excludes the retained lane, the override's finalization includes it.
		// Only the settlement sweep is made to no-op, exactly as a lock timeout does.
		const realSweep = gateInternals.sweepStaleDelegationsAsync;
		gateInternals.sweepStaleDelegationsAsync = async (
			sweepDirectory,
			timeoutMs,
			options,
		) =>
			options?.excludeCorrelationIds
				? 0
				: realSweep(sweepDirectory, timeoutMs, options);

		const summary = await abortPrWorkflow(directory, SESSION_ID, {
			kind: 'force',
			reason: 'lane wedged busy forever',
		});

		// The override itself worked: the retained lane is terminal.
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'force abort overrode 1 lane(s)',
		);
		expect(laneStatusOnDisk(directory, 'c-alive')).toBe('stale');
		// But the settled lane never went terminal, so the session is NOT restartable
		// — and the disclosure the human reads must say so rather than claim it.
		expect(laneStatusOnDisk(directory, 'c-dead')).toBe('pending');
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'WARNING: 1 PR workflow delegation record(s) for this session are still open (correlationId: c-dead)',
		);
		expect(summary.probeRetentionOverrideDisclosure).not.toContain(
			'A new PR workflow can now be started',
		);
		// The two claims are INDEPENDENT: the overridden lane's record did go
		// terminal, so its abandonment must still be stated even though the session
		// is not restartable. Suppressing both on one condition would hide the fact
		// that a live lane's transcript is now permanently gone.
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'Their delegation records were finalized (correlationId: c-alive); whatever those lanes still produce is no longer collectable.',
		);
		// Ground truth for that warning, through the tool that actually refuses.
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		const restarted = await prepareCheckout();
		expect(restarted.success).toBe(false);
		expect(restarted.message).toContain(
			'checkout preparation is refused while 1 PR workflow lane(s) are in flight',
		);
	});
});

describe('the abandonment clause states what it observed, not what is absent (N1)', () => {
	test('a targeted lane that races to completed is named collectable, never abandoned', async () => {
		// The clause used to be decided by ABSENCE from the still-open set. A lane
		// that reaches `completed` between the settlement read and the finalization
		// is spared by the sweep's own status filter, so it is absent for the
		// OPPOSITE reason a finalized lane is — and the clause fired anyway, over a
		// lane whose transcript was on disk and collectable. Telling an operator to
		// stop looking for recoverable output is the exact harm this issue removes.
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		await recordOpenPrWorkflowLane(
			directory,
			SESSION_ID,
			'lane-kept',
			'c-kept',
		);
		await recordOpenPrWorkflowLane(
			directory,
			SESSION_ID,
			'lane-race',
			'c-race',
		);
		backdatePrWorkflowLane(directory, 'c-kept', STALE_LANE_AGE_MS);
		backdatePrWorkflowLane(directory, 'c-race', STALE_LANE_AGE_MS);
		// BOTH lanes must be probe-retained. If only one were, the other would
		// settle through the ordinary sweep and never enter the override's targeted
		// set, and the race would be asserted against a lane nothing overrode.
		gateInternals.getSessionOps = () => ({
			status: async () => ({
				data: {
					[laneSubagentSessionId('c-kept')]: { type: 'busy' },
					[laneSubagentSessionId('c-race')]: { type: 'busy' },
				},
			}),
		});
		// The race: `c-race` finishes after the settlement decided it was retained
		// and before the finalization runs. It stays PAST the horizon on purpose —
		// the only thing sparing it is the sweep's STATUS filter, not its age, so a
		// regression cannot pass by accidentally sparing it for the wrong reason.
		gateInternals.beforeAbortClear = async () => {
			backdatePrWorkflowLane(
				directory,
				'c-race',
				STALE_LANE_AGE_MS,
				'completed',
			);
		};

		const summary = await abortPrWorkflow(directory, SESSION_ID, {
			kind: 'force',
			reason: 'lanes wedged busy forever',
		});

		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'force abort overrode 2 lane(s)',
		);
		// Ground truth on disk: one lane abandoned, one intact with its result.
		expect(laneStatusOnDisk(directory, 'c-kept')).toBe('stale');
		expect(laneStatusOnDisk(directory, 'c-race')).toBe('completed');
		// The abandonment clause names ONLY the record observed terminal `stale`.
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'Their delegation records were finalized (correlationId: c-kept); whatever those lanes still produce is no longer collectable.',
		);
		// THE assertion: the raced lane is never inside the uncollectable set.
		expect(summary.probeRetentionOverrideDisclosure).not.toMatch(
			/finalized \(correlationId: [^)]*c-race/,
		);
		// It is named WITH its observed status instead of silently written off. The
		// clause says "left intact", never "collectable": `error`,
		// `ingestion_error` and `ingesting` can land in this same bucket, and
		// promising output for those would be the mirror of the bug being fixed.
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'1 of the overridden lane(s) were NOT finalized: the sweep left those records intact at the status they had already reached (c-race (completed)). This abort did not discard them — check collect_lane_results before assuming that work is gone.',
		);
		// The restartability clause stays INDEPENDENT and unchanged: neither record
		// is open afterwards, so the session genuinely can restart.
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'A new PR workflow can now be started for this session.',
		);
	});
});
