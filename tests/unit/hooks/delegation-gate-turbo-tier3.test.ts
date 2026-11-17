/**
 * Turbo's Stage A bypass decides Tier 3 by the task's files, not its id.
 *
 * Tier 3 is the security-sensitive file class (src/parallel/tier3-classifier.ts;
 * the architect prompt's TIER 3 rules). The gate guessed it from the task id
 * (`startsWith('3.')`): every phase-3 task lost the bypass, and a task in any
 * other phase that touches auth/crypto/secret files kept it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { _internals } from '../../../src/hooks/delegation-gate';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let directory: string;
let cleanup: () => void;

function task(id: string, files: string[]) {
	return {
		id,
		phase: Number(id.split('.')[0]),
		status: 'in_progress' as const,
		size: 'small' as const,
		description: `Task ${id}`,
		depends: [],
		files_touched: files,
	};
}

function writePlan(): void {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Turbo tier 3',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'One',
				status: 'in_progress',
				tasks: [
					task('1.1', ['src/util/format.ts']),
					task('1.2', ['src/auth/login.ts']),
					task('1.3', []),
				],
			},
			{
				id: 3,
				name: 'Three',
				status: 'pending',
				tasks: [
					task('3.1', ['src/util/format.ts', 'tests/format.test.ts']),
					task('3.2', ['src/hooks/guardrails-extra.ts']),
				],
			},
		],
	} as Plan;
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir('turbo-tier3-'));
	writePlan();
});

afterEach(() => cleanup());

describe('turboMayBypassTask', () => {
	test('a phase-3 task with ordinary files is bypassable', async () => {
		expect(await _internals.turboMayBypassTask(directory, '3.1')).toBe(true);
		expect(await _internals.turboMayBypassTask(directory, '1.1')).toBe(true);
	});

	test('a task touching Tier 3 files is never bypassed, in any phase', async () => {
		expect(await _internals.turboMayBypassTask(directory, '1.2')).toBe(false);
		expect(await _internals.turboMayBypassTask(directory, '3.2')).toBe(false);
	});

	test('unknown files, unknown tasks and an unreadable plan fail closed', async () => {
		expect(await _internals.turboMayBypassTask(directory, '1.3')).toBe(false);
		expect(await _internals.turboMayBypassTask(directory, '9.9')).toBe(false);
		fs.writeFileSync(path.join(directory, '.swarm', 'plan.json'), '{not json');
		expect(await _internals.turboMayBypassTask(directory, '1.1')).toBe(false);
	});

	test('#3165 F-2: blank and noncanonical files_touched entries never bypass (fail closed)', async () => {
		// Each row is a files_touched shape that is NOT provably a plain
		// repo-relative path; the classifier's normalizeTier3Path rejects them
		// to Tier 3, so the turbo bypass must be refused for every one.
		const rows: Array<{ id: string; files: string[] }> = [
			{ id: '5.1', files: [''] }, // blank entry (length>0 array bypassed at base)
			{ id: '5.2', files: ['   '] }, // whitespace-only entry
			{ id: '5.3', files: ['/etc/passwd'] }, // absolute POSIX
			{ id: '5.4', files: ['C:\\repo\\src\\util\\format.ts'] }, // drive form
			{ id: '5.5', files: ['C:src/util/format.ts'] }, // drive-RELATIVE
			{ id: '5.6', files: ['~/src/util/format.ts'] }, // home alias
			{ id: '5.7', files: ['src/../src/util/format.ts'] }, // dot-dot segment
			// Windows absolute spellings that only surface after backslash
			// conversion (plan-critic r4 executed consumer probe: the UNC
			// form returned turboMayBypass=true pre-fix).
			{ id: '5.10', files: ['\\\\server\\share\\src\\util\\format.ts'] }, // UNC
			{ id: '5.11', files: ['\\src\\util\\format.ts'] }, // rooted backslash
			{ id: '5.12', files: ['\\\\?\\C:\\repo\\src\\util\\format.ts'] }, // extended-length
			// Directory-shaped entries (final-critic rounds 1-2): src/security/
			// was Tier 3 at base and must never obtain the Turbo bypass; the
			// terminal-dot spelling is the same declaration (round 2 probe).
			{ id: '5.13', files: ['src/security/'] }, // trailing slash (dir)
			{ id: '5.14', files: ['src/sandbox/'] }, // trailing slash (dir)
			{ id: '5.15', files: ['src/security/.'] }, // terminal dot (dir)
			{ id: '5.16', files: ['src/sandbox/./.'] }, // repeated dots (dir)
		];
		const plan = JSON.parse(
			fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
		) as Plan;
		plan.phases.push({
			id: 5,
			name: 'Five',
			status: 'pending',
			tasks: rows.map((row) => task(row.id, row.files)),
		} as Plan['phases'][number]);
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
		for (const row of rows) {
			expect(
				await _internals.turboMayBypassTask(directory, row.id),
				`task ${row.id} with files ${JSON.stringify(row.files)} must not bypass`,
			).toBe(false);
		}
		// The counterproof: a BENIGN dot-relative spelling normalizes to a
		// provable repo-relative path and keeps the bypass (normalization must
		// not over-deny) — the Tier-3 dot-relative twin lives in 6.2 below.
		const phaseFive = plan.phases[plan.phases.length - 1];
		phaseFive.tasks.push(task('5.9', ['./src/util/format.ts']));
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
		expect(await _internals.turboMayBypassTask(directory, '5.9')).toBe(true);
	});

	test('#3165 F-2: normalized spellings of Tier 3 gate files never bypass', async () => {
		// The exact repo-path set is matched AFTER normalization + case fold,
		// so these spellings of src/cli/index.ts all stay Tier 3.
		const plan = JSON.parse(
			fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
		) as Plan;
		plan.phases.push({
			id: 6,
			name: 'Six',
			status: 'pending',
			tasks: [
				task('6.1', ['src/cli/index.ts']),
				task('6.2', ['./src/cli/index.ts']),
				task('6.3', ['src\\cli\\index.ts']),
				task('6.4', ['SRC/CLI/INDEX.TS']),
			],
		} as Plan['phases'][number]);
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
		for (const id of ['6.1', '6.2', '6.3', '6.4']) {
			expect(
				await _internals.turboMayBypassTask(directory, id),
				`task ${id} touching a Tier 3 gate file must not bypass`,
			).toBe(false);
		}
	});
});
