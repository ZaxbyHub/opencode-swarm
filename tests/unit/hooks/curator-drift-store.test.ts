/**
 * writeDriftReport store-IO tests, extracted from curator-drift.test.ts
 * (FR-006: that file is over-cap and must not grow). #2480 re-anchored the
 * drift-report store to the swarm.db `phase_report` table; these pin the
 * upsert semantics, the DB-backed locator, the payload round-trip, and the
 * write→read round-trip.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeGroupCommitWriter } from '../../../src/db/group-commit-writer.js';
import { readPhaseReportsDb } from '../../../src/db/phase-report-store.js';
import { closeProjectDb } from '../../../src/db/project-db.js';
import {
	readPriorDriftReports,
	writeDriftReport,
} from '../../../src/hooks/curator-drift';
import type { DriftReport } from '../../../src/hooks/curator-types';
import { withFrozenClock } from '../../helpers/test-clock';

function createValidDriftReport(phase: number): DriftReport {
	withFrozenClock(() => {}); // #1782: deterministic timestamp
	return {
		schema_version: 1,
		phase,
		timestamp: new Date().toISOString(),
		alignment: 'ALIGNED',
		drift_score: 0.0,
		first_deviation: null,
		compounding_effects: [],
		corrections: [],
		requirements_checked: 10,
		requirements_satisfied: 10,
		scope_additions: [],
		injection_summary: 'Test report',
	};
}

describe('writeDriftReport (swarm.db store, #2480)', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = canonicalMkdtemp('curator-drift-store-');
	});

	afterEach(async () => {
		// Release the cached swarm.db handle before temp cleanup (EBUSY).
		try {
			closeGroupCommitWriter(tmpDir);
			closeProjectDb(tmpDir);
		} catch {
			// already closed
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it('upserts the report into the swarm.db phase_report table', async () => {
		const report = createValidDriftReport(5);
		const locator = await writeDriftReport(tmpDir, report);

		expect(locator).toBe('swarm.db:phase_report(curator_drift,5)');
		const rows = readPhaseReportsDb(tmpDir, 'curator_drift');
		expect(rows.length).toBe(1);
		expect(rows[0].phase).toBe(5);
	});

	it('creates .swarm/ (with swarm.db) if it does not exist', async () => {
		const swarmDir = path.join(tmpDir, '.swarm');
		if (existsSync(swarmDir)) {
			await fs.rm(swarmDir, { recursive: true, force: true });
		}

		const report = createValidDriftReport(1);
		await writeDriftReport(tmpDir, report);

		expect(existsSync(path.join(swarmDir, 'swarm.db'))).toBe(true);
	});

	it('returns the DB-backed report locator; same-phase rerun overwrites', async () => {
		await writeDriftReport(tmpDir, createValidDriftReport(1));
		const second = createValidDriftReport(1);
		second.alignment = 'MINOR_DRIFT';
		const locator = await writeDriftReport(tmpDir, second);

		expect(locator).toBe('swarm.db:phase_report(curator_drift,1)');
		const rows = readPhaseReportsDb(tmpDir, 'curator_drift');
		expect(rows.length).toBe(1); // one row per (kind, phase)
		expect(JSON.parse(rows[0].payload).alignment).toBe('MINOR_DRIFT');
	});

	it('stored payload is valid JSON parseable back to DriftReport', async () => {
		const report = createValidDriftReport(2);
		await writeDriftReport(tmpDir, report);

		const rows = readPhaseReportsDb(tmpDir, 'curator_drift');
		const parsed = JSON.parse(rows[0].payload) as DriftReport;

		expect(parsed.phase).toBe(2);
		expect(parsed.schema_version).toBe(1);
		expect(parsed.alignment).toBe('ALIGNED');
		expect(parsed.drift_score).toBe(0.0);
	});

	it('round-trip: writeDriftReport then readPriorDriftReports returns the same report', async () => {
		const originalReport = createValidDriftReport(4);
		await writeDriftReport(tmpDir, originalReport);

		const reports = await readPriorDriftReports(tmpDir);

		expect(reports.length).toBe(1);
		expect(reports[0].phase).toBe(originalReport.phase);
		expect(reports[0].alignment).toBe(originalReport.alignment);
		expect(reports[0].drift_score).toBe(originalReport.drift_score);
		expect(reports[0].schema_version).toBe(originalReport.schema_version);
	});
});
