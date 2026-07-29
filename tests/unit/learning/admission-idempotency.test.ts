/**
 * D1 — real-time admission must not double-confirm at the fold-in
 * (issue #1821, Workstream B, Task 3): core scenarios.
 *
 * `reinforceSwarmKnowledgeEntry` is NOT a no-op. It appends a `confirmed_by`
 * record and recomputes confidence, and `phaseNumbers.size >= 3` is hive
 * eligibility route 1 (`src/hooks/hive-policy.ts`). A candidate admitted in real
 * time and then folded in again would silently inflate confidence and push the
 * entry toward automatic promotion.
 *
 * Phase-number matching CANNOT prevent this: `curateAndStoreSwarm` has five
 * callers that resolve the phase differently — `src/commands/close.ts` hardcodes
 * 0 and the plan.md path falls back to 1 — so the fold-in routinely runs under a
 * different phase number than the admission did. Identity is the only workable
 * key.
 *
 * The per-check guard tests live in `admission-idempotency-checks.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { curateAndStoreSwarm } from '../../../src/hooks/knowledge-curator.js';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import { insightAdmissionMarker } from '../../../src/hooks/micro-reflector.js';
import { admitCandidate } from '../../../src/learning/admission.js';
import { resetSessionQueue } from '../../../src/learning/candidate-queue.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import {
	stampedCandidate as candidate,
	knowledgeConfig,
	LESSON,
	storedEntries as readStored,
	seedDurableQueue as seedQueue,
} from './_admission-fixtures.js';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('admission-d1-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	resetSessionQueue();
});

afterEach(() => {
	resetSessionQueue();
	fs.rmSync(dir, { recursive: true, force: true });
});

const storedEntries = () => readStored(dir);
const seedDurableQueue = (lines: Record<string, unknown>[]) =>
	seedQueue(dir, lines);

function admissionDeps(phaseNumber: number) {
	return {
		knowledgeConfig,
		projectName: 'proj',
		phaseNumber,
		sessionID: 'sess-1',
	};
}

describe('D1 — admitted candidate is not re-confirmed by the fold-in', () => {
	it('(a) survives a PHASE ADVANCE with exactly one confirmed_by', async () => {
		const cand = candidate();
		const admitted = await admitCandidate(dir, cand, admissionDeps(1));
		expect(admitted.outcome).toBe('admitted');

		// The durable backstop still holds the same candidate — that is the whole
		// point of AC8 (crash safety), and it is what the fold-in will read.
		seedDurableQueue([cand]);

		// Phase boundary at a DIFFERENT phase number than the admission used.
		await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 2 },
			dir,
			knowledgeConfig,
		);

		const entries = await storedEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].confirmed_by).toHaveLength(1);
		expect(entries[0].confirmed_by[0].phase_number).toBe(1);
		expect(entries[0].source_knowledge_ids).toContain(
			insightAdmissionMarker(cand.id as string),
		);
	});

	it('(b) survives a /swarm close fold-in at PHASE 0', async () => {
		const cand = candidate();
		await admitCandidate(dir, cand, admissionDeps(3));
		seedDurableQueue([cand]);

		// `src/commands/close.ts` hardcodes `{ phase_number: 0 }` — the case that
		// makes any phase-number-based guard unusable.
		await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 0 },
			dir,
			knowledgeConfig,
		);

		const entries = await storedEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].confirmed_by).toHaveLength(1);
		expect(entries[0].confirmed_by[0].phase_number).toBe(3);
	});

	it('(c) survives a LEGACY id-less durable line (no migration required)', async () => {
		const cand = candidate();
		await admitCandidate(dir, cand, admissionDeps(1));

		// A line written before the `id` field existed. The fold-in must recompute
		// the identical identity from {lesson, taskId, createdAt}.
		const { id: _dropped, ...legacyLine } = cand;
		expect('id' in legacyLine).toBe(false);
		seedDurableQueue([legacyLine]);

		await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 2 },
			dir,
			knowledgeConfig,
		);

		const entries = await storedEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].confirmed_by).toHaveLength(1);
	});

	it('does not double-confirm across TWO successive fold-ins', async () => {
		const cand = candidate();
		await admitCandidate(dir, cand, admissionDeps(1));

		seedDurableQueue([cand]);
		await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 2 },
			dir,
			knowledgeConfig,
		);
		seedDurableQueue([cand]);
		await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 3 },
			dir,
			knowledgeConfig,
		);

		const entries = await storedEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].confirmed_by).toHaveLength(1);
	});
});

describe('D1 — falsifiability controls (the guard must not skip everything)', () => {
	it('a NEVER-admitted candidate IS still folded in normally', async () => {
		// Without this control the tests above would pass even if the fold-in
		// silently dropped every insight candidate.
		seedDurableQueue([
			candidate('Always check the build output before pushing a change'),
		]);
		await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 2 },
			dir,
			knowledgeConfig,
		);

		const entries = await storedEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].lesson).toBe(
			'Always check the build output before pushing a change',
		);
		expect(entries[0].confirmed_by).toHaveLength(1);
	});

	it('a DIFFERENT candidate is admitted alongside an already-admitted one', async () => {
		const admittedCand = candidate();
		await admitCandidate(dir, admittedCand, admissionDeps(1));

		seedDurableQueue([
			admittedCand,
			candidate(
				'Verify the generated migration applies cleanly before merging',
			),
		]);
		await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 2 },
			dir,
			knowledgeConfig,
		);

		const entries = await storedEntries();
		expect(entries).toHaveLength(2);
		const original = entries.find((e) => e.lesson === LESSON);
		const fresh = entries.find((e) => e.lesson !== LESSON);
		expect(original?.confirmed_by).toHaveLength(1);
		expect(fresh?.confirmed_by).toHaveLength(1);
	});
});

describe('D1 — the REINFORCE branch is marked too', () => {
	it('stamps the marker when admission reinforces a pre-existing entry', async () => {
		// Seed a near-duplicate the admission will reinforce rather than append.
		const first = candidate(
			'Re-run the failing test file before finishing a fix',
		);
		await admitCandidate(dir, first, admissionDeps(1));

		const nearDuplicate = candidate(
			'Re-run the failing test file before finishing a fix now',
			{ created_at: '2026-02-02T00:00:00.000Z' },
		);
		const result = await admitCandidate(dir, nearDuplicate, admissionDeps(2));
		expect(result.outcome).toBe('reinforced');

		const afterAdmit = await storedEntries();
		expect(afterAdmit).toHaveLength(1);
		// `reinforceSwarmKnowledgeEntry` does not write source_knowledge_ids, so
		// admission must stamp it explicitly — otherwise the fold-in re-confirms.
		expect(afterAdmit[0].source_knowledge_ids).toContain(
			insightAdmissionMarker(nearDuplicate.id as string),
		);
		const confirmationsAfterAdmit = afterAdmit[0].confirmed_by.length;

		// Now the fold-in sees the same near-duplicate on the durable queue.
		seedDurableQueue([nearDuplicate]);
		await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 5 },
			dir,
			knowledgeConfig,
		);

		const afterFold = await storedEntries();
		expect(afterFold).toHaveLength(1);
		expect(afterFold[0].confirmed_by).toHaveLength(confirmationsAfterAdmit);
	});

	it('refuses to admit the same candidate twice in a row', async () => {
		const cand = candidate();
		expect((await admitCandidate(dir, cand, admissionDeps(1))).outcome).toBe(
			'admitted',
		);
		const second = await admitCandidate(dir, cand, admissionDeps(7));
		expect(second.outcome).toBe('rejected');
		expect(second.reason).toBe('already_admitted');

		const entries = await storedEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].confirmed_by).toHaveLength(1);
	});
});
