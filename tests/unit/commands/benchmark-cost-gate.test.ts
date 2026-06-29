import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleBenchmarkCommand } from '../../../src/commands/benchmark';
import { resetSwarmState, swarmState } from '../../../src/state';

let testDir: string;

beforeEach(() => {
	resetSwarmState();
	testDir = path.join(
		os.tmpdir(),
		`benchmark-cost-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
	swarmState.toolAggregates.set('read', {
		tool: 'read',
		count: 100,
		successCount: 100,
		failureCount: 0,
		totalDuration: 1000,
	});
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function writeCostTelemetry(costUsd: number): void {
	writeFileSync(
		path.join(testDir, '.swarm', 'telemetry.jsonl'),
		JSON.stringify({
			event: 'delegation_end',
			agentName: 'coder',
			taskId: '11.1',
			cost_usd: costUsd,
			cost_source: 'reported',
		}),
	);
}

describe('benchmark cost threshold', () => {
	it('passes when cumulative delegation cost is at or below threshold', async () => {
		writeCostTelemetry(0.25);

		const result = await handleBenchmarkCommand(testDir, [
			'--ci-gate',
			'--max-cost-usd',
			'0.30',
		]);

		expect(result).toContain('Total cost: $0.250000 <= $0.300000');
		const jsonMatch = result.match(
			/\[BENCHMARK_JSON\]\n([\s\S]*?)\n\[\/BENCHMARK_JSON\]/,
		);
		const parsed = JSON.parse(jsonMatch![1]);
		expect(parsed.costs.total_cost_usd).toBe(0.25);
		expect(
			parsed.ci_gate.checks.map((c: { name: string }) => c.name),
		).toContain('Total cost');
	});

	it('fails when cumulative delegation cost exceeds threshold', async () => {
		writeCostTelemetry(0.35);

		const result = await handleBenchmarkCommand(testDir, [
			'--ci-gate',
			'--max-cost-usd',
			'0.30',
		]);

		expect(result).toContain('Total cost: $0.350000 <= $0.300000');
		expect(result).toContain('FAILED');
	});

	it('does not add a cost gate unless a threshold is provided', async () => {
		writeCostTelemetry(0.35);

		const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);
		const jsonMatch = result.match(
			/\[BENCHMARK_JSON\]\n([\s\S]*?)\n\[\/BENCHMARK_JSON\]/,
		);
		const parsed = JSON.parse(jsonMatch![1]);

		expect(parsed.ci_gate.checks).toHaveLength(8);
		expect(parsed.costs.total_cost_usd).toBe(0.35);
	});

	it('rejects malformed cost threshold values instead of disabling the gate', async () => {
		await expect(
			handleBenchmarkCommand(testDir, [
				'--ci-gate',
				'--max-cost-usd',
				'not-a-number',
			]),
		).rejects.toThrow('Invalid --max-cost-usd value');
	});
});
