import { mock } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPendingDelegation } from '../../../src/background/pending-delegations';
import { _internals, type SessionOps } from '../../../src/tools/dispatch-lanes';

export const BASE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';

/**
 * Issue #2572: a fixed collection clock epoch. Freshly recorded delegations carry
 * `updatedAt` from the real clock (~1.79e12), so `DETERMINISTIC_EPOCH - updatedAt` is
 * negative ~9e10 — the stale sweep correctly reads that as not-stale, while the
 * budget math (`deadline - now`) stays constant instead of eroding under CI stalls.
 */
const DETERMINISTIC_COLLECTION_EPOCH = 1_700_000_000_000;

export function createCollectLaneTimeoutFixture(
	options: { deterministicClock?: boolean } = {},
) {
	const originalInternals = { ..._internals };
	// Issue #2572: the merge-group flake's outcome-flip family. The budget
	// reservation reads `_internals.now()` at call time, so any event-loop
	// stall >= timeout_ms between the deadline assignment and the first
	// per-lane slice zeroed every budget and flipped salvage outcomes to
	// pending. Pinning the clock keeps `remainingMs === timeout_ms` forever;
	// real-timer slices still bound the hung host calls. Consumers whose
	// wait:true scenarios depend on real deadline progression opt out with
	// `{ deterministicClock: false }` (their files say so in comments).
	// The runbook cure: docs/testing/test-stability.md, Class 1/2. The pin is
	// re-appliable because restoreInternals() (afterEach) puts the real clock
	// back — the owning test file re-pins in beforeEach so every test starts
	// deterministic while the process is left clean after the final restore.
	const pinCollectionClock = () => {
		_internals.now = () => DETERMINISTIC_COLLECTION_EPOCH;
	};
	if (options.deterministicClock !== false) {
		pinCollectionClock();
	}
	const directories: string[] = [];

	async function withTestDeadline<T>(promise: Promise<T>): Promise<T> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error('test deadline exceeded')),
						// Issue #2572 hang-guard arithmetic: correct wiring costs
						// <= ~150ms idle (measured; the heaviest salvage scenario
						// runs ~138-151ms), and PR #2587-class runner stalls run
						// into the hundreds of ms, so 500ms left only ~3.4x
						// headroom. 2500ms keeps the guard a true hang bound (any
						// bounding regression still trips) while tolerating those
						// stalls; worst case 12 x 2.5s = 30s stays inside the
						// per-file 60s coverage budget.
						2500,
					);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	function makeTempDir(): string {
		const directory = realpathSync(
			mkdtempSync(join(tmpdir(), 'collect-host-timeout-')),
		);
		directories.push(directory);
		return directory;
	}

	async function recordPending(args: {
		directory: string;
		batchId: string;
		laneId?: string;
		correlationId?: string;
		mode?: string;
		workflowLane?: string;
		prReviewLegacyTranscriptCompatibility?: boolean;
		workspace?: {
			directory: string;
			gitHead: string;
			dirtyHash: string | null;
			prHeadSha: string;
			scope: string;
		};
	}): Promise<void> {
		const correlationId = args.correlationId ?? `${args.batchId}-session`;
		await recordPendingDelegation(args.directory, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: `${args.batchId}-parent`,
			callID: args.batchId,
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: args.batchId,
			laneId: args.laneId ?? `${args.batchId}-lane`,
			mode: args.mode ?? 'advisory',
			...(args.workflowLane ? { workflowLane: args.workflowLane } : {}),
			...(args.prReviewLegacyTranscriptCompatibility !== undefined
				? {
						prReviewLegacyTranscriptCompatibility:
							args.prReviewLegacyTranscriptCompatibility,
					}
				: args.mode === 'swarm-pr-review:base' ||
						args.mode === 'swarm-pr-review:micro'
					? { prReviewLegacyTranscriptCompatibility: true }
					: {}),
			...(args.workspace ? { workspace: args.workspace } : {}),
			promptHash: `${args.batchId}-hash`,
			generation: 1,
		});
	}

	function baseOps(): Pick<SessionOps, 'create' | 'prompt' | 'delete'> {
		return {
			create: mock(async () => ({ data: { id: 'unused' } })),
			prompt: mock(async () => ({ data: null })),
			delete: mock(async () => undefined),
		};
	}

	function assistantMessage(
		text: string,
		overrides: Partial<
			NonNullable<
				Awaited<ReturnType<NonNullable<SessionOps['messages']>>>['data']
			>[number]['info']
		> = {},
	) {
		return {
			info: {
				role: 'assistant',
				time: { completed: 2 },
				finish: 'stop',
				...overrides,
			},
			parts: [{ type: 'text', text }],
		};
	}

	function restoreInternals(): void {
		Object.assign(_internals, originalInternals);
	}

	async function cleanupTempDirs(): Promise<void> {
		await Promise.all(
			directories
				.splice(0)
				.map((directory) => rm(directory, { recursive: true, force: true })),
		);
	}

	return {
		assistantMessage,
		baseOps,
		cleanupTempDirs,
		makeTempDir,
		pinCollectionClock,
		recordPending,
		restoreInternals,
		withTestDeadline,
	};
}
