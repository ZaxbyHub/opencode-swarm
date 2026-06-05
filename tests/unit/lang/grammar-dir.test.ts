import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { resolveGrammarsDir } from '../../../src/lang/runtime.js';

describe('resolveGrammarsDir — getGrammarsDirAbsolute path logic (#642)', () => {
	describe('dev source context (src/lang)', () => {
		test('resolves grammars inside src/lang', () => {
			const thisDir = '/project/src/lang';
			const result = resolveGrammarsDir(thisDir);
			expect(result).toBe(path.join('/project/src/lang', 'grammars'));
		});

		test('resolves directly into src/lang without traversing up', () => {
			const thisDir = '/project/src/lang';
			const result = resolveGrammarsDir(thisDir);
			// Should be src/lang/grammars (not src/lang/../lang/grammars)
			expect(result).not.toContain('..');
		});
	});

	describe('CLI bundle context (dist/cli)', () => {
		test('resolves grammars one level up from cli directory', () => {
			const thisDir = '/project/dist/cli';
			const result = resolveGrammarsDir(thisDir);
			expect(result).toBe(
				path.join('/project/dist/cli', '..', 'lang', 'grammars'),
			);
		});

		test('does not resolve to cli/lang/grammars (regression guard)', () => {
			const thisDir = '/project/dist/cli';
			const result = resolveGrammarsDir(thisDir);
			expect(result).not.toContain('cli/lang');
			expect(result).not.toContain('cli\\lang');
		});
	});

	describe('main bundle context (dist)', () => {
		test('resolves grammars under dist/lang/grammars', () => {
			const thisDir = '/project/dist';
			const result = resolveGrammarsDir(thisDir);
			expect(result).toBe(path.join('/project/dist', 'lang', 'grammars'));
		});
	});

	describe('Windows paths', () => {
		test('Windows-style path: dev source context', () => {
			const thisDir = 'C:\\project\\src\\lang';
			const result = resolveGrammarsDir(thisDir);
			expect(result).toBe(path.join('C:\\project\\src\\lang', 'grammars'));
		});

		test('Windows-style path: CLI bundle context', () => {
			const thisDir = 'C:\\project\\dist\\cli';
			const result = resolveGrammarsDir(thisDir);
			expect(result).toBe(
				path.join('C:\\project\\dist\\cli', '..', 'lang', 'grammars'),
			);
		});

		test('Windows-style path: main bundle context', () => {
			const thisDir = 'C:\\project\\dist';
			const result = resolveGrammarsDir(thisDir);
			expect(result).toBe(
				path.join('C:\\project\\dist', 'lang', 'grammars'),
			);
		});
	});

	describe('edge cases', () => {
		test('path ending with unrelated segment falls through to main-bundle logic', () => {
			const thisDir = '/some/custom/dir';
			const result = resolveGrammarsDir(thisDir);
			expect(result).toBe(path.join('/some/custom/dir', 'lang', 'grammars'));
		});

		test('CLI bundle and src/lang contexts both resolve one level up from their thisDir', () => {
			const cliResult = resolveGrammarsDir('/some/path/cli');
			const srcResult = resolveGrammarsDir('/some/path/src/lang');
			// CLI goes up one level; src/lang uses its own grammars subdirectory
			expect(cliResult).toBe(
				path.join('/some/path/cli', '..', 'lang', 'grammars'),
			);
			expect(srcResult).toBe(
				path.join('/some/path/src/lang', 'grammars'),
			);
		});
	});
});
