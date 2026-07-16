/**
 * End-to-end integration test for the issue-trace full chain:
 *   ISSUE_INGEST → PLAN → EXECUTE → commit-pr
 *
 * Proves idempotency at each transition and cross-issue fail-closed guard.
 * Uses real filesystem artifacts under a temp dir with `_internals` DI
 * seam overrides for the async adapters (critic approval, plan phase status).
 *
 * Mocked paths in this test:
 *   - _internals.isPlanCriticApproved → always true (approved plan)
 *   - _internals.readPlanPhaseStatus → controlled allComplete toggle
 * Untested branches (covered by issue-trace.test.ts and issue-trace-reducer.test.ts):
 *   - Critic rejection (row f noop)
 *   - Write failure (step 8 fail-closed)
 *   - Malformed JSON / missing files
 *   - Timeout / error in boundedApprovalCheck
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
} from '../../../src/hooks/issue-trace';
import type { TraceState } from '../../../src/hooks/issue-trace-reducer';

// ── Helpers ────────────────────────────────────────────────────────

/** Creates a temp dir under os.tmpdir() with .swarm/ subdirectory. */
function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-trace-e2e-'));
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

/** Writes JSON to a file inside .swarm/. */
function writeSwarmJson(dir: string, filename: string, data: unknown): void {
	const filePath = path.join(dir, '.swarm', filename);
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/** Reads and parses JSON from a file inside .swarm/. */
function readSwarmJson<T>(dir: string, filename: string): T | null {
	const filePath = path.join(dir, '.swarm', filename);
	try {
		const raw = fs.readFileSync(filePath, 'utf-8');
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/** Creates issue-reference.json with trace=true for the given issue number. */
function writeIssueRef(dir: string, number = 42): void {
	writeSwarmJson(dir, 'issue-reference.json', {
		url: `https://github.com/owner/repo/issues/${number}`,
		owner: 'owner',
		repo: 'repo',
		number,
		timestamp: '2026-01-01T00:00:00Z',
		flags: { trace: true },
	});
}

/** Creates spec.md with a Source Issue section referencing the given number. */
function writeSpec(dir: string, number = 42): void {
	const filePath = path.join(dir, '.swarm', 'spec.md');
	fs.writeFileSync(
		filePath,
		[
			'# Spec',
			'',
			'## Source Issue',
			'',
			`- Number: ${number}`,
			'',
			'## Details',
			'',
		].join('\n'),
		'utf-8',
	);
}

/** Creates issue-trace-state.json with the given overrides merged onto defaults. */
function writeTraceState(dir: string, state?: Partial<TraceState>): void {
	const defaults: TraceState = {
		issueNumber: 42,
		lastTransition: null,
		completed: false,
	};
	writeSwarmJson(dir, 'issue-trace-state.json', { ...defaults, ...state });
}

/** Creates a minimal plan.json with one phase. */
function writePlan(dir: string): void {
	writeSwarmJson(dir, 'plan.json', {
		title: 'test-plan',
		swarm_id: 'test',
		phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
	});
}

/**
 * Runs the hook's messagesTransform and returns the appended messages.
 * Uses a short approval timeout (100ms) to keep tests fast.
 */
async function runHook(
	dir: string,
	existingMessages: unknown[] = [],
): Promise<unknown[]> {
	const hook = createIssueTraceHook({}, dir, 100);
	const output = { messages: [...existingMessages] };
	await hook.messagesTransform({}, output);
	return output.messages;
}

/** Asserts that a message list contains exactly one system message with the given text. */
function expectSystemMessage(messages: unknown[], text: string): void {
	expect(messages).toHaveLength(1);
	expect(messages[0]).toEqual({
		role: 'system',
		content: [{ type: 'text', text }],
	});
}

// ── _internals restore ──────────────────────────────────────────────

const originals = { ..._internals };
afterEach(() => {
	Object.assign(_internals, originals);
});

// ── SCENARIO 1: Full Trace Chain ──────────────────────────────────

describe('issue-trace e2e — full chain', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		// Default: critic approved, phases not yet complete
		_internals.isPlanCriticApproved = () => Promise.resolve(true);
		_internals.readPlanPhaseStatus = () =>
			Promise.resolve({ allComplete: false });
	});

	test('Step A: ISSUE_INGEST → injects [MODE: PLAN]', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir);
		writeSpec(tmpDir, 42);
		// No plan.json → row (e) fires

		const messages = await runHook(tmpDir);
		expectSystemMessage(messages, '[MODE: PLAN]');

		const state = readSwarmJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state).not.toBeNull();
		expect(state!.lastTransition).toBe('ISSUE_INGEST_TO_PLAN');
		expect(state!.completed).toBe(false);
	});

	test('Step A idempotency: second call → no duplicate PLAN injection', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, { lastTransition: 'ISSUE_INGEST_TO_PLAN' });
		writeSpec(tmpDir, 42);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('Step B: PLAN → EXECUTE (critic approved, phases incomplete)', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, { lastTransition: 'ISSUE_INGEST_TO_PLAN' });
		writeSpec(tmpDir, 42);
		writePlan(tmpDir);
		// criticApproved = true (set in beforeEach), allComplete = false

		const messages = await runHook(tmpDir);
		expectSystemMessage(messages, '[MODE: EXECUTE]');

		const state = readSwarmJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state!.lastTransition).toBe('PLAN_TO_EXECUTE');
		expect(state!.completed).toBe(false);
	});

	test('Step B idempotency: already at PLAN_TO_EXECUTE → no injection', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, { lastTransition: 'PLAN_TO_EXECUTE' });
		writeSpec(tmpDir, 42);
		writePlan(tmpDir);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('Step C: EXECUTE → COMMIT directive with Closes #42', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, { lastTransition: 'PLAN_TO_EXECUTE' });
		writeSpec(tmpDir, 42);
		writePlan(tmpDir);
		// Override: all phases now complete
		_internals.readPlanPhaseStatus = () =>
			Promise.resolve({ allComplete: true });

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(1);
		const text = (messages[0] as { content: Array<{ text: string }> })
			.content[0].text;
		expect(text).toContain('Closes #42');
		expect(text).toContain('commit-pr');

		const state = readSwarmJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state!.lastTransition).toBe('EXECUTE_TO_COMMIT');
		expect(state!.completed).toBe(true);
	});

	test('Step C idempotency: already at EXECUTE_TO_COMMIT → no injection', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, {
			lastTransition: 'EXECUTE_TO_COMMIT',
			completed: true,
		});
		writeSpec(tmpDir, 42);
		_internals.readPlanPhaseStatus = () =>
			Promise.resolve({ allComplete: true });

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});
});

// ── SCENARIO 2: Restart Idempotency ────────────────────────────────

describe('issue-trace e2e — restart idempotency', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		_internals.isPlanCriticApproved = () => Promise.resolve(true);
		_internals.readPlanPhaseStatus = () =>
			Promise.resolve({ allComplete: true });
	});

	test('completed trace survives hook re-invocation without side effects', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, {
			lastTransition: 'EXECUTE_TO_COMMIT',
			completed: true,
		});
		writeSpec(tmpDir, 42);
		writePlan(tmpDir);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);

		// State must remain unchanged
		const state = readSwarmJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state!.completed).toBe(true);
		expect(state!.lastTransition).toBe('EXECUTE_TO_COMMIT');
	});
});

// ── SCENARIO 3: Cross-Issue Fail-Closed ────────────────────────────

describe('issue-trace e2e — cross-issue fail-closed', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		_internals.isPlanCriticApproved = () => Promise.resolve(true);
		_internals.readPlanPhaseStatus = () =>
			Promise.resolve({ allComplete: false });
	});

	test('issue-reference #99 with spec #42 → no injection (row c)', async () => {
		writeIssueRef(tmpDir, 99);
		writeTraceState(tmpDir, { issueNumber: 99 });
		writeSpec(tmpDir, 42);
		// Row (c): specIssueNumber (42) !== issueReference.number (99)

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);

		const state = readSwarmJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state!.lastTransition).toBeNull();
	});

	test('trace-state issueNumber mismatch → no injection (row c)', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, { issueNumber: 99 });
		writeSpec(tmpDir, 42);
		// Row (c): traceState.issueNumber (99) !== issueReference.number (42)

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});
});
