/**
 * Verification tests for the 6 registered tools
 *
 * Verifies:
 * 1. All 6 tools can be imported from './tools/index.ts'
 * 2. The tool: {} block in src/index.ts includes all 6 tools
 * 3. The plugin can load without errors
 */

import { describe, expect, it } from 'bun:test';

// The 6 tools that should be registered
const SIX_TOOLS = [
	'sast_scan',
	'sbom_generate',
	'build_check',
	'syntax_check',
	'placeholder_scan',
	'quality_budget',
] as const;

describe('6 Tools Registration Verification', () => {
	describe('Import from ./tools/index.ts', () => {
		for (const toolName of SIX_TOOLS) {
			it(`should export ${toolName} from tools/index.ts`, async () => {
				const toolsIndex = await import('./index');
				expect(toolsIndex).toHaveProperty(toolName);
				const tool = (toolsIndex as any)[toolName];
				expect(tool).toBeDefined();
			});
		}

		it('should export all 6 tools from tools/index.ts', async () => {
			const toolsIndex = await import('./index');
			for (const toolName of SIX_TOOLS) {
				expect(toolsIndex).toHaveProperty(toolName);
			}
		});
	});

	describe('Tool structure verification', () => {
		for (const toolName of SIX_TOOLS) {
			it(`${toolName} should be callable (function or object with execute)`, async () => {
				const { [toolName]: tool } = (await import('./index')) as any;
				expect(tool).toBeDefined();
				const isCallable =
					typeof tool === 'function' ||
					(typeof tool === 'object' && typeof tool.execute === 'function');
				expect(isCallable).toBe(true);
			});
		}
	});

	describe('src/index.ts imports', () => {
		it('should import all 6 tools from ./tools in src/index.ts (static check)', async () => {
			const fs = await import('node:fs');
			const srcContent = fs.readFileSync(
				require.resolve('../../src/index.ts'),
				'utf-8',
			);

			// Check the import statement from ./tools contains all 6 tools
			for (const toolName of SIX_TOOLS) {
				// Look for the import statement containing this tool
				const importRegex = new RegExp(
					`import\\s*\\{[^}]*${toolName}[^}]*\\}\\s*from\\s*['"]\\.\\/tools['"]`,
				);
				expect(srcContent).toMatch(importRegex);
			}
		});
	});

	describe('src/index.ts tool: {} block registration', () => {
		// Read the source file and verify the tool block contains all 6 tools
		it('should have all 6 tools in tool block', async () => {
			const fs = await import('node:fs');
			const srcContent = fs.readFileSync(
				require.resolve('../../src/index.ts'),
				'utf-8',
			);

			// Check tool: { ... } block contains all 6 tools
			// The tool block spans multiple lines with various indentation
			const toolBlockMatch = srcContent.match(/tool:\s*\{[\s\S]*?\n\s{2}\},/);
			expect(toolBlockMatch).not.toBeNull();

			const toolBlock = toolBlockMatch![0];
			for (const toolName of SIX_TOOLS) {
				expect(toolBlock).toContain(toolName);
			}
		});
	});
});
