/**
 * Issue #2615 — every `BackgroundDelegationWorkflowLaneFailureClass` member
 * has a live producer, and every terminal that the new 'liveness' class
 * describes (cancel, presumed-stale flips) both carries the class and is
 * classified as host abandonment by the PR-review circuit.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	type BackgroundDelegationWorkflowLaneFailureClass,
	findByBatchId,
	recordPendingDelegation,
	sweepStaleDelegations,
} from '../../../src/background/pending-delegations.js';
import { classifyPrReviewCircuitSignal } from '../../../src/pr-review/circuit.js';
import {
	_internals as cancelInternals,
	executeCancelLaneBatch,
} from '../../../src/tools/cancel-lane-batch.js';
import {
	_internals,
	executeCollectLaneResults,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Vocabulary mirror: this key set must be EXACT against the union. Note the
 * `satisfies` check does NOT compile-guard it (tsconfig excludes tests/), so
 * the source-anchor test below is the real enforcement: every member needs a
 * `workflowLaneFailureClass: '<member>'` producer. A declared-but-unproduced
 * member can no longer slip in silently (the 'deadline' gap of #2381).
 */
const FAILURE_CLASS_MEMBERS = {
	contract: 'contract',
	resource: 'resource',
	liveness: 'liveness',
	// Issue #2971: explicit operator cancellation (cancel_lane_batch / the
	// /swarm abort-pr-workflow force override) — never host liveness.
	operator_cancelled: 'operator_cancelled',
	// Issue #3311: verdict-lane contract failures carry their own class
	verdict_contract: 'verdict_contract',
} as const satisfies Record<
	BackgroundDelegationWorkflowLaneFailureClass,
	string
>;

const FAILURE_CLASSES = Object.values(FAILURE_CLASS_MEMBERS);

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');

function readSource(relativePath: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** Idle host whose transcript is empty — the cancel_pending stub shape. */
function idleEmptyHost(sessionId: string): SessionOps {
	return {
		create: async () => ({ data: { id: sessionId }, error: undefined }),
		prompt: async () => ({
			data: { parts: [{ type: 'text' as const, text: 'unused' }] },
			error: undefined,
		}),
		promptAsync: async () => ({ data: undefined, error: undefined }),
		status: async () => ({
			data: { [sessionId]: { type: 'idle' } },
			error: undefined,
		}),
		messages: async () => ({ data: [], error: undefined }),
		delete: async () => undefined,
		abort: async () => undefined,
	} as never;
}

async function seedPendingLane(
	dir: string,
	suffix: string,
	batchId = `batch-pc-${suffix}`,
): Promise<void> {
	const recorded = await recordPendingDelegation(dir, {
		correlationId: `sess-pc-${suffix}`,
		jobId: null,
		subagentSessionId: `sess-pc-${suffix}`,
		parentSessionId: `parent-pc-${suffix}`,
		callID: batchId,
		normalizedAgent: 'sme',
		swarmPrefixedAgent: 'mega_sme',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId: `lane-pc-${suffix}`,
		mode: 'swarm-pr-review:base',
	});
	expect(recorded).not.toBeNull();
}

describe('workflow lane failure class parity (issue #2615)', () => {
	let dir: string;
	const realGetSessionOps = _internals.getSessionOps;
	const realNow = _internals.now;

	beforeEach(() => {
		dir = canonicalMkdtemp('lane-failure-class-parity-');
	});

	afterEach(() => {
		_internals.getSessionOps = realGetSessionOps;
		_internals.now = realNow;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('every vocabulary member has a live producer site', () => {
		const producerSources = [
			readSource('src/tools/dispatch-lanes.ts'),
			readSource('src/background/pending-delegations.ts'),
			// Issue #2971: the confirmed-cancellation tool owns the
			// operator_cancelled producer literal.
			readSource('src/tools/cancel-lane-batch.ts'),
		].join('\n');
		for (const failureClass of FAILURE_CLASSES) {
			// Matches both object-literal producers (`workflowLaneFailureClass:
			// 'x'`) and assignment producers (`workflowLaneFailureClass = 'x'`).
			expect(producerSources).toMatch(
				new RegExp(`workflowLaneFailureClass\\s*[:=]\\s*'${failureClass}'`),
			);
		}
	});

	it('the retired deadline class has no producer anywhere in src', () => {
		// Read-side compatibility widened ResultSchema to accept durable
		// pre-#2615 'deadline' rows; nothing may ever WRITE the retired
		// member again. Whole-text scan tolerant of whitespace INCLUDING
		// newlines between the key, operator, and quoted value — the same
		// [:=]-on-a-key contract as the live-producer anchor above, so
		// multi-line producer formatting cannot slip past a line-scoped
		// check. Pure string ops (no regex-escape transport hazards).
		const srcRoot = path.join(REPO_ROOT, 'src');
		const tsFiles: string[] = [];
		const walk = (entry: string): void => {
			for (const name of fs.readdirSync(entry)) {
				const full = path.join(entry, name);
				if (fs.statSync(full).isDirectory()) {
					walk(full);
					continue;
				}
				if (name.endsWith('.ts')) tsFiles.push(full);
			}
		};
		walk(srcRoot);
		expect(tsFiles.length).toBeGreaterThan(0);
		const isDeadlineProducerText = (text: string): boolean => {
			const key = 'workflowLaneFailureClass';
			let searchFrom = 0;
			while (true) {
				const idx = text.indexOf(key, searchFrom);
				if (idx < 0) return false;
				searchFrom = idx + key.length;
				let i = searchFrom;
				const isSpace = (ch: string | undefined): boolean =>
					ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
				while (i < text.length && isSpace(text[i])) {
					i++;
				}
				const op = text[i];
				if (op !== ':' && op !== '=') continue;
				if (op === '=') {
					const next: string | undefined = text[i + 1];
					// '===', '!==', '=>' are consumers, not producers.
					if (next === '=' || next === '>' || next === '!') continue;
				}
				i++;
				while (i < text.length && isSpace(text[i])) {
					i++;
				}
				const quote = text[i];
				if (quote !== "'" && quote !== '"') continue;
				i++;
				if (text.slice(i, i + 8) !== 'deadline') continue;
				if (text[i + 8] === quote) return true;
			}
		};
		const producers = tsFiles.filter((file) =>
			isDeadlineProducerText(fs.readFileSync(file, 'utf8')),
		);
		expect(producers).toEqual([]);
	});

	it('cancel_pending is guidance-only; a confirmed cancel settles operator_cancelled (issue #2971)', async () => {
		_internals.getSessionOps = () => idleEmptyHost('sess-pc-1');
		await seedPendingLane(dir, '1');
		// The collector is observation-only: an ordinary cancel_pending request
		// must NOT abort or settle anything — it answers with a typed refusal.
		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-pc-1', wait: false, cancel_pending: true },
			dir,
		);
		expect(result.cancelled).toBe(0);
		expect(result.cancellation_refused?.length).toBe(1);
		expect(result.cancellation_refused?.[0]?.lane_id).toContain('pc-1');
		expect(result.cancellation_refused?.[0]?.next_action).toContain(
			'cancel_lane_batch',
		);
		let record = findByBatchId(dir, 'batch-pc-1')[0];
		expect(record.status).toBe('pending');
		// The authorized surface settles the distinct operator_cancelled class
		// (never liveness) through the exactly-once claim.
		const realCancelOps = cancelInternals.getSessionOps;
		cancelInternals.getSessionOps = () => idleEmptyHost('sess-pc-1');
		try {
			const cancel = await executeCancelLaneBatch(
				{
					batch_id: 'batch-pc-1',
					reason: 'parity: operator cancellation probe',
					confirm: true,
				},
				dir,
			);
			expect(cancel.cancelled).toBe(1);
			record = findByBatchId(dir, 'batch-pc-1')[0];
			expect(record.status).toBe('cancelled');
			expect(record.terminalResult?.result?.workflowLaneFailureClass).toBe(
				'operator_cancelled',
			);
		} finally {
			cancelInternals.getSessionOps = realCancelOps;
		}
	});

	it('the Task-side stale sweep stamps a typed liveness result', async () => {
		await seedPendingLane(dir, '2');
		// The updatedAt seam replays a persisted timestamp exactly — force the
		// record far past any horizon without a clock.
		await appendDelegationTransition(dir, 'sess-pc-2', {
			status: 'running',
			updatedAt: 1_000,
			expectedCurrentStatuses: ['pending'],
		});
		const swept = await sweepStaleDelegations(dir, 60_000);
		expect(swept).toBeGreaterThanOrEqual(1);
		const record = findByBatchId(dir, 'batch-pc-2')[0];
		expect(record.status).toBe('stale');
		expect(record.result?.workflowLaneFailureClass).toBe('liveness');
		expect(record.result?.error).toMatch(/stale/i);
	});

	it('the collect-path sweep settles an unobservable host session as liveness', async () => {
		await seedPendingLane(dir, '3');
		// updatedAt seam: force the record past the collect sweep's stale
		// horizon (DEFAULT_ASYNC_STALE_TIMEOUT_MS) without a clock.
		await appendDelegationTransition(dir, 'sess-pc-3', {
			status: 'running',
			updatedAt: 1_000,
			expectedCurrentStatuses: ['pending'],
		});
		// The host answers the status call but does not know the lane session,
		// and the transcript is empty — readiness is 'unknown' with the record
		// still open, the exact retained-forever row #2615 closes.
		_internals.getSessionOps = () =>
			({
				...idleEmptyHost('sess-pc-3'),
				status: async () => ({ data: {}, error: undefined }),
			}) as never;
		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-pc-3', wait: false },
			dir,
		);
		expect(result.failed).toBe(1);
		const record = findByBatchId(dir, 'batch-pc-3')[0];
		expect(record.status).toBe('error');
		expect(record.terminalResult?.result?.workflowLaneFailureClass).toBe(
			'liveness',
		);
		expect(record.terminalResult?.result?.error).toMatch(
			/host session unobservable/,
		);
	});

	it('the collect-path sweep stamps the idle-host stale flip with a typed liveness result', async () => {
		await seedPendingLane(dir, '5');
		await appendDelegationTransition(dir, 'sess-pc-5', {
			status: 'running',
			updatedAt: 1_000,
			expectedCurrentStatuses: ['pending'],
		});
		// The host knows the session and reports it IDLE with an empty
		// transcript: past the horizon this takes the stale flip (not the
		// unobservable-host settle, which requires readiness 'unknown').
		_internals.getSessionOps = () => idleEmptyHost('sess-pc-5');
		await executeCollectLaneResults(
			{ batch_id: 'batch-pc-5', wait: false },
			dir,
		);
		const record = findByBatchId(dir, 'batch-pc-5')[0];
		expect(record.status).toBe('stale');
		// The typed class still rides record.result — the exact surface the
		// admission fallback reads (#2615) — and, since #2700, the flip also
		// writes the typed terminal event atomically with the disposition (no
		// eventless-terminal window).
		expect(record.result?.workflowLaneFailureClass).toBe('liveness');
		expect(record.terminalResult?.status).toBe('stale');
		expect(record.terminalResult?.result.workflowLaneFailureClass).toBe(
			'liveness',
		);
		expect(record.result?.workflowLaneFailureClass).toBe('liveness');
		expect(record.result?.error).toMatch(/presumed stale/i);
	});

	it('the Task-side stale sweep preserves a pre-existing partial result while stamping liveness', async () => {
		await seedPendingLane(dir, '4');
		const partialDigest = 'p'.repeat(64);
		// A classless partial result stamped before the flip (legacy
		// ingestion-preview shape) — the merge must keep its evidence intact
		// and only add the failure class.
		await appendDelegationTransition(dir, 'sess-pc-4', {
			status: 'ingestion_error',
			updatedAt: 1_000,
			result: {
				error: 'partial transcript',
				chars: 17,
				truncated: false,
				digest: partialDigest,
			},
			expectedCurrentStatuses: ['pending'],
		});
		const swept = await sweepStaleDelegations(dir, 60_000);
		expect(swept).toBeGreaterThanOrEqual(1);
		const record = findByBatchId(dir, 'batch-pc-4')[0];
		expect(record.status).toBe('stale');
		expect(record.result?.error).toBe('partial transcript');
		expect(record.result?.digest).toBe(partialDigest);
		expect(record.result?.workflowLaneFailureClass).toBe('liveness');
	});

	it('settles an unobservable lane even when busy-batch pressure starves the shared status budget (review wedge)', async () => {
		// The #2609 12-lane shape: with the clock frozen at a 10ms remaining
		// deadline, `reserveCollectionLaneCallBudgets` floors the shared
		// per-lane status budget to zero for the whole batch
		// (floor(10/12) -> 1 -> floor(1/2) -> 0). Only the sweep's dedicated
		// settle reserve can still fund the liveness question — without it
		// the unobservable past-horizon lane stays wedged open.
		const batchId = 'batch-pc-wedge';
		await seedPendingLane(dir, 'w0', batchId);
		await appendDelegationTransition(dir, 'sess-pc-w0', {
			status: 'running',
			updatedAt: 1_000,
			expectedCurrentStatuses: ['pending'],
		});
		for (let index = 1; index < 12; index++) {
			await seedPendingLane(dir, `w${index}`, batchId);
		}
		const frozenNow = _internals.now();
		_internals.now = () => frozenNow;
		_internals.getSessionOps = () =>
			({
				...idleEmptyHost('sess-pc-w0'),
				status: async () => ({ data: {}, error: undefined }),
			}) as never;
		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false, timeout_ms: 10 },
			dir,
		);
		expect(result.failed).toBe(1);
		const settled = findByBatchId(dir, batchId).find(
			(record) => record.status === 'error',
		);
		expect(settled).toBeDefined();
		expect(settled?.terminalResult?.result?.workflowLaneFailureClass).toBe(
			'liveness',
		);
		expect(settled?.terminalResult?.result?.error).toMatch(
			/host session unobservable/,
		);
	});

	it('a typed liveness terminal is circuit-ignored as host abandonment', () => {
		expect(
			classifyPrReviewCircuitSignal({
				status: 'error',
				result: { workflowLaneFailureClass: 'liveness' },
			} as never),
		).toEqual({ kind: 'ignored', reason: 'host_abandonment' });
	});
});
