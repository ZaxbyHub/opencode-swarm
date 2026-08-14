/**
 * End-to-end integration test for the issue-trace full chain:
 *   ISSUE_INGEST → PLAN → EXECUTE → publication_handoff (commit-pr) → published
 *
 * Proves idempotency at each transition and cross-issue fail-closed guard.
 * Uses real filesystem artifacts under a temp dir with `_internals` DI
 * seam overrides for the async adapters (critic approval, plan phase status).
 *
 * Issue #2131 finding 2: the chain now ends in `publication_handoff` (NOT a
 * terminal "completed"), and reaches `published` only after a publication
 * receipt is observed.
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
	resetPhaseStatusCache,
} from '../../../src/hooks/issue-trace';
import type { TraceState } from '../../../src/hooks/issue-trace-reducer';

// ── Helpers ────────────────────────────────────────────────────────

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-trace-e2e-'));
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

function writeSwarmJson(dir: string, filename: string, data: unknown): void {
	fs.writeFileSync(
		path.join(dir, '.swarm', filename),
		JSON.stringify(data, null, 2),
		'utf-8',
	);
}

function readSwarmJson<T>(dir: string, filename: string): T | null {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(dir, '.swarm', filename), 'utf-8'),
		) as T;
	} catch {
		return null;
	}
}

/** issue-reference with trace=true and a noRepro waiver so the PLAN gate permits. */
function writeIssueRef(dir: string, number = 42): void {
	writeSwarmJson(dir, 'issue-reference.json', {
		url: `https://github.com/owner/repo/issues/${number}`,
		owner: 'owner',
		repo: 'repo',
		number,
		timestamp: '2026-01-01T00:00:00Z',
		flags: { trace: true, noRepro: true },
	});
}

function writeSpec(dir: string, number = 42): void {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'spec.md'),
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

function writeTraceState(dir: string, state?: Partial<TraceState>): void {
	const defaults: TraceState = {
		issueNumber: 42,
		lastTransition: null,
		status: 'in_progress',
	};
	writeSwarmJson(dir, 'issue-trace-state.json', { ...defaults, ...state });
}

async function runHook(
	dir: string,
	existingMessages: unknown[] = [],
): Promise<unknown[]> {
	const hook = createIssueTraceHook({}, dir, 100);
	const output = { messages: [...existingMessages] };
	await hook.messagesTransform({}, output);
	return output.messages;
}

function expectSystemMessage(messages: unknown[], text: string): void {
	expect(messages).toHaveLength(1);
	expect(messages[0]).toEqual({
		role: 'system',
		content: [{ type: 'text', text }],
	});
}

const originals = { ..._internals };
afterEach(() => {
	Object.assign(_internals, originals);
	resetPhaseStatusCache();
});

// ── SCENARIO 1: Full Trace Chain ──────────────────────────────────

describe('issue-trace e2e — full chain', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		_internals.isPlanCriticApproved = () => Promise.resolve(true);
	});

	test('Step A: ISSUE_INGEST → injects [MODE: PLAN]', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir);
		writeSpec(tmpDir, 42);
		// No plan → authoritative planExists is false → row (f) fires.

		const messages = await runHook(tmpDir);
		expectSystemMessage(messages, '[MODE: PLAN]');

		const state = readSwarmJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state!.lastTransition).toBe('ISSUE_INGEST_TO_PLAN');
		expect(state!.status).toBe('in_progress');
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
		_internals.readPlanPhaseStatus = () =>
			Promise.resolve({ planExists: true, allComplete: false });

		const messages = await runHook(tmpDir);
		expectSystemMessage(messages, '[MODE: EXECUTE]');

		const state = readSwarmJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state!.lastTransition).toBe('PLAN_TO_EXECUTE');
		expect(state!.status).toBe('in_progress');
	});

	test('Step B idempotency: already at PLAN_TO_EXECUTE → no injection', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, { lastTransition: 'PLAN_TO_EXECUTE' });
		writeSpec(tmpDir, 42);
		_internals.readPlanPhaseStatus = () =>
			Promise.resolve({ planExists: true, allComplete: false });

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('Step C: EXECUTE → publication_handoff directive with Closes #42', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, { lastTransition: 'PLAN_TO_EXECUTE' });
		writeSpec(tmpDir, 42);
		_internals.readPlanPhaseStatus = () =>
			Promise.resolve({ planExists: true, allComplete: true });

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(1);
		const text = (messages[0] as { content: Array<{ text: string }> })
			.content[0].text;
		expect(text).toContain('Closes #42');
		expect(text).toContain('commit-pr');
		expect(text).toContain('trace is NOT complete');

		const state = readSwarmJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state!.lastTransition).toBe('EXECUTE_TO_COMMIT');
		expect(state!.status).toBe('publication_handoff');
	});

	test('Step D: publication_handoff + receipt → published (terminal)', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, {
			lastTransition: 'EXECUTE_TO_COMMIT',
			status: 'publication_handoff',
		});
		writeSpec(tmpDir, 42);
		writeSwarmJson(tmpDir, 'issue-publication.json', {
			published: true,
			issueNumber: 42,
			prNumber: 7,
		});

		const messages = await runHook(tmpDir);
		expectSystemMessage(
			messages,
			'Publication confirmed. The issue-trace workflow is complete.',
		);
		const state = readSwarmJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state!.status).toBe('published');
		expect(state!.lastTransition).toBe('PUBLISHED');
	});

	test('Step C idempotency: already at EXECUTE_TO_COMMIT (publication_handoff, no receipt) → no injection', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, {
			lastTransition: 'EXECUTE_TO_COMMIT',
			status: 'publication_handoff',
		});
		writeSpec(tmpDir, 42);
		_internals.readPlanPhaseStatus = () =>
			Promise.resolve({ planExists: true, allComplete: true });

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
			Promise.resolve({ planExists: true, allComplete: true });
	});

	test('publication_handoff trace survives hook re-invocation without side effects', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, {
			lastTransition: 'EXECUTE_TO_COMMIT',
			status: 'publication_handoff',
		});
		writeSpec(tmpDir, 42);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);

		const state = readSwarmJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state!.status).toBe('publication_handoff');
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
			Promise.resolve({ planExists: true, allComplete: false });
	});

	test('issue-reference #99 with spec #42 → no injection', async () => {
		writeIssueRef(tmpDir, 99);
		writeTraceState(tmpDir, { issueNumber: 99 });
		writeSpec(tmpDir, 42);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
		const state = readSwarmJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state!.lastTransition).toBeNull();
	});

	test('trace-state issueNumber mismatch → no injection', async () => {
		writeIssueRef(tmpDir, 42);
		writeTraceState(tmpDir, { issueNumber: 99 });
		writeSpec(tmpDir, 42);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});
});
