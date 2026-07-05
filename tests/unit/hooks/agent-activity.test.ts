import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	_flushForTesting,
	createAgentActivityHooks,
} from '../../../src/hooks/agent-activity';
import { resetSwarmState, swarmState } from '../../../src/state';

const defaultConfig: PluginConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
};

const disabledConfig: PluginConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: {
		system_enhancer: true,
		compaction: true,
		agent_activity: false,
		delegation_tracker: false,
		agent_awareness_max_chars: 300,
	},
};

describe('Agent Activity Hooks', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = await mkdtemp(join(tmpdir(), 'agent-activity-test-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('Factory', () => {
		it('should return no-ops when agent_activity is disabled', async () => {
			const hooks = createAgentActivityHooks(disabledConfig, tempDir);

			// Call toolBefore - should not modify state
			const beforeCallID = 'test-call-1';
			await hooks.toolBefore(
				{
					tool: 'test-tool',
					sessionID: 'test-session',
					callID: beforeCallID,
				},
				{ args: {} },
			);

			// Call toolAfter - should not modify state
			await hooks.toolAfter(
				{
					tool: 'test-tool',
					sessionID: 'test-session',
					callID: beforeCallID,
				},
				{
					title: 'Test Tool',
					output: 'success',
					metadata: {},
				},
			);

			// Verify no state modifications
			expect(swarmState.activeToolCalls.size).toBe(0);
			expect(swarmState.toolAggregates.size).toBe(0);
			expect(swarmState.pendingEvents).toBe(0);
		});

		it('should return active hooks when config.hooks is undefined', () => {
			const hooks = createAgentActivityHooks(defaultConfig, tempDir);

			// Verify hooks are functions
			expect(typeof hooks.toolBefore).toBe('function');
			expect(typeof hooks.toolAfter).toBe('function');

			// Verify they are not no-ops (have meaningful implementation)
			expect(hooks.toolBefore.toString()).not.toContain('async () => {}');
			expect(hooks.toolAfter.toString()).not.toContain('async () => {}');
		});
	});

	describe('toolBefore', () => {
		it('should record entry in swarmState.activeToolCalls with correct shape', async () => {
			const hooks = createAgentActivityHooks(defaultConfig, tempDir);
			const callID = 'test-call-before';
			const sessionID = 'test-session';
			const tool = 'test-tool';
			const startTime = Date.now();

			await hooks.toolBefore(
				{
					tool,
					sessionID,
					callID,
				},
				{ args: {} },
			);

			const entry = swarmState.activeToolCalls.get(callID);
			expect(entry).toBeDefined();
			expect(entry?.tool).toBe(tool);
			expect(entry?.sessionID).toBe(sessionID);
			expect(entry?.callID).toBe(callID);
			expect(entry?.startTime).toBeGreaterThanOrEqual(startTime);
			expect(entry?.startTime).toBeLessThanOrEqual(Date.now());
		});
	});

	describe('toolAfter', () => {
		it('should handle normal flow: lookup, delete, compute duration, update aggregates, increment pendingEvents', async () => {
			const hooks = createAgentActivityHooks(defaultConfig, tempDir);
			const callID = 'test-call-normal';
			const tool = 'test-tool';
			const sessionID = 'test-session';

			// Set up initial state
			hooks.toolBefore(
				{
					tool,
					sessionID,
					callID,
				},
				{ args: {} },
			);

			const beforeCount = swarmState.toolAggregates.size;
			const beforePending = swarmState.pendingEvents;

			// Call toolAfter with successful output
			await hooks.toolAfter(
				{
					tool,
					sessionID,
					callID,
				},
				{
					title: 'Test Tool',
					output: 'success result',
					metadata: {},
				},
			);

			// Verify entry was deleted
			expect(swarmState.activeToolCalls.has(callID)).toBe(false);

			// Verify aggregate was created/updated
			expect(swarmState.toolAggregates.size).toBe(beforeCount + 1);
			expect(swarmState.toolAggregates.has(tool)).toBe(true);

			// Verify aggregate data
			const aggregate = swarmState.toolAggregates.get(tool)!;
			expect(aggregate.tool).toBe(tool);
			expect(aggregate.count).toBe(1);
			expect(aggregate.successCount).toBe(1);
			expect(aggregate.failureCount).toBe(0);
			expect(aggregate.totalDuration).toBeGreaterThanOrEqual(0);

			// Verify pendingEvents incremented
			expect(swarmState.pendingEvents).toBe(beforePending + 1);
		});

		it('should handle orphaned call gracefully when callID not found', async () => {
			const hooks = createAgentActivityHooks(defaultConfig, tempDir);
			const callID = 'non-existent-call';
			const beforeCount = swarmState.toolAggregates.size;
			const beforePending = swarmState.pendingEvents;

			await hooks.toolAfter(
				{
					tool: 'test-tool',
					sessionID: 'test-session',
					callID,
				},
				{
					title: 'Test Tool',
					output: 'success',
					metadata: {},
				},
			);

			// Verify no state modifications
			expect(swarmState.toolAggregates.size).toBe(beforeCount);
			expect(swarmState.pendingEvents).toBe(beforePending);
		});

		it('should handle success detection correctly', async () => {
			const hooks = createAgentActivityHooks(defaultConfig, tempDir);
			const tool = 'test-tool';

			// Test case 1: non-null output (success)
			const callID1 = 'success-call';
			hooks.toolBefore(
				{ tool, sessionID: 'session1', callID: callID1 },
				{ args: {} },
			);
			await hooks.toolAfter(
				{
					tool,
					sessionID: 'session1',
					callID: callID1,
				},
				{
					title: 'Test',
					output: 'some result', // non-null
					metadata: {},
				},
			);

			// Test case 2: empty string (success)
			const callID2 = 'empty-string-call';
			hooks.toolBefore(
				{ tool, sessionID: 'session2', callID: callID2 },
				{ args: {} },
			);
			await hooks.toolAfter(
				{
					tool,
					sessionID: 'session2',
					callID: callID2,
				},
				{
					title: 'Test',
					output: '', // empty string - should count as success
					metadata: {},
				},
			);

			// Test case 3: explicit success=false (failure)
			const callID3 = 'null-call';
			hooks.toolBefore(
				{ tool, sessionID: 'session3', callID: callID3 },
				{ args: {} },
			);
			await hooks.toolAfter(
				{
					tool,
					sessionID: 'session3',
					callID: callID3,
				},
				{
					title: 'Test',
					output: null as any,
					success: false,
					metadata: {},
				},
			);

			// Test case 4: explicit error (failure)
			const callID4 = 'undefined-call';
			hooks.toolBefore(
				{ tool, sessionID: 'session4', callID: callID4 },
				{ args: {} },
			);
			await hooks.toolAfter(
				{
					tool,
					sessionID: 'session4',
					callID: callID4,
				},
				{
					title: 'Test',
					output: undefined as any,
					error: new Error('tool failed'),
					metadata: {},
				},
			);

			// Verify aggregate results
			const aggregate = swarmState.toolAggregates.get(tool)!;
			expect(aggregate.count).toBe(4);
			expect(aggregate.successCount).toBe(2); // non-null + empty string
			expect(aggregate.failureCount).toBe(2); // explicit failure signals
		});

		it('should accumulate aggregate data for multiple calls to same tool', async () => {
			const hooks = createAgentActivityHooks(defaultConfig, tempDir);
			const tool = 'repeated-tool';

			// First call - success
			const callID1 = 'call-1';
			hooks.toolBefore(
				{ tool, sessionID: 'session1', callID: callID1 },
				{ args: {} },
			);
			await hooks.toolAfter(
				{
					tool,
					sessionID: 'session1',
					callID: callID1,
				},
				{
					title: 'Test',
					output: 'success1',
					metadata: {},
				},
			);

			// Second call - failure
			const callID2 = 'call-2';
			hooks.toolBefore(
				{ tool, sessionID: 'session2', callID: callID2 },
				{ args: {} },
			);
			await hooks.toolAfter(
				{
					tool,
					sessionID: 'session2',
					callID: callID2,
				},
				{
					title: 'Test',
					output: null as any,
					success: false,
					metadata: {},
				},
			);

			// Third call - success
			const callID3 = 'call-3';
			hooks.toolBefore(
				{ tool, sessionID: 'session3', callID: callID3 },
				{ args: {} },
			);
			await hooks.toolAfter(
				{
					tool,
					sessionID: 'session3',
					callID: callID3,
				},
				{
					title: 'Test',
					output: 'success3',
					metadata: {},
				},
			);

			// Verify accumulated data
			const aggregate = swarmState.toolAggregates.get(tool)!;
			expect(aggregate.count).toBe(3);
			expect(aggregate.successCount).toBe(2);
			expect(aggregate.failureCount).toBe(1);
			expect(aggregate.totalDuration).toBeGreaterThanOrEqual(0);
		});

		it('should create separate aggregate entries for different tools', async () => {
			const hooks = createAgentActivityHooks(defaultConfig, tempDir);

			// Tool A calls
			const callID1 = 'call-tool-a';
			hooks.toolBefore(
				{ tool: 'tool-a', sessionID: 'session1', callID: callID1 },
				{ args: {} },
			);
			await hooks.toolAfter(
				{
					tool: 'tool-a',
					sessionID: 'session1',
					callID: callID1,
				},
				{
					title: 'Tool A',
					output: 'success',
					metadata: {},
				},
			);

			// Tool B calls
			const callID2 = 'call-tool-b';
			hooks.toolBefore(
				{ tool: 'tool-b', sessionID: 'session2', callID: callID2 },
				{ args: {} },
			);
			await hooks.toolAfter(
				{
					tool: 'tool-b',
					sessionID: 'session2',
					callID: callID2,
				},
				{
					title: 'Tool B',
					output: 'success',
					metadata: {},
				},
			);

			// Verify separate aggregates
			expect(swarmState.toolAggregates.size).toBe(2);
			expect(swarmState.toolAggregates.has('tool-a')).toBe(true);
			expect(swarmState.toolAggregates.has('tool-b')).toBe(true);

			const toolAAgg = swarmState.toolAggregates.get('tool-a')!;
			const toolBAgg = swarmState.toolAggregates.get('tool-b')!;

			expect(toolAAgg.count).toBe(1);
			expect(toolBAgg.count).toBe(1);
			expect(toolAAgg.successCount).toBe(1);
			expect(toolBAgg.successCount).toBe(1);
		});
	});

	describe('flushActivityToFile (_flushForTesting)', () => {
		beforeEach(async () => {
			// Create .swarm directory
			await mkdir(join(tempDir, '.swarm'), { recursive: true });
		});

		it('should write Agent Activity section with markdown table', async () => {
			// Set up some tool activity
			swarmState.toolAggregates.set('test-tool', {
				tool: 'test-tool',
				count: 3,
				successCount: 2,
				failureCount: 1,
				totalDuration: 1500,
			});
			swarmState.pendingEvents = 5;

			// Create context.md file
			await writeFile(
				join(tempDir, '.swarm', 'context.md'),
				'# Test Context\n\nSome content here.',
			);

			await _flushForTesting(tempDir);

			// Verify file was written
			const content = await Bun.file(
				join(tempDir, '.swarm', 'context.md'),
			).text();
			expect(content).toContain('## Agent Activity');
			expect(content).toContain(
				'| Tool | Calls | Success | Failed | Avg Duration |',
			);
			expect(content).toContain('| test-tool | 3 | 2 | 1 | 500ms |');

			// Verify pendingEvents reset
			expect(swarmState.pendingEvents).toBe(0);
		});

		it('should render "No tool activity recorded yet." when aggregates are empty', async () => {
			swarmState.pendingEvents = 2;

			// Create context.md file
			await writeFile(
				join(tempDir, '.swarm', 'context.md'),
				'# Test Context\n\nSome content here.',
			);

			await _flushForTesting(tempDir);

			// Verify file was written
			const content = await Bun.file(
				join(tempDir, '.swarm', 'context.md'),
			).text();
			expect(content).toContain('## Agent Activity');
			expect(content).toContain('No tool activity recorded yet.');

			// Verify pendingEvents reset
			expect(swarmState.pendingEvents).toBe(0);
		});

		it('should replace existing Agent Activity section', async () => {
			// Set up initial activity
			swarmState.toolAggregates.set('old-tool', {
				tool: 'old-tool',
				count: 1,
				successCount: 1,
				failureCount: 0,
				totalDuration: 100,
			});

			const originalContent = `# Test Context

## Agent Activity
| Tool | Calls | Success | Failed | Avg Duration |
|------|-------|---------|--------|--------------|
| old-tool | 1 | 1 | 0 | 100ms |

## Other Section
Some other content.`;

			await writeFile(join(tempDir, '.swarm', 'context.md'), originalContent);

			// Update activity with new tool
			swarmState.toolAggregates.clear();
			swarmState.toolAggregates.set('new-tool', {
				tool: 'new-tool',
				count: 2,
				successCount: 1,
				failureCount: 1,
				totalDuration: 800,
			});

			await _flushForTesting(tempDir);

			// Verify content was replaced
			const content = await Bun.file(
				join(tempDir, '.swarm', 'context.md'),
			).text();
			expect(content).toContain('## Agent Activity');
			expect(content).toContain('| new-tool | 2 | 1 | 1 | 400ms |');
			expect(content).not.toContain('old-tool');
			expect(content).toContain('## Other Section'); // Other sections preserved
		});

		it('should append to empty file', async () => {
			swarmState.toolAggregates.set('test-tool', {
				tool: 'test-tool',
				count: 1,
				successCount: 1,
				failureCount: 0,
				totalDuration: 200,
			});

			// Create empty context.md
			await writeFile(join(tempDir, '.swarm', 'context.md'), '');

			await _flushForTesting(tempDir);

			const content = await Bun.file(
				join(tempDir, '.swarm', 'context.md'),
			).text();
			expect(content).toContain('## Agent Activity');
			expect(content).toContain('| test-tool | 1 | 1 | 0 | 200ms |');
		});

		it('should reset pendingEvents after successful flush', async () => {
			swarmState.toolAggregates.set('test-tool', {
				tool: 'test-tool',
				count: 1,
				successCount: 1,
				failureCount: 0,
				totalDuration: 100,
			});
			swarmState.pendingEvents = 7;

			await writeFile(join(tempDir, '.swarm', 'context.md'), '# Test');

			await _flushForTesting(tempDir);

			expect(swarmState.pendingEvents).toBe(0);
		});

		it('should sort tools by count in descending order', async () => {
			swarmState.toolAggregates.set('tool-a', {
				tool: 'tool-a',
				count: 5,
				successCount: 3,
				failureCount: 2,
				totalDuration: 1000,
			});
			swarmState.toolAggregates.set('tool-b', {
				tool: 'tool-b',
				count: 10,
				successCount: 8,
				failureCount: 2,
				totalDuration: 2000,
			});
			swarmState.toolAggregates.set('tool-c', {
				tool: 'tool-c',
				count: 3,
				successCount: 2,
				failureCount: 1,
				totalDuration: 600,
			});

			await writeFile(join(tempDir, '.swarm', 'context.md'), '# Test');
			await _flushForTesting(tempDir);

			const content = await Bun.file(
				join(tempDir, '.swarm', 'context.md'),
			).text();
			const lines = content.split('\n');

			// Find table data lines (skip header)
			const tableLines = lines.filter(
				(line) => line.startsWith('| ') && !line.includes('Calls'),
			);

			// Verify order: tool-b (10), tool-a (5), tool-c (3)
			expect(tableLines[0]).toContain('tool-b');
			expect(tableLines[1]).toContain('tool-a');
			expect(tableLines[2]).toContain('tool-c');
		});

		it('should replace Agent Activity section when it is the last section', async () => {
			// Set up initial activity
			swarmState.toolAggregates.set('old-tool', {
				tool: 'old-tool',
				count: 1,
				successCount: 1,
				failureCount: 0,
				totalDuration: 100,
			});

			const originalContent = `# Context

## Decisions
- Some decision

## Agent Activity
| Tool | Calls | Success | Failed | Avg Duration |
|------|-------|---------|--------|--------------|
| old-tool | 1 | 1 | 0 | 100ms |`;

			await writeFile(join(tempDir, '.swarm', 'context.md'), originalContent);

			// Update activity with new tool
			swarmState.toolAggregates.clear();
			swarmState.toolAggregates.set('new-tool', {
				tool: 'new-tool',
				count: 2,
				successCount: 1,
				failureCount: 1,
				totalDuration: 800,
			});

			await _flushForTesting(tempDir);

			// Verify content was replaced and content before Agent Activity is preserved
			const content = await Bun.file(
				join(tempDir, '.swarm', 'context.md'),
			).text();
			expect(content).toContain('# Context');
			expect(content).toContain('## Decisions');
			expect(content).toContain('- Some decision');
			expect(content).toContain('## Agent Activity');
			expect(content).toContain('| new-tool | 2 | 1 | 1 | 400ms |');
			expect(content).not.toContain('old-tool');
		});

		it('should append Agent Activity section when heading not found in non-empty content', async () => {
			swarmState.toolAggregates.set('test-tool', {
				tool: 'test-tool',
				count: 3,
				successCount: 2,
				failureCount: 1,
				totalDuration: 1500,
			});

			const originalContent = `# Context

## Decisions
- Some decision

## Patterns
- Some pattern`;

			await writeFile(join(tempDir, '.swarm', 'context.md'), originalContent);

			await _flushForTesting(tempDir);

			// Verify Agent Activity is appended with double-newline separator
			const content = await Bun.file(
				join(tempDir, '.swarm', 'context.md'),
			).text();
			expect(content).toContain('# Context');
			expect(content).toContain('## Decisions');
			expect(content).toContain('- Some decision');
			expect(content).toContain('## Patterns');
			expect(content).toContain('- Some pattern');
			expect(content).toContain('## Agent Activity');
			expect(content).toContain('| test-tool | 3 | 2 | 1 | 500ms |');

			// Verify the section is appended at the end
			const lines = content.split('\n');
			const agentActivityIndex = lines.findIndex((line) =>
				line.includes('## Agent Activity'),
			);
			const patternsIndex = lines.findIndex((line) =>
				line.includes('## Patterns'),
			);
			expect(agentActivityIndex).toBeGreaterThan(patternsIndex);
		});

		it('should create context.md when file does not exist', async () => {
			swarmState.toolAggregates.set('test-tool', {
				tool: 'test-tool',
				count: 2,
				successCount: 1,
				failureCount: 1,
				totalDuration: 800,
			});
			swarmState.pendingEvents = 3;

			// Note: .swarm directory already exists from beforeEach
			// context.md file should NOT exist initially

			await _flushForTesting(tempDir);

			// Verify context.md was created with Agent Activity section
			const content = await Bun.file(
				join(tempDir, '.swarm', 'context.md'),
			).text();
			expect(content).toContain('## Agent Activity');
			expect(content).toContain('| test-tool | 2 | 1 | 1 | 400ms |');
			expect(swarmState.pendingEvents).toBe(0);
		});

		it('should auto-trigger flush at 20 pending events', async () => {
			const hooks = createAgentActivityHooks(defaultConfig, tempDir);

			// Create empty context.md file so write succeeds
			await writeFile(join(tempDir, '.swarm', 'context.md'), '# Test');

			// Execute 20 rapid toolBefore + toolAfter calls to reach pendingEvents >= 20
			for (let i = 0; i < 20; i++) {
				const callID = `auto-flush-test-${i}`;
				await hooks.toolBefore(
					{
						tool: 'auto-test-tool',
						sessionID: 'auto-session',
						callID,
					},
					{ args: {} },
				);

				await hooks.toolAfter(
					{
						tool: 'auto-test-tool',
						sessionID: 'auto-session',
						callID,
					},
					{
						title: 'Auto Test',
						output: `result-${i}`,
						metadata: {},
					},
				);
			}

			// Flush directly to avoid relying on wall-clock auto-flush timing
			await _flushForTesting(tempDir);

			// Verify context.md file exists and contains the Agent Activity table
			const content = await Bun.file(
				join(tempDir, '.swarm', 'context.md'),
			).text();
			expect(content).toContain('## Agent Activity');
			expect(content).toContain('| auto-test-tool | 20 | 20 | 0 |');

			// Verify pendingEvents was reset after auto-flush
			expect(swarmState.pendingEvents).toBe(0);
		});

		it('should show "0ms" for average duration when count is zero', async () => {
			// Manually set a toolAggregate with count: 0
			swarmState.toolAggregates.set('zero-tool', {
				tool: 'zero-tool',
				count: 0,
				successCount: 0,
				failureCount: 0,
				totalDuration: 0,
			});
			swarmState.pendingEvents = 1;

			await writeFile(join(tempDir, '.swarm', 'context.md'), '# Test');

			await _flushForTesting(tempDir);

			// Verify the rendered table line shows "0ms" for avg duration
			const content = await Bun.file(
				join(tempDir, '.swarm', 'context.md'),
			).text();
			expect(content).toContain('| zero-tool | 0 | 0 | 0 | 0ms |');
		});
	});
});
