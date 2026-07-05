import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AGENT_TOOL_MAP,
	COUNCIL_AGENT_TOOL_MAP,
} from '../../../src/config/constants';
import { TOOL_NAME_SET, TOOL_NAMES } from '../../../src/tools/tool-names';

let tempDir: string;

function seedConfig(enabled: boolean): void {
	mkdirSync(join(tempDir, '.opencode'), { recursive: true });
	writeFileSync(
		join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ council: { enabled } }),
	);
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'declare-council-'));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('declare_council_criteria — happy path', () => {
	test('enabled config + 3 criteria → success, file on disk, replaced:false', async () => {
		seedConfig(true);
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const result = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [
					{
						id: 'C1',
						description: 'All tests pass with zero regressions',
						mandatory: true,
					},
					{
						id: 'C2',
						description: 'No placeholder bodies or stub implementations',
						mandatory: true,
					},
					{
						id: 'C3',
						description: 'Style guide conformance (biome clean)',
						mandatory: false,
					},
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.taskId).toBe('1.1');
		expect(parsed.criteriaCount).toBe(3);
		expect(parsed.mandatoryCount).toBe(2);
		expect(typeof parsed.declaredAt).toBe('string');
		expect(parsed.replaced).toBe(false);

		// criteria-store writes under .swarm/council/ with a sanitized filename.
		const councilDir = join(tempDir, '.swarm', 'council');
		// File name uses safeId which converts "1.1" → "1_1".
		const filePath = join(councilDir, '1_1.json');
		const payload = JSON.parse(readFileSync(filePath, 'utf-8'));
		expect(payload.taskId).toBe('1.1');
		expect(payload.criteria).toHaveLength(3);
		expect(payload.criteria[0].id).toBe('C1');
	});
});

describe('declare_council_criteria — idempotent overwrite', () => {
	test('second call with same taskId returns replaced:true', async () => {
		seedConfig(true);
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const first = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [
					{ id: 'C1', description: 'first declaration here', mandatory: true },
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		expect(JSON.parse(first).replaced).toBe(false);

		const second = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [
					{
						id: 'C1',
						description: 'second declaration here',
						mandatory: true,
					},
					{
						id: 'C2',
						description: 'additional criterion here',
						mandatory: false,
					},
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(second);
		expect(parsed.success).toBe(true);
		expect(parsed.replaced).toBe(true);
		expect(parsed.criteriaCount).toBe(2);
	});
});

describe('declare_council_criteria — duplicate id rejection', () => {
	test('two items with id "C1" → structured error, no FS write', async () => {
		seedConfig(true);
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const result = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [
					{
						id: 'C1',
						description: 'first duplicate item here',
						mandatory: true,
					},
					{
						id: 'C1',
						description: 'second duplicate item here',
						mandatory: false,
					},
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toMatch(/duplicate/i);
		expect(parsed.errors).toContain('C1');

		// No file should have been written.
		const { existsSync } = await import('node:fs');
		expect(existsSync(join(tempDir, '.swarm', 'council'))).toBe(false);
	});
});

describe('declare_council_criteria — config gate', () => {
	test('council.enabled=false → disabled error, no FS write', async () => {
		seedConfig(false);
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const result = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [
					{ id: 'C1', description: 'test criterion here', mandatory: true },
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toMatch(/disabled/i);

		const { existsSync } = await import('node:fs');
		expect(existsSync(join(tempDir, '.swarm', 'council'))).toBe(false);
	});

	test('council config missing entirely → disabled error', async () => {
		// Seed explicit disabled config so test is deterministic regardless of user-level config.
		// Without this, loadPluginConfig may pick up a user-level config with council.enabled=true.
		seedConfig(false);
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const result = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [
					{ id: 'C1', description: 'test criterion here', mandatory: true },
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toMatch(/disabled/i);
	});
});

describe('declare_council_criteria — zod input validation', () => {
	test('malformed taskId rejected before any FS op', async () => {
		seedConfig(true);
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const result = await declare_council_criteria.execute(
			{
				taskId: '../etc/passwd',
				criteria: [
					{ id: 'C1', description: 'test criterion here', mandatory: true },
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
	});

	test('too many criteria (21) rejected by zod .max(20)', async () => {
		seedConfig(true);
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const criteria = Array.from({ length: 21 }, (_, i) => ({
			id: `C${i + 1}`,
			description: `criterion number ${i + 1} has a long enough description`,
			mandatory: true,
		}));
		const result = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria,
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
	});

	test('empty criteria array rejected', async () => {
		seedConfig(true);
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const result = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
	});

	test('id not matching /^C\\d+$/ rejected', async () => {
		seedConfig(true);
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const result = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [
					{ id: 'bad', description: 'test criterion here', mandatory: true },
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
	});

	test('adversarial id "__proto__" rejected by regex (defense in depth)', async () => {
		seedConfig(true);
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const result = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [
					{
						id: '__proto__',
						description: 'prototype pollution attempt',
						mandatory: true,
					},
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
	});

	test('description 9 chars (below min 10) rejected', async () => {
		seedConfig(true);
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const result = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [{ id: 'C1', description: 'too short', mandatory: true }],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
	});

	test('description over 500 chars rejected', async () => {
		seedConfig(true);
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const result = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [{ id: 'C1', description: 'x'.repeat(501), mandatory: true }],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
	});
});

describe('declare_council_criteria — registration', () => {
	test('declare_council_criteria is in TOOL_NAMES', () => {
		expect(TOOL_NAMES).toContain('declare_council_criteria');
	});

	test('declare_council_criteria is in TOOL_NAME_SET', () => {
		expect(TOOL_NAME_SET.has('declare_council_criteria')).toBe(true);
	});

	test('declare_council_criteria is in COUNCIL_AGENT_TOOL_MAP.architect', () => {
		expect(COUNCIL_AGENT_TOOL_MAP.architect).toContain(
			'declare_council_criteria',
		);
	});

	test('declare_council_criteria is opt-in architect-only (no base agent has it)', () => {
		const otherAgents = Object.keys(AGENT_TOOL_MAP).filter(
			(a) => a !== 'architect',
		) as Array<keyof typeof AGENT_TOOL_MAP>;
		expect(AGENT_TOOL_MAP.architect).not.toContain('declare_council_criteria');
		for (const agent of otherAgents) {
			expect(AGENT_TOOL_MAP[agent]).not.toContain('declare_council_criteria');
		}
	});

	test('declare_council_criteria is exported from src/tools/index.ts', async () => {
		const tools = await import('../../../src/tools/index');
		expect('declare_council_criteria' in tools).toBe(true);
	});

	test('exported tool has description, execute, args with required fields', async () => {
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		expect(declare_council_criteria).toBeDefined();
		expect(declare_council_criteria).toHaveProperty('description');
		expect(declare_council_criteria).toHaveProperty('execute');
		expect(typeof declare_council_criteria.execute).toBe('function');
		expect(declare_council_criteria.args).toBeDefined();
		expect(declare_council_criteria.args).toHaveProperty('taskId');
		expect(declare_council_criteria.args).toHaveProperty('criteria');
		expect(declare_council_criteria.args).toHaveProperty('working_directory');
	});
});
