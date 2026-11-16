/**
 * #3710 regression — the Lean Turbo lane runner's post-dispatch
 * `sanitizeFailureEvidenceDisplay` wrap must redact the lane failure BEFORE
 * it reaches the durable lane evidence and the returned LaneResult.
 *
 * Sink (src/turbo/lean/runner.ts `_processLane`, post-dispatch wrap): after
 * `dispatchWithModelFallback` settles (including the rethrown-error catch),
 * every failing `dispatchResult.error` is rewritten through
 * `sanitizeFailureEvidenceDisplay` and only THEN flows into
 * `laneInState.error`, the `_writeLaneEvidenceSafely(..., 'failed',
 * {error})` artifact (`.swarm/evidence/<phase>/lean-turbo/<laneId>.json`,
 * written by the REAL `writeLaneEvidence`), and the returned LaneResult.
 *
 * This test drives the real `_processLane` (private-by-convention, still
 * callable in TS tests) on a runner built like
 * runner-provider-error-3162-fixtures.ts: `_sessionOps` injection for the
 * SDK stub, `_internals` stubs ONLY for lane locks and the run-state read
 * (the phase), while `writeLaneEvidence` stays REAL so the persisted
 * artifact is produced by production code. The stub session.create
 * succeeds and session.prompt resolves WITHOUT `data` with a 401
 * token-bearing error, so `_doDispatch` returns the raw
 * `session.prompt failed: ${JSON.stringify(error)}` string, the model
 * fallback classifies it permanent and rethrows, and the catch feeds the
 * cleartext into the wrap under test.
 *
 * Mutation contract: removing the wrap's `sanitizeFailureEvidenceDisplay`
 * call makes this suite RED (cleartext token in the returned LaneResult and
 * in the persisted lane evidence). All tokens are synthetic.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../../src/config/constants';
import { resetSwarmState, startAgentSession } from '../../../../src/state';
import {
	type LaneResult,
	LeanTurboRunner,
} from '../../../../src/turbo/lean/runner';
import type { LeanTurboLane } from '../../../../src/turbo/lean/state';
import {
	canonicalMkdtemp,
	removeTreeWithRetry,
} from '../../../helpers/tmpdir.js';

const SYNTH_TOKEN = 'sk-SynthAbCdEf12345678901234567890';
const SYNTH_OPENAI_PLACEHOLDER = '[REDACTED:openai]';
const SESSION_ID = 'sess-lean-post-dispatch-3710';
const PHASE = 1;

const LANE: LeanTurboLane = {
	laneId: 'lane-redact-3710',
	taskIds: ['1.1'],
	files: ['src/a.ts'],
	status: 'pending',
};

const LEAN_CONFIG = {
	...DEFAULT_LEAN_TURBO_CONFIG,
	// No worktree provisioning: the failure under test is the provider
	// dispatch, and provisioning would drag git machinery into the fixture.
	worktree_isolation: false,
} as typeof DEFAULT_LEAN_TURBO_CONFIG;

/** Saved `_internals` members replaced in beforeEach, restored in afterEach. */
const internals = LeanTurboRunner._internals;
const savedAcquireLaneLocks = internals.acquireLaneLocks;
const savedReleaseLaneLocks = internals.releaseLaneLocks;
const savedLoadLeanTurboRunState = internals.loadLeanTurboRunState;

interface LaneEvidenceShape {
	error?: string;
	status?: string;
}

let tmpDir: string;

/** `_processLane` is private-by-convention; invoke it through a structural cast. */
type ProcessLane = (
	lane: LeanTurboLane,
	leanConfig: typeof DEFAULT_LEAN_TURBO_CONFIG,
	plan?: undefined,
) => Promise<LaneResult>;

beforeEach(() => {
	resetSwarmState();
	startAgentSession(SESSION_ID, 'architect');
	tmpDir = canonicalMkdtemp('lean-post-dispatch-3710-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });

	// Lane locks: stubbed so no lock files or cross-lane state are needed.
	internals.acquireLaneLocks = mock(async () => ({
		acquired: true,
	})) as unknown as typeof internals.acquireLaneLocks;
	internals.releaseLaneLocks = mock(
		async () => undefined,
	) as unknown as typeof internals.releaseLaneLocks;

	// Run-state read: the ONLY thing _writeLaneEvidenceSafely needs from it
	// is the phase, and _updateDurableStateLaneStatus needs the lane row.
	// writeLaneEvidence itself stays REAL so the evidence artifact is
	// production output.
	internals.loadLeanTurboRunState = mock(() => ({
		sessionID: SESSION_ID,
		status: 'running' as const,
		strategy: 'lean' as const,
		phase: PHASE,
		maxParallelCoders: 2,
		lanes: [{ ...LANE }],
		serializedTasks: [],
		degradedTasks: [],
		counters: {
			lanesPlanned: 1,
			lanesStarted: 1,
			lanesCompleted: 0,
			lanesFailed: 0,
			tasksSerialized: 0,
			tasksDegraded: 0,
		},
	})) as unknown as typeof internals.loadLeanTurboRunState;
});

afterEach(() => {
	internals.acquireLaneLocks = savedAcquireLaneLocks;
	internals.releaseLaneLocks = savedReleaseLaneLocks;
	internals.loadLeanTurboRunState = savedLoadLeanTurboRunState;
	resetSwarmState();
	removeTreeWithRetry(tmpDir);
	mock.restore();
});

describe('lean runner post-dispatch redaction wrap (#3710)', () => {
	test('failed lane result and persisted lane evidence carry the redacted provider error', async () => {
		const runner = new LeanTurboRunner({
			directory: tmpDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['coder'],
			leanConfig: LEAN_CONFIG,
		});
		// SDK stub: create succeeds, prompt resolves WITHOUT data with a
		// 401 token-bearing error (the _doDispatch prompt-failure branch).
		(runner as unknown as { _sessionOps: unknown })._sessionOps = {
			create: mock(async () => ({
				data: { id: 'lane-child-redact-3710' },
				error: null,
			})),
			prompt: mock(async () => ({
				data: undefined,
				error: {
					name: 'ProviderError',
					message: `Invalid API key provided: ${SYNTH_TOKEN}. You can find your API key at https://platform.openai.example/account/api-keys.`,
					statusCode: 401,
				},
			})),
			delete: mock(async () => undefined),
		};
		// In-memory lane status row, as runPhase would have registered.
		(
			runner as unknown as { _laneStatuses: Map<string, LeanTurboLane> }
		)._laneStatuses.set(LANE.laneId, { ...LANE });

		const result = await (
			runner as unknown as { _processLane: ProcessLane }
		)._processLane(LANE, LEAN_CONFIG, undefined);

		// Posture unchanged: a permanent provider failure fails the lane.
		expect(result.status).toBe('failed');
		// The returned LaneResult error is the REDACTED wrap…
		expect(result.error).toContain(SYNTH_OPENAI_PLACEHOLDER);
		expect(
			result.error?.includes(SYNTH_TOKEN),
			`LaneResult error carries token cleartext: ${result.error}`,
		).toBe(false);

		// …and so is the persisted lane evidence written by the REAL
		// writeLaneEvidence under .swarm/evidence/<phase>/lean-turbo/.
		const evidencePath = path.join(
			tmpDir,
			'.swarm',
			'evidence',
			String(PHASE),
			'lean-turbo',
			`${LANE.laneId}.json`,
		);
		expect(fs.existsSync(evidencePath)).toBe(true);
		const evidence = JSON.parse(
			fs.readFileSync(evidencePath, 'utf-8'),
		) as LaneEvidenceShape;
		expect(evidence.status).toBe('failed');
		expect(evidence.error).toContain(SYNTH_OPENAI_PLACEHOLDER);
		expect(
			evidence.error?.includes(SYNTH_TOKEN),
			`lane evidence error carries token cleartext: ${evidence.error}`,
		).toBe(false);
	}, 60_000);
});
