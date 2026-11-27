/**
 * #3893/#3915 owner-approved fix (option b): the four subsystem persisted
 * free-text surfaces compose the redaction floor at their write boundaries.
 * Each leg drives the REAL write path with a synthetic credential and
 * asserts the persisted bytes are redacted (read-back through the module's
 * own reader where one exists). RED at the pre-fix base, GREEN after the fix.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { writeCuratorSummary } from '../../../src/hooks/curator';
import type { CuratorSummary } from '../../../src/hooks/curator-types';
import {
	appendKnowledge,
	appendRetractionRecord,
	normalize,
	readKnowledge,
	readRetractionRecords,
} from '../../../src/hooks/knowledge-store';
import { storeSummary } from '../../../src/summaries/manager';
import {
	writePhaseArchitectureSummary,
	writeSupervisorReport,
} from '../../../src/summaries/store';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GH = `ghp_${'w'.repeat(30)}`;
const STRIPE = `sk_live_${'A'.repeat(36)}`;

function walkAndRead(dir: string): string {
	const out: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const cur = stack.pop() as string;
		for (const entry of Array.from(
			require('node:fs').readdirSync(cur, {
				withFileTypes: true,
			}) as Array<{ name: string; isDirectory(): boolean }>,
		)) {
			const full = path.join(cur, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else out.push(readFileSync(full, 'utf-8'));
		}
	}
	return out.join('\n');
}

describe('persisted free-text floor (option b surfaces)', () => {
	test('curator-summary.json: phase digest prose is floored on disk', async () => {
		const dir = canonicalMkdtemp('optb-curator-');
		const summary: CuratorSummary = {
			schema_version: 1,
			session_id: 'sess-1',
			last_updated: '2026-11-26T00:00:00.000Z',
			last_phase_covered: 1,
			digest: 'a'.repeat(12),
			phase_digests: [
				{
					phase: 1,
					timestamp: '2026-11-26T00:00:00.000Z',
					summary: `phase summary quoting ${GH}`,
					agents_used: ['coder'],
					tasks_completed: 1,
					tasks_total: 1,
					key_decisions: [`decided with ${STRIPE}`],
					blockers_resolved: [],
				},
			],
			compliance_observations: [],
			knowledge_recommendations: [],
		};
		await writeCuratorSummary(dir, summary);
		const persisted = walkAndRead(path.join(dir, '.swarm'));
		expect(persisted.includes(GH)).toBe(false);
		expect(persisted.includes(STRIPE)).toBe(false);
	});

	test('summaries store: summaryText and fullOutput are floored on disk', async () => {
		const dir = canonicalMkdtemp('optb-summaries-');
		await storeSummary(
			dir,
			'S1',
			`tool output containing ${STRIPE}`,
			`summary quoting ${GH}`,
			1_000_000,
		);
		const persisted = walkAndRead(path.join(dir, '.swarm'));
		expect(persisted.includes(GH)).toBe(false);
		expect(persisted.includes(STRIPE)).toBe(false);
	});

	test('knowledge JSONL: lesson lines are floored on disk', async () => {
		const dir = canonicalMkdtemp('optb-knowledge-');
		const file = path.join(dir, '.swarm', 'knowledge.jsonl');
		await appendKnowledge(file, {
			lesson: `lesson learned with ${GH} inside`,
			tags: ['t'],
			revision: 0,
		});
		const persisted = readFileSync(file, 'utf-8');
		expect(persisted.includes(GH)).toBe(false);
		// Structure preserved: the record still parses with its tags.
		const parsed = JSON.parse(persisted.trim()) as { tags: string[] };
		expect(parsed.tags).toEqual(['t']);
	});

	test('knowledge retraction append is floored on disk', async () => {
		const dir = canonicalMkdtemp('optb-retract-');
		const { appendRetractionRecord } = await import(
			'../../../src/hooks/knowledge-store'
		);
		const file = path.join(dir, '.swarm', 'knowledge-retractions.jsonl');
		await appendRetractionRecord(dir, {
			id: 'r-1',
			retracted_lesson: `retracted lesson with ${STRIPE}`,
			normalized_lesson: 'normalized',
			recorded_at: '2026-11-26T00:00:00.000Z',
		});
		const persisted = readFileSync(file, 'utf-8');
		expect(persisted.includes(STRIPE)).toBe(false);
	});

	test('R-8b (recommended): evidence bundles floor on saveEvidence', async () => {
		const { saveEvidence } = await import('../../../src/evidence/manager');
		const dir = canonicalMkdtemp('optb-evidence-');
		// project-root guard: canonicalMkdtemp roots are accepted as-is by the
		// evidence manager's own suite (manager.test.ts drives the same helper)
		const bundle = await saveEvidence(dir, '1.1', {
			task_id: '1.1',
			type: 'note',
			timestamp: new Date().toISOString(),
			agent: 'test-agent',
			verdict: 'info',
			summary: `note evidence quoting ${GH} and ${STRIPE}`,
		} as never);
		expect(bundle).toBeTruthy();
		const persisted = walkAndRead(path.join(dir, '.swarm'));
		expect(persisted.includes(GH)).toBe(false);
		expect(persisted.includes(STRIPE)).toBe(false);
	});

	test('R-9: a credential ENDING a JSON string value redacts without corrupting the artifact (knowledge)', async () => {
		const dir = canonicalMkdtemp('r9-knowledge-');
		const file = path.join(dir, '.swarm', 'knowledge.jsonl');
		// The exact R-9 shape: the env_secret arm's optional trailing quote
		// consumed the JSON string delimiter when the floor ran over the
		// SERIALIZED line. Per-value flooring must redact AND keep the line
		// parseable.
		await appendKnowledge(file, {
			lesson: 'cfg secret_access_key=abcdefgh12345678',
			tags: ['t'],
			revision: 0,
		});
		const persisted = readFileSync(file, 'utf-8');
		expect(persisted.includes('abcdefgh12345678')).toBe(false);
		const parsed = JSON.parse(persisted.trim()) as {
			lesson: string;
			tags: string[];
		};
		expect(parsed.lesson.includes('[REDACTED:env_secret]')).toBe(true);
		expect(parsed.tags).toEqual(['t']);
	});

	test('R-9: end-of-string credential redacts without corrupting curator-summary.json', async () => {
		const dir = canonicalMkdtemp('r9-curator-');
		await writeCuratorSummary(dir, {
			schema_version: 1,
			session_id: 'sess-r9',
			last_updated: '2026-11-26T00:00:00.000Z',
			last_phase_covered: 1,
			digest: 'b'.repeat(12),
			phase_digests: [
				{
					phase: 1,
					timestamp: '2026-11-26T00:00:00.000Z',
					summary: 'ends with secret_access_key=abcdefgh12345678',
					agents_used: ['coder'],
					tasks_completed: 1,
					tasks_total: 1,
					key_decisions: [],
					blockers_resolved: [],
				},
			],
			compliance_observations: [],
			knowledge_recommendations: [],
		});
		const persisted = readFileSync(
			path.join(dir, '.swarm', 'curator-summary.json'),
			'utf-8',
		);
		expect(persisted.includes('abcdefgh12345678')).toBe(false);
		const parsed = JSON.parse(persisted) as {
			phase_digests: Array<{ summary: string }>;
		};
		expect(
			parsed.phase_digests[0]?.summary.includes('[REDACTED:env_secret]'),
		).toBe(true);
	});

	test('R-9: end-of-string credential redacts without corrupting the sidecar bundles', () => {
		const dir = canonicalMkdtemp('r9-sidecar-');
		writePhaseArchitectureSummary(dir, {
			schema_version: 1,
			phase: 3,
			summary: 'rollup ends with secret_access_key=abcdefgh12345678',
			agents_seen: [],
			tasks_seen: [],
			key_decisions: [],
			conflicts: [],
			unresolved_risks: [],
			constraint_violations: [],
			evidence_refs: [],
			created_at: '2026-11-26T00:00:00.000Z',
		});
		const persisted = readFileSync(
			path.join(
				dir,
				'.swarm',
				'evidence',
				'3',
				'phase-architecture-summary.json',
			),
			'utf-8',
		);
		expect(persisted.includes('abcdefgh12345678')).toBe(false);
		const parsed = JSON.parse(persisted) as { summary: string };
		expect(parsed.summary.includes('[REDACTED:env_secret]')).toBe(true);
	});

	test('R-8b: phase architecture summary sidecar is floored on disk', () => {
		const dir = canonicalMkdtemp('optb-archsum-');
		writePhaseArchitectureSummary(dir, {
			schema_version: 1,
			phase: 2,
			summary: `rollup quoting ${GH}`,
			agents_seen: ['coder'],
			tasks_seen: ['t1'],
			key_decisions: [`decision with ${STRIPE}`],
			conflicts: [],
			unresolved_risks: [],
			constraint_violations: [],
			evidence_refs: [],
			created_at: '2026-11-26T00:00:00.000Z',
		});
		const persisted = walkAndRead(path.join(dir, '.swarm'));
		expect(persisted.includes(GH)).toBe(false);
		expect(persisted.includes(STRIPE)).toBe(false);
	});

	test('R-8b: supervisor report sidecar is floored on disk (gate fields intact)', () => {
		const dir = canonicalMkdtemp('optb-supervisor-');
		writeSupervisorReport(dir, {
			schema_version: 1,
			phase: 2,
			verdict: 'CONCERNS',
			findings: [
				{
					severity: 'high',
					category: 'architecture',
					description: `finding quoting ${GH}`,
					recommendation: 'fix it',
				},
			],
			knowledge_recommendations: [],
			created_at: '2026-11-26T00:00:00.000Z',
		});
		const persisted = walkAndRead(path.join(dir, '.swarm'));
		expect(persisted.includes(GH)).toBe(false);
		// Gate-readable shape survives the floor (fixed points on clean text).
		const parsed = JSON.parse(
			readFileSync(
				path.join(
					dir,
					'.swarm',
					'evidence',
					'2',
					'architecture-supervisor.json',
				),
				'utf-8',
			),
		) as { entries: Array<{ verdict?: string; phase_number?: number }> };
		expect(parsed.entries[0]?.verdict).toBe('CONCERNS');
		expect(parsed.entries[0]?.phase_number).toBe(2);
	});
});

describe('retraction suppression key — regression: floored normalized_lesson must match the floored lesson (F-002)', () => {
	test('a secret-bearing retraction suppresses the floored on-disk lesson', async () => {
		// Previous behavior (PR #3952 review F-002): the curator computed
		// normalized_lesson from the RAW retraction text and the store persisted
		// that caller-supplied key verbatim. normalize() strips punctuation
		// (the underscore in ghp_…) BEFORE the secret patterns can match the
		// normalized copy, so the stored key kept raw token material while the
		// floored lesson on disk carried the [REDACTED:github_token]
		// placeholder — the suppression check
		// `suppressedLessons.has(normalize(entry.lesson))` could never match
		// and the retracted knowledge remained visible (with the token body
		// leaking into knowledge-retractions.jsonl).
		const dir = canonicalMkdtemp('f002-retract-');
		const knowledgeFile = path.join(dir, '.swarm', 'knowledge.jsonl');
		const retractionFile = path.join(
			dir,
			'.swarm',
			'knowledge-retractions.jsonl',
		);
		const rawLesson = `never commit the ${GH} token raw`;

		// The knowledge writer floors the lesson on disk…
		await appendKnowledge(knowledgeFile, {
			lesson: rawLesson,
			tags: ['t'],
			revision: 0,
		});
		// …and the curator appends a retraction whose normalized_lesson is
		// computed from the RAW text (the pre-fix caller contract).
		await appendRetractionRecord(dir, {
			id: 'r-f002',
			retracted_lesson: rawLesson,
			normalized_lesson: normalize(rawLesson),
			recorded_at: '2026-11-26T00:00:00.000Z',
			reported_by: 'architect',
			matched_swarm_ids: [],
			matched_hive_ids: [],
		});

		const persistedLesson = (
			await readKnowledge<{ lesson: string }>(knowledgeFile)
		)[0]?.lesson;
		expect(persistedLesson?.includes('[REDACTED:github_token]')).toBe(true);

		const records = await readRetractionRecords(dir);
		expect(records).toHaveLength(1);

		// The exact consumer predicate (knowledge-curator.ts,
		// knowledge-reader.ts, tools/knowledge-query.ts):
		// suppressedLessons.has(normalize(entry.lesson)) — evaluated against
		// the FLOORED on-disk lesson.
		const suppressed = new Set(records.map((r) => r.normalized_lesson));
		expect(suppressed.has(normalize(persistedLesson ?? ''))).toBe(true);

		// The token body (with or without the normalize-stripped underscore)
		// must not leak into the retractions file via the key.
		const persisted = readFileSync(retractionFile, 'utf-8');
		expect(persisted.includes(GH)).toBe(false);
		expect(persisted.includes(`ghp ${'w'.repeat(30)}`)).toBe(false);
	});

	test('secret-free retraction keys are byte-identical to the caller-supplied form', async () => {
		// The recomputation must be a no-op for secret-free text so existing
		// dedup/suppression behavior is unchanged: redactSecrets is identity on
		// clean text, so the store persists the caller's key verbatim.
		const dir = canonicalMkdtemp('f002-clean-');
		await appendRetractionRecord(dir, {
			id: 'r-f002-clean',
			retracted_lesson: 'Always use strict mode',
			normalized_lesson: 'always use strict mode',
			recorded_at: '2026-11-26T00:00:00.000Z',
			reported_by: 'architect',
			matched_swarm_ids: [],
			matched_hive_ids: [],
		});
		const records = await readRetractionRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0]?.normalized_lesson).toBe('always use strict mode');
	});
});
