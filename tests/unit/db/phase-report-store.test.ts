/**
 * phase-report swarm.db store (issue #2480): entity/KV upsert semantics for
 * both drift families, ordered reads, and the multi-file legacy import.
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
import { canonicalMkdtemp } from '../../../helpers/tmpdir';
import {
	_resetPhaseReportImportGuards,
	phaseReportLocator,
	readPhaseReportsDb,
	upsertPhaseReportDb,
} from '../../../src/db/phase-report-store.js';
import { closeProjectDb } from '../../../src/db/project-db.js';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('phase-report-');
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	_resetPhaseReportImportGuards();
});

afterEach(() => {
	closeProjectDb(dir);
	rmSync(dir, { recursive: true, force: true });
});

describe('upsert / read', () => {
	test('one row per (kind, phase); same-phase rerun overwrites', async () => {
		await upsertPhaseReportDb(
			dir,
			'curator_drift',
			1,
			'{"alignment":"ALIGNED"}',
		);
		await upsertPhaseReportDb(
			dir,
			'curator_drift',
			2,
			'{"alignment":"MINOR_DRIFT"}',
		);
		await upsertPhaseReportDb(
			dir,
			'design_doc_drift',
			1,
			'{"verdict":"DOC_FRESH"}',
		);
		await upsertPhaseReportDb(
			dir,
			'curator_drift',
			1,
			'{"alignment":"MAJOR_DRIFT"}',
		);

		const curator = readPhaseReportsDb(dir, 'curator_drift');
		expect(curator.length).toBe(2);
		expect(curator[0].phase).toBe(1);
		expect(JSON.parse(curator[0].payload).alignment).toBe('MAJOR_DRIFT');
		expect(curator[1].phase).toBe(2);

		const doc = readPhaseReportsDb(dir, 'design_doc_drift');
		expect(doc.length).toBe(1);
		expect(doc[0].phase).toBe(1);
	});

	test('reads are ordered ascending by phase regardless of write order', async () => {
		await upsertPhaseReportDb(dir, 'curator_drift', 9, '{}');
		await upsertPhaseReportDb(dir, 'curator_drift', 2, '{}');
		await upsertPhaseReportDb(dir, 'curator_drift', 5, '{}');
		const phases = readPhaseReportsDb(dir, 'curator_drift').map((r) => r.phase);
		expect(phases).toEqual([2, 5, 9]);
	});

	test('locator form is stable and human-readable', () => {
		expect(phaseReportLocator('curator_drift', 3)).toBe(
			'swarm.db:phase_report(curator_drift,3)',
		);
	});
});

describe('legacy file import', () => {
	test('both families import once, per-kind empty-guarded, then cold-archive', async () => {
		writeFileSync(
			path.join(dir, '.swarm', 'drift-report-phase-2.json'),
			'{"phase":2,"alignment":"ALIGNED","timestamp":"t","drift_score":0,"schema_version":1,"compounding_effects":[]}',
		);
		writeFileSync(
			path.join(dir, '.swarm', 'drift-report-phase-1.json'),
			'{"phase":1,"alignment":"MINOR_DRIFT","timestamp":"t","drift_score":0.2,"schema_version":1,"compounding_effects":[]}',
		);
		writeFileSync(
			path.join(dir, '.swarm', 'doc-drift-phase-4.json'),
			'{"phase":4}',
		);
		writeFileSync(
			path.join(dir, '.swarm', 'drift-report-phase-9.json'),
			'{corrupt',
		);

		const rows = readPhaseReportsDb(dir, 'curator_drift');
		expect(rows.map((r) => r.phase)).toEqual([1, 2]); // corrupt skipped
		const doc = readPhaseReportsDb(dir, 'design_doc_drift');
		expect(doc.map((r) => r.phase)).toEqual([4]);

		for (const name of [
			'drift-report-phase-1.json.imported',
			'drift-report-phase-2.json.imported',
			'doc-drift-phase-4.json.imported',
		]) {
			expect(existsSync(path.join(dir, '.swarm', name))).toBe(true);
		}
		// The corrupt file was NOT imported but also NOT destroyed by the
		// archivedNames path (only parsed files archive).
		expect(
			existsSync(path.join(dir, '.swarm', 'drift-report-phase-9.json')),
		).toBe(true);
	});

	test('non-empty kind + reappearing file → no re-import, file preserved', async () => {
		await upsertPhaseReportDb(dir, 'curator_drift', 1, '{"phase":1}');
		writeFileSync(
			path.join(dir, '.swarm', 'drift-report-phase-1.json'),
			'{"phase":1,"alignment":"ALIGNED"}',
		);
		const rows = readPhaseReportsDb(dir, 'curator_drift');
		expect(rows.length).toBe(1);
		expect(JSON.parse(rows[0].payload).alignment).toBeUndefined(); // not overwritten by the file
		expect(
			existsSync(path.join(dir, '.swarm', 'drift-report-phase-1.json')),
		).toBe(true);
	});
});
