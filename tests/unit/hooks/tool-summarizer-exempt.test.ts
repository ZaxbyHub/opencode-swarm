import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SummaryConfig } from '../../../src/config/schema';
import {
	createToolSummarizerHook,
	resetSummaryIdCounter,
} from '../../../src/hooks/tool-summarizer';

describe('tool-summarizer exempt_tools feature', () => {
	let tempDir: string;
	let hook: (input: any, output: any) => Promise<void>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `tool-summarizer-test-${Date.now()}`);
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
		resetSummaryIdCounter();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function defaultConfig(overrides?: Partial<SummaryConfig>): SummaryConfig {
		return {
			enabled: true,
			threshold_bytes: 1024, // low threshold so large outputs get summarized
			max_summary_chars: 1000,
			max_stored_bytes: 10485760,
			retention_days: 7,
			exempt_tools: [
				'retrieve_summary',
				'retrieve_lane_output',
				'task',
				'read',
			], // explicit default
			...overrides,
		};
	}

	describe('Default exemptions', () => {
		it('retrieve_summary is never summarized', async () => {
			const config = defaultConfig();
			hook = createToolSummarizerHook(config, tempDir);

			const originalOutput = 'x'.repeat(2000);
			const output = { output: originalOutput };
			const input = { tool: 'retrieve_summary' };

			await hook(input, output);

			// Verify output was NOT modified
			expect(output.output).toBe(originalOutput);
			expect(output.output).toBe('x'.repeat(2000));
		});

		it('task is never summarized', async () => {
			const config = defaultConfig();
			hook = createToolSummarizerHook(config, tempDir);

			const originalOutput = 'x'.repeat(2000);
			const output = { output: originalOutput };
			const input = { tool: 'task' };

			await hook(input, output);

			// Verify output was NOT modified
			expect(output.output).toBe(originalOutput);
			expect(output.output).toBe('x'.repeat(2000));
		});

		it('retrieve_lane_output is never summarized', async () => {
			const config = defaultConfig();
			hook = createToolSummarizerHook(config, tempDir);

			const originalOutput = 'x'.repeat(2000);
			const output = { output: originalOutput };
			const input = { tool: 'retrieve_lane_output' };

			await hook(input, output);

			expect(output.output).toBe(originalOutput);
		});

		it('read tool is exempt by default', async () => {
			const config = defaultConfig();
			hook = createToolSummarizerHook(config, tempDir);

			const originalOutput = 'x'.repeat(200000); // 200KB > threshold (102400) to exercise exemption
			const output = { output: originalOutput };
			const input = { tool: 'read' };

			await hook(input, output);

			// Verify output was NOT modified (exemption prevents summarization)
			expect(output.output).toBe(originalOutput);
			expect(output.output).toBe('x'.repeat(200000));
		});
	});

	describe('Non-exempt tools', () => {
		it('bash tool IS summarized', async () => {
			const config = defaultConfig();
			hook = createToolSummarizerHook(config, tempDir);

			const originalOutput = 'x'.repeat(2000);
			const output = { output: originalOutput };
			const input = { tool: 'bash' };

			await hook(input, output);

			// Verify output WAS summarized
			expect(output.output).toContain('[SUMMARY S1]');
			expect(output.output).not.toBe(originalOutput);
		});
	});

	describe('Custom exempt_tools', () => {
		it('custom tool is exempt when in exempt_tools list', async () => {
			const config = defaultConfig({
				exempt_tools: ['my_custom_tool'],
			});
			hook = createToolSummarizerHook(config, tempDir);

			const originalOutput = 'x'.repeat(2000);
			const output = { output: originalOutput };
			const input = { tool: 'my_custom_tool' };

			await hook(input, output);

			// Verify output was NOT modified
			expect(output.output).toBe(originalOutput);
			expect(output.output).toBe('x'.repeat(2000));
		});

		it('retrieve_summary is NOT exempt when not in custom list', async () => {
			const config = defaultConfig({
				exempt_tools: ['my_custom_tool'],
			});
			hook = createToolSummarizerHook(config, tempDir);

			const originalOutput = 'x'.repeat(2000);
			const output = { output: originalOutput };
			const input = { tool: 'retrieve_summary' };

			await hook(input, output);

			// Verify output WAS summarized
			expect(output.output).toContain('[SUMMARY S1]');
			expect(output.output).not.toBe(originalOutput);
		});
	});

	describe('Empty exempt list', () => {
		it('no tools are exempt when exempt_tools is empty', async () => {
			const config = defaultConfig({
				exempt_tools: [],
			});
			hook = createToolSummarizerHook(config, tempDir);

			const originalOutput = 'x'.repeat(2000);
			const output = { output: originalOutput };
			const input = { tool: 'retrieve_summary' };

			await hook(input, output);

			// Verify output WAS summarized (no exemptions)
			expect(output.output).toContain('[SUMMARY S1]');
			expect(output.output).not.toBe(originalOutput);
		});
	});

	describe('Legacy config support', () => {
		it('legacy config without exempt_tools field uses fallback default', async () => {
			// Simulate a legacy config object without exempt_tools field
			// Using type assertion to bypass TypeScript's type checking
			const baseConfig = defaultConfig();
			const { exempt_tools: _, ...legacyConfigBase } = baseConfig;
			const legacyConfig = legacyConfigBase as SummaryConfig;

			hook = createToolSummarizerHook(legacyConfig, tempDir);

			const originalOutput = 'x'.repeat(2000);
			const output = { output: originalOutput };
			const input = { tool: 'retrieve_summary' };

			await hook(input, output);

			// Verify output was NOT modified (fallback default should apply)
			expect(output.output).toBe(originalOutput);
			expect(output.output).toBe('x'.repeat(2000));
		});
	});

	describe('Output modification verification', () => {
		it('verify output.output is unchanged for exempt tools (retrieve_summary)', async () => {
			const config = defaultConfig();
			hook = createToolSummarizerHook(config, tempDir);

			const originalOutput = 'x'.repeat(2000);
			const output = { output: originalOutput };
			const input = { tool: 'retrieve_summary' };

			await hook(input, output);

			// Strict equality check - must be exactly the same object reference
			expect(output.output).toBe(originalOutput);
		});

		it('verify output.output is unchanged for exempt tools (task)', async () => {
			const config = defaultConfig();
			hook = createToolSummarizerHook(config, tempDir);

			const originalOutput = 'x'.repeat(2000);
			const output = { output: originalOutput };
			const input = { tool: 'task' };

			await hook(input, output);

			// Strict equality check
			expect(output.output).toBe(originalOutput);
		});

		it('verify output.output is unchanged for custom exempt tool', async () => {
			const config = defaultConfig({
				exempt_tools: ['custom_exempt_tool'],
			});
			hook = createToolSummarizerHook(config, tempDir);

			const originalOutput = 'x'.repeat(2000);
			const output = { output: originalOutput };
			const input = { tool: 'custom_exempt_tool' };

			await hook(input, output);

			// Strict equality check
			expect(output.output).toBe(originalOutput);
		});
	});
});
