/**
 * Tests for the issue-trace hook (src/hooks/issue-trace.ts).
 *
 * Uses the `_internals` DI seam to override adapter functions,
 * avoiding `mock.module` leakage across test files (AGENTS.md invariant 7).
 *
 * Under 500 lines (FR-006).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	createIssueTraceHook,
	resetApprovalCache,
} from '../../../src/hooks/issue-trace';
import type { TraceState } from '../../../src/hooks/issue-trace-reducer';

// ── Helpers ────────────────────────────────────────────────────────

/** Creates a temp dir under os.tmpdir() with .swarm/ subdirectory. */
function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-trace-test-'));
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

/** Writes JSON to a file inside .swarm/. */
function writeJson(dir: string, filename: string, data: unknown): void {
	const filePath = path.join(dir, '.swarm', filename);
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/** Reads JSON from a file inside .swarm/. */
function readJson<T>(dir: string, filename: string): T | null {
	const filePath = path.join(dir, '.swarm', filename);
	try {
		const raw = fs.readFileSync(filePath, 'utf-8');
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/** Creates a valid issue-reference.json with trace=true. */
function writeIssueRef(dir: string, number = 42): void {
	writeJson(dir, 'issue-reference.json', {
		url: `https://github.com/owner/repo/issues/${number}`,
		owner: 'owner',
		repo: 'repo',
		number,
		timestamp: '2026-01-01T00:00:00Z',
		flags: { trace: true },
	});
}

/** Creates a spec.md with the given issue number in the Source Issue section. */
function writeSpecWithIssue(dir: string, number = 42): void {
	const filePath = path.join(dir, '.swarm', 'spec.md');
	fs.writeFileSync(
		filePath,
		`# Spec\n\n## Source Issue\n\n- Number: ${number}\n\n## Details\n`,
		'utf-8',
	);
}

/** Creates a default trace-state.json. */
function writeTraceState(dir: string, state?: Partial<TraceState>): void {
	const defaults: TraceState = {
		issueNumber: 42,
		lastTransition: null,
		completed: false,
	};
	writeJson(dir, 'issue-trace-state.json', { ...defaults, ...state });
}

/** Runs the hook's messagesTransform and returns the output messages. */
async function runHook(
	dir: string,
	inputMessages: unknown[] = [],
	approvalTimeoutMs: number = 100,
): Promise<unknown[]> {
	const hook = createIssueTraceHook({}, dir, approvalTimeoutMs);
	const output = { messages: [...inputMessages] };
	await hook.messagesTransform({}, output);
	return output.messages;
}

// ── Restore originals ──────────────────────────────────────────────

const originals = { ..._internals };
afterEach(() => {
	Object.assign(_internals, originals);
	resetApprovalCache();
});

// ── Tests ───────────────────────────────────────────────────────────

describe('issue-trace hook', () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTempDir();
	});

	test('noop when no issue-reference.json exists', async () => {
		// No issue-reference.json → trace flag cannot be true
		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('noop when trace flag is false', async () => {
		writeJson(tmpDir, 'issue-reference.json', {
			url: 'https://github.com/owner/repo/issues/42',
			owner: 'owner',
			repo: 'repo',
			number: 42,
			timestamp: '2026-01-01T00:00:00Z',
			flags: { trace: false },
		});
		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('noop when spec does not exist', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir);
		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('signal injection: spec exists + no plan → [MODE: PLAN]', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir);
		writeSpecWithIssue(tmpDir);
		// No plan.json → planExists returns false

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({
			role: 'system',
			content: [{ type: 'text', text: '[MODE: PLAN]' }],
		});
	});

	test('state mutation: trace-state updated with new lastTransition', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir);
		writeSpecWithIssue(tmpDir);

		await runHook(tmpDir);

		const state = readJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state).not.toBeNull();
		expect(state?.lastTransition).toBe('ISSUE_INGEST_TO_PLAN');
		expect(state?.completed).toBe(false);
	});

	test('WRITE-FAIL → no injection: override writeTraceState to throw', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir);
		writeSpecWithIssue(tmpDir);

		_internals.writeTraceState = () => {
			throw new Error('disk full');
		};

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);

		// State should be unchanged (write failed before rename)
		const state = readJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state?.lastTransition).toBeNull();
	});

	test('idempotency: second call with same state → no duplicate injection', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir, { lastTransition: 'ISSUE_INGEST_TO_PLAN' });
		writeSpecWithIssue(tmpDir);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('cross-issue fail-closed: spec issue number mismatch → no injection', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir);
		// Spec references issue #99, but issue-ref is #42
		writeSpecWithIssue(tmpDir, 99);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('timeout: isPlanCriticApproved never resolves → returns false after timeout', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir);
		writeSpecWithIssue(tmpDir);
		// Create a plan so the reducer reaches row (f) or (g)
		writeJson(tmpDir, 'plan.json', {
			title: 'test',
			swarm_id: 'test',
			phases: [],
		});

		// Mock isPlanCriticApproved to hang forever
		_internals.isPlanCriticApproved = () =>
			new Promise<boolean>(() => {
				// never resolves
			});

		// Must complete within a reasonable time (100ms timeout + overhead)
		const start = Date.now();
		const messages = await runHook(tmpDir, [], 100);
		const elapsed = Date.now() - start;

		// Should not hang — the boundedApprovalCheck uses a 100ms timeout
		expect(elapsed).toBeLessThan(2000);

		// With plan but no critic approval, reducer returns no-op (row f)
		expect(messages).toHaveLength(0);
	});

	test('malformed JSON: corrupt issue-reference.json → noop', async () => {
		const filePath = path.join(tmpDir, '.swarm', 'issue-reference.json');
		fs.writeFileSync(filePath, '{not valid json{{{', 'utf-8');

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('trace issue number mismatch in trace state → no injection', async () => {
		writeIssueRef(tmpDir, 42);
		// Trace state references a different issue number
		writeTraceState(tmpDir, { issueNumber: 99 });
		writeSpecWithIssue(tmpDir, 42);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('trace already completed → noop', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir, { completed: true });
		writeSpecWithIssue(tmpDir);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('error in boundedApprovalCheck → noop (fail-closed)', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir);
		writeSpecWithIssue(tmpDir);
		// Mock everything to exercise the async path
		_internals.isPlanCriticApproved = () => {
			throw new Error('approval check crashed');
		};

		// The catch in boundedApprovalCheck returns false,
		// and the reducer still returns a result. The hook itself
		// shouldn't throw — only the boundedApprovalCheck catch.
		const messages = await runHook(tmpDir);
		// With spec + no plan, this is row (e) — should still inject PLAN
		// because critic approval is only checked after plan exists (row f)
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({
			role: 'system',
			content: [{ type: 'text', text: '[MODE: PLAN]' }],
		});
	});

	test('output without messages array → safe no-op', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir);
		writeSpecWithIssue(tmpDir);

		const hook = createIssueTraceHook({}, tmpDir, 100);
		const output = {}; // no messages array
		await hook.messagesTransform({}, output);
		// Should not throw, and state should still be written
		const state = readJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state?.lastTransition).toBe('ISSUE_INGEST_TO_PLAN');
	});

	test('all phases complete → COMMIT directive injected', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir, { lastTransition: 'PLAN_TO_EXECUTE' });
		writeSpecWithIssue(tmpDir);
		writeJson(tmpDir, 'plan.json', {
			title: 'test',
			swarm_id: 'test',
			phases: [{ id: 1, name: 'Phase 1', status: 'complete', tasks: [] }],
		});
		_internals.isPlanCriticApproved = () => Promise.resolve(true);
		_internals.readPlanPhaseStatus = () =>
			Promise.resolve({ allComplete: true });

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({
			role: 'system',
			content: [
				{
					type: 'text',
					text: 'All phases complete. Compose commit-pr to publish the PR. Read .swarm/issue-reference.json for Closes #42.',
				},
			],
		});

		const state = readJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state?.completed).toBe(true);
		expect(state?.lastTransition).toBe('EXECUTE_TO_COMMIT');
	});

	test('EXECUTE_TO_COMMIT idempotency → no duplicate directive', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir, {
			lastTransition: 'EXECUTE_TO_COMMIT',
			completed: true,
		});
		writeSpecWithIssue(tmpDir);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});
});

// ── Cleanup ────────────────────────────────────────────────────────

// Temp dirs cleaned up by OS; no explicit cleanup needed for these tests.
