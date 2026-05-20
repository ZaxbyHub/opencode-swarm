/**
 * Targeted regression tests for Phase 5 full-auto deadlock fixes.
 *
 * Change 1 — src/full-auto/oversight.ts Line 256:
 *   BLOCKED verdict now returns 'deny' instead of 'pause' (deadlock fix).
 *   Before: decisionFromVerdict('BLOCKED', false) returned 'pause'
 *   After:  decisionFromVerdict('BLOCKED', false) returns 'deny'
 *
 * Change 2 — src/hooks/full-auto-permission.ts Lines 314-316:
 *   architectOutput now JSON-stringifies output.args so the critic receives
 *   a serializable string rather than a raw object.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dispatchFullAutoOversight } from '../../../src/full-auto/oversight';
import {
	loadFullAutoRunState,
	startFullAutoRun,
} from '../../../src/full-auto/state';
import { _internals as stateInternals } from '../../../src/state';

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'deadlock-fix-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
	stateInternals.swarmState.opencodeClient = null;
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Change 1 tests: decisionFromVerdict now returns 'deny' for BLOCKED
// ─────────────────────────────────────────────────────────────────────────────

describe('decisionFromVerdict — BLOCKED now returns deny (deadlock fix)', () => {
	/**
	 * Regression F# (Phase 5 deadlock):
	 * The old code returned 'pause' for BLOCKED without escalation, which
	 * caused the run to pause and wait for human resumption — a deadlock when
	 * no human was available. The fix returns 'deny' so the architect agent
	 * receives a deterministic error and can retry or revise.
	 */
	test('BLOCKED without escalation returns deny (not pause)', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });

		// Mock the OpenCode client to return a BLOCKED verdict.
		const mockClient = {
			session: {
				create: mock(async () => ({
					data: { id: 'critic-session-1' },
				})),
				prompt: mock(async () => ({
					data: {
						parts: [
							{
								type: 'text',
								text: 'VERDICT: BLOCKED\nREASONING: test blocked\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
							},
						],
					},
				})),
				delete: mock(async () => ({})),
			},
		};
		stateInternals.swarmState.opencodeClient = mockClient as any;

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-1',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'test-model',
			oversightAgentName: 'critic_oversight',
		});

		// Phase 5 deadlock fix: BLOCKED → deny (not pause)
		expect(out.decision).toBe('deny');
		expect(out.verdict).toBe('BLOCKED');
	});

	test('BLOCKED with escalation returns escalate_human', async () => {
		startFullAutoRun(tmpDir, 'sess-2', { enabled: true });

		const mockClient = {
			session: {
				create: mock(async () => ({
					data: { id: 'critic-session-2' },
				})),
				prompt: mock(async () => ({
					data: {
						parts: [
							{
								type: 'text',
								text: 'VERDICT: BLOCKED\nREASONING: needs human review\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: YES',
							},
						],
					},
				})),
				delete: mock(async () => ({})),
			},
		};
		stateInternals.swarmState.opencodeClient = mockClient as any;

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-2',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'test-model',
			oversightAgentName: 'critic_oversight',
		});

		// Escalation takes priority over BLOCKED→deny
		expect(out.decision).toBe('escalate_human');
		expect(out.verdict).toBe('BLOCKED');
	});

	test('APPROVED still returns allow', async () => {
		startFullAutoRun(tmpDir, 'sess-3', { enabled: true });

		const mockClient = {
			session: {
				create: mock(async () => ({
					data: { id: 'critic-session-3' },
				})),
				prompt: mock(async () => ({
					data: {
						parts: [
							{
								type: 'text',
								text: 'VERDICT: APPROVED\nREASONING: looks good\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
							},
						],
					},
				})),
				delete: mock(async () => ({})),
			},
		};
		stateInternals.swarmState.opencodeClient = mockClient as any;

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-3',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'test-model',
			oversightAgentName: 'critic_oversight',
		});

		expect(out.decision).toBe('allow');
		expect(out.verdict).toBe('APPROVED');
	});

	test('NEEDS_REVISION still returns deny (default)', async () => {
		startFullAutoRun(tmpDir, 'sess-4', { enabled: true });

		const mockClient = {
			session: {
				create: mock(async () => ({
					data: { id: 'critic-session-4' },
				})),
				prompt: mock(async () => ({
					data: {
						parts: [
							{
								type: 'text',
								text: 'VERDICT: NEEDS_REVISION\nREASONING: fix this\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
							},
						],
					},
				})),
				delete: mock(async () => ({})),
			},
		};
		stateInternals.swarmState.opencodeClient = mockClient as any;

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-4',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'test-model',
			oversightAgentName: 'critic_oversight',
		});

		// NEEDS_REVISION maps to deny (default fallback in decisionFromVerdict)
		expect(out.decision).toBe('deny');
		expect(out.verdict).toBe('NEEDS_REVISION');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Change 2 tests: architectOutput JSON serialization
// The fix (lines 314-316 in full-auto-permission.ts) ensures output.args
// is JSON-stringified before being passed to dispatchFullAutoOversight as
// architectOutput. Without stringify, a plain object becomes "[object Object]"
// in the string prompt — useless for the critic.
// ─────────────────────────────────────────────────────────────────────────────

describe('architectOutput — JSON serialization of output.args', () => {
	test('architectOutput string is embedded verbatim in prompt (serialized form)', async () => {
		startFullAutoRun(tmpDir, 'sess-5', { enabled: true });

		let capturedPromptBody: any;
		const mockClient = {
			session: {
				create: mock(async () => ({
					data: { id: 'critic-session-5' },
				})),
				prompt: mock(async (opts: any) => {
					capturedPromptBody = opts;
					return {
						data: {
							parts: [
								{
									type: 'text',
									text: 'VERDICT: APPROVED\nREASONING: ok\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
								},
							],
						},
					};
				}),
				delete: mock(async () => ({})),
			},
		};
		stateInternals.swarmState.opencodeClient = mockClient as any;

		// Pass a JSON-serialized plan — this is what the hook does after the fix.
		const planArgs = {
			plan: { title: 'Test Plan', tasks: ['task1', 'task2'] },
		};
		const serializedPlan = JSON.stringify(planArgs);

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-5',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'test-model',
			oversightAgentName: 'critic_oversight',
			architectOutput: serializedPlan,
		});

		expect(out.decision).toBe('allow');
		// Verify the serialized plan appears in the prompt parts sent to the critic.
		const promptText = capturedPromptBody?.body?.parts
			?.map((p: any) => p.text)
			?.join('');
		expect(promptText).toContain(serializedPlan);
		// Verify it does NOT contain the broken "[object Object]" string.
		expect(promptText).not.toContain('[object Object]');
	});

	test('architectOutput is undefined when not provided — no ARCHITECT OUTPUT block in prompt', async () => {
		startFullAutoRun(tmpDir, 'sess-6', { enabled: true });

		let capturedPromptBody: any;
		const mockClient = {
			session: {
				create: mock(async () => ({
					data: { id: 'critic-session-6' },
				})),
				prompt: mock(async (opts: any) => {
					capturedPromptBody = opts;
					return {
						data: {
							parts: [
								{
									type: 'text',
									text: 'VERDICT: APPROVED\nREASONING: ok\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
								},
							],
						},
					};
				}),
				delete: mock(async () => ({})),
			},
		};
		stateInternals.swarmState.opencodeClient = mockClient as any;

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-6',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'test-model',
			oversightAgentName: 'critic_oversight',
			// architectOutput intentionally omitted
		});

		expect(out.decision).toBe('allow');
		const promptText = capturedPromptBody?.body?.parts
			?.map((p: any) => p.text)
			?.join('');
		// No ARCHITECT OUTPUT section should appear when architectOutput is undefined.
		expect(promptText).not.toContain('ARCHITECT OUTPUT');
	});
});
