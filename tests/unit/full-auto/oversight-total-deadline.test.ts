/**
 * Issue #2103 workstream G: one total deadline around the oversight operation.
 * Session creation, prompt, retries, backoff, and cleanup must all stop within
 * it; timeout is recorded distinctly from rejection; the risky action stays
 * denied and recovery controls remain reachable.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	dispatchFullAutoOversight,
	_internals as oversightInternals,
} from '../../../src/full-auto/oversight';
import {
	loadFullAutoRunState,
	startFullAutoRun,
} from '../../../src/full-auto/state';
import { _internals as stateInternals } from '../../../src/state';
import { abortDeadline } from '../../../src/utils/abort-deadline';

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;
const origDeadline = oversightInternals.newDeadline;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'oversight-deadline-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	oversightInternals.newDeadline = origDeadline;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

function baseInput() {
	return {
		directory: tmpDir,
		sessionID: 'sess-deadline',
		triggerSource: 'high_risk_action' as const,
		oversightAgentName: 'critic_oversight',
		criticModel: 'test/critic',
		inputSummary: 'risky action proposal',
		phase: 'implementation',
	};
}

describe('oversight total deadline (#2103 G)', () => {
	test('a prompt that never resolves returns within the deadline with a distinct TIMEOUT reason', async () => {
		startFullAutoRun(tmpDir, 'sess-deadline', { enabled: true });
		// Inject a short deadline so the test does not wait 10s.
		oversightInternals.newDeadline = (ms: number) =>
			abortDeadline(Math.min(ms, 50));

		const promptAborted = false;
		stateInternals.swarmState.opencodeClient = {
			session: {
				create: mock(async () => ({ data: { id: 'eph-1' }, error: null })),
				prompt: mock(
					(_req: unknown) =>
						new Promise(() => {
							// never resolves — simulates a hung host
						}),
				),
				// capture abort via signal on the request is host-side; we assert the
				// deadline fired via the returned reason instead.
				get: mock(async () => ({ data: { id: 'eph-1' }, error: null })),
				del: mock(async () => ({ data: undefined, error: null })),
			},
		} as unknown as typeof stateInternals.swarmState.opencodeClient;
		void promptAborted;

		const startedAt = Date.now();
		const result = await dispatchFullAutoOversight(baseInput());
		const elapsed = Date.now() - startedAt;

		// The caller returns at (roughly) the deadline even though the delegate
		// never resolves.
		expect(elapsed).toBeLessThan(5_000);
		expect(result.verdict).toBe('BLOCKED');
		expect(result.reasoning).toContain('OVERSIGHT TIMEOUT');
		expect(result.reasoning).toContain('/swarm full-auto status');

		// The run is paused (risky action denied), not silently continued.
		const runState = loadFullAutoRunState(tmpDir, 'sess-deadline');
		expect(['paused', 'terminated']).toContain(runState?.status);
	}, 20_000);

	test('a fast successful dispatch is unaffected by the deadline', async () => {
		startFullAutoRun(tmpDir, 'sess-fast', { enabled: true });
		oversightInternals.newDeadline = (ms: number) =>
			abortDeadline(Math.min(ms, 5_000));

		stateInternals.swarmState.opencodeClient = {
			session: {
				create: mock(async () => ({ data: { id: 'eph-ok' }, error: null })),
				prompt: mock(async () => ({
					data: {
						parts: [
							{
								type: 'text',
								text: 'VERDICT: APPROVED\nREASONING: fine\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
							},
						],
					},
					error: null,
				})),
				del: mock(async () => ({ data: undefined, error: null })),
			},
		} as unknown as typeof stateInternals.swarmState.opencodeClient;

		const input = baseInput();
		input.sessionID = 'sess-fast';
		const result = await dispatchFullAutoOversight(input);
		expect(result.verdict).toBe('APPROVED');
	}, 20_000);
});
