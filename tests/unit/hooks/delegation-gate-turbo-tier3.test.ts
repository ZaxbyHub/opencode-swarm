/**
 * Turbo's Stage A bypass decides Tier 3 by the task's files, not its id.
 *
 * Tier 3 is the security-sensitive file class (src/parallel/tier3-classifier.ts;
 * the architect prompt's TIER 3 rules), the same rule update_task_status
 * applies to Turbo's Stage B bypass. The gate guessed it from the task id
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
});
