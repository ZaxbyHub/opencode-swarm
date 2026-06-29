import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Helper function to create a test file with mock.module content
async function createTestFile(
	testDir: string,
	filename: string,
	content: string,
): Promise<string> {
	const filePath = join(testDir, filename);
	await Bun.write(filePath, content);
	return filePath;
}

// Minimal implementation of the script's Check 2 logic for isolated testing
// The script's full logic (Check 1 + Check 2) is tested via integration,
// but the spread pattern check (Check 2) is unit-tested here for isolation.
async function checkSpreadViolations(files: string[]): Promise<{
	violations: Array<{ file: string; line: number; module: string }>;
}> {
	const results: Array<{ file: string; line: number; module: string }> = [];

	for (const file of files) {
		const content = await readFile(file, 'utf-8');
		const lines = content.split('\n');

		// Find all mock.module('node:...') calls and extract module name
		const nodeModuleCalls: Array<{ line: number; module: string }> = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// Match mock.module('node:fs', ...) or mock.module("node:fs", ...)
			const match = line.match(/mock\.module\(['"](node:[^'"]+)['"]/);
			if (match) {
				nodeModuleCalls.push({ line: i + 1, module: match[1] });
			}
		}

		// For each node: module, check if there's a corresponding spread
		for (const { line, module } of nodeModuleCalls) {
			// Convert module name to spread variable name
			// e.g., 'node:fs' -> 'realFs', 'node:fs/promises' -> 'realFsPromises'
			// Script logic: first letter capitalized, letters after / or _ also capitalized
			const rawModule = module.split(':')[1]; // e.g. 'fs' or 'child_process' or 'fs/promises'
			const parts = rawModule.split(/[/ _]/);
			const camelParts = parts.map(
				(p) => p.charAt(0).toUpperCase() + p.slice(1),
			);
			const spreadVar = 'real' + camelParts.join('');

			// Check if file has the spread pattern (with word-boundary protection)
			const spreadPattern = new RegExp(`\\.\\.\\.${spreadVar}[^A-Za-z0-9_]`);
			const hasSpread = spreadPattern.test(content);

			if (!hasSpread) {
				results.push({ file, line, module });
			}
		}
	}

	return { violations: results };
}

async function runSpreadCheck(testDir: string): Promise<{
	exitCode: number;
	violations: Array<{ file: string; line: number; module: string }>;
}> {
	// Find all .test.ts files in testDir
	const { readdirSync, statSync } = await import('node:fs');
	const testFiles: string[] = [];

	function findTests(dir: string) {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				findTests(fullPath);
			} else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
				testFiles.push(fullPath);
			}
		}
	}

	findTests(testDir);

	const { violations } = await checkSpreadViolations(testFiles);
	return {
		exitCode: violations.length > 0 ? 1 : 0,
		violations,
	};
}

describe('check-mock-cleanup.sh spread check (Check 2)', () => {
	let testDir: string;

	beforeEach(() => {
		const prefix = join(tmpdir(), 'mock-cleanup-test-');
		const rawDir = mkdtempSync(prefix);
		testDir = realpathSync(rawDir);
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('exits 0 when all files have proper spread', async () => {
		await createTestFile(
			testDir,
			'test1.test.ts',
			`
import { mock } from 'bun:test';

mock.module('node:fs', () => ({ ...realFs, ... }));
mock.module('node:child_process', () => ({ ...realChildProcess, ... }));
mock.module('node:fs/promises', () => ({ ...realFsPromises, ... }));

describe('test', () => {
  it('does something', () => {
    // test code
  });
});
    `,
		);

		const result = await runSpreadCheck(testDir);
		expect(result.exitCode).toBe(0);
		expect(result.violations).toHaveLength(0);
	});

	test('exits 1 when a file lacks spread', async () => {
		await createTestFile(
			testDir,
			'test2.test.ts',
			`
import { mock } from 'bun:test';

mock.module('node:fs', () => ({ ... }));

describe('test', () => {
  it('does something', () => {
    // test code
  });
});
    `,
		);

		const result = await runSpreadCheck(testDir);
		expect(result.exitCode).toBe(1);
		expect(result.violations.length).toBeGreaterThan(0);
		expect(result.violations[0].module).toBe('node:fs');
	});

	test('detects both single and double quotes', async () => {
		await createTestFile(
			testDir,
			'test3.test.ts',
			`
import { mock } from 'bun:test';

mock.module('node:fs', () => ({ ...realFs, ... }));

describe('test', () => {
  it('does something', () => {
    // test code
  });
});
    `,
		);

		await createTestFile(
			testDir,
			'test4.test.ts',
			`
import { mock } from 'bun:test';

mock.module("node:fs", () => ({ ...realFs, ... }));

describe('test', () => {
  it('does something', () => {
    // test code
  });
});
    `,
		);

		const result = await runSpreadCheck(testDir);
		expect(result.exitCode).toBe(0);
		expect(result.violations).toHaveLength(0);
	});

	test('correctly handles node:fs', async () => {
		await createTestFile(
			testDir,
			'test5.test.ts',
			`
import { mock } from 'bun:test';

mock.module('node:fs', () => ({ ...realFs, ... }));

describe('test', () => {
  it('does something', () => {
    // test code
  });
});
    `,
		);

		const result = await runSpreadCheck(testDir);
		expect(result.exitCode).toBe(0);
		expect(result.violations).toHaveLength(0);
	});

	test('correctly handles node:child_process', async () => {
		await createTestFile(
			testDir,
			'test6.test.ts',
			`
import { mock } from 'bun:test';

mock.module('node:child_process', () => ({ ...realChildProcess, ... }));

describe('test', () => {
  it('does something', () => {
    // test code
  });
});
    `,
		);

		const result = await runSpreadCheck(testDir);
		expect(result.exitCode).toBe(0);
		expect(result.violations).toHaveLength(0);
	});

	test('correctly handles node:fs/promises', async () => {
		await createTestFile(
			testDir,
			'test7.test.ts',
			`
import { mock } from 'bun:test';

mock.module('node:fs/promises', () => ({ ...realFsPromises, ... }));

describe('test', () => {
  it('does something', () => {
    // test code
  });
});
    `,
		);

		const result = await runSpreadCheck(testDir);
		expect(result.exitCode).toBe(0);
		expect(result.violations).toHaveLength(0);
	});

	test('correctly handles files without mock.module calls', async () => {
		await createTestFile(
			testDir,
			'test8.test.ts',
			`
describe('test', () => {
  it('does something', () => {
    // test code without mock.module
  });
});
    `,
		);

		const result = await runSpreadCheck(testDir);
		expect(result.exitCode).toBe(0);
		expect(result.violations).toHaveLength(0);
	});
});
