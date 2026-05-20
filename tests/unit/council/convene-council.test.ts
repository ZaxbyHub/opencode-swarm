import { describe, expect, test } from 'bun:test';
import { AGENT_TOOL_MAP } from '../../../src/config/constants';
import { TOOL_NAME_SET, TOOL_NAMES } from '../../../src/tools/tool-names';

describe('submit_council_verdicts — registration', () => {
	test('submit_council_verdicts is in TOOL_NAMES', () => {
		expect(TOOL_NAMES).toContain('submit_council_verdicts');
	});

	test('submit_council_verdicts is in TOOL_NAME_SET (derived from TOOL_NAMES)', () => {
		expect(TOOL_NAME_SET.has('submit_council_verdicts')).toBe(true);
	});

	test('submit_council_verdicts is in AGENT_TOOL_MAP.architect', () => {
		expect(AGENT_TOOL_MAP.architect).toContain('submit_council_verdicts');
	});

	test('submit_council_verdicts is architect-only — no other agent has it', () => {
		const otherAgents = Object.keys(AGENT_TOOL_MAP).filter(
			(a) => a !== 'architect',
		) as Array<keyof typeof AGENT_TOOL_MAP>;
		for (const agent of otherAgents) {
			expect(AGENT_TOOL_MAP[agent]).not.toContain('submit_council_verdicts');
		}
	});

	test('submit_council_verdicts is exported from src/tools/index.ts', async () => {
		const tools = await import('../../../src/tools/index');
		expect('submit_council_verdicts' in tools).toBe(true);
	});

	test('submit_council_verdicts module exports a valid tool with description + execute', async () => {
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		expect(submit_council_verdicts).toBeDefined();
		expect(submit_council_verdicts).toHaveProperty('description');
		expect(submit_council_verdicts).toHaveProperty('execute');
		expect(typeof submit_council_verdicts.execute).toBe('function');
	});

	test('submit_council_verdicts declares required args surface', async () => {
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		expect(submit_council_verdicts.args).toBeDefined();
		expect(submit_council_verdicts.args).toHaveProperty('taskId');
		expect(submit_council_verdicts.args).toHaveProperty('swarmId');
		expect(submit_council_verdicts.args).toHaveProperty('verdicts');
		expect(submit_council_verdicts.args).toHaveProperty('working_directory');
	});
});

describe('submit_council_verdicts — config gate', () => {
	test('returns disabled message when council.enabled is not set (default)', async () => {
		const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import(
			'node:fs'
		);
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const tempDir = mkdtempSync(join(tmpdir(), 'convene-council-test-'));
		try {
			// Seed explicit disabled config so test is deterministic regardless of user-level config.
			// Without this, loadPluginConfig may pick up a user-level config with council.enabled=true.
			mkdirSync(join(tempDir, '.opencode'), { recursive: true });
			writeFileSync(
				join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({ council: { enabled: false } }),
			);
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [
						{
							agent: 'critic',
							verdict: 'APPROVE',
							confidence: 1,
							findings: [],
							criteriaAssessed: [],
							criteriaUnmet: [],
							durationMs: 0,
						},
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.reason).toContain('disabled');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('invalid arguments return structured error without throwing', async () => {
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		const result = await submit_council_verdicts.execute(
			{
				// missing required fields
				taskId: 'not-a-valid-task-id',
			},
			{ directory: process.cwd() },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
		expect(Array.isArray(parsed.errors)).toBe(true);
	});
});

describe('submit_council_verdicts — happy path with enabled config', () => {
	test('writes council evidence and returns APPROVE when enabled', async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } =
			await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const tempDir = mkdtempSync(join(tmpdir(), 'convene-council-enabled-'));
		try {
			// Enable council in project config
			mkdirSync(join(tempDir, '.opencode'), { recursive: true });
			writeFileSync(
				join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({ council: { enabled: true } }),
			);

			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [
						{
							agent: 'critic',
							verdict: 'APPROVE',
							confidence: 1,
							findings: [],
							criteriaAssessed: [],
							criteriaUnmet: [],
							durationMs: 10,
						},
						{
							agent: 'reviewer',
							verdict: 'APPROVE',
							confidence: 1,
							findings: [],
							criteriaAssessed: [],
							criteriaUnmet: [],
							durationMs: 10,
						},
						{
							agent: 'sme',
							verdict: 'APPROVE',
							confidence: 1,
							findings: [],
							criteriaAssessed: [],
							criteriaUnmet: [],
							durationMs: 10,
						},
						{
							agent: 'test_engineer',
							verdict: 'APPROVE',
							confidence: 1,
							findings: [],
							criteriaAssessed: [],
							criteriaUnmet: [],
							durationMs: 10,
						},
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.overallVerdict).toBe('APPROVE');
			expect(parsed.vetoedBy).toBeNull();

			// Evidence file should be written at the raw taskId path under
			// gates.council — the shape check_gate_status / update-task-status
			// actually consume.
			const evidencePath = join(tempDir, '.swarm', 'evidence', '1.1.json');
			const evidenceJson = JSON.parse(readFileSync(evidencePath, 'utf-8'));
			expect(evidenceJson.gates).toBeDefined();
			expect(evidenceJson.gates.council).toBeDefined();
			expect(evidenceJson.gates.council.verdict).toBe('APPROVE');
			// Standard GateInfo fields must be present for downstream readers.
			expect(evidenceJson.gates.council.sessionId).toBe('swarm-1');
			expect(typeof evidenceJson.gates.council.timestamp).toBe('string');
			expect(evidenceJson.gates.council.agent).toBe('architect');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
