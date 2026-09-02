/**
 * D1 guard-by-guard coverage (issue #1821, Workstream B, Task 3).
 *
 * These cover the marker checks individually. Two of them are genuinely
 * isolating — disabling the in-transaction CHECK 2a scan or CHECK 2b each turns
 * exactly one test here red. The pre-transaction CHECK 1 is deliberately NOT
 * claimed to be isolated: since 2a became a full marker SCAN it subsumes every
 * case CHECK 1 catches, so CHECK 1 survives as an early skip that avoids
 * entering the transaction (and taking the `.swarm/` lock) at all, plus
 * defence in depth. Do not "prove" CHECK 1 by a test that only passes because
 * 2a is absent.
 *
 * The end-to-end scenarios live in `admission-idempotency.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeGroupCommitWriter } from '../../../src/db/group-commit-writer.js';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { curateAndStoreSwarm } from '../../../src/hooks/knowledge-curator.js';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import { insightAdmissionMarker } from '../../../src/hooks/micro-reflector.js';
import { admitCandidate } from '../../../src/learning/admission.js';
import { resetSessionQueue } from '../../../src/learning/candidate-queue.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import {
	stampedCandidate as candidate,
	entryFixtureBase,
	FIXTURE_CONFIRMATION,
	knowledgeConfig,
	LESSON,
	storedEntries as readStored,
	seedDurableQueue as seedQueue,
} from './_admission-fixtures.js';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('admission-d1-checks-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	resetSessionQueue();
});

afterEach(() => {
	resetSessionQueue();
	// #2480: the curator flow opens swarm.db — release before cleanup.
	try {
		closeGroupCommitWriter(dir);
		closeProjectDb(dir);
	} catch {
		// already closed
	}
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

describe('D1 — a marked entry suppresses the candidate whichever entry dedup picks', () => {
	it('skips the candidate when the MARKED entry is not the nearest duplicate', async () => {
		// `findNearDuplicate` is FIRST-match (`entries.find`), not best-match, so an
		// unmarked near-duplicate sitting EARLIER in the file wins the dedup lookup
		// even though a different, marked entry already accounts for this candidate.
		// Both marker checks are full SCANS for exactly this reason — neither keys
		// off the entry dedup happened to select. This is the defense-in-depth case:
		// the pre-transaction scan catches it first, and the in-transaction scan is
		// the backstop, so removing either layer alone still leaves the invariant
		// held (`admission-idempotency-checks` proves each layer separately below).
		const cand = candidate();
		const marker = insightAdmissionMarker(cand.id as string);
		const confirmation = FIXTURE_CONFIRMATION;
		const base = entryFixtureBase();
		const unmarkedFirst = {
			...base,
			id: 'entry-b-unmarked',
			lesson: LESSON,
			confirmed_by: [confirmation],
		};
		const markedSecond = {
			...base,
			id: 'entry-a-marked',
			lesson: `${LESSON} every time`,
			confirmed_by: [confirmation],
			source_knowledge_ids: [marker],
		};
		fs.writeFileSync(
			resolveSwarmKnowledgePath(dir),
			`${JSON.stringify(unmarkedFirst)}\n${JSON.stringify(markedSecond)}\n`,
		);

		seedDurableQueue([cand]);
		await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 5 },
			dir,
			knowledgeConfig,
		);

		const entries = await storedEntries();
		expect(entries).toHaveLength(2);
		const b = entries.find((e) => e.id === 'entry-b-unmarked');
		const a = entries.find((e) => e.id === 'entry-a-marked');
		// Neither entry may gain a phase-5 confirmation: the candidate was already
		// accounted for by the marked entry.
		expect(b?.confirmed_by).toHaveLength(1);
		expect(a?.confirmed_by).toHaveLength(1);
	});
});

describe('D1 — CHECK 2 (in-transaction) closes the snapshot-staleness window', () => {
	it('skips a candidate admitted AFTER the snapshot read but BEFORE the transaction', async () => {
		// `curateAndStoreSwarm` reads its snapshot BEFORE the LLM enrichment loop
		// and before `consumeInsightCandidates`. A real-time admission that commits
		// inside that window is invisible to the pre-transaction check, so only the
		// in-transaction re-test against fresh disk state can stop the second
		// reinforcement. This drives the admission from inside the enrichment
		// delegate, which is exactly where that window lives.
		const cand = candidate();
		seedDurableQueue([cand]);

		let admittedDuringWindow = false;
		const llmDelegate = async (): Promise<string> => {
			if (!admittedDuringWindow) {
				admittedDuringWindow = true;
				const result = await admitCandidate(dir, cand, admissionDeps(1));
				expect(result.outcome).toBe('admitted');
			}
			// Enrichment output is irrelevant here; the retro lesson exists only to
			// make the curator call the delegate at the right moment.
			return '[]';
		};

		await curateAndStoreSwarm(
			['a plain prose retrospective lesson with no predicate or scope'],
			'proj',
			{ phase_number: 2 },
			dir,
			knowledgeConfig,
			{ llmDelegate },
		);

		expect(admittedDuringWindow).toBe(true);
		const entries = await storedEntries();
		const admitted = entries.filter((e) => e.lesson === LESSON);
		expect(admitted).toHaveLength(1);
		expect(admitted[0].confirmed_by).toHaveLength(1);
		expect(admitted[0].confirmed_by[0].phase_number).toBe(1);
	});
});

describe('D1 — CHECK 2a scans for the marker rather than trusting the picked id', () => {
	it('does not reinforce a second entry when a DIFFERENT entry carries the marker', async () => {
		// `findNearDuplicate` is first-match over the array, and the fold-in picks
		// its reinforcement target from the STALE snapshot. If the entry real-time
		// admission marked is not the entry the fold-in picked, a check that only
		// inspected the picked entry would miss the marker and confirm a second
		// entry for a candidate already accounted for.
		const cand = candidate();
		const marker = insightAdmissionMarker(cand.id as string);
		const confirmation = FIXTURE_CONFIRMATION;
		const base = entryFixtureBase();
		// The fold-in's snapshot sees ONLY the unmarked near-duplicate.
		const unmarked = {
			...base,
			id: 'entry-unmarked',
			lesson: LESSON,
			confirmed_by: [confirmation],
		};
		fs.writeFileSync(
			resolveSwarmKnowledgePath(dir),
			`${JSON.stringify(unmarked)}\n`,
		);
		seedDurableQueue([cand]);

		// A DIFFERENT entry carrying the marker appears inside the staleness
		// window, driven from the enrichment delegate.
		const llmDelegate = async (): Promise<string> => {
			const current = fs
				.readFileSync(resolveSwarmKnowledgePath(dir), 'utf-8')
				.split('\n')
				.filter((l) => l.trim());
			const marked = {
				...base,
				id: 'entry-marked',
				lesson: `${LESSON} every single time`,
				confirmed_by: [confirmation],
				source_knowledge_ids: [marker],
			};
			fs.writeFileSync(
				resolveSwarmKnowledgePath(dir),
				`${[...current, JSON.stringify(marked)].join('\n')}\n`,
			);
			return '[]';
		};

		await curateAndStoreSwarm(
			['a plain prose retrospective lesson with no predicate or scope'],
			'proj',
			{ phase_number: 9 },
			dir,
			knowledgeConfig,
			{ llmDelegate },
		);

		const entries = await storedEntries();
		const picked = entries.find((e) => e.id === 'entry-unmarked');
		const carrier = entries.find((e) => e.id === 'entry-marked');
		expect(carrier).toBeDefined();
		// Neither entry may gain a phase-9 confirmation.
		expect(picked?.confirmed_by).toHaveLength(1);
		expect(carrier?.confirmed_by).toHaveLength(1);
	});
});

describe('D1 — the marker scan applies the ACTIVE filter itself', () => {
	it('re-admits a candidate whose only marked entry was archived', async () => {
		const cand = candidate();
		await admitCandidate(dir, cand, admissionDeps(1));

		// Archive the admitted entry directly on disk. `snapshotPlusNew` and the
		// in-transaction `current` array both still contain it, so a marker scan
		// that skipped `isActiveSwarmKnowledgeEntry` would treat this stale marker
		// as proof of admission and silently drop a legitimate candidate.
		const knowledgePath = resolveSwarmKnowledgePath(dir);
		const raw = fs
			.readFileSync(knowledgePath, 'utf-8')
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as SwarmKnowledgeEntry);
		raw[0].status = 'archived';
		fs.writeFileSync(
			knowledgePath,
			`${raw.map((e) => JSON.stringify(e)).join('\n')}\n`,
		);

		seedDurableQueue([cand]);
		await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 2 },
			dir,
			knowledgeConfig,
		);

		const entries = await storedEntries();
		// The archived original plus a freshly folded-in active entry.
		expect(entries).toHaveLength(2);
		expect(entries.filter((e) => e.status === 'archived')).toHaveLength(1);
		expect(entries.filter((e) => e.status === 'candidate')).toHaveLength(1);
	});
});

describe('D1 — candidate identity is content-derived, never trusted from disk', () => {
	it('IGNORES a spoofed `id` on the durable line', async () => {
		// `.swarm/insight-candidates.jsonl` is read back through a bare
		// `JSON.parse(...) as InsightCandidate` and the curator explicitly treats it
		// as tamper-suspect. If the stamped `id` were trusted, a line carrying an
		// already-admitted candidate's id would make the fold-in silently DROP this
		// genuinely new lesson.
		const admitted = candidate();
		await admitCandidate(dir, admitted, admissionDeps(1));

		const distinctLesson =
			'Always check the generated migration applies cleanly before merging';
		const spoofed = {
			...candidate(distinctLesson),
			id: admitted.id, // stolen identity
		};
		seedDurableQueue([spoofed]);

		await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 2 },
			dir,
			knowledgeConfig,
		);

		const entries = await storedEntries();
		// The distinct lesson survives: identity is recomputed from content, so the
		// stolen id cannot suppress it.
		expect(entries.map((e) => e.lesson)).toContain(distinctLesson);
		expect(entries).toHaveLength(2);
	});

	it('IGNORES a rotated `id`, so the same lesson is still not re-confirmed', async () => {
		// The mirror-image attack: a fresh random id every run would, if trusted,
		// let the same lesson be re-confirmed every phase and inflate confidence
		// toward hive auto-promotion.
		const cand = candidate();
		await admitCandidate(dir, cand, admissionDeps(1));

		seedDurableQueue([{ ...cand, id: 'ic_0000000000000000' }]);
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
});
