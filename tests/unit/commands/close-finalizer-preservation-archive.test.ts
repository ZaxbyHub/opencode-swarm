import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
	initializeCloseFinalizerHarness,
	mockedSwarmState,
} from './close-finalizer.shared.ts';

const h = await initializeCloseFinalizerHarness();
let testDir = '';

beforeEach(() => {
	h.resetState();
	testDir = h.newTestDir();
});

afterEach(() => {
	h.restoreInternals();
	h.cleanupTestDir(testDir);
	mock.restore();
});

describe('handleCloseCommand — finalizer stages', () => {
	describe('resetSwarmStatePreservingSingletons integration', () => {
		it('calls resetSwarmStatePreservingSingletons (not bare resetSwarmState) on close', async () => {
			await h.writePlan(testDir);

			await h.handleCloseCommand(testDir, []);

			expect(h.mockResetSwarmStatePreservingSingletons).toHaveBeenCalledTimes(1);
		});

		it('calls resetSwarmStatePreservingSingletons() and all 7 singletons survive when the close command path runs', async () => {
			await h.writePlan(testDir);

			const sentinelClient = { __close_test: 'preserved-opencode-client' };
			mockedSwarmState.opencodeClient = sentinelClient;
			mockedSwarmState.fullAutoEnabledInConfig = false;
			mockedSwarmState.curatorInitAgentNames = ['close_init_a', 'close_init_b'];
			mockedSwarmState.curatorPhaseAgentNames = ['close_phase_x'];
			mockedSwarmState.skillImproverAgentNames = ['close_skill_y'];
			mockedSwarmState.specWriterAgentNames = ['close_spec_z'];
			mockedSwarmState.generatedAgentNames = ['close_gen_1', 'close_gen_2'];
			mockedSwarmState.pendingEvents = 123;
			mockedSwarmState.lastBudgetPct = 77;
			mockedSwarmState.activeToolCalls.set('close-test-call', { tool: 'x' });

			const result = await h.handleCloseCommand(testDir, []);

			expect(h.mockResetSwarmStatePreservingSingletons).toHaveBeenCalledTimes(1);
			expect(result).toContain('finalized');

			expect(mockedSwarmState.opencodeClient).toBe(sentinelClient);
			expect(mockedSwarmState.fullAutoEnabledInConfig).toBe(false);
			expect(mockedSwarmState.curatorInitAgentNames).toEqual([
				'close_init_a',
				'close_init_b',
			]);
			expect(mockedSwarmState.curatorPhaseAgentNames).toEqual([
				'close_phase_x',
			]);
			expect(mockedSwarmState.skillImproverAgentNames).toEqual([
				'close_skill_y',
			]);
			expect(mockedSwarmState.specWriterAgentNames).toEqual(['close_spec_z']);
			expect(mockedSwarmState.generatedAgentNames).toEqual([
				'close_gen_1',
				'close_gen_2',
			]);
			expect(mockedSwarmState.pendingEvents).toBe(0);
			expect(mockedSwarmState.lastBudgetPct).toBe(0);
			expect(mockedSwarmState.activeToolCalls.size).toBe(0);
		});

		it('close succeeds when resetSwarmStatePreservingSingletons is the only state reset path', async () => {
			await h.writePlan(testDir);

			const result = await h.handleCloseCommand(testDir, []);

			expect(result).toContain('finalized');
			expect(h.mockResetSwarmStatePreservingSingletons).toHaveBeenCalledTimes(1);
		});
	});

	describe('Archive stage', () => {
		it('creates an archive directory under .swarm/archive/ with a timestamped name', async () => {
			await h.writePlan(testDir);

			await h.handleCloseCommand(testDir, []);

			const archiveBase = path.join(h.swarmDir(testDir), 'archive');
			expect(existsSync(archiveBase)).toBe(true);

			const entries = readdirSync(archiveBase);
			expect(entries.length).toBeGreaterThanOrEqual(1);

			const archiveName = entries.find((entry) => entry.startsWith('swarm-'));
			expect(archiveName).toBeDefined();
			expect(archiveName).toMatch(/^swarm-\d{4}-\d{2}-\d{2}T/);
		});

		it('copies plan.json, context.md, and events.jsonl into the archive when they exist', async () => {
			await h.writePlan(testDir);
			writeFileSync(path.join(h.swarmDir(testDir), 'context.md'), '# Context\nSome context');
			writeFileSync(
				path.join(h.swarmDir(testDir), 'events.jsonl'),
				'{"event":"started"}\n',
			);

			await h.handleCloseCommand(testDir, []);

			const archiveBase = path.join(h.swarmDir(testDir), 'archive');
			const archiveEntry = readdirSync(archiveBase).find((entry) =>
				entry.startsWith('swarm-'),
			);
			expect(archiveEntry).toBeDefined();

			const archivePath = path.join(archiveBase, archiveEntry!);
			expect(existsSync(path.join(archivePath, 'plan.json'))).toBe(true);
			expect(existsSync(path.join(archivePath, 'context.md'))).toBe(true);
			expect(existsSync(path.join(archivePath, 'events.jsonl'))).toBe(true);

			const archivedEvents = readFileSync(path.join(archivePath, 'events.jsonl'), 'utf-8');
			expect(archivedEvents).toContain('{"event":"started"}');
		});

		it('return message includes archive result', async () => {
			await h.writePlan(testDir);

			const result = await h.handleCloseCommand(testDir, []);

			expect(result).toContain('**Archive:**');
			expect(result).toContain('Archived');
			expect(result).toContain('.swarm/archive/swarm-');
		});
	});
});
