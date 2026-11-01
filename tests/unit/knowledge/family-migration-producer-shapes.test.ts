/**
 * Producer-shape key derivation in the knowledge family manifest (issue
 * #3521 AC2/AC3 / frozen check C7's shipped surface). Real producers write
 * `event_id` rows to knowledge-events.jsonl (no top-level id) and
 * `knowledgeId` rows to knowledge-application.jsonl (no unique record id) —
 * the previous default `lineId` selector returned null for both, silently
 * dropping event rows on link and aborting unlink copy-back at the
 * pre-commit validator. Also exercises the FULL migrateKnowledgeFamily link
 * + unlink copy-back flow on real producer row shapes.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { KNOWLEDGE_FAMILY } from '../../../src/knowledge/family-manifest';
import {
	_internals,
	migrateKnowledgeFamily,
} from '../../../src/knowledge/family-migration';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const { keySelectorFor, validateSerialized, appendUnionById } = _internals;

function member(filename: string) {
	const m = KNOWLEDGE_FAMILY.find((x) => x.filename === filename);
	if (!m) throw new Error(`no member ${filename}`);
	return m;
}

const eventsMember = member('knowledge-events.jsonl');
const applicationMember = member('knowledge-application.jsonl');

/** Real RetrievedEvent shape (src/hooks/knowledge-events.ts). */
const realEventRow = {
	type: 'retrieved',
	event_id: 'evt-abc-123',
	timestamp: '2026-10-31T00:00:00Z',
	trace_id: 't-1',
	session_id: 's-1',
	agent: 'coder',
	query: 'shell write gate',
	retrieval_mode: 'manual',
	result_ids: ['k1'],
	ranks: { k1: 1 },
	scores: { k1: 0.9 },
} as const;

/** Real KnowledgeApplicationRecord shape (src/hooks/knowledge-types.ts). */
const realApplicationRow = {
	timestamp: '2026-10-30T00:00:00Z',
	knowledgeId: 'k42',
	result: 'applied',
	phase: 'implement',
	taskId: '1.1',
	action: 'apply',
	sessionId: 's-9',
	reason: 'relevant to fix',
} as const;

const created: string[] = [];
afterAll(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

describe('knowledge-events key selector', () => {
	test('derives a real key from event_id on a real producer row', () => {
		expect(keySelectorFor(eventsMember)(realEventRow)).toBe('evt-abc-123');
	});

	test('legacy top-level id rows still key (synthetic-suite compatibility)', () => {
		expect(keySelectorFor(eventsMember)({ id: 'ev1', kind: 'surface' })).toBe(
			'ev1',
		);
	});

	test('malformed rows (neither field) return null and the validator rejects them', () => {
		const malformed = { type: 'retrieved', timestamp: '2026-10-31T00:00:00Z' };
		expect(keySelectorFor(eventsMember)(malformed)).toBeNull();
		expect(
			validateSerialized(
				eventsMember as never,
				`${JSON.stringify(malformed)}\n`,
			),
		).toBe(false);
	});

	test('a real event row SURVIVES a fresh link (added, not dropped)', () => {
		const r = appendUnionById(
			[] as never[],
			[realEventRow] as never[],
			keySelectorFor(eventsMember) as never,
		);
		expect(r.added).toBe(1);
		expect(r.merged).toHaveLength(1);
	});

	test('the validator ACCEPTS the serialized real row (unlink copy-back path)', () => {
		expect(
			validateSerialized(
				eventsMember as never,
				`${JSON.stringify(realEventRow)}\n`,
			),
		).toBe(true);
	});
});

describe('knowledge-application key selector', () => {
	test('derives a stable whole-row identity for a real producer row', () => {
		const key = keySelectorFor(applicationMember)(realApplicationRow);
		expect(typeof key).toBe('string');
		expect(key.length).toBeGreaterThan(0);
		// Same bytes re-seen on retry derive the SAME key (idempotent dedupe).
		expect(keySelectorFor(applicationMember)({ ...realApplicationRow })).toBe(
			key,
		);
	});

	test('legacy top-level id rows keep their id as the key', () => {
		expect(
			keySelectorFor(applicationMember)({ id: 'app-1', knowledgeId: 'k1' }),
		).toBe('app-1');
	});

	test('two DISTINCT application outcomes for one knowledgeId both survive', () => {
		// Rows differ only in contextual fields (sessionId/taskId) at the same
		// timestamp+result — a knowledgeId-only key would collapse them.
		const a = { ...realApplicationRow, sessionId: 's-a', taskId: '1.1' };
		const b = { ...realApplicationRow, sessionId: 's-b', taskId: '2.2' };
		const r = appendUnionById(
			[] as never[],
			[a, b] as never[],
			keySelectorFor(applicationMember) as never,
		);
		expect(r.added).toBe(2);
		expect(r.merged).toHaveLength(2);
	});

	test('an exact retry of the same row dedupes', () => {
		const r = appendUnionById(
			[realApplicationRow] as never[],
			[{ ...realApplicationRow }] as never[],
			keySelectorFor(applicationMember) as never,
		);
		expect(r.merged).toHaveLength(1);
		expect(r.skipped).toBe(1);
	});

	test('a row without knowledgeId is malformed: null key, validator rejects', () => {
		const malformed = { timestamp: '2026-10-30T00:00:00Z', result: 'applied' };
		expect(keySelectorFor(applicationMember)(malformed)).toBeNull();
		expect(
			validateSerialized(
				applicationMember as never,
				`${JSON.stringify(malformed)}\n`,
			),
		).toBe(false);
	});

	test('the validator ACCEPTS the serialized real application row', () => {
		expect(
			validateSerialized(
				applicationMember as never,
				`${JSON.stringify(realApplicationRow)}\n`,
			),
		).toBe(true);
	});
});

describe('migrateKnowledgeFamily on real producer shapes (link + unlink)', () => {
	function seed(dir: string, files: Record<string, string>): string {
		mkdirSync(dir, { recursive: true });
		for (const [name, body] of Object.entries(files)) {
			writeFileSync(path.join(dir, name), body);
		}
		return dir;
	}

	test('link copies real event + application rows; unlink copy-back completes', async () => {
		const root = canonicalMkdtemp('km-producer-');
		created.push(root);
		const shared = seed(path.join(root, 'shared'), {
			'knowledge.jsonl': `${JSON.stringify({
				id: 'k9',
				lesson: 'existing shared lesson',
				revision: 1,
				updated_at: '2026-01-01T00:00:00Z',
			})}\n`,
		});
		const local = seed(path.join(root, 'local'), {
			'knowledge.jsonl': `${JSON.stringify({
				id: 'k9',
				lesson: 'newer local lesson',
				revision: 4,
				updated_at: '2026-09-01T00:00:00Z',
			})}\n`,
			'knowledge-events.jsonl': `${JSON.stringify(realEventRow)}\n`,
			'knowledge-application.jsonl': `${JSON.stringify(realApplicationRow)}\n`,
		});

		// LINK: local merges INTO shared. Must not throw (the base bug aborted
		// at validateSerialized on the keyless real event row).
		const linkCounts = await migrateKnowledgeFamily(shared, local);
		const eventsAfter = readFileSync(
			path.join(shared, 'knowledge-events.jsonl'),
			'utf8',
		);
		expect(eventsAfter).toContain('evt-abc-123');
		const applicationAfter = readFileSync(
			path.join(shared, 'knowledge-application.jsonl'),
			'utf8',
		);
		expect(applicationAfter).toContain('k42');
		const storeAfter = readFileSync(
			path.join(shared, 'knowledge.jsonl'),
			'utf8',
		);
		expect(storeAfter).toContain('newer local lesson');

		// UNLINK: shared copies BACK to local. Also must not throw; the real
		// rows survive the reverse migration with identical keys (dedupe).
		await migrateKnowledgeFamily(local, shared);
		const localEvents = readFileSync(
			path.join(local, 'knowledge-events.jsonl'),
			'utf8',
		);
		expect(localEvents).toContain('evt-abc-123');
		// The application member's copy-back is asserted too — the original
		// gap never checked it (PRR-020c).
		const localApplication = readFileSync(
			path.join(local, 'knowledge-application.jsonl'),
			'utf8',
		);
		expect(localApplication).toContain('k42');
		// The events member actually merged work (added the real event row).
		const eventsMemberCount = linkCounts.perMember.find(
			(m) => m.filename === 'knowledge-events.jsonl',
		);
		expect(eventsMemberCount?.merged).toBeGreaterThan(0);
	});
});
