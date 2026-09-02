/**
 * legacy-import fault injection (issue #2480): the Windows rename-retry path
 * and the committed-but-unarchived crash window.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	importLegacyJsonl,
} from '../../../src/db/legacy-import.js';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
const realRename = _internals.renameSync;

beforeEach(() => {
	dir = canonicalMkdtemp('legacy-import-');
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	_internals.renameSync = realRename;
	closeProjectDb(dir);
	rmSync(dir, { recursive: true, force: true });
});

describe('#2480 review F-02: oversize legacy artifact is skipped inert', () => {
	test('a file over the import cap is not imported and not renamed', () => {
		const legacyPath = path.join(dir, '.swarm', 'oversize.jsonl');
		// Small file first to size the cap down deterministically.
		_internals.maxLegacyImportBytes = () => 16;
		const oversizeLine = `${JSON.stringify({ lesson: 'too big' })}`.padEnd(
			64,
			'x',
		);
		writeFileSync(legacyPath, `${oversizeLine}\n`);
		const result = importLegacyJsonl(dir, {
			fileName: 'oversize.jsonl',
			streamCount: (db) =>
				db
					.query<{ count: number }, [string]>(
						'SELECT COUNT(*) as count FROM insight_candidate WHERE stream_id = ?',
					)
					.get('oversize')?.count ?? 0,
			insertRow: (db, version, payload) => {
				db.run(
					'INSERT INTO insight_candidate (stream_id, version, payload, created_at) VALUES (?, ?, ?, ?)',
					['oversize', version, payload, '2026-01-01'],
				);
			},
			parseLine: (line) => line,
		});
		expect(result.imported).toBe(0);
		expect(result.archived).toBe(false);
		// Inert: file left in place, NOT renamed to .imported.
		expect(existsSync(legacyPath)).toBe(true);
		expect(existsSync(`${legacyPath}.imported`)).toBe(false);
		_internals.maxLegacyImportBytes = () => 1024 * 1024; // repair
		// Now importable.
		const result2 = importLegacyJsonl(dir, {
			fileName: 'oversize.jsonl',
			streamCount: (db) =>
				db
					.query<{ count: number }, [string]>(
						'SELECT COUNT(*) as count FROM insight_candidate WHERE stream_id = ?',
					)
					.get('oversize')?.count ?? 0,
			insertRow: (db, version, payload) => {
				db.run(
					'INSERT INTO insight_candidate (stream_id, version, payload, created_at) VALUES (?, ?, ?, ?)',
					['oversize', version, payload, '2026-01-01'],
				);
			},
			parseLine: (line) => line,
		});
		expect(result2.imported).toBe(1);
		expect(existsSync(`${legacyPath}.imported`)).toBe(true);
	});
});

describe('rename retry (Windows EPERM shape)', () => {
	test('EPERM on the first attempt is retried and eventually succeeds', () => {
		writeFileSync(
			path.join(dir, '.swarm', 'queue.jsonl'),
			JSON.stringify({ lesson: 'one' }) + '\n',
		);
		let calls = 0;
		_internals.renameSync = ((from: string, to: string) => {
			calls++;
			if (calls === 1) {
				const err = new Error('ephemeral lock') as NodeJS.ErrnoException;
				err.code = 'EPERM';
				throw err;
			}
			return realRename(from, to);
		}) as typeof realRename;

		const result = importLegacyJsonl(dir, {
			fileName: 'queue.jsonl',
			streamCount: (db) =>
				db
					.query<{ count: number }, [string]>(
						'SELECT COUNT(*) as count FROM insight_candidate WHERE stream_id = ?',
					)
					.get('q')?.count ?? 0,
			insertRow: (db, version, payload) => {
				db.run(
					'INSERT INTO insight_candidate (stream_id, version, payload, created_at) VALUES (?, ?, ?, ?)',
					['q', version, payload, '2026-01-01'],
				);
			},
			parseLine: (line) => {
				try {
					JSON.parse(line);
					return line;
				} catch {
					return null;
				}
			},
		});

		expect(calls).toBe(2); // retried once, then succeeded
		expect(result.imported).toBe(1);
		expect(result.archived).toBe(true);
		expect(existsSync(path.join(dir, '.swarm', 'queue.jsonl.imported'))).toBe(
			true,
		);
	});

	test('a persistent rename failure leaves the committed import un-archived (idempotent next run)', () => {
		writeFileSync(
			path.join(dir, '.swarm', 'queue.jsonl'),
			JSON.stringify({ lesson: 'one' }) + '\n',
		);
		_internals.renameSync = (() => {
			const err = new Error('locked forever') as NodeJS.ErrnoException;
			err.code = 'EPERM';
			throw err;
		}) as typeof realRename;

		const result = importLegacyJsonl(dir, {
			fileName: 'queue.jsonl',
			streamCount: (db) =>
				db
					.query<{ count: number }, [string]>(
						'SELECT COUNT(*) as count FROM insight_candidate WHERE stream_id = ?',
					)
					.get('q')?.count ?? 0,
			insertRow: (db, version, payload) => {
				db.run(
					'INSERT INTO insight_candidate (stream_id, version, payload, created_at) VALUES (?, ?, ?, ?)',
					['q', version, payload, '2026-01-01'],
				);
			},
			parseLine: (line) => line,
		});

		// Committed, not archived, no throw.
		expect(result.imported).toBe(1);
		expect(result.archived).toBe(false);
		expect(existsSync(path.join(dir, '.swarm', 'queue.jsonl'))).toBe(true);
	});
});
