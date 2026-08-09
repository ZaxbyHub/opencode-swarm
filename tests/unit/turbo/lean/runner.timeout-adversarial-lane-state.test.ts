/**
 * Adversarial security tests for LeanTurboRunner — concurrent timeout race on
 * `_timedOutLanes` state, split out of `runner.timeout-adversarial.test.ts`
 * under FR-006 (500-line test-file cap) once that file grew past the cap.
 *
 * Attack vector tested:
 * - Concurrent timeout races on the `_timedOutLanes` Map, including two
 *   lanes sharing the same `laneId` and rapid concurrent timeouts across
 *   distinct lanes that must not corrupt shared timeout-tracking state.
 *
 * Strategy:
 * - Uses a real canonicalized temp dir
 * - Injects mock SessionClient via the `_sessionOps` instance seam
 * - Builds lanes as literals and calls `dispatchLane` directly: this file does
 *   not exercise lane planning or lock acquisition (the sibling file's header
 *   claims both; that claim is inherited boilerplate — it does not hold there
 *   either — and is deliberately not repeated here)
 * - No mock.module usage — all mocking via instance seam or _internals
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LeanTurboLane } from '../../../../src/turbo/lean/planner';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import * as leanState from '../../../../src/turbo/lean/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const SESSION_ID = 'sess-timeout-adversarial';

interface MockSessionOps {
	create: ReturnType<typeof mock>;
	prompt: ReturnType<typeof mock>;
	delete: ReturnType<typeof mock>;
}

let tmpDir: string;

function makeRunner(options?: {
	opencodeClient?: null;
	generatedAgentNames?: string[];
}) {
	return new LeanTurboRunner({
		directory: tmpDir,
		sessionID: SESSION_ID,
		...options,
	});
}

function injectMockSessionOps(runner: LeanTurboRunner, ops: MockSessionOps) {
	(runner as unknown as { _sessionOps: MockSessionOps })._sessionOps = ops;
}

/**
 * Interval between poll checks used by both bounded-poll helpers below.
 *
 * Deliberately 15ms rather than something smaller. Windows quantizes timer
 * waits to its ~15.6ms scheduler tick, so `Bun.sleep(1)` and `Bun.sleep(5)`
 * BOTH cost ~15.4ms there (measured on a Windows CI-class box) while costing
 * ~1ms and ~5ms on Linux. A sub-tick interval therefore makes the per-poll
 * cost differ by up to 15x across the matrix, which is what made an earlier
 * millisecond-denominated bound overshoot its stated deadline ~3x on Windows
 * and become unreachable. At 15ms the measured per-poll cost is ~19ms on
 * Windows and ~15ms on Linux — close enough that one poll budget is honest on
 * both.
 */
const POLL_INTERVAL_MS = 15;

/**
 * Default poll budget for both helpers. The slowest condition either one waits
 * on is the `session.delete` driven by a mock that sleeps 500ms — measured at
 * ~26 polls on Windows (where each poll costs more than its nominal interval,
 * so fewer are needed to cover the same wall time) and ~33 on Linux; 260
 * gives the worse of those roughly 8x headroom. Worst-case wall time is
 * `maxPolls x` the platform's real cost for `Bun.sleep(POLL_INTERVAL_MS)`:
 * measured ~5.0s on Windows, ~3.9s on Linux. Both must stay INSIDE the
 * per-test budget or the helpers' `throw` is dead code and a hung test
 * surfaces as an opaque harness timeout instead of the diagnostic below.
 */
const DEFAULT_MAX_POLLS = 260;

/**
 * Per-test budget for both tests below. Sized ABOVE the helpers' worst-case
 * poll cost (~5.0s on Windows) so an exhausted poll budget surfaces as the
 * helper's own diagnostic rather than an opaque "this test timed out" from the
 * harness. It is not itself a timing assertion — nothing in either test waits
 * on it — but it must stay explicit, because CI does not run at bun's 5s
 * default: `scripts/ci/run-test-with-timeout.ts` DEFAULTS the sharded unit job
 * to `--timeout 120000` (it injects that only when the caller passed no
 * `--timeout`, so a caller-supplied value wins) and the coverage gate passes
 * `--timeout 60000`, either of which would let a genuinely hung test sit for a
 * minute or more.
 */
const POLL_TEST_BUDGET_MS = 12_000;

/**
 * Bounded poll for T6's "does `_timedOutLanes` drain" assertion. No shared
 * helper for this exists in `tests/helpers/`, and this is the only call site
 * in this file, so it is kept local rather than promoted.
 *
 * Bounded by POLL COUNT, not by elapsed wall-clock time. Two reasons, and the
 * bound is deliberately expressed in polls rather than milliseconds so the
 * signature cannot make a timing claim that is false on some platform:
 *
 * 1. `scripts/check-test-clock.sh` is a required CI gate (its step in the
 *    `quality` job of ci.yml — cited by construct, not line, because edits
 *    to ci.yml shift line numbers and stale citations have already had to be
 *    corrected twice in this changeset) that
 *    blocks a test file performing a raw timestamp read or installing a spy
 *    on the date object, unless the file imports the freeze-clock helper
 *    module OR calls one of its wrappers. The gate is LINE-SCOPED, not
 *    file-scoped (`check-test-clock.sh:82-102`): only lines the diff ADDS
 *    can block, which is why the sibling file this one was split from still
 *    passes with 4 pre-existing hits. Freezing the clock here would break a
 *    poll that depends on real time advancing, so the only way to satisfy
 *    the gate is not to read the clock at all.
 *    NOTE: that gate greps for its patterns WITHOUT excluding comments, so
 *    spelling the forbidden call syntax out here — even inside this docstring
 *    — would itself trip it. Describe the APIs; do not write them.
 * 2. A millisecond-denominated bound cannot be honest across the matrix — see
 *    `POLL_INTERVAL_MS` above for the Windows tick-quantization measurements.
 *
 * The helper still waits exactly as long as the background cleanup takes
 * (returning on the first satisfied check) rather than sleeping a fixed guess,
 * and fails loudly when the budget is exhausted instead of hanging. Do NOT
 * reintroduce elapsed-time measurement against a raw timestamp read here.
 */
async function pollUntilDrained(
	map: Map<string, string>,
	maxPolls: number = DEFAULT_MAX_POLLS,
): Promise<void> {
	for (let i = 0; i < maxPolls; i++) {
		if (map.size === 0) return;
		await Bun.sleep(POLL_INTERVAL_MS);
	}
	if (map.size > 0) {
		throw new Error(
			`_timedOutLanes did not drain within ${maxPolls} polls of ${POLL_INTERVAL_MS}ms; ${map.size} entries remain: ${JSON.stringify([...map.entries()])}`,
		);
	}
}

/**
 * Bounded poll for a `mock()` having been called at least once. Same
 * poll-count rationale as `pollUntilDrained` above — no raw clock read, so it
 * stays clear of the `check-test-clock.sh` gate without needing to freeze a
 * clock that this poll depends on actually advancing.
 */
async function pollUntilCalled(
	mockFn: ReturnType<typeof mock>,
	maxPolls: number = DEFAULT_MAX_POLLS,
): Promise<void> {
	for (let i = 0; i < maxPolls; i++) {
		if (mockFn.mock.calls.length > 0) return;
		await Bun.sleep(POLL_INTERVAL_MS);
	}
	if (mockFn.mock.calls.length === 0) {
		throw new Error(
			`mock was not called within ${maxPolls} polls of ${POLL_INTERVAL_MS}ms`,
		);
	}
}

function writeMinimalPlan(phaseNumber = 1) {
	const plan = {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: phaseNumber,
		phases: [
			{
				id: phaseNumber,
				name: `Phase ${phaseNumber}`,
				status: 'in_progress',
				tasks: [
					{
						id: `${phaseNumber}.1`,
						description: 'Task 1',
						status: 'pending',
						phase: phaseNumber,
						size: 'small',
						depends: [],
						acceptance: 'Done',
					},
					{
						id: `${phaseNumber}.2`,
						description: 'Task 2',
						status: 'pending',
						phase: phaseNumber,
						size: 'small',
						depends: [],
						acceptance: 'Done',
					},
				],
			},
		],
		lean: {
			max_parallel_coders: 4,
			require_declared_scope: false,
			conflict_policy: 'serialize',
			degrade_on_risk: true,
			phase_reviewer: false,
			phase_critic: false,
			integrated_diff_required: false,
			allow_docs_only_without_reviewer: false,
			worktree_isolation: false,
		},
	};

	fs.writeFileSync(
		path.join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf-8',
	);
}

function writeScopeFiles(taskFiles: Record<string, string[]>) {
	const scopeDir = path.join(tmpDir, '.swarm', 'scopes');
	fs.mkdirSync(scopeDir, { recursive: true });
	for (const [taskId, files] of Object.entries(taskFiles)) {
		fs.writeFileSync(
			path.join(scopeDir, `scope-${taskId}.json`),
			JSON.stringify({ files }),
			'utf-8',
		);
	}
}

beforeEach(() => {
	// FR-011: the canonical helper is required here, not the two-call
	// realpath-wrap idiom the sibling file uses. That idiom is tolerated there
	// only because its lines are pre-existing; the lint is line-scoped, so in
	// an all-added file every line counts as added and the wrap — which biome
	// splits across lines — fails the same-line requirement.
	tmpDir = canonicalMkdtemp('runner-timeout-adversarial-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	leanState.repairStateUnreadable(tmpDir);
	// Reset timeout to undefined before each test
	LeanTurboRunner._internals.laneDispatchTimeoutMs = undefined;
});

afterEach(() => {
	leanState.repairStateUnreadable(tmpDir);
	LeanTurboRunner._internals.laneDispatchTimeoutMs = undefined;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR T6: Concurrent timeout race on _timedOutLanes Map
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR T6 — concurrent timeout race on _timedOutLanes', () => {
	test(
		'two lanes with same laneId do not interfere on _timedOutLanes',
		async () => {
			writeMinimalPlan(1);
			writeScopeFiles({ '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] });

			const sessionId1 = `session-1-${Math.random().toString(36).slice(2)}`;
			const sessionId2 = `session-2-${Math.random().toString(36).slice(2)}`;

			// Both lanes share the same laneId (adversarial input)
			const lane1: LeanTurboLane = {
				laneId: 'same-lane-id', // Same laneId
				taskIds: ['1.1'],
				files: ['src/a.ts'],
				status: 'pending',
			};
			const lane2: LeanTurboLane = {
				laneId: 'same-lane-id', // Same laneId
				taskIds: ['1.2'],
				files: ['src/b.ts'],
				status: 'pending',
			};

			const createMock = mock((opts: { query: { directory: string } }) => {
				const id = opts.query.directory === tmpDir ? sessionId1 : sessionId2;
				return Promise.resolve({ data: { id }, error: null });
			});
			const promptMock = mock(() =>
				Bun.sleep(500).then(() =>
					Promise.resolve({
						data: { parts: [{ type: 'text', text: 'Done' }] },
						error: null,
					}),
				),
			);
			const deleteMock = mock(() => Promise.resolve());

			const concurrentOps = {
				create: createMock,
				prompt: promptMock,
				delete: deleteMock,
			};

			const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
			injectMockSessionOps(runner, concurrentOps);

			LeanTurboRunner._internals.laneDispatchTimeoutMs = 20;

			// Dispatch both lanes with same laneId concurrently
			const [result1, result2] = await Promise.all([
				runner.dispatchLane(lane1, 'mega_coder'),
				runner.dispatchLane(lane2, 'mega_coder'),
			]);

			// Both should get timeout errors
			expect(result1.ok).toBe(false);
			expect(result2.ok).toBe(false);
			expect(result1.error).toContain('timed out');
			expect(result2.error).toContain('timed out');

			// The prompt mock settles 500ms after being invoked (the scenario under
			// test — a session that eventually completes AFTER its dispatch already
			// timed out). The old shape observed that with a single fixed
			// `await Bun.sleep(600)`: only 100ms of slack over the mock's own
			// 500ms delay, a 1.2x margin — the same flake class that evicted PR
			// #2080 from the merge queue. Poll the actual observable condition
			// instead (the mock having been called), with no fixed margin to blow
			// through under load: this waits exactly as long as the background
			// cleanup takes, up to the per-test budget below, rather than guessing
			// a window that can be too short.
			await pollUntilCalled(deleteMock);

			// At least one orphan session was cleaned up. Deliberately NOT
			// `toHaveBeenCalledTimes(2)`: both lanes share a laneId, so the
			// first completion handler clears the map entry and the second
			// finds `tracked === undefined` and takes the branch that only
			// clears the marker (runner.ts) — the second lane's session is
			// never deleted. That orphan leak is real but pre-existing and
			// adversarial-input-only (duplicate laneId); this assertion
			// records what actually happens rather than asserting a cleanup
			// the production code does not perform.
			expect(deleteMock).toHaveBeenCalled();
		},
		POLL_TEST_BUDGET_MS,
	);

	test(
		'rapid concurrent timeouts on different lanes do not corrupt _timedOutLanes state',
		async () => {
			writeMinimalPlan(1);
			writeScopeFiles({
				'1.1': ['src/a.ts'],
				'1.2': ['src/b.ts'],
			});

			// 2 lanes that timeout quickly
			const lanes: LeanTurboLane[] = [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: ['src/a.ts'],
					status: 'pending',
				},
				{
					laneId: 'lane-2',
					taskIds: ['1.2'],
					files: ['src/b.ts'],
					status: 'pending',
				},
			];

			// The old shape raced two real timers 4x apart: `laneDispatchTimeoutMs
			// = 5` against a prompt mock that rejected via `setTimeout(..., 20)`,
			// fired concurrently across both lanes through `Promise.all`. A
			// loaded CI runner narrowing that 15ms gap made the dispatch-timeout
			// race itself nondeterministic — the exact flake class that evicted
			// PR #2080 from the merge queue.
			//
			// Fix: the prompt mock never settles on its own. It captures each
			// call's `reject` into `promptRejectFns` instead of scheduling one.
			// With no rival timer, `dispatchLane`'s own `laneDispatchTimeoutMs`
			// setTimeout (src/turbo/lean/runner.ts:758-766) is the ONLY thing
			// that can ever settle the `Promise.race` — the `ok:false` / 'timed
			// out' assertions below are a deterministic lower bound, not a race.
			//
			// That determinism only covers the first half of this test. The
			// second half asserts `_timedOutLanes` DRAINS — and per
			// runner.ts:777-807, the drain only happens once `dispatchPromise`
			// (i.e. `_doDispatch`, which is still running `session.prompt` in
			// the background after the timeout already won) itself settles.
			// `_doDispatch` catches its own rejections internally
			// (runner.ts:936-947) and always RESOLVES with `{ ok: false, error }`
			// rather than rejecting, so the drain runs through the `.then`
			// handler's `else` branch (runner.ts:800-801), not the outer
			// `.catch`. A prompt that never settles would make that resolution —
			// and therefore the drain — unobservable: the `size === 0`
			// assertion below would then fail on an exhausted poll budget
			// rather than on the defect it exists to catch, which is a much
			// worse diagnostic. So every captured reject is explicitly fired,
			// with the same error, AFTER the timeout assertions, to drive that
			// cleanup.
			const promptRejectFns: Array<(err: Error) => void> = [];
			const rejectPromptOps = {
				create: mock(() =>
					Promise.resolve({
						data: { id: `session-${Math.random().toString(36).slice(2)}` },
						error: null,
					}),
				),
				prompt: mock(
					() =>
						new Promise<never>((_, reject) => {
							promptRejectFns.push(reject);
						}),
				),
				delete: mock(() => Promise.resolve()),
			};

			const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
			injectMockSessionOps(runner, rejectPromptOps);

			LeanTurboRunner._internals.laneDispatchTimeoutMs = 5;

			// Fire all dispatches concurrently
			const results = await Promise.all(
				lanes.map((lane) => runner.dispatchLane(lane, 'mega_coder')),
			);

			// All should timeout — the dispatch-side timer is the sole resolver
			// now, so this holds regardless of scheduler load.
			for (const result of results) {
				expect(result.ok).toBe(false);
				expect(result.error).toContain('timed out');
			}

			// Every lane that timed out sets its sentinel synchronously inside the
			// `catch` block that raced the timeout (runner.ts:775), before
			// `dispatchLane` returns. Since `results` above has already resolved
			// for every lane, the sentinels are guaranteed to be populated by this
			// point — assert that BEFORE the drain below, so a mutation that
			// deletes the `.set(...'__pending__')` call at runner.ts:775 (and
			// therefore never populates `_timedOutLanes` at all) cannot leave the
			// `size === 0` drain assertion vacuously true. Without this, "went
			// from populated to empty" and "was never populated" are
			// indistinguishable.
			const timedOutLanes = (
				runner as unknown as { _timedOutLanes: Map<string, string> }
			)._timedOutLanes;
			expect(timedOutLanes.size).toBe(lanes.length);

			// `session.create` is an already-resolved promise and `session.prompt`
			// is called on the microtask chain immediately after — both drain
			// before the 5ms macrotask timer above can fire, so every lane's
			// reject function is captured by this point without needing a poll.
			expect(promptRejectFns.length).toBe(lanes.length);
			for (const reject of promptRejectFns) {
				reject(new Error('Prompt rejected'));
			}

			// _timedOutLanes should drain once each `_doDispatch` resolves (with
			// `{ ok: false, error: 'Prompt rejected' }`, per its internal catch)
			// and the `.then` handler's cleanup branch runs. That is background
			// work with no signal this test can `await` directly, so poll for it
			// instead of guessing a fixed delay: this waits exactly as long as
			// the machine needs and only fails on genuine breakage, unlike a
			// fixed sleep that can be too short under load or needlessly long
			// otherwise.
			await pollUntilDrained(timedOutLanes);

			expect(timedOutLanes.size).toBe(0);
		},
		POLL_TEST_BUDGET_MS,
	);
});
