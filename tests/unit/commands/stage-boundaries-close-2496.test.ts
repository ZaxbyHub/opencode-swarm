import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../..',
);

const closeFacade = path.join(repoRoot, 'src', 'commands', 'close.ts');
const requiredStageModules = [
	'src/commands/close/finalize-stage.ts',
	'src/commands/close/archive-stage.ts',
	'src/commands/close/clean-stage.ts',
	'src/commands/close/align-stage.ts',
	'src/commands/close/context.ts',
	'src/commands/close/constants.ts',
	'src/commands/close/internals.ts',
	'src/commands/close/fs-helpers.ts',
	'src/commands/close/db-helpers.ts',
] as const;
const requiredFacadeExports = [
	'./close/finalize-stage.js',
	'./close/archive-stage.js',
	'./close/clean-stage.js',
	'./close/align-stage.js',
	'./close/context.js',
	'./close/constants.js',
	'./close/internals.js',
	'./close/fs-helpers.js',
	'./close/db-helpers.js',
] as const;
const stageOwners = [
	['finalize-stage.ts', 'runFinalizeStage'],
	['archive-stage.ts', 'runArchiveStage'],
	['clean-stage.ts', 'runCleanStage'],
	['align-stage.ts', 'runAlignStage'],
] as const;
const prohibitedCatchAllModules = [
	'core.ts',
	'close-core.ts',
	'implementation.ts',
	'impl.ts',
	'legacy.ts',
] as const;

function readText(filePath: string): string {
	if (!existsSync(filePath)) {
		throw new Error(`missing file: ${path.relative(repoRoot, filePath)}`);
	}
	return readFileSync(filePath, 'utf8');
}

describe('close stage module boundaries — issue #2496', () => {
	it('AC1 extracts each close stage and shared helper concern behind the facade', () => {
		const facade = readText(closeFacade);
		const missing = requiredStageModules.filter(
			(relativePath) => !existsSync(path.join(repoRoot, relativePath)),
		);

		expect(
			missing,
			`missing close stage modules: ${missing.join(', ')}`,
		).toEqual([]);
		for (const exportPath of requiredFacadeExports) {
			expect(facade).toContain(exportPath);
		}
		expect(facade.split(/\r?\n/u).length).toBeLessThan(500);
	});

	it('AC3 prevents stage implementations from being reconsolidated into close.ts', () => {
		const facade = readText(closeFacade);
		const prohibitedDefinitions = [
			'function runFinalizeStage',
			'function runArchiveStage',
			'function runCleanStage',
			'function runAlignStage',
			'function acquireFinalizeLock',
		].filter((needle) => facade.includes(needle));

		expect(
			prohibitedDefinitions,
			`close.ts still contains stage implementations: ${prohibitedDefinitions.join(', ')}`,
		).toEqual([]);
	});

	it('AC3 keeps each stage implementation in its named bounded owner', () => {
		const closeDir = path.join(repoRoot, 'src', 'commands', 'close');

		for (const [fileName, runner] of stageOwners) {
			const source = readText(path.join(closeDir, fileName));
			expect(source).toMatch(
				new RegExp(`export\\s+(?:async\\s+)?function\\s+${runner}\\b`, 'u'),
			);
			expect(source).toContain('./internals.js');
			expect(source).toContain('_internals');
			expect(source.split(/\r?\n/u).length).toBeLessThan(800);
		}

		const hiddenCatchAlls = prohibitedCatchAllModules.filter((fileName) =>
			existsSync(path.join(closeDir, fileName)),
		);
		expect(
			hiddenCatchAlls,
			`generic close implementation modules are prohibited: ${hiddenCatchAlls.join(', ')}`,
		).toEqual([]);
	});

	it('AC2 preserves one shared mutable _internals object', async () => {
		const facade = await import('../../../src/commands/close.js');
		const canonical = await import('../../../src/commands/close/internals.js');

		expect(facade._internals).toBe(canonical._internals);
	});
});
