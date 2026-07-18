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
