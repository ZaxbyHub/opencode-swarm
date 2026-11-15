import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	dispatchFullAutoOversight,
	_internals as oversightInternals,
	probeFullAutoOversightHealth,
} from '../../../src/full-auto/oversight';
import { startFullAutoRun } from '../../../src/full-auto/state';
import { _internals as stateInternals } from '../../../src/state';
import { dispatchPhaseCritic } from '../../../src/turbo/lean/integration';
import { dispatchPhaseReviewer } from '../../../src/turbo/lean/reviewer';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

/**
 * #3710 D3 — dispatch-family PERSISTENCE sinks redact provider error text.
 *
 * The sibling test (oversight-persistence-redaction-3710.test.ts) pins the
 * session.prompt failure leg. This matrix pins the OTHER dispatch seams where
 * provider error text carrying a bare credential token is persisted:
 *
 *   (a) oversight session.create failure — dispatchFullAutoOversight builds
 *       `Failed to create critic session: ${JSON.stringify(error)}` and the
 *       non-transient pause path persists it as pauseReason +
 *       lastOversightReason in `.swarm/full-auto-state.json`.
 *   (b) probeFullAutoOversightHealth — both the no-data create rejection leg
 *       and the throwing-create catch leg return `reason` built from
 *       sanitizeFailureEvidenceDisplay.
 *   (c) dispatchPhaseReviewer (src/turbo/lean/reviewer.ts) — a failed
 *       dispatcher status whose error carries the token flows into the
 *       REJECTED fail-closed path; the sanitized reason is persisted to
 *       `.swarm/evidence/{phase}/lean-turbo-reviewer.json` and returned.
 *   (d) dispatchPhaseCritic (src/turbo/lean/integration.ts) — same shape for
 *       `.swarm/evidence/{phase}/lean-turbo-critic.json`.
 *
 * Seam disclosure for (c)/(d): the reviewer/critic `_internals` seams were NOT
 * replaced. The drive uses the public `config.dispatcher` injection, which
 * flows through the modules' REAL `_internals.dispatchReviewerAgent` /
 * `_internals.dispatchCriticAgent` default implementations (the injected
 * dispatcher's failed status is converted to a thrown Error exactly as a live
 * client-bound dispatcher would be), so the full production path — fallback
 * classification, fail-closed catch, writeReviewerEvidence /
 * writeCriticEvidence — runs unstubbed. No source-text assertions.
 *
 * Contract (issue #3710): every persisted/returned reason carries the
 * family placeholder ([REDACTED:openai] for the sk- shape) and no token-body
 * cleartext. All tokens below are synthetic.
 */

const SYNTH_TOKEN = 'sk-Synth0q9Xb2Lw4R5tY8uI1oP3sD6fG';
const SYNTH_OPENAI_PLACEHOLDER = '[REDACTED:openai]';
const SESSION_ID = 'sess-dispatch-redact-3710';
const PHASE = 3;

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;
let origSleep: typeof oversightInternals.sleep;

interface FullAutoRunStateShape {
	pauseReason?: string;
	lastOversightReason?: string;
	status?: string;
}

function readPersistedRunState(dir: string): FullAutoRunStateShape {
	const statePath = path.join(dir, '.swarm', 'full-auto-state.json');
	const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
		sessions?: Record<string, FullAutoRunStateShape>;
	};
	return parsed.sessions?.[SESSION_ID] ?? {};
}

function assertRedacted(label: string, value: string | undefined): void {
	expect(value, `${label}: reason field missing`).toBeDefined();
	expect(
		value?.includes(SYNTH_TOKEN),
		`${label}: carries token cleartext: ${value}`,
	).toBe(false);
	expect(value).toContain(SYNTH_OPENAI_PLACEHOLDER);
}

/**
 * Stub SDK client whose session.create resolves WITHOUT data and with an
 * error object carrying the synthetic token — the (a)/(b) no-data entry path.
 * The "Invalid API key" + 401 signal classifies non-transient, so the
 * pause path runs on the first attempt.
 */
function stubClientWithCreateError(): void {
	const create = mock().mockResolvedValue({
		data: undefined,
		error: {
			name: 'ProviderAuthError',
			message: `Invalid API key provided: ${SYNTH_TOKEN}. You can find your API key at https://platform.openai.example/account/api-keys.`,
			statusCode: 401,
		},
	});
	const prompt = mock().mockResolvedValue({});
	const deleteSession = mock().mockResolvedValue({});
	stateInternals.swarmState.opencodeClient = {
		session: { create, prompt, delete: deleteSession },
	} as unknown as typeof stateInternals.swarmState.opencodeClient;
}

/** Stub SDK client whose session.create REJECTS with a token-carrying Error. */
function stubClientWithThrowingCreate(): void {
	const create = mock().mockRejectedValue(
		new Error(
			`Provider transport rejected authentication credential ${SYNTH_TOKEN} for this request`,
		),
	);
	const prompt = mock().mockResolvedValue({});
	const deleteSession = mock().mockResolvedValue({});
	stateInternals.swarmState.opencodeClient = {
		session: { create, prompt, delete: deleteSession },
	} as unknown as typeof stateInternals.swarmState.opencodeClient;
}

beforeEach(() => {
	tmpDir = canonicalMkdtemp('dispatch-redact-3710-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
	origSleep = oversightInternals.sleep;
	oversightInternals.sleep = async () => {};
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	oversightInternals.sleep = origSleep;
	removeTreeWithRetry(tmpDir);
});

// ─── (a) oversight session.create failure → durable pause state ──────────────

describe('oversight session.create failure persists redacted (#3710 D3)', () => {
	test('pauseReason and lastOversightReason carry the placeholder, no token cleartext', async () => {
		stubClientWithCreateError();
		startFullAutoRun(tmpDir, SESSION_ID, { enabled: true });

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: SESSION_ID,
			trigger: 'test',
			triggerSource: 'tool_action',
			phase: PHASE,
			criticModel: 'm',
			oversightAgentName: 'critic_oversight',
		});

		// Fail-closed posture preserved under redaction.
		expect(out.verdict).toBe('BLOCKED');
		expect(out.decision).toBe('pause');

		const runState = readPersistedRunState(tmpDir);
		expect(runState.status).toBe('paused');
		assertRedacted('full-auto-state pauseReason', runState.pauseReason);
		assertRedacted(
			'full-auto-state lastOversightReason',
			runState.lastOversightReason,
		);
	}, 60_000);
});

// ─── (b) health probe — both create-failure legs ─────────────────────────────

describe('probeFullAutoOversightHealth returns redacted reasons (#3710 D3)', () => {
	test('no-data create rejection leg: reason redacted', async () => {
		stubClientWithCreateError();
		const probe = await probeFullAutoOversightHealth({
			directory: tmpDir,
			sessionID: SESSION_ID,
		});
		expect(probe.healthy).toBe(false);
		expect(probe.attempts).toBe(1);
		assertRedacted('probe reason (no-data create)', probe.reason);
	}, 30_000);

	test('throwing create catch leg: reason redacted', async () => {
		stubClientWithThrowingCreate();
		const probe = await probeFullAutoOversightHealth({
			directory: tmpDir,
			sessionID: SESSION_ID,
		});
		expect(probe.healthy).toBe(false);
		expect(probe.attempts).toBe(1);
		assertRedacted('probe reason (throwing create)', probe.reason);
	}, 30_000);
});

// ─── (c) lean reviewer evidence — .swarm/evidence/{phase}/lean-turbo-reviewer.json

describe('lean reviewer dispatch failure persists redacted evidence (#3710 D3)', () => {
	test('lean-turbo-reviewer.json reason and returned reason carry the placeholder, no token', async () => {
		const result = await dispatchPhaseReviewer(tmpDir, PHASE, SESSION_ID, {
			timeoutMs: 5_000,
			// Injected dispatcher whose failed status error carries the token;
			// flows through the REAL _internals.dispatchReviewerAgent default,
			// which converts the failed status to a thrown Error.
			dispatcher: {
				dispatch: async () => ({
					status: 'error' as const,
					agentName: 'reviewer',
					text: '',
					error: `Provider authentication rejected: invalid API key ${SYNTH_TOKEN} for model access`,
					durationMs: 1,
					promptBytes: 0,
					responseBytes: 0,
				}),
			},
		});

		// Fail-closed posture preserved under redaction.
		expect(result.verdict).toBe('REJECTED');
		assertRedacted('reviewer returned reason', result.reason);

		const evidencePath = path.join(
			tmpDir,
			'.swarm',
			'evidence',
			String(PHASE),
			'lean-turbo-reviewer.json',
		);
		expect(fs.existsSync(evidencePath), 'reviewer evidence file missing').toBe(
			true,
		);
		const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8')) as {
			verdict?: string;
			reason?: string;
		};
		expect(evidence.verdict).toBe('REJECTED');
		assertRedacted('reviewer evidence reason', evidence.reason);
	}, 60_000);
});

// ─── (d) lean critic evidence — .swarm/evidence/{phase}/lean-turbo-critic.json ─

describe('lean critic dispatch failure persists redacted evidence (#3710 D3)', () => {
	test('lean-turbo-critic.json reason and returned reason carry the placeholder, no token', async () => {
		const result = await dispatchPhaseCritic(tmpDir, PHASE, SESSION_ID, {
			// timeoutMs 0/undefined → no timeout in the critic default config.
			dispatcher: {
				dispatch: async () => ({
					status: 'error' as const,
					agentName: 'critic',
					text: '',
					error: `Provider authentication rejected: invalid API key ${SYNTH_TOKEN} for model access`,
					durationMs: 1,
					promptBytes: 0,
					responseBytes: 0,
				}),
			},
		});

		// Fail-closed posture preserved under redaction.
		expect(result.verdict).toBe('REJECTED');
		assertRedacted('critic returned reason', result.reason);

		const evidencePath = path.join(
			tmpDir,
			'.swarm',
			'evidence',
			String(PHASE),
			'lean-turbo-critic.json',
		);
		expect(fs.existsSync(evidencePath), 'critic evidence file missing').toBe(
			true,
		);
		const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8')) as {
			verdict?: string;
			reason?: string;
		};
		expect(evidence.verdict).toBe('REJECTED');
		assertRedacted('critic evidence reason', evidence.reason);
	}, 60_000);
});
