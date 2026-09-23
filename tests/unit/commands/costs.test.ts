import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCostsCommand } from '../../../src/commands/costs';

let testDir: string;

beforeEach(() => {
	testDir = path.join(
		os.tmpdir(),
		`costs-command-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function writeTelemetry(lines: Array<Record<string, unknown>>): void {
	writeFileSync(
		path.join(testDir, '.swarm', 'telemetry.jsonl'),
		lines.map((line) => JSON.stringify(line)).join('\n'),
	);
}

describe('handleCostsCommand', () => {
	it('renders per-agent and per-task totals from delegation telemetry', async () => {
		writeTelemetry([
			{
				event: 'delegation_end',
				agentName: 'coder',
				taskId: '2.1',
				tokens_input: 1000,
				tokens_output: 250,
				cost_usd: 0.0042,
				cost_source: 'estimated',
				gate: 'qa_review',
				retry_index: 1,
			},
			{
				event: 'delegation_end',
				agentName: 'reviewer',
				taskId: '2.1',
				cost_source: 'unavailable',
			},
		]);

		const result = await handleCostsCommand(testDir, []);

		expect(result).toContain('## Swarm Costs');
		expect(result).toContain('Total tracked cost: $0.004200');
		expect(result).toContain('Delegations: 2');
		expect(result).toContain('| coder | 1 | $0.004200 | 1,000 | 250 |');
		expect(result).toContain('| reviewer | 1 | $0.000000 | 0 | 0 |');
		expect(result).toContain('| 2.1 | 2 | $0.004200 | 1,000 | 250 |');
		expect(result).toContain('### By Gate');
		expect(result).toContain('| qa_review | 1 | $0.004200 | 1,000 | 250 |');
		expect(result).toContain('### By Retry Loop');
		expect(result).toContain('| 1 | 1 | $0.004200 | 1,000 | 250 |');
	});

	it('works against an existing .swarm directory without cost fields', async () => {
		writeTelemetry([
			{
				event: 'delegation_end',
				agentName: 'legacy_coder',
				taskId: 'old-task',
				result: 'completed',
			},
		]);

		const result = await handleCostsCommand(testDir, []);

		expect(result).toContain('Total tracked cost: $0.000000');
		expect(result).toContain(
			'Cost source: reported $0.000000, estimated $0.000000, unavailable 1',
		);
		expect(result).toContain(
			'| legacy_coder | 1 | $0.000000 | 0 | 0 | 0 | 0 | 1 |',
		);
	});

	it('returns machine-readable JSON when requested', async () => {
		writeTelemetry([
			{
				event: 'delegation_end',
				agentName: 'coder',
				taskId: '3.1',
				cost_usd: 0.01,
				cost_source: 'reported',
			},
		]);

		const result = await handleCostsCommand(testDir, ['--json']);
		const jsonMatch = result.match(
			/\[COSTS_JSON\]\n([\s\S]*?)\n\[\/COSTS_JSON\]/,
		);

		expect(jsonMatch).not.toBeNull();
		const parsed = JSON.parse(jsonMatch![1]);
		expect(parsed.total_cost_usd).toBe(0.01);
		expect(parsed.by_agent[0].name).toBe('coder');
		expect(parsed.by_gate[0].name).toBe('unknown');
		expect(parsed.by_retry[0].name).toBe('0');
	});
});
