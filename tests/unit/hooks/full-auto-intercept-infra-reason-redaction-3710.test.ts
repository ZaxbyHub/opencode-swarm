/**
 * #3710 regression — the legacy intercept path's exhausted-retry
 * `infraReason` must carry REDACTED provider error text into the REAL
 * pause persistence seam.
 *
 * Sink (src/hooks/full-auto-intercept.ts, the non-retry arm of the
 * SC-011 dispatch loop): after retries exhaust, the below-threshold arm
 * builds
 *   `oversight infrastructure failure after N attempt(s): ${sanitizeFailureEvidenceDisplay(...)}`
 * and hands it to `pauseFullAutoRun`, which persists it as
 * `sessions[sessionID].pauseReason` in `.swarm/full-auto-state.json`.
 * Before #3710 the provider message (which embeds a credential token in the
 * `Critic LLM prompt failed: ${JSON.stringify(promptResult.error)}` wrap)
 * reached the file in cleartext.
 *
 * This test drives the real exported `dispatchCriticAndWriteEvent` with a
 * stub SDK client (via the src/state `_internals.swarmState.opencodeClient`
 * seam, the same pattern as tests/unit/full-auto/oversight-persistence-
 * redaction-3710.test.ts): `session.create` succeeds and `session.prompt`
 * resolves WITHOUT `data` carrying a 401 token-bearing error, so the single
 * dispatch attempt fails, the loop exhausts (maxDispatchRetries=0 → 1
 * attempt), and the pause arm runs. `startFullAutoRun` opens the run first
 * so `pauseFullAutoRun` has a live session record to persist into.
 *
 * Mutation contract: removing the `sanitizeFailureEvidenceDisplay(...)` call
 * from the `infraReason` construction makes this suite RED (the synthetic
 * token appears in cleartext in the persisted pauseReason). All tokens are
 * synthetic; no real credential material is used.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	loadFullAutoRunState,
	startFullAutoRun,
} from '../../../src/full-auto/state';
import { dispatchCriticAndWriteEvent } from '../../../src/hooks/full-auto-intercept';
import { _internals as stateInternals } from '../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const SYNTH_TOKEN = 'sk-SynthAbCdEf12345678901234567890';
const SYNTH_OPENAI_PLACEHOLDER = '[REDACTED:openai]';
const SESSION_ID = 'sess-infra-reason-3710';

interface FullAutoRunStateShape {
	status?: string;
	pauseReason?: string;
}

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;

/**
 * Stub SDK client whose session.prompt resolves WITHOUT `data` and with a
 * 401 provider error carrying the synthetic token — the exact entry shape
 * the retry loop wraps into `Critic LLM prompt failed: ${JSON.stringify(...)}`.
 */
function stubClientWithPromptError(): void {
	const create = mock().mockResolvedValue({ data: { id: 'critic-sess-3710' } });
	const prompt = mock().mockResolvedValue({
		data: undefined,
		error: {
			name: 'ProviderError',
			message: `Invalid API key provided: ${SYNTH_TOKEN}. You can find your API key at https://platform.openai.example/account/api-keys.`,
			statusCode: 401,
		},
	});
	const deleteSession = mock().mockResolvedValue({});
	stateInternals.swarmState.opencodeClient = {
		session: { create, prompt, delete: deleteSession },
	} as unknown as typeof stateInternals.swarmState.opencodeClient;
}

beforeEach(() => {
	tmpDir = canonicalMkdtemp('infra-reason-redact-3710-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
	stubClientWithPromptError();
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	removeTreeWithRetry(tmpDir);
	mock.restore();
});

describe('legacy intercept infraReason pause persistence redaction (#3710)', () => {
	test('exhausted-retry pause persists a redacted pauseReason to full-auto-state.json', async () => {
		startFullAutoRun(tmpDir, SESSION_ID, { enabled: true });

		const result = await dispatchCriticAndWriteEvent(
			tmpDir,
			'Ready for Phase 2?',
			'Critic context',
			'test-model',
			'phase_completion',
			0,
			0,
			'critic_oversight',
			SESSION_ID,
			0, // maxDispatchRetries → exactly one attempt, then the pause arm
			3, // maxConsecutiveDispatchFailures → 1 failure stays below the
			//    auto-degrade threshold, so pauseFullAutoRun runs without
			//    terminateFullAutoRun (the non-retry pause arm).
		);

		// Posture unchanged: an exhausted dispatch intercepts with the
		// fail-closed default verdict and pauses the run.
		expect(result.verdict).toBe('NEEDS_REVISION');

		const state = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(state?.status).toBe('paused');

		const runState: FullAutoRunStateShape = (state ??
			{}) as FullAutoRunStateShape;
		const pauseReason = runState.pauseReason ?? '';
		expect(pauseReason).toContain(
			'oversight infrastructure failure after 1 attempt(s):',
		);
		// The persisted reason carries the family placeholder…
		expect(pauseReason).toContain(SYNTH_OPENAI_PLACEHOLDER);
		// …and no token-body cleartext.
		expect(
			pauseReason.includes(SYNTH_TOKEN),
			`pauseReason carries token cleartext: ${pauseReason}`,
		).toBe(false);

		// The whole persisted artifact (every field of the session record)
		// is cleartext-free.
		const statePath = path.join(tmpDir, '.swarm', 'full-auto-state.json');
		expect(fs.existsSync(statePath)).toBe(true);
		const rawState = fs.readFileSync(statePath, 'utf-8');
		expect(
			rawState.includes(SYNTH_TOKEN),
			'full-auto-state.json carries token cleartext',
		).toBe(false);
		expect(rawState).toContain(SYNTH_OPENAI_PLACEHOLDER);
	}, 60_000);
});
