import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { loadFullOutput } from '../../../src/summaries/manager';
import { retrieve_summary } from '../../../src/tools/retrieve-summary';

// Mock loadFullOutput
mock.module('../../../src/summaries/manager', () => ({
	loadFullOutput: mock(),
	sanitizeSummaryId: (id: string) => {
		if (!/^S\d+$/.test(id)) {
			throw new Error('Invalid ID');
		}
		return id;
	},
}));

const mockLoadFullOutput = loadFullOutput as ReturnType<typeof mock>;

// Helper to create mock context
function getMockContext(dir: string): ToolContext {
	return {
		sessionID: 'test-session',
		messageID: 'test-message',
		agent: 'test-agent',
		directory: dir,
		worktree: dir,
		abort: new AbortController().signal,
		metadata: () => ({}),
		ask: async () => undefined,
	};
}

describe('retrieve_summary pagination', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'retrieve-summary-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		mockLoadFullOutput.mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
		mock.restore();
	});

	test('returns first 100 lines with continuation header for large output', async () => {
		// Create output with 250 lines
		const largeOutput = Array.from(
			{ length: 250 },
			(_, i) => `Line ${i + 1}`,
		).join('\n');
		mockLoadFullOutput.mockResolvedValue(largeOutput);

		const result = await retrieve_summary.execute(
			{ id: 'S1' },
			getMockContext(tempDir),
		);

		// Should have continuation header
		expect(result).toContain('--- Lines 1-100 of 250 ---');
		// Should have continuation hint
		expect(result).toContain(
			'... 150 more lines. Use offset=100 to retrieve more.',
		);
		// Should NOT have continuation when we've reached the end
		expect(result).not.toContain('--- Lines 101-250');
	});

	test('returns from offset when specified', async () => {
		const output = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join(
			'\n',
		);
		mockLoadFullOutput.mockResolvedValue(output);

		const result = await retrieve_summary.execute(
			{ id: 'S1', offset: 100, limit: 50 },
			getMockContext(tempDir),
		);

		// Should start from line 101 (offset 100 + 1 for 1-indexed display)
		expect(result).toContain('--- Lines 101-150 of 300 ---');
		// Should have continuation hint (still more lines)
		expect(result).toContain(
			'... 150 more lines. Use offset=150 to retrieve more.',
		);
		// Should contain the correct lines
		expect(result).toContain('Line 101');
		expect(result).toContain('Line 150');
	});

	test('respects custom limit', async () => {
		const output = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join(
			'\n',
		);
		mockLoadFullOutput.mockResolvedValue(output);

		const result = await retrieve_summary.execute(
			{ id: 'S1', limit: 50 },
			getMockContext(tempDir),
		);

		// Should return only 50 lines
		expect(result).toContain('--- Lines 1-50 of 100 ---');
		// Should have continuation hint
		expect(result).toContain(
			'... 50 more lines. Use offset=50 to retrieve more.',
		);
	});

	test('clamps limit to max 500', async () => {
		const output = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}`).join(
			'\n',
		);
		mockLoadFullOutput.mockResolvedValue(output);

		// Request 1000 but should be clamped to 500
		const result = await retrieve_summary.execute(
			{ id: 'S1', limit: 1000 },
			getMockContext(tempDir),
		);

		// Should return only 500 lines (clamped)
		expect(result).toContain('--- Lines 1-500 of 1000 ---');
		// Should have continuation hint
		expect(result).toContain(
			'... 500 more lines. Use offset=500 to retrieve more.',
		);
	});

	test('returns all lines with no continuation for small output', async () => {
		// Create output with only 50 lines (less than default 100)
		const smallOutput = Array.from(
			{ length: 50 },
			(_, i) => `Line ${i + 1}`,
		).join('\n');
		mockLoadFullOutput.mockResolvedValue(smallOutput);

		const result = await retrieve_summary.execute(
			{ id: 'S1' },
			getMockContext(tempDir),
		);

		// Should show all lines
		expect(result).toContain('--- Lines 1-50 of 50 ---');
		// Should NOT have continuation hint
		expect(result).not.toContain('more lines');
		expect(result).not.toContain('offset=');
	});

	test('offset beyond total lines returns empty chunk', async () => {
		const output = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join(
			'\n',
		);
		mockLoadFullOutput.mockResolvedValue(output);

		// Request offset beyond total lines
		const result = await retrieve_summary.execute(
			{ id: 'S1', offset: 500 },
			getMockContext(tempDir),
		);

		// Should show exhausted-range response
		expect(result).toContain('--- Offset beyond range ---');
		// Should NOT have continuation hint
		expect(result).not.toContain('more lines');
	});

	test('default offset is 0', async () => {
		const output = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join(
			'\n',
		);
		mockLoadFullOutput.mockResolvedValue(output);

		// Don't specify offset - should default to 0
		const result = await retrieve_summary.execute(
			{ id: 'S1' },
			getMockContext(tempDir),
		);

		expect(result).toContain('--- Lines 1-50 of 50 ---');
	});

	test('default limit is 100', async () => {
		// Create output with exactly 100 lines
		const output = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join(
			'\n',
		);
		mockLoadFullOutput.mockResolvedValue(output);

		// Don't specify limit - should default to 100
		const result = await retrieve_summary.execute(
			{ id: 'S1' },
			getMockContext(tempDir),
		);

		// At exactly 100, there's no continuation (endLine === totalLines)
		expect(result).toContain('--- Lines 1-100 of 100 ---');
		expect(result).not.toContain('more lines');
	});
});
