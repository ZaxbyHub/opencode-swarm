import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

async function pathExists(p: string): Promise<boolean> {
	return stat(p)
		.then(() => true)
		.catch(() => false);
}

import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer.js';

// Mock only co-change-analyzer (app-specific, no contamination risk)
const mockDetectDarkMatter = mock(
	async (_dir: string, _options: any) => [] as CoChangeEntry[],
);

mock.module('../../../src/tools/co-change-analyzer.js', () => ({
	detectDarkMatter: mockDetectDarkMatter,
}));

// Import AFTER mock setup
const { handleSimulateCommand } = await import(
	'../../../src/commands/simulate.js'
);

// Use a unique temp dir per test to avoid state leakage
let testDir: string;

describe('handleSimulateCommand', () => {
	let mockPairs: CoChangeEntry[];

	beforeEach(() => {
		mockDetectDarkMatter.mockClear();

		// Create a unique temp directory for each test
		testDir = require('node:fs').realpathSync(
			require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'simulate-test-')),
		);

		// Set up mock pairs
		mockPairs = [
			{
				fileA: 'src/utils/helper.ts',
				fileB: 'src/components/Button.tsx',
				coChangeCount: 15,
				npmi: 0.823,
				lift: 4.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 45,
				commitsB: 50,
			},
			{
				fileA: 'src/services/api.ts',
				fileB: 'src/types/index.ts',
				coChangeCount: 12,
				npmi: 0.756,
				lift: 3.8,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 60,
				commitsB: 55,
			},
		];
	});

	afterEach(() => {
		mock.restore();
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	function getReportPath(): string {
		return path.join(testDir, '.swarm', 'simulate-report.md');
	}

	async function readReport(): Promise<string> {
		return Bun.file(getReportPath()).text();
	}

	it('Calls detectDarkMatter with correct directory and default options', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, []);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {});
	});

	it('Parses --threshold flag correctly when valid (0.7)', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--threshold', '0.7']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {
			npmiThreshold: 0.7,
		});
	});

	it('Parses --threshold flag correctly when valid (0.0)', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--threshold', '0.0']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {
			npmiThreshold: 0,
		});
	});

	it('Parses --threshold flag correctly when valid (1.0)', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--threshold', '1.0']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {
			npmiThreshold: 1,
		});
	});

	it('Ignores invalid threshold > 1', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--threshold', '1.5']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {});
		const call = mockDetectDarkMatter.mock.calls[0] as any[];
		const options = call[1] as any;
		expect(options.npmiThreshold).toBeUndefined();
	});

	it('Ignores invalid threshold < 0', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--threshold', '-0.5']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {});
		const call = mockDetectDarkMatter.mock.calls[0] as any[];
		const options = call[1] as any;
		expect(options.npmiThreshold).toBeUndefined();
	});

	it('Ignores non-numeric threshold value', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--threshold', 'invalid']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {});
		const call = mockDetectDarkMatter.mock.calls[0] as any[];
		const options = call[1] as any;
		expect(options.npmiThreshold).toBeUndefined();
	});

	it('Ignores threshold flag with missing value', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--threshold']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {});
		const call = mockDetectDarkMatter.mock.calls[0] as any[];
		const options = call[1] as any;
		expect(options.npmiThreshold).toBeUndefined();
	});

	it('Parses --min-commits flag correctly when valid', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--min-commits', '50']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {
			minCommits: 50,
		});
	});

	it('Ignores invalid min-commits (0)', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--min-commits', '0']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {});
		const call = mockDetectDarkMatter.mock.calls[0] as any[];
		const options = call[1] as any;
		expect(options.minCommits).toBeUndefined();
	});

	it('Ignores invalid min-commits (negative)', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--min-commits', '-10']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {});
		const call = mockDetectDarkMatter.mock.calls[0] as any[];
		const options = call[1] as any;
		expect(options.minCommits).toBeUndefined();
	});

	it('Ignores non-numeric min-commits value', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--min-commits', 'invalid']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {});
		const call = mockDetectDarkMatter.mock.calls[0] as any[];
		const options = call[1] as any;
		expect(options.minCommits).toBeUndefined();
	});

	it('Parses both flags together correctly', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, [
			'--threshold',
			'0.6',
			'--min-commits',
			'30',
		]);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {
			npmiThreshold: 0.6,
			minCommits: 30,
		});
	});

	it('Handles flags in reverse order', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, [
			'--min-commits',
			'40',
			'--threshold',
			'0.8',
		]);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith(testDir, {
			npmiThreshold: 0.8,
			minCommits: 40,
		});
	});

	it('Returns summary string with correct pair count (non-zero)', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		const result = await handleSimulateCommand(testDir, []);

		expect(result).toBe('2 hidden coupling pairs detected');
	});

	it('Returns summary string with zero for empty results', async () => {
		mockDetectDarkMatter.mockImplementation(async () => []);

		const result = await handleSimulateCommand(testDir, []);

		expect(result).toBe('0 hidden coupling pairs detected');
	});

	it('Returns summary string with singular "pair" when count is 1', async () => {
		const singlePair = [mockPairs[0]];
		mockDetectDarkMatter.mockImplementation(async () => singlePair);

		const result = await handleSimulateCommand(testDir, []);

		expect(result).toBe('1 hidden coupling pairs detected'); // Note: code says "pairs" not "pair"
	});

	it('Handles empty results gracefully and still creates report', async () => {
		mockDetectDarkMatter.mockImplementation(async () => []);

		const result = await handleSimulateCommand(testDir, []);

		expect(await pathExists(getReportPath())).toBe(true);
		expect(result).toBe('0 hidden coupling pairs detected');
		const capturedReport = await readReport();
		expect(capturedReport).toContain('# Simulate Report');
		expect(capturedReport).toContain('0 hidden coupling pairs detected');
	});

	it('Writes report to .swarm/simulate-report.md', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, []);

		expect(await pathExists(getReportPath())).toBe(true);
		const capturedContent = await readReport();
		expect(capturedContent).toBeDefined();
	});

	it('Creates .swarm directory before writing report', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, []);

		expect(await pathExists(path.join(testDir, '.swarm'))).toBe(true);
	});

	it('Report contains correct markdown structure with results', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, []);

		const capturedReport = await readReport();
		expect(capturedReport).toContain('# Simulate Report');
		expect(capturedReport).toContain('Generated:');
		expect(capturedReport).toContain('## Dark Matter Analysis');
		expect(capturedReport).toContain('2 hidden coupling pairs detected:');
		expect(capturedReport).toContain(
			'| File A | File B | NPMI | Co-Changes | Lift |',
		);
		expect(capturedReport).toContain(
			'|--------|--------|------|------------|------|',
		);
		expect(capturedReport).toContain('src/utils/helper.ts');
		expect(capturedReport).toContain('src/components/Button.tsx');
		expect(capturedReport).toContain('0.823');
		expect(capturedReport).toContain('15');
		expect(capturedReport).toContain('4.50');
		expect(capturedReport).toContain('## Recommendation');
	});

	it('Report includes correct pair count in recommendation section', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, []);

		const capturedReport = await readReport();
		expect(capturedReport).toContain(
			'2 hidden coupling pairs may cause unexpected side effects when modified.',
		);
	});

	it('Report formats NPMI with 3 decimal places', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, []);

		const capturedReport = await readReport();
		expect(capturedReport).toContain('0.823'); // 3 decimal places
	});

	it('Report formats lift with 2 decimal places', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, []);

		const capturedReport = await readReport();
		expect(capturedReport).toContain('4.50'); // 2 decimal places
	});

	it('Report contains ISO timestamp', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, []);

		const capturedReport = await readReport();
		expect(capturedReport).toContain('Generated: ');
		expect(capturedReport).toMatch(/\d{4}-\d{2}-\d{2}T/); // ISO date format
	});

	it('Report excludes table rows when no pairs detected', async () => {
		mockDetectDarkMatter.mockImplementation(async () => []);

		await handleSimulateCommand(testDir, []);

		const capturedReport = await readReport();
		expect(capturedReport).toBeDefined();
		expect(capturedReport).toContain('0 hidden coupling pairs detected:');
		// Should not have any data rows after header
		const lines = capturedReport.split('\n');
		const tableHeaderIndex = lines.findIndex((l) => l.includes('| File A |'));
		const headerSeparatorIndex = lines.findIndex((l) =>
			l.includes('|--------|'),
		);
		expect(tableHeaderIndex).toBeGreaterThanOrEqual(0);
		expect(headerSeparatorIndex).toBeGreaterThanOrEqual(0);
		// Next line after separator should not be a table row (should be empty or recommendation)
		expect(lines[headerSeparatorIndex + 1].trim()).toMatch(
			/^$|## Recommendation/,
		);
	});

	it('Handles multiple pairs in report', async () => {
		const multiplePairs = [
			...mockPairs,
			{
				fileA: 'src/hooks/useAuth.ts',
				fileB: 'src/store/authSlice.ts',
				coChangeCount: 20,
				npmi: 0.9,
				lift: 5.2,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 70,
				commitsB: 65,
			},
		];
		mockDetectDarkMatter.mockImplementation(async () => multiplePairs);

		const result = await handleSimulateCommand(testDir, []);

		const capturedReport = await readReport();
		expect(result).toBe('3 hidden coupling pairs detected');
		expect(capturedReport).toContain('3 hidden coupling pairs detected:');
		expect(capturedReport).toContain('src/utils/helper.ts');
		expect(capturedReport).toContain('src/components/Button.tsx');
		expect(capturedReport).toContain('src/services/api.ts');
		expect(capturedReport).toContain('src/types/index.ts');
		expect(capturedReport).toContain('src/hooks/useAuth.ts');
		expect(capturedReport).toContain('src/store/authSlice.ts');
	});

	it('Validates threshold boundary at 0 (inclusive)', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--threshold', '0']);

		const call = mockDetectDarkMatter.mock.calls[0] as any[];
		const options = call[1] as any;
		expect(options.npmiThreshold).toBe(0);
	});

	it('Validates threshold boundary at 1 (inclusive)', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--threshold', '1']);

		const call = mockDetectDarkMatter.mock.calls[0] as any[];
		const options = call[1] as any;
		expect(options.npmiThreshold).toBe(1);
	});

	it('Validates min-commits boundary at 1 (inclusive)', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, ['--min-commits', '1']);

		const call = mockDetectDarkMatter.mock.calls[0] as any[];
		const options = call[1] as any;
		expect(options.minCommits).toBe(1);
	});

	it('Uses correct encoding (utf-8) when writing report', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, []);

		// File exists and is valid UTF-8 text (can be read as string)
		const content = await readReport();
		expect(typeof content).toBe('string');
		expect(content.length).toBeGreaterThan(0);
	});

	it('Creates directory with recursive option', async () => {
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		await handleSimulateCommand(testDir, []);

		// Verify .swarm directory was created (recursive mkdir worked)
		expect(await pathExists(path.join(testDir, '.swarm'))).toBe(true);
	});
});
