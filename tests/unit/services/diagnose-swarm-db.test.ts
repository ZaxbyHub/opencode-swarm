/**
 * Diagnose swarm-db health check (issue #2480 obligation 5): absent DB is
 * healthy, a live DB reports quick_check + driver floors, a corrupt DB errors,
 * and recorded migration failures surface as a warning.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db.js';
import { getDiagnoseData } from '../../../src/services/diagnose-service.js';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('diagnose-db-');
});

afterEach(() => {
	closeProjectDb(dir);
	rmSync(dir, { recursive: true, force: true });
});

function swarmDbCheck(
	checks: Array<{ name: string; status: string; detail: string }>,
): { name: string; status: string; detail: string } | undefined {
	return checks.find((c) => c.name === 'swarm.db');
}

describe('diagnose swarm-db check', () => {
	test('absent DB is healthy and never created by diagnose', async () => {
		const data = await getDiagnoseData(dir);
		const check = swarmDbCheck(data.checks);
		expect(check).toBeDefined();
		expect(check?.status).toBe('✅');
		expect(check?.detail).toContain('not created');
	});

	test('a healthy DB reports quick_check ok + journal mode + driver', async () => {
		mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		getProjectDb(dir); // create + migrate
		const data = await getDiagnoseData(dir);
		const check = swarmDbCheck(data.checks);
		expect(check?.status).toBe('✅');
		expect(check?.detail).toContain('quick_check ok');
		expect(check?.detail).toContain('wal');
		expect(check?.detail).toContain('driver:');
	});

	test('a corrupt DB surfaces as an error, never throws', async () => {
		mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		writeFileSync(
			path.join(dir, '.swarm', 'swarm.db'),
			'not a sqlite database at all',
		);
		const data = await getDiagnoseData(dir);
		const check = swarmDbCheck(data.checks);
		expect(check?.status).toBe('❌');
		expect(check?.detail.length).toBeGreaterThan(0);
	});

	test('recorded migration failures surface as a warning', async () => {
		mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		const db = getProjectDb(dir);
		db.run(
			"INSERT INTO migration_failures (version, name, error) VALUES (99, 'synthetic', 'injected')",
		);
		const data = await getDiagnoseData(dir);
		const check = swarmDbCheck(data.checks);
		expect(check?.status).toBe('⚠️');
		expect(check?.detail).toContain('1 recorded migration failure');
	});
});
