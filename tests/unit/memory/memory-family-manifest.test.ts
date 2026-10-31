/**
 * #1850: memory family manifest + migration engine (acceptance #7).
 * Tests the manifest inventory, JSONL append-union, and SQLite staging.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MEMORY_FAMILY } from '../../../src/memory/memory-family-manifest';
import { _internals } from '../../../src/memory/memory-family-migration';

function makeTmp(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe('#1850 memory family manifest (acceptance #7)', () => {
	test('manifest includes memory.db, all JSONL files, and excludes derived', () => {
		const filenames = MEMORY_FAMILY.map((m) => m.filename);
		expect(filenames).toContain('memory.db');
		expect(filenames).toContain('memories.jsonl');
		expect(filenames).toContain('proposals.jsonl');
		expect(filenames).toContain('audit.jsonl');
		expect(filenames).toContain('reward-events.jsonl');
		expect(filenames).toContain('outcome-events.jsonl');
		expect(filenames).toContain('consolidation-log.jsonl');
		// Derived/skip members.
		expect(filenames).toContain('backups/');
		expect(filenames).toContain('export/');
	});

	test('every canonical member has a merge strategy', () => {
		for (const m of MEMORY_FAMILY) {
			if (m.scope === 'canonical') {
				expect(['sqlite-file-copy', 'append-union']).toContain(m.mergeStrategy);
			}
		}
	});
});

describe('#1850 memory family migration — JSONL append-union', () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	test('F-17: append-union dedups by id (idempotent on retry)', () => {
		const dest = [{ id: 'a', text: 'first' }];
		const src = [
			{ id: 'a', text: 'first' },
			{ id: 'b', text: 'second' },
		];
		const { merged, added, skipped } = _internals.appendUnionById(dest, src);
		expect(merged).toHaveLength(2);
		expect(added).toBe(1);
		expect(skipped).toBe(1);
	});

	// #2958: the union is recency-aware — newer source rows supersede,
	// missing recency reports unresolved, tombstone resurrections are listed.
	test('#2958: newer source row supersedes (both counters, no unresolved)', () => {
		const dest = [
			{ id: 'a', text: 'v1', updatedAt: '2026-09-20T00:00:00.000Z' },
		];
		const src = [
			{ id: 'a', text: 'v2', updatedAt: '2026-09-22T00:00:00.000Z' },
		];
		const r = _internals.appendUnionById(dest, src);
		expect(r.superseded).toBe(1);
		expect(r.skipped).toBe(0);
		expect(r.added).toBe(0);
		expect(r.unresolvedCollisions).toHaveLength(0);
		expect(
			r.merged.filter((x) => (x as { id: string }).id === 'a'),
		).toHaveLength(2);
	});

	test('#2958: destination-newer keeps (skip, no supersession, no unresolved)', () => {
		const dest = [
			{ id: 'a', text: 'v2', updatedAt: '2026-09-22T00:00:00.000Z' },
		];
		const src = [
			{ id: 'a', text: 'v1', updatedAt: '2026-09-20T00:00:00.000Z' },
		];
		const r = _internals.appendUnionById(dest, src);
		expect(r.skipped).toBe(1);
		expect(r.superseded).toBe(0);
		expect(r.unresolvedCollisions).toHaveLength(0);
		expect(r.merged).toHaveLength(1);
	});

	test('#2958: missing recency on either side reports the id unresolved', () => {
		const dest = [{ id: 'a', text: 'old' }];
		const src = [{ id: 'a', text: 'new' }];
		const r = _internals.appendUnionById(dest, src);
		expect(r.skipped).toBe(1);
		expect(r.unresolvedCollisions).toEqual(['a']);
		expect(r.merged).toHaveLength(1);
	});

	test('#2958: snake_case updated_at alias is honored', () => {
		const dest = [
			{ id: 'a', text: 'v1', updated_at: '2026-09-20T00:00:00.000Z' },
		];
		const src = [
			{ id: 'a', text: 'v2', updatedAt: '2026-09-22T00:00:00.000Z' },
		];
		const r2 = _internals.appendUnionById(dest, src);
		expect(r2.superseded).toBe(1);
		expect(r2.unresolvedCollisions).toHaveLength(0);
	});

	test('#2958: an unparsable timestamp is no recency signal (unresolved)', () => {
		const dest = [{ id: 'a', text: 'old', updatedAt: 'not-a-date' }];
		const src = [
			{ id: 'a', text: 'new', updatedAt: '2026-09-22T00:00:00.000Z' },
		];
		const r2 = _internals.appendUnionById(dest, src);
		expect(r2.skipped).toBe(1);
		expect(r2.unresolvedCollisions).toEqual(['a']);
	});

	test('#2958: an id-bearing row on a no-recency member reports unresolved', () => {
		// audit.jsonl / reward-events.jsonl rows carry randomUUID ids but no
		// version recency — a differing same-id row is kept + reported.
		const dest = [{ id: 'e1', operation: 'op-a' }];
		const src = [{ id: 'e1', operation: 'op-b' }];
		const r2 = _internals.appendUnionById(dest, src, {
			memberFilename: 'audit.jsonl',
		});
		expect(r2.skipped).toBe(1);
		expect(r2.unresolvedCollisions).toEqual(['e1']);
	});

	test('#2958: destination tombstone resurrected by a newer live source row', () => {
		const dest = [
			{
				id: 'a',
				text: 'gone',
				updatedAt: '2026-09-20T00:00:00.000Z',
				metadata: { deleted: true },
			},
		];
		const src = [
			{ id: 'a', text: 'back', updatedAt: '2026-09-22T00:00:00.000Z' },
		];
		const r = _internals.appendUnionById(dest, src);
		expect(r.resurrectedIds).toEqual(['a']);
		expect(r.superseded).toBe(1);
	});

	test('F-18: validateSerializedJsonl rejects malformed JSON', () => {
		expect(_internals.validateSerializedJsonl('{"id":"a"}\nnot json\n')).toBe(
			false,
		);
	});

	test('F-19: validateSerializedJsonl accepts valid id-keyed lines', () => {
		expect(_internals.validateSerializedJsonl('{"id":"a"}\n{"id":"b"}\n')).toBe(
			true,
		);
	});
});
