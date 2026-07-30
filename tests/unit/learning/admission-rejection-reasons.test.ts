/**
 * `AdmissionResult.reason` — the three literals nothing was reading
 * (issue #1821, Workstream B).
 *
 * `'invalid_shape'`, `'screened_out'` and `'no_change'` each appeared exactly
 * once repo-wide: at the `return` that produces them. The drain loop reads only
 * `outcome` and drops `reason` on the floor, so all three were write-only. That
 * is the repo's "untested branch" class — a literal no test pins can be renamed,
 * merged into its neighbour, or deleted, and the whole suite stays green even
 * though three genuinely distinguishable rejection causes have collapsed into
 * one indistinguishable one.
 *
 * They are worth keeping rather than collapsing: each names a DIFFERENT gate,
 * and a caller debugging "my lesson never landed" needs to know whether it was
 * malformed, screened out by the model, or blocked before the transaction ever
 * opened. These tests are what make that distinction real.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { admitCandidate } from '../../../src/learning/admission.js';
import {
	enqueueCandidate,
	resetSessionQueue,
} from '../../../src/learning/candidate-queue.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import {
	baseDeps,
	knowledgeConfig,
	stampedCandidate,
} from './_admission-fixtures.js';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('admission-reasons-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	resetSessionQueue();
});

afterEach(() => {
	resetSessionQueue();
	fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Screening reserves its token budget from the SESSION QUEUE, and
 * `reserveLlmBudget` returns false when no queue exists for the session — which
 * makes screening fail open and admit unscreened. A test that wants the screener
 * to actually run must therefore materialize the session queue first.
 */
function withSessionQueue(sessionID: string): void {
	enqueueCandidate(sessionID, stampedCandidate('queue seed'), {
		maxQueueSize: 10,
		maxLlmCallsPerSession: 5,
		maxTokensPerSession: 50_000,
		maxRetriesPerCandidate: 1,
	});
}

describe('admitCandidate — rejection reasons are distinguishable', () => {
	it("gate 1 rejects a malformed candidate as 'invalid_shape'", async () => {
		// An agent name outside the validator's NAME_PATTERN fails the shape gate
		// BEFORE the actionability gate, so the reason must be the shape one — not
		// the 'unactionable' reason the very next gate produces.
		const result = await admitCandidate(
			dir,
			stampedCandidate('lesson for the shape gate', {
				applies_to_agents: ['Not A Valid Agent Name!'],
			}),
			baseDeps(),
		);
		expect(result.outcome).toBe('rejected');
		expect(result.reason).toBe('invalid_shape');
		// Nothing may have been written: the shape gate precedes the transaction.
		expect(fs.existsSync(path.join(dir, '.swarm', 'knowledge.jsonl'))).toBe(
			false,
		);
	});

	it("gate 2's reason is NOT 'invalid_shape' — the two gates stay separate", async () => {
		// Well-formed but carrying no predicate: it clears the shape gate and is
		// stopped by the Layer-5 actionability floor instead. Pinning this is what
		// keeps 'invalid_shape' from silently absorbing the gate below it.
		const result = await admitCandidate(
			dir,
			stampedCandidate('lesson with no predicate', {
				required_actions: [],
				forbidden_actions: [],
				verification_checks: [],
			}),
			baseDeps(),
		);
		expect(result.outcome).toBe('rejected');
		expect(result.reason).not.toBe('invalid_shape');
		expect(result.reason).not.toBe('screened_out');
	});

	it("gate 3 rejects a model-screened candidate as 'screened_out'", async () => {
		withSessionQueue('sess-screen');
		const result = await admitCandidate(
			dir,
			stampedCandidate('lesson the screener refuses'),
			{
				...baseDeps(),
				sessionID: 'sess-screen',
				llmDelegate: async () => 'REJECT',
				llmTimeoutMs: 1000,
				llmBudget: {
					maxLlmCallsPerSession: 5,
					maxTokensPerSession: 50_000,
				},
			},
		);
		expect(result.outcome).toBe('rejected');
		expect(result.reason).toBe('screened_out');
	});

	it("an ADMIT verdict does not produce 'screened_out'", async () => {
		withSessionQueue('sess-admit');
		const result = await admitCandidate(
			dir,
			stampedCandidate('lesson the screener accepts'),
			{
				...baseDeps(),
				sessionID: 'sess-admit',
				llmDelegate: async () => 'ADMIT',
				llmTimeoutMs: 1000,
				llmBudget: {
					maxLlmCallsPerSession: 5,
					maxTokensPerSession: 50_000,
				},
			},
		);
		expect(result.outcome).toBe('admitted');
		expect(result.reason).toBeUndefined();
	});

	it("'no_change' is returned when the transaction body never runs at all", async () => {
		// `transactFile` returns false WITHOUT invoking its mutate callback when it
		// cannot create the store directory, so `reason` keeps its initial value.
		// That is the one path on which the literal survives, and it is a real
		// operator-visible state — the store is unwritable — not dead defence.
		// A path whose parent is an existing FILE makes mkdir fail portably
		// (ENOTDIR on POSIX, ENOENT/EEXIST on Windows) without needing chmod.
		const blocker = path.join(dir, '.swarm', 'blocker');
		fs.writeFileSync(blocker, 'not a directory');
		const result = await admitCandidate(
			dir,
			stampedCandidate('lesson that cannot be persisted'),
			{
				...baseDeps(),
				resolveKnowledgePath: () => path.join(blocker, 'knowledge.jsonl'),
			},
		);
		expect(result.outcome).toBe('rejected');
		expect(result.reason).toBe('no_change');
		// The candidate still produced validated provenance — the write failed, the
		// adjudication did not.
		expect(result.provenance?.mechanism).toBe('micro_reflection');
	});

	it("a successful admission overwrites 'no_change' rather than leaking it", async () => {
		const result = await admitCandidate(
			dir,
			stampedCandidate('lesson that persists cleanly'),
			baseDeps(),
		);
		expect(result.outcome).toBe('admitted');
		expect(result.reason).toBeUndefined();
		expect(result.entryId).toBeDefined();
		expect(knowledgeConfig.schema_version).toBeGreaterThan(0);
	});
});
