/**
 * Tests for the issue-trace hook (src/hooks/issue-trace.ts).
 *
 * Uses the `_internals` DI seam to override adapter functions,
 * avoiding `mock.module` leakage across test files (AGENTS.md invariant 7).
 *
 * Issue #2131 finding 2: covers the typed `status` model, the reproduction
 * gate (2.6), durable delivery ordering (2.5), and the authoritative
 * plan-phase cache (2.3).
 *
 * Under 500 lines (FR-006).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	createIssueTraceHook,
	resetApprovalCache,
	resetPhaseStatusCache,
} from '../../../src/hooks/issue-trace';
import type { TraceState } from '../../../src/hooks/issue-trace-reducer';

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Issue #2526: MODE directives ride a user-role guidance carrier with a
 * provenance fence instead of a flat role:'system' entry (which the host
 * converter discards). Expected-carrier helper mirrors the literal contract.
 */
function expectIssueTraceCarrier(body: string): {
	info: { id: string; role: string };
	parts: Array<{ type: string; text: string }>;
} {
	return {
		info: { id: 'swarm-guidance:issue-trace', role: 'user' },
		parts: [
			{
				type: 'text',
				text: `<swarm_system_directive source="opencode-swarm" kind="issue-trace">\n${body}\n</swarm_system_directive>`,
			},
		],
	};
}

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

/**
 * Creates a valid issue-reference.json with trace=true. `noRepro` defaults to
 * true so the reproduction gate (issue #2131 2.6) permits the PLAN transition
 * via the typed-waiver path; tests that exercise the gate set it to false.
 */
function writeIssueRef(
	dir: string,
	number = 42,
	opts: { noRepro?: boolean } = {},
): void {
	writeJson(dir, 'issue-reference.json', {
		url: `https://github.com/owner/repo/issues/${number}`,
		owner: 'owner',
		repo: 'repo',
		number,
		timestamp: '2026-01-01T00:00:00Z',
		flags: { trace: true, noRepro: opts.noRepro ?? true },
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
		status: 'in_progress',
	};
	writeJson(dir, 'issue-trace-state.json', { ...defaults, ...state });
}

/** Writes a valid reproduction receipt bound to the given issue. */
function writeReproReceipt(dir: string, number = 42): void {
	writeJson(dir, 'reproduction.json', {
		performed: true,
		issueNumber: number,
		timestamp: '2026-01-01T00:00:00Z',
		commands: ['bun test x'],
	});
}

/** Writes both residual-B receipts (implementation review + recurrence sweep). */
function writeResidualBReceipts(dir: string, number = 42): void {
	writeJson(dir, 'implementation-review.json', {
		issueNumber: number,
		reviewerVerdict: 'APPROVE',
		criticVerdict: 'APPROVE',
		diffBase: 'abc1234',
		diffHead: 'def5678',
		notes: 'fresh reviewer and critic both approved',
		timestamp: '2026-01-01T00:00:00Z',
	});
	writeJson(dir, 'recurrence-sweep.json', {
		issueNumber: number,
		defectClass: 'no defect class',
		justification: 'docs-only change corrects no behavior',
		timestamp: '2026-01-01T00:00:00Z',
	});
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
	resetPhaseStatusCache();
});

// ── Tests ───────────────────────────────────────────────────────────

describe('issue-trace hook', () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTempDir();
	});

	test('noop when no issue-reference.json exists', async () => {
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

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual(expectIssueTraceCarrier('[MODE: PLAN]'));
	});

	test('state mutation: trace-state updated with new lastTransition + in_progress status', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir);
		writeSpecWithIssue(tmpDir);

		await runHook(tmpDir);

		const state = readJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state).not.toBeNull();
		expect(state?.lastTransition).toBe('ISSUE_INGEST_TO_PLAN');
		expect(state?.status).toBe('in_progress');
	});

	test('WRITE-FAIL → directive still delivered, state NOT persisted (retry next cycle)', async () => {
		// Issue #2131 finding 2.5: delivery happens BEFORE the state write, so a
		// write failure does not lose the directive. The transition is not
		// persisted, so the next cycle recomputes and re-emits it.
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir);
		writeSpecWithIssue(tmpDir);

		const logErrorCalls: Array<[string, unknown]> = [];
		_internals.logError = mock((msg: string, err: unknown) => {
			logErrorCalls.push([msg, err]);
		});
		_internals.writeTraceState = () => {
			throw new Error('disk full');
		};

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(1);
		// State unchanged (write failed before rename)
		const state = readJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state?.lastTransition).toBeNull();
		// RP-001: the write failure is logged, not silently swallowed
		expect(logErrorCalls).toHaveLength(1);
		expect(logErrorCalls[0][0]).toBe('[issue-trace] hook cycle failed:');
		expect(logErrorCalls[0][1]).toBeInstanceOf(Error);
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
		writeSpecWithIssue(tmpDir, 99);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('timeout: isPlanCriticApproved never resolves → returns false after timeout', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir);
		writeSpecWithIssue(tmpDir);
		// An authoritative plan exists with an incomplete phase (so planExists is
		// true and row g — plan exists, critic pending — applies).
		_internals.readPlanPhaseStatus = () =>
			Promise.resolve({ planExists: true, allComplete: false });
		_internals.isPlanCriticApproved = () =>
			new Promise<boolean>(() => {
				// never resolves
			});

		const start = Date.now();
		const messages = await runHook(tmpDir, [], 100);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(2000);
		// With plan but no critic approval, reducer returns no-op (row g)
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
		writeTraceState(tmpDir, { issueNumber: 99 });
		writeSpecWithIssue(tmpDir, 42);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('trace already published (terminal) → noop', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir, { status: 'published' });
		writeSpecWithIssue(tmpDir);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	test('error in boundedApprovalCheck → noop (fail-closed) but PLAN still fires pre-plan', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir);
		writeSpecWithIssue(tmpDir);
		_internals.isPlanCriticApproved = () => {
			throw new Error('approval check crashed');
		};

		const messages = await runHook(tmpDir);
		// Spec + no plan (reproduction waived) → PLAN fires; critic approval is
		// only consulted after a plan exists.
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual(expectIssueTraceCarrier('[MODE: PLAN]'));
	});

	// Issue #2131 finding 2.5: durable delivery ordering.
	test('output WITHOUT a messages array → transition NOT persisted (retry next cycle)', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir);
		writeSpecWithIssue(tmpDir);

		const hook = createIssueTraceHook({}, tmpDir, 100);
		const output = {}; // no messages array — cannot durably deliver
		await hook.messagesTransform({}, output);

		// The PLAN transition must NOT be advanced, so the next cycle recomputes
		// and re-emits it instead of being permanently suppressed by idempotency.
		const state = readJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state?.lastTransition).toBeNull();
		expect(state?.status).toBe('in_progress');

		// A subsequent call WITH a messages array then delivers + persists.
		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(1);
		const state2 = readJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state2?.lastTransition).toBe('ISSUE_INGEST_TO_PLAN');
	});

	test('all phases complete → publication_handoff directive injected (NOT completed)', async () => {
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
			Promise.resolve({ planExists: true, allComplete: true });
		writeResidualBReceipts(tmpDir);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual(
			expectIssueTraceCarrier(
				'All implementation phases are complete. Compose commit-pr to publish the PR. Read .swarm/issue-reference.json for Closes #42. After the PR is created/updated, call record_issue_publication (with the issue number, PR number, URL, and HEAD sha) so this trace reaches its terminal published state — the trace is NOT complete until publication is confirmed.',
			),
		);

		const state = readJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state?.status).toBe('publication_handoff');
		expect(state?.lastTransition).toBe('EXECUTE_TO_COMMIT');
	});

	test('publication receipt observed → published transition', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir, {
			lastTransition: 'EXECUTE_TO_COMMIT',
			status: 'publication_handoff',
		});
		writeSpecWithIssue(tmpDir);
		writeJson(tmpDir, 'issue-publication.json', {
			published: true,
			issueNumber: 42,
			prNumber: 7,
			prUrl: 'https://github.com/owner/repo/pull/7',
			publishedAt: '2026-01-01T00:00:00Z',
		});

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual(
			expectIssueTraceCarrier(
				'Publication confirmed. The issue-trace workflow is complete.',
			),
		);
		const state = readJson<TraceState>(tmpDir, 'issue-trace-state.json');
		expect(state?.status).toBe('published');
		expect(state?.lastTransition).toBe('PUBLISHED');
	});

	test('EXECUTE_TO_COMMIT idempotency → no duplicate directive', async () => {
		writeIssueRef(tmpDir);
		writeTraceState(tmpDir, {
			lastTransition: 'EXECUTE_TO_COMMIT',
			status: 'publication_handoff',
		});
		writeSpecWithIssue(tmpDir);

		const messages = await runHook(tmpDir);
		expect(messages).toHaveLength(0);
	});

	// Issue #2131 finding 2.6: reproduction gate.
	describe('reproduction gate (issue #2131 2.6)', () => {
		test('emits a ONE-SHOT reproduction-required directive when NOT permitted', async () => {
			writeIssueRef(tmpDir, 42, { noRepro: false });
			writeTraceState(tmpDir);
			writeSpecWithIssue(tmpDir);

			// First drive: one-shot directive + [MODE: ISSUE_INGEST], state → REPRO_GATE.
			const messages = await runHook(tmpDir);
			expect(messages).toHaveLength(2);
			const state = readJson<TraceState>(tmpDir, 'issue-trace-state.json');
			expect(state?.lastTransition).toBe('REPRO_GATE');

			// Second drive: one-shot already fired → silent noop (no re-nagging).
			const messages2 = await runHook(tmpDir);
			expect(messages2).toHaveLength(0);
		});

		test('PLAN permitted by a reproduction receipt bound to the issue', async () => {
			writeIssueRef(tmpDir, 42, { noRepro: false });
			writeTraceState(tmpDir);
			writeSpecWithIssue(tmpDir);
			writeReproReceipt(tmpDir, 42);

			const messages = await runHook(tmpDir);
			expect(messages).toHaveLength(1);
			expect(messages[0]).toEqual(expectIssueTraceCarrier('[MODE: PLAN]'));
		});

		test('reproduction receipt for a DIFFERENT issue does NOT permit PLAN', async () => {
			writeIssueRef(tmpDir, 42, { noRepro: false });
			writeTraceState(tmpDir);
			writeSpecWithIssue(tmpDir);
			writeReproReceipt(tmpDir, 999); // bound to a different issue

			// The foreign receipt does not satisfy the gate, so the one-shot
			// reproduction-required directive fires and PLAN does NOT.
			await runHook(tmpDir);
			const state = readJson<TraceState>(tmpDir, 'issue-trace-state.json');
			expect(state?.lastTransition).toBe('REPRO_GATE');
			expect(state?.status).toBe('in_progress');
		});

		test('PLAN permitted by a noReproWaiver', async () => {
			writeJson(tmpDir, 'issue-reference.json', {
				url: 'https://github.com/owner/repo/issues/42',
				owner: 'owner',
				repo: 'repo',
				number: 42,
				timestamp: '2026-01-01T00:00:00Z',
				flags: { trace: true, noRepro: false },
				noReproWaiver: {
					waived: true,
					reason: 'doc-only issue',
					timestamp: '2026-01-01T00:00:00Z',
				},
			});
			writeTraceState(tmpDir);
			writeSpecWithIssue(tmpDir);

			const messages = await runHook(tmpDir);
			expect(messages).toHaveLength(1);
		});
	});
});
