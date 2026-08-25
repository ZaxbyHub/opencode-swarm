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
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;
let origSetTimer: typeof oversightInternals.setTimer;
let origClearTimer: typeof oversightInternals.clearTimer;
let origTeardown: typeof oversightInternals.teardownEphemeralSession;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('full-auto-deadline-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
	origSetTimer = oversightInternals.setTimer;
	origClearTimer = oversightInternals.clearTimer;
	origTeardown = oversightInternals.teardownEphemeralSession;
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	oversightInternals.setTimer = origSetTimer;
	oversightInternals.clearTimer = origClearTimer;
	oversightInternals.teardownEphemeralSession = origTeardown;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('dispatchFullAutoOversight total deadline', () => {
	test('fails closed when total deadline expires during create', async () => {
		startFullAutoRun(tmpDir, 'sess-deadline', { enabled: true });
		oversightInternals.setTimer = ((fn: (...args: any[]) => void) => {
			queueMicrotask(() => fn());
			return 1 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof oversightInternals.setTimer;
		oversightInternals.clearTimer =
			(() => {}) as typeof oversightInternals.clearTimer;
		stateInternals.swarmState.opencodeClient = {
			session: {
				create: mock(
					async () =>
						await new Promise(() => undefined as unknown as undefined),
				),
				prompt: mock(async () => ({ data: null, error: null })),
				delete: mock(async () => ({})),
			},
		} as any;

		const result = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-deadline',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'm',
			oversightAgentName: 'critic_oversight',
			fullAutoConfig: {
				total_timeout_ms: 5,
				cleanup_timeout_ms: 5,
				max_dispatch_retries: 0,
				max_consecutive_dispatch_failures: 3,
			},
		});

		expect(result.verdict).toBe('BLOCKED');
		expect(result.reasoning).toMatch(/deadline expired|dispatch failed/i);
		expect(loadFullAutoRunState(tmpDir, 'sess-deadline')?.status).toBe(
			'paused',
		);
	});

	test('cleanup timeout does not block return', async () => {
		startFullAutoRun(tmpDir, 'sess-cleanup', { enabled: true });
		oversightInternals.teardownEphemeralSession = (() =>
			new Promise(
				() => undefined as unknown as undefined,
			)) as typeof oversightInternals.teardownEphemeralSession;
		stateInternals.swarmState.opencodeClient = {
			session: {
				create: mock(async () => ({
					data: { id: 'critic-session' },
					error: null,
				})),
				prompt: mock(async () => ({
					data: {
						parts: [
							{
								type: 'text',
								text: 'VERDICT: APPROVED\nREASONING: ok\nEVIDENCE_CHECKED: diff\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
							},
						],
					},
				})),
				delete: mock(async () => ({})),
			},
		} as any;

		const result = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-cleanup',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'm',
			oversightAgentName: 'critic_oversight',
			fullAutoConfig: {
				total_timeout_ms: 50,
				cleanup_timeout_ms: 1,
				max_dispatch_retries: 0,
				max_consecutive_dispatch_failures: 3,
			},
		});

		expect(result.verdict).toBe('APPROVED');
		expect(result.decision).toBe('allow');
	});
});
