import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	dispatchFullAutoOversight,
	_internals as oversightInternals,
} from '../../../src/full-auto/oversight';
import { startFullAutoRun } from '../../../src/full-auto/state';
import { _internals as stateInternals } from '../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

/**
 * #3710 D2 — TRANSIENT-arm persistence pin (implementation-review round 2).
 *
 * The frozen C2 suite drives a NON-transient prompt failure (401), which
 * exercises the `oversight dispatch failed without retry:` arm of the
 * infraReason construction. The TRANSIENT arm (`oversight infrastructure
 * failure after N attempt(s):`) is an independently editable sink, and the
 * round-1 named mutation M-C2 showed removing only its sanitizer wrapper
 * survives every frozen check. This suite drives a token-bearing TRANSIENT
 * failure (429-shaped, classified retryable so the retry budget is exhausted
 * on the transient path) through the REAL persistence seam and pins the
 * redacted reasoning in every durable artifact — removing the transient arm's
 * sanitizer makes these assertions fail. All tokens are synthetic.
 */

const SYNTH_TOKEN = 'sk-SynthTransient123456789012345678';
const SYNTH_OPENAI_PLACEHOLDER = '[REDACTED:openai]';
const TRANSIENT_PREFIX = 'oversight infrastructure failure after 1 attempt(s):';
const SESSION_ID = 'sess-redact-transient-3710';
const PHASE = 4;

interface ReasonShape {
	type?: string;
	session_id?: string;
	reasoning?: string;
}

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;
let origSleep: typeof oversightInternals.sleep;

function readReasoning(dir: string): ReasonShape[] {
	const out: ReasonShape[] = [];
	const eventsPath = path.join(dir, '.swarm', 'events.jsonl');
	if (fs.existsSync(eventsPath)) {
		for (const line of fs.readFileSync(eventsPath, 'utf-8').split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as { type?: unknown };
				if (parsed.type === 'swarm-events-manifest') continue;
			} catch {
				continue;
			}
			const parsed = JSON.parse(line) as ReasonShape;
			if (
				parsed.type === 'full_auto_oversight' &&
				parsed.session_id === SESSION_ID
			) {
				out.push(parsed);
			}
		}
	}
	const statePath = path.join(dir, '.swarm', 'full-auto-state.json');
	if (fs.existsSync(statePath)) {
		const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
			sessions?: Record<
				string,
				{ pauseReason?: string; lastOversightReason?: string }
			>;
		};
		const session = parsed.sessions?.[SESSION_ID];
		if (session) {
			out.push({
				type: 'full_auto_oversight',
				session_id: SESSION_ID,
				reasoning: `${session.pauseReason ?? ''}\n${session.lastOversightReason ?? ''}`,
			});
		}
	}
	return out;
}

function stubClientWithTransientPromptError(): void {
	const create = mock().mockResolvedValue({
		data: { id: 'critic-sess-t3710' },
	});
	const prompt = mock().mockResolvedValue({
		data: undefined,
		error: {
			name: 'ProviderRateLimitError',
			message: `429 rate limit exceeded, temporarily unavailable: rotate ${SYNTH_TOKEN} and retry`,
			statusCode: 429,
		},
	});
	const deleteSession = mock().mockResolvedValue({});
	stateInternals.swarmState.opencodeClient = {
		session: { create, prompt, delete: deleteSession },
	} as unknown as typeof stateInternals.swarmState.opencodeClient;
}

beforeEach(() => {
	tmpDir = canonicalMkdtemp('oversight-transient-3710-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
	origSleep = oversightInternals.sleep;
	oversightInternals.sleep = async () => {};
	stubClientWithTransientPromptError();
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	oversightInternals.sleep = origSleep;
	removeTreeWithRetry(tmpDir);
});

describe('transient-arm oversight persistence is redacted (#3710 review r2)', () => {
	test('the transient (retry-exhausted) infraReason persists redacted through the real seam', async () => {
		startFullAutoRun(tmpDir, SESSION_ID, { enabled: true });
		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: SESSION_ID,
			trigger: 'test',
			triggerSource: 'tool_action',
			phase: PHASE,
			criticModel: 'm',
			oversightAgentName: 'critic_oversight',
			fullAutoConfig: { max_dispatch_retries: 0 },
		});

		// Fail-closed posture preserved on the transient path.
		expect(out.verdict).toBe('BLOCKED');
		expect(out.decision).toBe('pause');

		const persisted = readReasoning(tmpDir);
		expect(persisted.length).toBeGreaterThan(0);
		let sawTransientPrefix = false;
		for (const record of persisted) {
			const reasoning = record.reasoning ?? '';
			if (reasoning.includes(TRANSIENT_PREFIX)) sawTransientPrefix = true;
			expect(
				reasoning.includes(SYNTH_TOKEN),
				`persisted reasoning carries token cleartext: ${reasoning}`,
			).toBe(false);
			expect(reasoning).toContain(SYNTH_OPENAI_PLACEHOLDER);
		}
		// The TRANSIENT arm (not the non-retry arm) produced this reason.
		expect(sawTransientPrefix).toBe(true);
	}, 60_000);
});
