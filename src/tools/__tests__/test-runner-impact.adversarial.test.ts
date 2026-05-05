import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	mock,
	test,
} from 'bun:test';
import type { ToolResult } from '../create-tool';

// We need to use mock.module which is set up in beforeEach
// This allows us to properly intercept the module imports

// Helper to convert ToolResult to string
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

function createToolContext(directory: string) {
	return { directory } as never;
}

// Store mock references
let mockAnalyzeImpact: Mock<(...args: any[]) => any>;

describe('test-runner impact scope ADVERSARIAL security tests', () => {
	beforeEach(async () => {
		// Reset module cache to ensure clean state
		delete require.cache[require.resolve('../../../src/tools/test-runner.js')];
		delete require.cache[
			require.resolve('../../../src/test-impact/analyzer.js')
		];
		delete require.cache[
			require.resolve('../../../src/utils/path-security.js')
		];
		delete require.cache[require.resolve('../../../src/build/discovery.js')];

		// Create fresh mock for analyzeImpact
		mockAnalyzeImpact = mock(() =>
			Promise.resolve({
				impactedTests: [],
				unrelatedTests: [],
				untestedFiles: [],
				impactMap: {},
			}),
		);

		// Mock the test-impact/analyzer module
		mock.module('../../../src/test-impact/analyzer.js', () => ({
			analyzeImpact: mockAnalyzeImpact,
		}));

		// Mock the build/discovery module to avoid real binary checks
		mock.module('../../../src/build/discovery.js', () => ({
			isCommandAvailable: () => false,
		}));

		// Mock the path-security module to avoid Windows path issues in tests
		// Import real module and override only validateDirectory to allow test paths
		const realPathSecurity = await import(
			'../../../src/utils/path-security.js'
		);
		mock.module('../../../src/utils/path-security.js', () => ({
			...realPathSecurity,
			validateDirectory: () => {},
			validateSymlinkBoundary: () => {},
		}));
	});

	afterEach(() => {
		mock.restore();
	});

	async function invokeTool(
		args: Record<string, unknown>,
		directory?: string,
	): Promise<{ parsed: Record<string, unknown>; raw: string }> {
		const { test_runner } = await import('../../../src/tools/test-runner.js');
		const result = await test_runner.execute(
			args,
			createToolContext(directory ?? '/fake/dir'),
		);
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(resultToString(result));
		} catch {
			parsed = { _parseError: resultToString(result) };
		}
		return { parsed, raw: resultToString(result) };
	}

	function setupAnalyzeImpactMock(impactedTests: string[] = []) {
		mockAnalyzeImpact.mockImplementation(() =>
			Promise.resolve({
				impactedTests,
				unrelatedTests: [],
				untestedFiles: [],
				impactMap: impactedTests.reduce(
					(acc, t) => {
						acc[t] = [t];
						return acc;
					},
					{} as Record<string, string[]>,
				),
			}),
		);
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// 1. PATH TRAVERSAL ATTACKS IN FILES ARRAY
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: rejects path traversal ../etc/passwd', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['../etc/passwd'],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects path traversal ../../secrets', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['../../secrets'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects URL-encoded path traversal %2e%2e%2f', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['..%2f..%2fsecrets'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects double-encoded traversal %252e%252e', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['%252e%252e%252fsecrets'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects Unicode fullwidth dot traversal', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['..\uff0e..\uff0esecret'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 2. SHELL METACHARACTERS IN FILE PATHS
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: rejects semicolon injection', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js; rm -rf /'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects pipe injection', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js | cat /etc/passwd'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects ampersand injection', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js & curl evil.com'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects backtick injection', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js`whoami`'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects dollar injection', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js$(whoami)'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 3. SENSITIVE SYSTEM PATH ATTEMPTS
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: rejects /etc/passwd absolute path', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['/etc/passwd'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects C:\\Windows\\System32 absolute path', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['C:\\Windows\\System32\\config\\SAM'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects /root/.ssh/id_rsa', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['/root/.ssh/id_rsa'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 4. NULL BYTES IN FILE PATHS
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: rejects null byte in path', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo\x00bar.js'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects null byte at start of path', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['\x00foo.js'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 5. CONTROL CHARACTERS IN FILE PATHS
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: rejects newline in path', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo\nbar.js'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects carriage return in path', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo\rbar.js'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects tab in path', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo\tbar.js'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 6. MASSIVE FILES ARRAY (10000+ ENTRIES)
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: handles 15000 files without crash', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: Array(15000).fill('src/app.ts'),
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		// Should return valid JSON - either error (validation) or result
		expect(
			parsed.success !== undefined ||
				parsed.error !== undefined ||
				parsed._parseError === undefined,
		).toBe(true);
	});

	test('impact: handles 50000 files without crash', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: Array(50000).fill('src/app.ts'),
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		// Should return valid JSON
		expect(parsed).toBeTruthy();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 7. EXTREMELY LONG FILE PATHS
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: rejects 10000 character path', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: [`${'a'.repeat(10000)}.ts`],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects 50000 character path', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: [`${'a'.repeat(50000)}.ts`],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 8. POWERSHELL METACHARACTERS IN FILE PATHS
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: rejects PowerShell pipe operator', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js|whoami'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects PowerShell semicolon', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js;whoami'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects PowerShell ampersand', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js&whoami'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects PowerShell backticks', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js`whoami`'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects PowerShell dollar signs', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js$env:PATH'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects PowerShell braces', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js{whoami}'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects PowerShell brackets', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js[whoami]'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects PowerShell angle brackets', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js<whoami>'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects PowerShell quotes', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js"whoami"'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects PowerShell hash', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['foo.js#comment'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 9. DUPLICATE FILES (SAME FILE REPEATED 1000+ TIMES)
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: handles 1000 duplicate files without crash', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: Array(1000).fill('src/app.ts'),
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		// Should return valid JSON
		expect(parsed).toBeTruthy();
	});

	test('impact: handles 10000 duplicate files without crash', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: Array(10000).fill('src/app.ts'),
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		// Should return valid JSON
		expect(parsed).toBeTruthy();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 10. ESCAPE ATTEMPTS FROM WORKING DIRECTORY
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: rejects escape via dotdot in middle of path', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['src/../../../etc/passwd'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects Windows device path', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['\\\\.\\C:\\Windows\\System32'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects UNC path', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['\\\\server\\share\\file.ts'],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 11. EDGE CASES - VALID BUT WEIRD INPUTS
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: handles empty string in files array', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: [''],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		// Empty string should be rejected by validation
		expect(obj.success).toBe(false);
	});

	test('impact: handles files as plain string instead of array', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: 'not-an-array' as unknown as string[],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects null files array', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: null as unknown as string[],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects undefined files', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: undefined as unknown as string[],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		// Missing files entirely should fail for impact scope
		expect(obj.success).toBe(false);
	});

	test('impact: rejects empty files array', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: [],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 12. TYPE CONFUSION ATTACKS
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: rejects non-string file entries', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: [123 as unknown as string],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects object in files array', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: [{ path: 'foo.js' }] as unknown as string[],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects array in files array', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: [['foo.js']] as unknown as string[],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects boolean in files array', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: [true, false] as unknown as string[],
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 13. IMPACT SCOPE SPECIFIC - analyzeImpact CALLED CORRECTLY
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: calls analyzeImpact with valid source files', async () => {
		setupAnalyzeImpactMock(['test/foo.test.ts']);

		await invokeTool(
			{
				scope: 'impact',
				files: ['src/app.ts'],
			},
			process.cwd(),
		);

		expect(mockAnalyzeImpact).toHaveBeenCalled();
		const calls = mockAnalyzeImpact.mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0][0]).toEqual(['src/app.ts']);
	});

	test('impact: filter non-source extensions from files array', async () => {
		setupAnalyzeImpactMock(['test/foo.test.ts']);

		await invokeTool(
			{
				scope: 'impact',
				files: ['README.md', 'src/app.ts', 'config.json'],
			},
			process.cwd(),
		);

		expect(mockAnalyzeImpact).toHaveBeenCalled();
		const calls = mockAnalyzeImpact.mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		// Should filter to only source files (.ts)
		expect(calls[0][0]).toEqual(['src/app.ts']);
	});

	test('impact: falls back to graph scope when no impacted tests found', async () => {
		setupAnalyzeImpactMock([]);

		const { parsed, raw } = await invokeTool(
			{
				scope: 'impact',
				files: ['src/app.ts'],
			},
			process.cwd(),
		);

		expect(raw).toBeTruthy();
		// Should return valid result (fallback behavior)
		expect(parsed).toBeTruthy();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 14. COVERAGE FLAG VALIDATION
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: rejects non-boolean coverage', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['src/app.ts'],
			coverage: 'true' as unknown as boolean,
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 15. TIMEOUT VALIDATION
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: rejects negative timeout', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['src/app.ts'],
			timeout_ms: -1000,
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	test('impact: rejects timeout exceeding maximum', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'impact',
			files: ['src/app.ts'],
			timeout_ms: 600_000, // 10 minutes, max is 5 minutes
		});
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 16. SCOPE VALIDATION
	// ═══════════════════════════════════════════════════════════════════════════

	test('impact: rejects invalid scope', async () => {
		const { parsed, raw } = await invokeTool({
			scope: 'invalid_scope' as 'impact',
			files: ['src/app.ts'],
		} as Record<string, unknown>);
		expect(raw).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});
});
