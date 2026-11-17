import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
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
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

/**
 * #3710 D2 — a provider error carrying a bare credential token must NOT be
 * persisted in cleartext through the REAL oversight persistence seam.
 *
 * At base, `attemptDispatch` builds `Critic prompt failed:
 * ${JSON.stringify(promptResult.error)}` (src/full-auto/oversight.ts), which
 * flows into `infraReason` and is persisted UNREDACTED by
 * pauseFullAutoRun (`.swarm/full-auto-state.json` pauseReason),
 * writeFullAutoOversightEvent (`.swarm/events.jsonl`),
 * writeFullAutoOversightEvidence (`.swarm/evidence/<phase>/full-auto-*.json`),
 * and recordFullAutoOversight (lastOversightReason in the same run state).
 *
 * Frozen contract (issue #3710 AC2): RED at base — the synthetic token body
 * survives in cleartext in the persisted artifacts; GREEN after the fix —
 * every persisted artifact carries the family placeholder
 * ([REDACTED:openai] for the sk- shape) and no token-body cleartext.
 * The `code` machine-string field of buildRecord is out of scope here.
 *
 * The dispatch stub mirrors tests/unit/full-auto/oversight.test.ts: a stub
 * SDK client whose session.prompt resolves WITHOUT `data` and with an error
 * object carrying the synthetic token — exactly the D2 entry path. All
 * tokens below are synthetic; no real credential material is used.
 */

const SYNTH_TOKEN = 'sk-Synth0q9Xb2Lw4R5tY8uI1oP3sD6fG';
const SYNTH_OPENAI_PLACEHOLDER = '[REDACTED:openai]';
const SESSION_ID = 'sess-redact-3710';
const PHASE = 4;

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;
let origSleep: typeof oversightInternals.sleep;

interface FullAutoOversightEventShape {
	type?: string;
	session_id?: string;
	reasoning?: string;
	verdict?: string;
}

interface FullAutoRunStateShape {
	pauseReason?: string;
	lastOversightReason?: string;
	lastOversightVerdict?: string;
}

function readPersistedEvents(dir: string): FullAutoOversightEventShape[] {
	const eventsPath = path.join(dir, '.swarm', 'events.jsonl');
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, 'utf-8')
		.split(/\r?\n/)
		.filter(Boolean)
		.filter((line) => {
			try {
				return (
					(JSON.parse(line) as { type?: unknown }).type !==
					'swarm-events-manifest'
				);
			} catch {
				return true;
			}
		})
		.map((line) => JSON.parse(line) as FullAutoOversightEventShape);
}

function readPersistedEvidence(dir: string): FullAutoOversightEventShape[] {
	const evidenceRoot = path.join(dir, '.swarm', 'evidence');
	if (!fs.existsSync(evidenceRoot)) return [];
	const events: FullAutoOversightEventShape[] = [];
	const stack = [evidenceRoot];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!/^full-auto-\d+\.json$/.test(entry.name)) continue;
			events.push(
				JSON.parse(
					fs.readFileSync(full, 'utf-8'),
				) as FullAutoOversightEventShape,
			);
		}
	}
	return events;
}

function readPersistedRunState(dir: string): FullAutoRunStateShape {
	const statePath = path.join(dir, '.swarm', 'full-auto-state.json');
	const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
		sessions?: Record<string, FullAutoRunStateShape>;
	};
	return parsed.sessions?.[SESSION_ID] ?? {};
}

function stubClientWithPromptError(): void {
	const create = mock().mockResolvedValue({ data: { id: 'critic-sess-3710' } });
	const prompt = mock().mockResolvedValue({
		data: undefined,
		error: {
			name: 'ProviderAuthError',
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
	tmpDir = canonicalMkdtemp('oversight-redact-3710-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
	origSleep = oversightInternals.sleep;
	oversightInternals.sleep = async () => {};
	stubClientWithPromptError();
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	oversightInternals.sleep = origSleep;
	removeTreeWithRetry(tmpDir);
});

describe('oversight prompt-failure reasoning is persisted redacted (#3710 D2)', () => {
	test('events, evidence, and run state carry the family placeholder and no token cleartext', async () => {
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

		// Posture unchanged: a prompt dispatch failure still fails closed.
		expect(out.verdict).toBe('BLOCKED');
		expect(out.decision).toBe('pause');

		const events = readPersistedEvents(tmpDir).filter(
			(event) =>
				event.type === 'full_auto_oversight' && event.session_id === SESSION_ID,
		);
		expect(events.length).toBeGreaterThan(0);
		for (const event of events) {
			expect(
				event.reasoning?.includes(SYNTH_TOKEN),
				`events.jsonl reasoning carries token cleartext: ${event.reasoning}`,
			).toBe(false);
			expect(event.reasoning).toContain(SYNTH_OPENAI_PLACEHOLDER);
		}

		const evidence = readPersistedEvidence(tmpDir);
		expect(evidence.length).toBeGreaterThan(0);
		for (const record of evidence) {
			expect(
				record.reasoning?.includes(SYNTH_TOKEN),
				`evidence reasoning carries token cleartext: ${record.reasoning}`,
			).toBe(false);
			expect(record.reasoning).toContain(SYNTH_OPENAI_PLACEHOLDER);
		}

		const runState = readPersistedRunState(tmpDir);
		expect(runState.pauseReason).toBeDefined();
		expect(runState.pauseReason?.includes(SYNTH_TOKEN)).toBe(false);
		expect(runState.pauseReason).toContain(SYNTH_OPENAI_PLACEHOLDER);
		expect(runState.lastOversightReason?.includes(SYNTH_TOKEN)).toBe(false);
		expect(runState.lastOversightReason).toContain(SYNTH_OPENAI_PLACEHOLDER);
	}, 60_000);

	test('run is paused (fail-closed posture preserved under redaction)', async () => {
		startFullAutoRun(tmpDir, SESSION_ID, { enabled: true });
		await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: SESSION_ID,
			trigger: 'test',
			triggerSource: 'tool_action',
			phase: PHASE,
			criticModel: 'm',
			oversightAgentName: 'critic_oversight',
		});
		const state = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(state?.status).toBe('paused');
		expect(state?.lastOversightVerdict).toBe('BLOCKED');
	}, 60_000);
});
