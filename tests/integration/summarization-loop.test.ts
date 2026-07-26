import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRetrieveCommand } from '../../src/commands/retrieve';
import type { SummaryConfig } from '../../src/config/schema';
import {
	createToolSummarizerHook,
	resetSummaryIdCounter,
} from '../../src/hooks/tool-summarizer';

/**
 * Default configuration helper
 */
function defaultConfig(overrides?: Partial<SummaryConfig>): SummaryConfig {
	return {
		enabled: true,
		threshold_bytes: 1024,
		max_summary_chars: 1000,
		max_stored_bytes: 10485760,
		retention_days: 7,
		exempt_tools: ['retrieve_summary', 'task', 'read'],
		...overrides,
	};
}

describe('summarization loop fix integration', () => {
	let tempDir: string;

	beforeEach(() => {
		// Reset summary ID counter before each test
		resetSummaryIdCounter();

		// Create temporary directory for test
		tempDir = join(tmpdir(), `summarization-loop-test-${Date.now()}`);
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		// Clean up temporary directory
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// ==================== ADVERSARIAL TESTS ====================
	// These test attack vectors against the exempt_tools configuration

	test('ADVERSARY: empty array override disables operator exemptions but not the floor', async () => {
		// Contract change (see docs/releases/pending/pr-workflow-lane-output-context.md):
		// SUMMARIZER_EXEMPT_TOOL_NAMES is now an unconditional FLOOR. Operator
		// config can no longer remove a floor member (retrieve_summary among
		// them) by omitting it — summarizing it would destroy the recovery
		// mechanism the summarizer itself points callers to. This test used to
		// assert the pre-floor "empty array disables everything" behavior for
		// retrieve_summary specifically; that premise no longer holds for a
		// floor member, so it now asserts the floor holds for retrieve_summary
		// while confirming an empty array genuinely disables exemption for a
		// tool that is NOT on the floor.
		const config = defaultConfig({ exempt_tools: [] });
		const hook = createToolSummarizerHook(config, tempDir);

		const floorOutput = {
			title: 'retrieve',
			output: 'x'.repeat(2500),
			metadata: {},
		};
		await hook(
			{ tool: 'retrieve_summary', sessionID: 'test', callID: 'call-1' },
			floorOutput,
		);
		// Floor member: still exempt even with an empty operator list.
		expect(floorOutput.output).not.toContain('[SUMMARY');

		const nonFloorOutput = {
			title: 'other',
			output: 'y'.repeat(2500),
			metadata: {},
		};
		await hook(
			{ tool: 'some_other_tool', sessionID: 'test', callID: 'call-2' },
			nonFloorOutput,
		);
		// Non-floor tool: an empty operator list genuinely disables exemption.
		expect(nonFloorOutput.output).toContain('[SUMMARY');
	});

	test('ADVERSARY: null/undefined exempt_tools uses defaults', async () => {
		// Defense: null/undefined should fall back to defaults via ?? operator
		const config = defaultConfig({ exempt_tools: null as any });
		const hook = createToolSummarizerHook(config, tempDir);

		const largeOutput = 'retrieve_summary content'.repeat(100);
		const input = {
			tool: 'retrieve_summary',
			sessionID: 'test',
			callID: 'call-1',
		};
		const output = { title: 'retrieve', output: largeOutput, metadata: {} };

		await hook(input, output);

		// With null, defaults should apply - output should NOT be summarized
		expect(output.output).not.toContain('[SUMMARY');
	});

	test('ADVERSARY: case-sensitive mismatch on an operator-added exemption', async () => {
		// Contract change: 'read' is a floor member (SUMMARIZER_EXEMPT_TOOL_NAMES),
		// so it stays exempt regardless of what an operator's exempt_tools list
		// contains — a wrong-case entry for a floor member can no longer matter,
		// since the floor is matched by its own canonical lowercase names, not
		// by the operator's (possibly malformed) config. The original test used
		// 'read' to demonstrate case-sensitive matching, which no longer
		// demonstrates an attack now that 'read' cannot be un-exempted. Case
		// sensitivity is still real JS behavior for OPERATOR-added exemptions on
		// non-floor tools, so this now exercises that with a synthetic tool name.
		const config = defaultConfig({ exempt_tools: ['Custom_Tool'] }); // wrong case
		const hook = createToolSummarizerHook(config, tempDir);

		const largeOutput = 'custom tool output data'.repeat(100);
		const input = { tool: 'custom_tool', sessionID: 'test', callID: 'call-1' };
		const output = { title: 'custom', output: largeOutput, metadata: {} };

		await hook(input, output);

		// 'custom_tool' (lowercase) won't match 'Custom_Tool' (mixed case) in
		// includes() — case-sensitive matching is expected JS behavior for
		// operator-supplied, non-floor exemptions.
		expect(output.output).toContain('[SUMMARY S1]');
	});

	test('ADVERSARY: duplicate entries work but are wasteful', async () => {
		// Defense check: duplicates don't crash, just waste cycles
		const config = defaultConfig({
			exempt_tools: [
				'read',
				'read',
				'read',
				'task',
				'task',
				'retrieve_summary',
			],
		});
		const hook = createToolSummarizerHook(config, tempDir);

		const largeOutput = 'task content'.repeat(100);
		const input = { tool: 'task', sessionID: 'test', callID: 'call-1' };
		const output = { title: 'task', output: largeOutput, metadata: {} };

		// Should not crash
		await hook(input, output);

		// Output should remain unchanged due to exemptions
		expect(output.output).not.toContain('[SUMMARY');
	});

	test('ADVERSARY: extra-large array (1000 entries) - performance test', async () => {
		// Performance attack: pass huge array of exempt tools
		const largeArray = Array.from({ length: 1000 }, (_, i) => `tool_${i}`);
		// Include 'bash' in the large array so we can test if it gets summarized
		largeArray[500] = 'bash';

		const config = defaultConfig({ exempt_tools: largeArray });
		const hook = createToolSummarizerHook(config, tempDir);

		const bashOutput = 'bash command output'.repeat(100);
		const input = { tool: 'bash', sessionID: 'test', callID: 'call-1' };
		const output = { title: 'bash', output: bashOutput, metadata: {} };

		// Should complete without hanging
		await hook(input, output);

		// bash IS in the large array at index 500, so should be exempt
		expect(output.output).not.toContain('[SUMMARY');
	});

	test('ADVERSARY: wrong type string instead of array', async () => {
		// Attack: Pass string instead of array - includes() works on strings!
		// 'read,task'.includes('read') returns TRUE - so it incorrectly exempts
		const config = defaultConfig({ exempt_tools: 'read,task' as any });
		const hook = createToolSummarizerHook(config, tempDir);

		const largeOutput = 'read output'.repeat(100);
		const input = { tool: 'read', sessionID: 'test', callID: 'call-1' };
		const output = { title: 'read', output: largeOutput, metadata: {} };

		// Should handle gracefully without crashing
		await hook(input, output);

		// Type confusion: 'read,task'.includes('read') is TRUE as substring match
		// So 'read' is treated as exempt - output is NOT summarized
		// Note: TypeScript/Zod validation prevents this in production; this tests runtime behavior
		expect(output.output).not.toContain('[SUMMARY');
	});

	// ==================== HAPPY PATH TESTS ====================

	test('main loop prevention: retrieve_summary output is never summarized', async () => {
		// Arrange: Create hook with default config
		const config = defaultConfig();
		const hook = createToolSummarizerHook(config, tempDir);

		// Create a large bash output (2000 bytes - above 1024 threshold)
		const bashOutput = 'line'.repeat(500); // ~2000 bytes
		expect(bashOutput.length).toBeGreaterThan(config.threshold_bytes);

		// Step 1: Summarize bash output → S1 stored, output replaced with summary text
		const bashInput = {
			tool: 'bash',
			sessionID: 'test-session',
			callID: 'test-call-1',
		};
		const bashOutputObj = {
			title: 'bash output',
			output: bashOutput,
			metadata: {},
		};

		await hook(bashInput, bashOutputObj);

		// Verify S1 was created and bash output was replaced
		expect(bashOutputObj.output).not.toBe(bashOutput); // Should be replaced
		expect(bashOutputObj.output).toContain('[SUMMARY S1]');
		const summaryDir = join(tempDir, '.swarm', 'summaries');
		expect(existsSync(join(summaryDir, 'S1.json'))).toBe(true);

		const summaryText = bashOutputObj.output;

		// Step 2: Simulate what happens when retrieve_summary runs
		// Call the hook again but with input.tool = 'retrieve_summary' and output.output = summaryText
		const retrieveInput = {
			tool: 'retrieve_summary',
			sessionID: 'test-session',
			callID: 'test-call-2',
		};
		const retrieveOutputObj = {
			title: 'retrieve_summary output',
			output: summaryText, // This is the S1 summary text
			metadata: {},
		};

		await hook(retrieveInput, retrieveOutputObj);

		// Assert: output.output is UNCHANGED (still the summary text, not a new S2)
		expect(retrieveOutputObj.output).toBe(summaryText);

		// Assert: Only ONE summary file exists in .swarm/summaries/
		const summaryFiles = readdirSync(summaryDir).filter((f) =>
			f.endsWith('.json'),
		);
		expect(summaryFiles.length).toBe(1);
		expect(summaryFiles[0]).toBe('S1.json');

		// Verify S2.json does not exist
		expect(existsSync(join(summaryDir, 'S2.json'))).toBe(false);
	});

	test('task tool output is never summarized', async () => {
		// Arrange: Create hook with default config
		const config = defaultConfig();
		const hook = createToolSummarizerHook(config, tempDir);

		// Create a large task output (2000 bytes - above 1024 threshold)
		const taskOutput = 'task line'.repeat(250); // ~2000 bytes
		expect(taskOutput.length).toBeGreaterThan(config.threshold_bytes);

		// Call hook with input.tool = 'task' and large output
		const taskInput = {
			tool: 'task',
			sessionID: 'test-session',
			callID: 'test-call',
		};
		const taskOutputObj = {
			title: 'task output',
			output: taskOutput,
			metadata: {},
		};

		await hook(taskInput, taskOutputObj);

		// Assert: output.output unchanged, no summary file created
		expect(taskOutputObj.output).toBe(taskOutput);

		const summaryDir = join(tempDir, '.swarm', 'summaries');
		// Check if summaries directory exists (it won't be created if no summarization occurred)
		if (existsSync(summaryDir)) {
			const summaryFiles = readdirSync(summaryDir).filter((f) =>
				f.endsWith('.json'),
			);
			expect(summaryFiles.length).toBe(0);
		} else {
			// Directory doesn't exist, which is also correct
			expect(true).toBe(true);
		}
	});

	test('non-exempt tool IS summarized (control test)', async () => {
		// Arrange: Create hook with default config
		const config = defaultConfig();
		const hook = createToolSummarizerHook(config, tempDir);

		// Create a large bash output (2000 bytes - above 1024 threshold)
		const bashOutput = 'line'.repeat(500); // ~2000 bytes
		expect(bashOutput.length).toBeGreaterThan(config.threshold_bytes);

		// Call hook with input.tool = 'bash' and large output
		const bashInput = {
			tool: 'bash',
			sessionID: 'test-session',
			callID: 'test-call',
		};
		const bashOutputObj = {
			title: 'bash output',
			output: bashOutput,
			metadata: {},
		};

		await hook(bashInput, bashOutputObj);

		// Assert: output replaced with summary
		expect(bashOutputObj.output).not.toBe(bashOutput);
		expect(bashOutputObj.output).toContain('[SUMMARY S1]');
		expect(bashOutputObj.output).toContain(
			'Use /swarm retrieve S1 for full content',
		);

		// Verify summary file was created
		const summaryDir = join(tempDir, '.swarm', 'summaries');
		const summaryFiles = readdirSync(summaryDir).filter((f) =>
			f.endsWith('.json'),
		);
		expect(summaryFiles.length).toBe(1);
		expect(summaryFiles[0]).toBe('S1.json');
	});

	test('retrieve returns original after bash summarization', async () => {
		// Arrange: Create hook with default config
		const config = defaultConfig();
		const hook = createToolSummarizerHook(config, tempDir);

		// Create a large bash output (2000 bytes)
		const originalBashOutput = 'line'.repeat(500); // ~2000 bytes
		expect(originalBashOutput.length).toBeGreaterThan(config.threshold_bytes);

		// Step 1: bash output → summarized → S1
		const bashInput = {
			tool: 'bash',
			sessionID: 'test-session',
			callID: 'test-call',
		};
		const bashOutputObj = {
			title: 'bash output',
			output: originalBashOutput,
			metadata: {},
		};

		await hook(bashInput, bashOutputObj);

		// Verify S1 was created and output was replaced
		expect(bashOutputObj.output).not.toBe(originalBashOutput);
		expect(bashOutputObj.output).toContain('[SUMMARY S1]');

		// Step 2: Retrieve S1 via handleRetrieveCommand
		const retrievedContent = await handleRetrieveCommand(tempDir, ['S1']);

		// Assert: retrieved content equals original bash output
		expect(retrievedContent).toBe(originalBashOutput);
	});
});
