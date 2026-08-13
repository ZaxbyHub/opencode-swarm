import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentDefinition } from '../../../src/agents';
import {
	createCompactionService,
	getCompactionMetrics,
	resetCompactionState,
} from '../../../src/services/compaction-service';
import { getStatusData } from '../../../src/services/status-service';
import {
	resetSwarmState,
	setSessionBudget,
	swarmState,
} from '../../../src/state';

describe('compaction-metrics', () => {
	const tempDir = path.join(os.tmpdir(), `swarm-compaction-test-${Date.now()}`);
	let emptyAgents: Record<string, AgentDefinition>;

	beforeEach(() => {
		resetCompactionState();
		resetSwarmState();
		emptyAgents = {};
		// Ensure temp directory exists for snapshot writes
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	test('getCompactionMetrics returns 0 count and null lastSnapshotAt initially', () => {
		const metrics = getCompactionMetrics();
		expect(metrics.compactionCount).toBe(0);
		expect(metrics.lastSnapshotAt).toBeNull();
	});

	test('after observation tier fires, compactionCount increments and lastSnapshotAt is ISO string', async () => {
		// Set budget above observation threshold (40%)
		setSessionBudget('test-session', 45, 128000);

		const hook = createCompactionService(
			{
				enabled: true,
				observationThreshold: 40,
				reflectionThreshold: 60,
				emergencyThreshold: 80,
				preserveLastNTurns: 5,
			},
			tempDir,
			() => {},
		);

		await hook.toolAfter(
			{ tool: 'TestTool', sessionID: 'test-session' },
			{ output: { result: 'ok' } },
		);

		const metrics = getCompactionMetrics();
		expect(metrics.compactionCount).toBe(1);
		expect(typeof metrics.lastSnapshotAt).toBe('string');
		expect(metrics.lastSnapshotAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
		);
	});

	test('getStatusData returns live compactionCount and lastSnapshotAt from getCompactionMetrics', async () => {
		// Set budget above reflection threshold (60%)
		setSessionBudget('test-session', 65, 128000);

		const hook = createCompactionService(
			{
				enabled: true,
				observationThreshold: 40,
				reflectionThreshold: 60,
				emergencyThreshold: 80,
				preserveLastNTurns: 5,
			},
			tempDir,
			() => {},
		);

		await hook.toolAfter(
			{ tool: 'TestTool', sessionID: 'test-session' },
			{ output: { result: 'ok' } },
		);

		const statusData = await getStatusData(tempDir, emptyAgents);
		expect(statusData.compactionCount).toBeGreaterThan(0);
		expect(statusData.lastSnapshotAt).not.toBeNull();
	});
});
