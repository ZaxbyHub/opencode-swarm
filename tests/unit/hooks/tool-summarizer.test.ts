import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { handleRetrieveCommand } from '../../../src/commands/retrieve';
import type { SummaryConfig } from '../../../src/config/schema';
import { createToolSummarizerHook } from '../../../src/hooks/tool-summarizer';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function defaultConfig(overrides?: Partial<SummaryConfig>): SummaryConfig {
	return {
		enabled: true,
		threshold_bytes: 102400,
		max_summary_chars: 1000,
		max_stored_bytes: 10485760,
		retention_days: 7,
		...overrides,
	};
}

describe('tool-summarizer', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('tool-summarizer-');
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('disabled config returns no-op that passes output through unchanged', async () => {
		const config = defaultConfig({ enabled: false });
		const hook = createToolSummarizerHook(config, tempDir);

		const largeOutput = 'x'.repeat(30000); // Large output - size irrelevant when disabled
		const input = { tool: 'Read', sessionID: 'test-session', callID: 'call-1' };
		const output = {
			title: 'Read Result',
			output: largeOutput,
			metadata: null,
		};

		await hook(input, output);

		// Output should be unchanged when summaries are disabled
		expect(output.output).toBe(largeOutput);
	});

	it('output below threshold passes through unchanged', async () => {
		const config = defaultConfig({ enabled: true, threshold_bytes: 102400 });
		const hook = createToolSummarizerHook(config, tempDir);

		const smallOutput = 'Hello world';
		const input = { tool: 'Read', sessionID: 'test-session', callID: 'call-1' };
		const output = {
			title: 'Read Result',
			output: smallOutput,
			metadata: null,
		};

		await hook(input, output);

		// Output should be unchanged (below threshold * 1.25 = 128000 bytes)
		expect(output.output).toBe(smallOutput);
	});

	it('large output is replaced with summary and stored on disk', async () => {
		const config = defaultConfig({
			enabled: true,
			threshold_bytes: 1024,
			max_summary_chars: 1000,
			max_stored_bytes: 10485760,
		});
		const hook = createToolSummarizerHook(config, tempDir);

		const largeOutput = 'x'.repeat(2000); // 2000 bytes > 1024 * 1.25 = 1280
		const input = { tool: 'Read', sessionID: 'test-session', callID: 'call-1' };
		const output = {
			title: 'Read Result',
			output: largeOutput,
			metadata: null,
		};

		await hook(input, output);

		// Output should be changed to a summary
		expect(output.output).not.toBe(largeOutput);
		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).toContain('→ Use /swarm retrieve S1');

		// Verify file exists on disk
		const summaryFile = join(tempDir, '.swarm', 'summaries', 'S1.json');
		expect(existsSync(summaryFile)).toBe(true);
	});

	it('summary IDs increment per session (S1, S2, S3...)', async () => {
		const config = defaultConfig({
			enabled: true,
			threshold_bytes: 1024,
		});
		const hook = createToolSummarizerHook(config, tempDir);

		// First call
		const output1 = {
			title: 'Result 1',
			output: 'a'.repeat(2000),
			metadata: null,
		};
		await hook(
			{ tool: 'Read', sessionID: 'test-session', callID: 'call-1' },
			output1,
		);
		expect(output1.output).toContain('[SUMMARY S1]');

		// Second call
		const output2 = {
			title: 'Result 2',
			output: 'b'.repeat(2000),
			metadata: null,
		};
		await hook(
			{ tool: 'Read', sessionID: 'test-session', callID: 'call-2' },
			output2,
		);
		expect(output2.output).toContain('[SUMMARY S2]');

		// Third call
		const output3 = {
			title: 'Result 3',
			output: 'c'.repeat(2000),
			metadata: null,
		};
		await hook(
			{ tool: 'Read', sessionID: 'test-session', callID: 'call-3' },
			output3,
		);
		expect(output3.output).toContain('[SUMMARY S3]');
	});

	it('storage error causes fail-open: output passes through unchanged', async () => {
		const config = defaultConfig({
			enabled: true,
			threshold_bytes: 1024,
			max_stored_bytes: 10, // Tiny max - will cause storeSummary to throw
		});
		const hook = createToolSummarizerHook(config, tempDir);

		const largeOutput = 'x'.repeat(2000); // 2000 bytes > max_stored_bytes of 10
		const input = { tool: 'Read', sessionID: 'test-session', callID: 'call-1' };
		const output = {
			title: 'Read Result',
			output: largeOutput,
			metadata: null,
		};

		await hook(input, output);

		// Output should be unchanged due to fail-open behavior
		expect(output.output).toBe(largeOutput);
	});

	it('factory returns a function', () => {
		const configEnabled = defaultConfig({ enabled: true });
		const resultEnabled = createToolSummarizerHook(configEnabled, tempDir);
		expect(typeof resultEnabled).toBe('function');

		const configDisabled = defaultConfig({ enabled: false });
		const resultDisabled = createToolSummarizerHook(configDisabled, tempDir);
		expect(typeof resultDisabled).toBe('function');
	});
});

describe('tool-summarizer integration', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('tool-summarizer-integration-');
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('end-to-end: large output → hook summarizes → retrieve returns original', async () => {
		const config = defaultConfig({
			enabled: true,
			threshold_bytes: 1024,
			max_summary_chars: 1000,
			max_stored_bytes: 10485760,
		});
		const hook = createToolSummarizerHook(config, tempDir);

		// Generate large output that will exceed threshold
		const originalOutput =
			'Line ' + 'x'.repeat(2000) + '\nAnother line of content';
		const input = { tool: 'Read', sessionID: 'test-session', callID: 'call-1' };
		const output = {
			title: 'Read Result',
			output: originalOutput,
			metadata: null,
		};

		// Step 1: Hook summarizes the output
		await hook(input, output);

		// Verify output was replaced with summary
		expect(output.output).not.toBe(originalOutput);
		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).toContain('→ Use /swarm retrieve S1');

		// Step 2: Retrieve command returns the original output
		const retrieved = await handleRetrieveCommand(tempDir, ['S1']);
		expect(retrieved).toBe(originalOutput);
	});
});
