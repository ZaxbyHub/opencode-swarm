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

// =============================================================================
// Helper types & factories
// =============================================================================

function makeASTDiffResult(
	overrides: Partial<ASTDiffResult> = {},
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
		signature: '()',
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
		totalFiles: 1,
		totalChanges: 1,
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

// =============================================================================
// Test suite
// =============================================================================

// ToolContext shape — only directory matters for diff tool
function makeToolContext(directory: string) {
	return { directory } as unknown as import('@opencode-ai/plugin').ToolContext;
}

describe('diff tool — generateSummaryMarkdown wiring', () => {
	let mockExecFileSync: ReturnType<typeof vi.fn>;
	let mockComputeASTDiff: ReturnType<typeof vi.fn>;
	let mockClassifyChanges: ReturnType<typeof vi.fn>;
	let mockGenerateSummary: ReturnType<typeof vi.fn>;
	let mockGenerateSummaryMarkdown: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		// Clear module cache so each test gets fresh module state
		delete require.cache[require.resolve('../../tools/diff.js')];

		// Create fresh mocks
		mockExecFileSync = vi.fn();
		mockComputeASTDiff = vi.fn();
		mockClassifyChanges = vi.fn();
		mockGenerateSummary = vi.fn();
		mockGenerateSummaryMarkdown = vi.fn();

		vi.mock('node:child_process', () => ({
			execFileSync: mockExecFileSync,
		}));

		vi.mock('../../diff/ast-diff.js', () => ({
			computeASTDiff: mockComputeASTDiff,
		}));

		vi.mock('../../diff/semantic-classifier.js', () => ({
			classifyChanges: mockClassifyChanges,
		}));

		vi.mock('../../diff/summary-generator.js', () => ({
			generateSummary: mockGenerateSummary,
			generateSummaryMarkdown: mockGenerateSummaryMarkdown,
		}));
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	// =============================================================================
	// TEST 1: semanticSummary present + markdownSummary generated → included in result
	// =============================================================================
	test('markdownSummary is included when AST analysis produces semanticSummary', async () => {
		const { diff } = await import('../../tools/diff.js');

		// --- git numstat ---
		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args?.includes('--numstat')) {
				return '10\t5\tsrc/api.ts';
			}
			// git diff -U3
			if (args?.includes('-U3')) {
				return '';
			}
			// git show for old/new content
			if (args?.[0] === 'show') {
				return 'export function oldFunc() {}';
			}
			return '';
		});

		// --- AST diff produces changes ---
		mockComputeASTDiff.mockResolvedValue(
			makeASTDiffResult({
				filePath: 'src/api.ts',
				changes: [
					makeASTChange({
						type: 'modified',
						category: 'function',
						name: 'getUser',
						lineStart: 10,
						lineEnd: 15,
						signature: '(id: number): User',
					}),
				],
			}),
		);

		// --- semantic classification succeeds ---
		mockClassifyChanges.mockReturnValue([
			makeClassifiedChange({
				category: 'SIGNATURE_CHANGE',
				riskLevel: 'Critical',
				filePath: 'src/api.ts',
				symbolName: 'getUser',
				description: "Function signature changed for 'getUser'",
			}),
		]);

		// --- summary generation succeeds ---
		mockGenerateSummary.mockReturnValue(
			makeSemanticDiffSummary({
				totalFiles: 1,
				totalChanges: 1,
				criticalItems: [],
			}),
		);

		// --- markdown generation produces output ---
		mockGenerateSummaryMarkdown.mockReturnValue(
			'## Change Summary (1 files, 1 changes)\n### Critical (review first)\n- src/api.ts: SIGNATURE_CHANGE',
		);

		const result = await diff.execute({}, makeToolContext('/fake/project'));

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.markdownSummary).toBeDefined();
		expect(parsed.markdownSummary).toContain('## Change Summary');
		expect(parsed.markdownSummary).toContain('src/api.ts');
	});

	// =============================================================================
	// TEST 2: AST analysis fails (computeASTDiff throws) → markdownSummary absent
	// =============================================================================
	test('markdownSummary is absent when AST analysis throws', async () => {
		const { diff } = await import('../../tools/diff.js');

		// --- git numstat ---
		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args?.includes('--numstat')) {
				return '10\t5\tsrc/broken.ts';
			}
			if (args?.includes('-U3')) {
				return '';
			}
			if (args?.[0] === 'show') {
				return 'export function oldFunc() {}';
			}
			return '';
		});

		// --- AST diff throws for every file ---
		mockComputeASTDiff.mockRejectedValue(
			new Error('tree-sitter failed to load grammar'),
		);

		// --- semanticSummary is never generated because astDiffs stays empty ---
		// (the catch block in diff.ts creates a fallback entry, but with no semanticSummary)
		// markdownSummary is never set because semanticSummary is falsy

		const result = await diff.execute({}, makeToolContext('/fake/project'));

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.markdownSummary).toBeUndefined();
	});

	// =============================================================================
	// TEST 3: AST analysis returns empty changes (no semanticSummary) → markdownSummary absent
	// =============================================================================
	test('markdownSummary is absent when AST returns zero changes (no semanticSummary)', async () => {
		const { diff } = await import('../../tools/diff.js');

		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args?.includes('--numstat')) {
				return '10\t5\tsrc/unchanged.ts';
			}
			if (args?.includes('-U3')) {
				return '';
			}
			if (args?.[0] === 'show') {
				return 'export function oldFunc() {}';
			}
			return '';
		});

		// --- AST diff returns result but with NO changes ---
		mockComputeASTDiff.mockResolvedValue(
			makeASTDiffResult({
				filePath: 'src/unchanged.ts',
				changes: [], // empty — no actual changes
			}),
		);

		// --- No semanticSummary because there were no changes to classify ---
		// (astDiffs gets a fallback entry because astResult was truthy but changes.length === 0
		// and astResult.error was also falsy — wait, actually the condition is:
		// if (astResult && (astResult.changes.length > 0 || astResult.error))
		// so with empty changes and no error, nothing is pushed to astDiffs
		// → astDiffs.length === 0 → semanticSummary never generated → markdownSummary absent

		const result = await diff.execute({}, makeToolContext('/fake/project'));

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.markdownSummary).toBeUndefined();
	});

	// =============================================================================
	// TEST 4: semanticSummary present but generateSummaryMarkdown throws → markdownSummary absent
	// =============================================================================
	test('markdownSummary is absent when generateSummaryMarkdown throws', async () => {
		const { diff } = await import('../../tools/diff.js');

		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args?.includes('--numstat')) {
				return '10\t5\tsrc/api.ts';
			}
			if (args?.includes('-U3')) {
				return '';
			}
			if (args?.[0] === 'show') {
				return 'export function oldFunc() {}';
			}
			return '';
		});

		mockComputeASTDiff.mockResolvedValue(
			makeASTDiffResult({
				filePath: 'src/api.ts',
				changes: [
					makeASTChange({
						type: 'modified',
						category: 'function',
						name: 'getUser',
						signature: '(id: number): User',
					}),
				],
			}),
		);

		mockClassifyChanges.mockReturnValue([
			makeClassifiedChange({
				category: 'SIGNATURE_CHANGE',
				riskLevel: 'Critical',
				filePath: 'src/api.ts',
				symbolName: 'getUser',
			}),
		]);

		mockGenerateSummary.mockReturnValue(
			makeSemanticDiffSummary({ totalFiles: 1, totalChanges: 1 }),
		);

		// --- markdown generation throws ---
		mockGenerateSummaryMarkdown.mockImplementation(() => {
			throw new Error('Markdown rendering failed');
		});

		const result = await diff.execute({}, makeToolContext('/fake/project'));

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.markdownSummary).toBeUndefined();
		// semanticSummary should still be present because classifyChanges/generateSummary succeeded
		expect(parsed.semanticSummary).toBeDefined();
	});

	// =============================================================================
	// TEST 5: classifyChanges throws → markdownSummary absent (graceful fallback)
	// =============================================================================
	test('markdownSummary is absent when classifyChanges throws', async () => {
		const { diff } = await import('../../tools/diff.js');

		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args?.includes('--numstat')) {
				return '10\t5\tsrc/api.ts';
			}
			if (args?.includes('-U3')) {
				return '';
			}
			if (args?.[0] === 'show') {
				return 'export function oldFunc() {}';
			}
			return '';
		});

		mockComputeASTDiff.mockResolvedValue(
			makeASTDiffResult({
				filePath: 'src/api.ts',
				changes: [makeASTChange({ name: 'getUser' })],
			}),
		);

		// --- classifyChanges throws ---
		mockClassifyChanges.mockImplementation(() => {
			throw new Error('Classification engine error');
		});

		// generateSummary is never called because classifyChanges threw
		// semanticSummary is never set → markdownSummary is never set

		const result = await diff.execute({}, makeToolContext('/fake/project'));

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.markdownSummary).toBeUndefined();
		expect(parsed.semanticSummary).toBeUndefined();
	});
});
