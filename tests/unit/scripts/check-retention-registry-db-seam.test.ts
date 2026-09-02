/**
 * Biting synthetic tests for the issue #2480 retention-registry redesign:
 * the swarm.db STORE-OP seam, the raw-handle confinement ratchet, and the
 * src/db reverse-staleness rule. Each test drives fixture trees through the
 * REAL gate logic — a check that cannot fail on a synthetic violation is
 * theater (tests/unit/scripts/check-retention-registry.test.ts precedent).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	collectDbFoundationStalenessErrors,
	collectDbHandleConfinementErrors,
	moduleWritesDurableState,
} from '../../../scripts/check-retention-registry';

let root: string;

function srcModule(rel: string, source: string): void {
	const abs = path.join(root, rel);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, source, 'utf8');
}

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), 'retention-db-seam-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('moduleWritesDurableState — store-op seam', () => {
	test('a swarm.db store-op call marks the module as a writer', () => {
		expect(
			moduleWritesDurableState('await appendInsightCandidatesDb(dir, rows);'),
		).toBe(true);
		expect(
			moduleWritesDurableState('const b = consumeInsightCandidatesDb(d, 5);'),
		).toBe(true);
		expect(
			moduleWritesDurableState('await upsertPhaseReportDb(d, kind, n, p);'),
		).toBe(true);
		expect(moduleWritesDurableState('importLegacyJsonl(d, opts);')).toBe(true);
		expect(moduleWritesDurableFilesImport()).toBe(true);
		function moduleWritesDurableFilesImport(): boolean {
			return moduleWritesDurableState('importLegacyJsonFiles(d, opts);');
		}
	});

	test('read-only store getters do NOT mark the module', () => {
		expect(
			moduleWritesDurableState('countPendingInsightCandidatesDb(d);'),
		).toBe(false);
		expect(
			moduleWritesDurableState('listPendingInsightCandidatesDb(d, 5);'),
		).toBe(false);
		expect(
			moduleWritesDurableState("readPhaseReportsDb(d, 'curator_drift');"),
		).toBe(false);
	});

	test('commented-out store-op calls do not mark the module', () => {
		expect(
			moduleWritesDurableState(
				'// await appendInsightCandidatesDb(dir, rows);',
			),
		).toBe(false);
	});
});

describe('collectDbHandleConfinementErrors — raw-handle ratchet', () => {
	test('a Database-typed module outside src/db without an allowlist entry fails', () => {
		srcModule(
			'src/hooks/rogue-writer.ts',
			"import type { Database } from 'bun:sqlite';\nexport function f(db: Database) { db.run('INSERT'); }\n",
		);
		const errors = collectDbHandleConfinementErrors(root, {});
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain('rogue-writer.ts');
		expect(errors[0]).toContain('RAW_DB_HANDLE_MODULES');
	});

	test('an allowlisted module passes; a getProjectDb-typed module is caught too', () => {
		srcModule(
			'src/memory/legacy-holder.ts',
			"import type { Database } from 'bun:sqlite';\nexport const db: Database | null = null;\n",
		);
		const allowlist = {
			'src/memory/legacy-holder.ts': 'owned by the memory-sqlite row',
		};
		expect(collectDbHandleConfinementErrors(root, allowlist)).toEqual([]);

		srcModule(
			'src/tools/rogue-handle.ts',
			'declare function getProjectDb(d: string): unknown;\nexport type Handle = ReturnType<typeof getProjectDb>;\n',
		);
		const errors = collectDbHandleConfinementErrors(root, allowlist);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain('rogue-handle.ts');
	});

	test('src/db modules are exempt from the confinement rule', () => {
		srcModule(
			'src/db/new-store.ts',
			"import type { Database } from 'bun:sqlite';\nexport function w(db: Database) { db.run('x'); }\n",
		);
		expect(collectDbHandleConfinementErrors(root, {})).toEqual([]);
	});

	test('a stale allowlist entry for a missing module fails', () => {
		const errors = collectDbHandleConfinementErrors(root, {
			'src/gone/away.ts': 'stale',
		});
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain('no longer exists');
	});
});

describe('collectDbFoundationStalenessErrors — src/db reverse-staleness', () => {
	test('a registered src/db writer that stopped calling any enumerated seam fails', () => {
		srcModule(
			'src/db/stale-store.ts',
			'export function noop(): void { return; }\n',
		);
		const errors = collectDbFoundationStalenessErrors(root, [
			{ writerModules: ['src/db/stale-store.ts'] },
		]);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain('reverse-staleness');
	});

	test('a src/db writer that still calls a store-op seam passes', () => {
		srcModule(
			'src/db/live-store.ts',
			"import { getProjectDb } from './project-db.js';\nexport function w(d: string) { getProjectDb(d); }\n",
		);
		const errors = collectDbFoundationStalenessErrors(root, [
			{ writerModules: ['src/db/live-store.ts'] },
		]);
		expect(errors).toEqual([]);
	});

	test('non-src/db rows are out of scope for the rule', () => {
		srcModule(
			'src/hooks/bespoke.ts',
			'export function w(): void { return; }\n',
		);
		const errors = collectDbFoundationStalenessErrors(root, [
			{ writerModules: ['src/hooks/bespoke.ts'] },
		]);
		expect(errors).toEqual([]);
	});
});
