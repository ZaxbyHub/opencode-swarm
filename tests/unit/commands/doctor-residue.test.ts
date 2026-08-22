/**
 * Issue #2035 — /swarm config doctor residue wiring: read-only by default,
 * explicit recoverable quarantine via --quarantine-residue, and rollback via
 * --rollback-residue-quarantine. All three surfaces render from the shared
 * inventory implementation.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleDoctorCommand } from '../../../src/commands/doctor';
import { _internals as residueInternals } from '../../../src/services/swarm-residue';

let projectDir: string;
let swarmDir: string;
const realQueryTracked = residueInternals.queryTracked;

function makeResidue(rel: string, hoursOld = 2, content = 'stale'): string {
	const abs = path.join(swarmDir, ...rel.split('/'));
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, content, 'utf-8');
	const t = new Date(Date.now() - hoursOld * 60 * 60 * 1000);
	utimesSync(abs, t, t);
	return abs;
}

beforeEach(() => {
	projectDir = mkdtempSync(path.join(os.tmpdir(), 'doctor-residue-'));
	swarmDir = path.join(projectDir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	residueInternals.queryTracked = () => ({ tracked: new Set<string>() });
});

afterEach(() => {
	residueInternals.queryTracked = realQueryTracked;
	rmSync(projectDir, { recursive: true, force: true });
});

describe('handleDoctorCommand — atomic-write residue (issue #2035)', () => {
	test('default run is READ-ONLY: reports inventory, moves nothing', async () => {
		makeResidue('context.md.tmp.1710000000.123456789');
		writeFileSync(path.join(swarmDir, 'context.md'), 'target', 'utf-8');

		const out = await handleDoctorCommand(projectDir, []);

		expect(out).toContain('Atomic-write Residue');
		expect(out).toContain('target-suffix-tmp-num-alnum');
		expect(out).toContain('--quarantine-residue');
		// Nothing moved, nothing deleted.
		expect(
			existsSync(path.join(swarmDir, 'context.md.tmp.1710000000.123456789')),
		).toBe(true);
		expect(existsSync(path.join(swarmDir, 'quarantine'))).toBe(false);
	});

	test('clean project shows no residue section', async () => {
		const out = await handleDoctorCommand(projectDir, []);
		expect(out).not.toContain('Atomic-write Residue');
	});

	test('--quarantine-residue moves verified stale residue with manifest', async () => {
		writeFileSync(path.join(swarmDir, 'context.md'), 'target', 'utf-8');
		makeResidue('context.md.tmp.1710000000.123456789');

		const out = await handleDoctorCommand(projectDir, ['--quarantine-residue']);

		expect(out).toContain('Residue Quarantine');
		expect(out).toContain('Quarantined 1 stale temp file(s)');
		expect(out).toContain('--rollback-residue-quarantine');
		expect(
			existsSync(path.join(swarmDir, 'context.md.tmp.1710000000.123456789')),
		).toBe(false);
		const quarantineRoot = path.join(swarmDir, 'quarantine');
		const batch = readdirSync(quarantineRoot)[0]!;
		expect(
			existsSync(
				path.join(quarantineRoot, batch, 'context.md.tmp.1710000000.123456789'),
			),
		).toBe(true);
		expect(
			JSON.parse(
				readFileSync(
					path.join(quarantineRoot, batch, 'manifest.json'),
					'utf-8',
				),
			).schema_version,
		).toBe(1);
	});

	test('--rollback-residue-quarantine restores the latest batch', async () => {
		writeFileSync(path.join(swarmDir, 'context.md'), 'target', 'utf-8');
		const rel = 'context.md.tmp.1710000000.123456789';
		makeResidue(rel, 3, 'recover-me');
		await handleDoctorCommand(projectDir, ['--quarantine-residue']);
		expect(existsSync(path.join(swarmDir, rel))).toBe(false);

		const out = await handleDoctorCommand(projectDir, [
			'--rollback-residue-quarantine',
		]);

		expect(out).toContain('Residue Quarantine Rollback');
		expect(out).toContain('1 restored');
		expect(readFileSync(path.join(swarmDir, rel), 'utf-8')).toBe('recover-me');
	});
});
