import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleContextMapStatsCommand } from '../../../src/commands/context-map-stats';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('handleContextMapStatsCommand', () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(() => {
		const safe = createSafeTestDir('ctx-map-stats-');
		dir = safe.dir;
		cleanup = safe.cleanup;
	});

	afterEach(() => {
		cleanup();
	});

	test('empty state shows "No capsule telemetry recorded."', async () => {
		const result = await handleContextMapStatsCommand(dir);
		expect(result).toBe('No capsule telemetry recorded.');
	});

	test('populated state shows summary with aggregated values', async () => {
		const swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const telemetryPath = path.join(swarmDir, 'context-telemetry.jsonl');
		const entry1 = {
			timestamp: '2026-07-29T00:00:00Z',
			task_id: '1.1',
			agent_role: 'coder',
			delegation_reason: 'context-capsule',
			token_estimate: 5000,
			cache_hits: 3,
			cache_misses: 1,
			stale_entries: 0,
			recommended_reads: 2,
			skipped_reads: 4,
			success: true,
		};
		const entry2 = {
			timestamp: '2026-07-29T00:01:00Z',
			task_id: '2.1',
			agent_role: 'reviewer',
			delegation_reason: 'context-capsule',
			token_estimate: 8000,
			cache_hits: 2,
			cache_misses: 3,
			stale_entries: 1,
			recommended_reads: 5,
			skipped_reads: 1,
			success: true,
		};
		fs.writeFileSync(
			telemetryPath,
			`${JSON.stringify(entry1)}\n${JSON.stringify(entry2)}\n`,
			'utf-8',
		);

		const result = await handleContextMapStatsCommand(dir);
		expect(result).toContain('Total delegations:** 2');
		expect(result).toContain('Cache hits:**');
		expect(result).toContain('Success rate:**');
		expect(result).not.toContain('No capsule telemetry recorded.');
	});

	test('multiple entries aggregate correctly', async () => {
		const swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const telemetryPath = path.join(swarmDir, 'context-telemetry.jsonl');
		const makeEntry = (n: number) => ({
			timestamp: `2026-07-29T00:0${n}:00Z`,
			task_id: `${n}.1`,
			agent_role: 'coder',
			delegation_reason: 'context-capsule',
			token_estimate: 1000,
			cache_hits: 1,
			cache_misses: 0,
			stale_entries: 0,
			recommended_reads: 0,
			skipped_reads: 0,
			success: true,
		});
		fs.writeFileSync(
			telemetryPath,
			[makeEntry(1), makeEntry(2), makeEntry(3)]
				.map((e) => JSON.stringify(e))
				.join('\n') + '\n',
			'utf-8',
		);

		const result = await handleContextMapStatsCommand(dir);
		expect(result).toContain('Cache hits:** 3');
	});

	test('empty file content triggers "No capsule telemetry recorded."', async () => {
		const swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const telemetryPath = path.join(swarmDir, 'context-telemetry.jsonl');
		fs.writeFileSync(telemetryPath, '', 'utf-8');

		const result = await handleContextMapStatsCommand(dir);
		expect(result).toBe('No capsule telemetry recorded.');
	});

	test('malformed JSONL is handled gracefully', async () => {
		const swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const telemetryPath = path.join(swarmDir, 'context-telemetry.jsonl');
		fs.writeFileSync(
			telemetryPath,
			'not json\n{broken\n===garbage===\n',
			'utf-8',
		);

		const result = await handleContextMapStatsCommand(dir);
		expect(result).toBe('No capsule telemetry recorded.');
	});
});
