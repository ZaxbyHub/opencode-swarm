import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir.js';
import type { Plan } from '../config/plan-schema.js';
import { closeAllProjectDbs, getProfileForIdentity } from '../db/index.js';
import { handleQaGatesCommand } from './qa-gates.js';

let tempDir: string;

function writePlanJson(directory: string): void {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task 1',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
	const swarmDir = path.join(directory, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf8',
	);
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('qa-gates-cmd-test-');
});

afterEach(() => {
	closeAllProjectDbs();
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe('handleQaGatesCommand', () => {
	test('errors when plan.json is missing', async () => {
		const result = await handleQaGatesCommand(tempDir, [], '');
		expect(result.toLowerCase()).toContain('plan.json');
	});

	test('show (default) returns defaults when no profile persisted yet', async () => {
		writePlanJson(tempDir);
		const result = await handleQaGatesCommand(tempDir, [], '');
		expect(result).toContain('QA Gate Profile for plan_id=');
		expect(result).toContain('no profile persisted yet');
		expect(result).toContain('reviewer: on');
		expect(result).toContain('council_mode: off');
	});

	test('enable persists gates into the profile', async () => {
		writePlanJson(tempDir);
		const result = await handleQaGatesCommand(
			tempDir,
			['enable', 'council_mode'],
			'',
		);
		expect(result).toContain('Enabled gates persisted');
		expect(result).toContain('council_mode: on');

		// Verify persistence in DB
		const profile = getProfileForIdentity(tempDir, {
			swarm: 'test-swarm',
			title: 'Test Plan',
		});
		expect(profile).not.toBeNull();
		expect(profile?.gates.council_mode).toBe(true);
	});

	test('enable rejects unknown gate names', async () => {
		writePlanJson(tempDir);
		const result = await handleQaGatesCommand(
			tempDir,
			['enable', 'bogus_gate'],
			'',
		);
		expect(result.toLowerCase()).toContain('unknown gate');
	});

	test('unknown subcommand prints usage', async () => {
		writePlanJson(tempDir);
		const result = await handleQaGatesCommand(tempDir, ['wat'], '');
		expect(result).toContain('Usage:');
		expect(result).toContain('enable');
		expect(result).toContain('override');
	});

	test('is registered in COMMAND_REGISTRY', async () => {
		const { COMMAND_REGISTRY } = await import('./registry.js');
		expect('qa-gates' in COMMAND_REGISTRY).toBe(true);
	});
});
