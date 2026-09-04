import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleBenchmarkCommand } from '../../../src/commands/benchmark';
import { resetSwarmState, swarmState } from '../../../src/state';
import { resultText } from '../../helpers/benchmark-result-text.js';

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
			record_id: 'record-11-1',
			version: 1,
			identity_fingerprint: 'a'.repeat(32),
			agentName: 'coder',
			taskId: '11.1',
			cost_usd: costUsd,
			cost_source: 'reported',
			cost_evidence: [
				{
					kind: 'provider_reported',
					amount_usd: costUsd,
					currency: 'USD',
					source_path: 'assistant.cost',
					reason: 'authoritative',
					usage: {
						tokens_input: 0,
						tokens_output: 0,
						tokens_reasoning: 0,
						tokens_cache: 0,
					},
				},
			],
		}),
	);
}

describe('benchmark cost threshold', () => {
	it('marks the monetary gate inconclusive when delegation cost is unavailable', async () => {
		writeFileSync(
			path.join(testDir, '.swarm', 'telemetry.jsonl'),
			JSON.stringify({
				event: 'delegation_end',
				agentName: 'coder',
				taskId: '11.0',
				cost_usd: null,
				cost_source: 'unavailable',
			}),
		);

		const result = await handleBenchmarkCommand(testDir, [
			'--ci-gate',
			'--max-cost-usd',
			'0',
		]);
		const jsonMatch = resultText(result).match(
			/\[BENCHMARK_JSON\]\n([\s\S]*?)\n\[\/BENCHMARK_JSON\]/,
		);
		const parsed = JSON.parse(jsonMatch![1]);
		const costGate = parsed.ci_gate.checks.find(
			(check: { name: string }) => check.name === 'Total cost',
		);

		expect(resultText(result)).toContain('Total cost: inconclusive');
		expect(costGate.passed).toBe(false);
		expect(costGate.evidence_status).toBe('inconclusive');
		expect(costGate.reason).toBe('budgetInconclusive');
	});

	it('marks the monetary gate inconclusive after a durable join miss', async () => {
		writeCostTelemetry(0.25);
		writeFileSync(
			path.join(testDir, '.swarm', 'telemetry.jsonl'),
			`${readFileSync(path.join(testDir, '.swarm', 'telemetry.jsonl'), 'utf8')}\n${JSON.stringify({ event: 'delegation_cost_join', reason: 'join_miss' })}`,
		);
		const result = await handleBenchmarkCommand(testDir, [
			'--ci-gate',
			'--max-cost-usd',
			'1',
		]);
		expect(resultText(result)).toContain('Total cost: inconclusive');
	});

	it('uses authoritative modern evidence instead of a contradictory scalar', async () => {
		writeCostTelemetry(5);
		const telemetryPath = path.join(testDir, '.swarm', 'telemetry.jsonl');
		const row = JSON.parse(readFileSync(telemetryPath, 'utf8'));
		row.cost_usd = 0;
		row.tokens_input = 0;
		row.cost_evidence[0].usage = {
			tokens_input: 1_000_000,
			tokens_output: 3,
			tokens_reasoning: 4,
			tokens_cache: 5,
		};
		writeFileSync(telemetryPath, JSON.stringify(row));

		const result = await handleBenchmarkCommand(testDir, [
			'--ci-gate',
			'--max-cost-usd',
			'1',
		]);
		const jsonMatch = resultText(result).match(
			/\[BENCHMARK_JSON\]\n([\s\S]*?)\n\[\/BENCHMARK_JSON\]/,
		);
		const parsed = JSON.parse(jsonMatch![1]);
		expect(parsed.costs.total_cost_usd).toBe(5);
		expect(parsed.costs.total_input_tokens).toBe(1_000_000);
		expect(parsed.costs.total_reasoning_tokens).toBe(4);
		expect(parsed.costs.total_cache_tokens).toBe(5);
		expect(resultText(result)).toContain('Total cost: $5.000000 <= $1.000000');
	});

	it('passes when cumulative delegation cost is at or below threshold', async () => {
		writeCostTelemetry(0.25);

		const result = await handleBenchmarkCommand(testDir, [
			'--ci-gate',
			'--max-cost-usd',
			'0.30',
		]);

		expect(resultText(result)).toContain('Total cost: $0.250000 <= $0.300000');
		const jsonMatch = resultText(result).match(
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

		expect(resultText(result)).toContain('Total cost: $0.350000 <= $0.300000');
		expect(resultText(result)).toContain('FAILED');
	});

	it('does not add a cost gate unless a threshold is provided', async () => {
		writeCostTelemetry(0.35);

		const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);
		const jsonMatch = resultText(result).match(
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
