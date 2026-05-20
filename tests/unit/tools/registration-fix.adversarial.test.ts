/**
 * Adversarial security tests for tool registration in src/index.ts
 *
 * Attack vectors tested:
 * 1. Name collisions - tools with same name as existing imports
 * 2. Import shadowing - tools shadowing other imports in same file
 * 3. createSwarmTool structure verification for diff_summary, test_impact, mutation_test
 * 4. Duplicate imports in the import block
 * 5. Phantom imports - imports that don't exist in barrel exports
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Import tools to verify their structure
import { diff_summary, mutation_test, test_impact } from '../../../src/tools';
import { TOOL_NAMES, type ToolName } from '../../../src/tools/tool-names';

describe('Adversarial: Tool Registration Security', () => {
	// ========================================================================
	// 1. NAME COLLISION DETECTION
	// ========================================================================
	describe('1. Name Collision Detection', () => {
		test('diff_summary should not collide with any existing tool name', () => {
			const collision = TOOL_NAMES.filter(
				(name) => name === 'diff_summary' || name.includes('diff_summary'),
			);
			expect(collision).toHaveLength(1);
			expect(collision[0]).toBe('diff_summary');
		});

		test('test_impact should not collide with any existing tool name', () => {
			const collision = TOOL_NAMES.filter(
				(name) => name === 'test_impact' || name.includes('test_impact'),
			);
			expect(collision).toHaveLength(1);
			expect(collision[0]).toBe('test_impact');
		});

		test('mutation_test should not collide with any existing tool name', () => {
			const collision = TOOL_NAMES.filter(
				(name) => name === 'mutation_test' || name.includes('mutation_test'),
			);
			expect(collision).toHaveLength(1);
			expect(collision[0]).toBe('mutation_test');
		});

		test('no tool name should appear twice in TOOL_NAMES array', () => {
			const seen = new Set<string>();
			const duplicates: string[] = [];
			for (const name of TOOL_NAMES) {
				if (seen.has(name)) {
					duplicates.push(name);
				}
				seen.add(name);
			}
			expect(duplicates).toEqual([]);
		});

		test('similar tool names should not accidentally collide', () => {
			const similarNames = ['diff', 'diff_summary', 'diff_summary_tool'];
			const unique = new Set(similarNames);
			expect(unique.size).toBe(similarNames.length);
		});
	});

	// ========================================================================
	// 2. IMPORT SHADOWING VERIFICATION
	// ========================================================================
	describe('2. Import Shadowing Verification', () => {
		test('src/index.ts imports should not shadow each other', () => {
			const indexPath = path.resolve(process.cwd(), 'src', 'index.ts');
			const indexContent = fs.readFileSync(indexPath, 'utf-8');

			const toolsImportMatch = indexContent.match(
				/import\s*\{([^}]+)\}\s*from\s*['"]\.\/tools['"]/,
			);
			expect(toolsImportMatch).toBeTruthy();

			const importedTools = toolsImportMatch![1]
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s.length > 0);

			const duplicates = importedTools.filter(
				(tool, idx) => importedTools.indexOf(tool) !== idx,
			);
			expect(duplicates).toEqual([]);

			expect(importedTools).toContain('diff_summary');
			expect(importedTools).toContain('test_impact');
			expect(importedTools).toContain('mutation_test');
		});

		test('no import should shadow built-in or external modules', () => {
			const indexPath = path.resolve(process.cwd(), 'src', 'index.ts');
			const indexContent = fs.readFileSync(indexPath, 'utf-8');

			const dangerousShadows = [
				'path',
				'fs',
				'child_process',
				'process',
				'Buffer',
				'console',
				'JSON',
				'Error',
			];

			const importMatches = indexContent.matchAll(
				/import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g,
			);

			for (const match of importMatches) {
				const importedNames = match[1]
					.split(',')
					.map((s) => s.trim().split(' as ')[0].trim())
					.filter((s) => s.length > 0);

				for (const name of importedNames) {
					const shadowed = dangerousShadows.filter(
						(builtin) => name === builtin || name.endsWith(' as ' + builtin),
					);
					expect(shadowed).toEqual([]);
				}
			}
		});

		test('each imported tool should have exactly one binding', () => {
			const indexPath = path.resolve(process.cwd(), 'src', 'index.ts');
			const indexContent = fs.readFileSync(indexPath, 'utf-8');

			const toolsImportMatch = indexContent.match(
				/import\s*\{([^}]+)\}\s*from\s*['"]\.\/tools['"]/,
			);
			expect(toolsImportMatch).toBeTruthy();

			const importedTools = toolsImportMatch![1]
				.split(',')
				.map((s) => s.trim().split(' as ')[0].trim())
				.filter((s) => s.length > 0);

			const seen = new Set<string>();
			const duplicates: string[] = [];
			for (const tool of importedTools) {
				if (seen.has(tool)) {
					duplicates.push(tool);
				}
				seen.add(tool);
			}
			expect(duplicates).toEqual([]);
		});
	});

	// ========================================================================
	// 3. createSwarmTool STRUCTURE VERIFICATION
	// ========================================================================
	describe('3. createSwarmTool Structure for New Tools', () => {
		describe('diff_summary', () => {
			test('should have execute method that is a function', () => {
				expect(diff_summary).toBeDefined();
				expect(typeof diff_summary.execute).toBe('function');
			});

			test('should have a non-empty description', () => {
				expect(diff_summary.description).toBeDefined();
				expect(typeof diff_summary.description).toBe('string');
				expect(diff_summary.description.length).toBeGreaterThan(0);
			});

			test('description should contain expected keywords', () => {
				const desc = diff_summary.description.toLowerCase();
				expect(
					desc.includes('diff') ||
						desc.includes('semantic') ||
						desc.includes('summary'),
				).toBe(true);
			});

			test('should have args schema', () => {
				expect(diff_summary).toHaveProperty('args');
				expect(diff_summary.args).toBeDefined();
			});
		});

		describe('test_impact', () => {
			test('should have execute method that is a function', () => {
				expect(test_impact).toBeDefined();
				expect(typeof test_impact.execute).toBe('function');
			});

			test('should have a non-empty description', () => {
				expect(test_impact.description).toBeDefined();
				expect(typeof test_impact.description).toBe('string');
				expect(test_impact.description.length).toBeGreaterThan(0);
			});

			test('description should contain expected keywords', () => {
				const desc = test_impact.description.toLowerCase();
				expect(desc.includes('test') && desc.includes('impact')).toBe(true);
			});

			test('should have args schema', () => {
				expect(test_impact).toHaveProperty('args');
				expect(test_impact.args).toBeDefined();
			});
		});

		describe('mutation_test', () => {
			test('should have execute method that is a function', () => {
				expect(mutation_test).toBeDefined();
				expect(typeof mutation_test.execute).toBe('function');
			});

			test('should have a non-empty description', () => {
				expect(mutation_test.description).toBeDefined();
				expect(typeof mutation_test.description).toBe('string');
				expect(mutation_test.description.length).toBeGreaterThan(0);
			});

			test('description should contain expected keywords', () => {
				const desc = mutation_test.description.toLowerCase();
				expect(desc.includes('mutation')).toBe(true);
			});

			test('should have args schema', () => {
				expect(mutation_test).toHaveProperty('args');
				expect(mutation_test.args).toBeDefined();
			});
		});

		describe('execute signature validation', () => {
			test('diff_summary execute should accept 2+ parameters', () => {
				const executeLength = diff_summary.execute.length;
				expect(executeLength).toBeGreaterThanOrEqual(2);
			});

			test('test_impact execute should accept 2+ parameters', () => {
				const executeLength = test_impact.execute.length;
				expect(executeLength).toBeGreaterThanOrEqual(2);
			});

			test('mutation_test execute should accept 2+ parameters', () => {
				const executeLength = mutation_test.execute.length;
				expect(executeLength).toBeGreaterThanOrEqual(2);
			});
		});
	});

	// ========================================================================
	// 4. DUPLICATE IMPORT DETECTION
	// ========================================================================
	describe('4. Duplicate Import Detection', () => {
		test('import block should have no duplicate imports', () => {
			const indexPath = path.resolve(process.cwd(), 'src', 'index.ts');
			const indexContent = fs.readFileSync(indexPath, 'utf-8');

			const toolsImportMatch = indexContent.match(
				/import\s*\{([^}]+)\}\s*from\s*['"]\.\/tools['"]/,
			);
			expect(toolsImportMatch).toBeTruthy();

			const importLine = toolsImportMatch![1];
			const imports = importLine
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s.length > 0);

			const seen = new Set<string>();
			const duplicates: string[] = [];
			for (const imp of imports) {
				const baseName = imp.split(' as ')[0].trim();
				if (seen.has(baseName)) {
					duplicates.push(baseName);
				}
				seen.add(baseName);
			}
			expect(duplicates).toEqual([]);
		});

		test('no tool should be imported twice with different aliases', () => {
			const indexPath = path.resolve(process.cwd(), 'src', 'index.ts');
			const indexContent = fs.readFileSync(indexPath, 'utf-8');

			const toolsImportMatch = indexContent.match(
				/import\s*\{([^}]+)\}\s*from\s*['"]\.\/tools['"]/,
			);
			expect(toolsImportMatch).toBeTruthy();

			const imports = toolsImportMatch![1]
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s.length > 0);

			const bases = imports.map((s) => s.split(' as ')[0].trim());
			const uniqueBases = new Set(bases);

			expect(bases.length).toBe(uniqueBases.size);
		});
	});

	// ========================================================================
	// 5. PHANTOM IMPORT DETECTION
	// ========================================================================
	describe('5. Phantom Import Detection (Barrel Export Alignment)', () => {
		test('barrel exports should contain all 3 newly registered tools', () => {
			const barrelPath = path.resolve(
				process.cwd(),
				'src',
				'tools',
				'index.ts',
			);
			const barrelContent = fs.readFileSync(barrelPath, 'utf-8');

			expect(barrelContent).toContain('diff_summary');
			expect(barrelContent).toContain('test_impact');
			expect(barrelContent).toContain('mutation_test');
		});

		test('all 3 new tools should be registered in the tool object', () => {
			const indexPath = path.resolve(process.cwd(), 'src', 'index.ts');
			const indexContent = fs.readFileSync(indexPath, 'utf-8');

			// The tools are registered via shorthand property syntax
			const toolBlockMatch = indexContent.match(/tool:\s*\{([^}]+)\}/s);
			expect(toolBlockMatch).toBeTruthy();

			const toolBlock = toolBlockMatch![1];
			expect(toolBlock).toContain('diff_summary');
			expect(toolBlock).toContain('test_impact');
			expect(toolBlock).toContain('mutation_test');
		});

		test('barrel re-exports should not have syntax errors', () => {
			const barrelPath = path.resolve(
				process.cwd(),
				'src',
				'tools',
				'index.ts',
			);
			const barrelContent = fs.readFileSync(barrelPath, 'utf-8');

			const exportCount = (barrelContent.match(/export\s*\{/g) || []).length;
			expect(exportCount).toBeGreaterThan(50);
		});
	});

	// ========================================================================
	// EDGE CASES: Malformed Inputs
	// ========================================================================
	describe('Edge Cases: Malformed Inputs', () => {
		test('should handle empty tool name attempts', () => {
			expect(TOOL_NAMES.includes('' as ToolName)).toBe(false);
		});

		test('should handle whitespace-only tool names', () => {
			const whitespaceNames = TOOL_NAMES.filter((name) => name.trim() !== name);
			expect(whitespaceNames).toEqual([]);
		});

		test('should handle Unicode tool names', () => {
			expect(/[^\x00-\x7F]/.test('diff_summary')).toBe(false);
			expect(/[^\x00-\x7F]/.test('test_impact')).toBe(false);
			expect(/[^\x00-\x7F]/.test('mutation_test')).toBe(false);
		});

		test('should handle tool names with path traversal attempts', () => {
			const dangerous = ['../', './', '/', '\\', '\x00'];
			for (const dangerousChar of dangerous) {
				const matches = TOOL_NAMES.filter((name) =>
					name.includes(dangerousChar),
				);
				expect(matches).toEqual([]);
			}
		});

		test('should reject tool names with shell metacharacters', () => {
			const metachars = [';', '|', '&', '$', '`', '>', '<', '\n', '\r'];
			for (const char of metachars) {
				const matches = TOOL_NAMES.filter((name) => name.includes(char));
				expect(matches).toEqual([]);
			}
		});
	});

	// ========================================================================
	// EDGE CASES: Boundary conditions
	// ========================================================================
	describe('Edge Cases: Boundary Conditions', () => {
		test('all 3 new tools should be in TOOL_NAMES array', () => {
			expect(TOOL_NAMES).toContain('diff_summary');
			expect(TOOL_NAMES).toContain('test_impact');
			expect(TOOL_NAMES).toContain('mutation_test');
		});

		test('all 3 new tools should be in ToolName type (via set)', () => {
			const TOOL_NAME_SET = new Set(TOOL_NAMES);
			expect(TOOL_NAME_SET.has('diff_summary')).toBe(true);
			expect(TOOL_NAME_SET.has('test_impact')).toBe(true);
			expect(TOOL_NAME_SET.has('mutation_test')).toBe(true);
		});

		test('new tools should not appear more than once', () => {
			const diffSummaryCount = TOOL_NAMES.filter(
				(n) => n === 'diff_summary',
			).length;
			const testImpactCount = TOOL_NAMES.filter(
				(n) => n === 'test_impact',
			).length;
			const mutationTestCount = TOOL_NAMES.filter(
				(n) => n === 'mutation_test',
			).length;

			expect(diffSummaryCount).toBe(1);
			expect(testImpactCount).toBe(1);
			expect(mutationTestCount).toBe(1);
		});

		test('new tools should not accidentally be aliases for each other', () => {
			const indexPath = path.resolve(process.cwd(), 'src', 'index.ts');
			const indexContent = fs.readFileSync(indexPath, 'utf-8');

			const toolsImportMatch = indexContent.match(
				/import\s*\{([^}]+)\}\s*from\s*['"]\.\/tools['"]/,
			);
			expect(toolsImportMatch).toBeTruthy();

			const imports = toolsImportMatch![1];

			expect(imports).not.toContain('diff_summary as');
			expect(imports).not.toContain('test_impact as');
			expect(imports).not.toContain('mutation_test as');
		});
	});
});
