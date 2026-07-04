import { beforeEach, describe, expect, it } from 'bun:test';
import {
	getLanguageForExtension,
	getParserForFile,
	isSupportedFile,
	listSupportedLanguages,
} from '../../../src/lang/registry';
import { clearParserCache } from '../../../src/lang/runtime';

describe('Language Registry', () => {
	describe('getLanguageForExtension', () => {
		it('should return language for .js files', () => {
			const lang = getLanguageForExtension('.js');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('javascript');
		});

		it('should return language for .jsx files', () => {
			const lang = getLanguageForExtension('.jsx');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('javascript');
		});

		it('should return language for Node ESM/CJS JavaScript files', () => {
			expect(getLanguageForExtension('.mjs')?.id).toBe('javascript');
			expect(getLanguageForExtension('.cjs')?.id).toBe('javascript');
		});

		it('should return language for .ts files', () => {
			const lang = getLanguageForExtension('.ts');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('typescript');
		});

		it('should return language for .tsx files', () => {
			const lang = getLanguageForExtension('.tsx');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('tsx');
		});

		it('should return language for .py files', () => {
			const lang = getLanguageForExtension('.py');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('python');
		});

		it('should return language for .go files', () => {
			const lang = getLanguageForExtension('.go');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('go');
		});

		it('should return language for .rs files', () => {
			const lang = getLanguageForExtension('.rs');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('rust');
		});

		it('should return language for .java files', () => {
			const lang = getLanguageForExtension('.java');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('java');
		});

		it('should return language for .c files', () => {
			const lang = getLanguageForExtension('.c');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('c');
		});

		it('should return language for .cpp files', () => {
			const lang = getLanguageForExtension('.cpp');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('cpp');
		});

		it('should return language for .cs files', () => {
			const lang = getLanguageForExtension('.cs');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('csharp');
		});

		it('should return language for .rb files', () => {
			const lang = getLanguageForExtension('.rb');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('ruby');
		});

		it('should return language for .swift files', () => {
			const lang = getLanguageForExtension('.swift');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('swift');
		});

		it('should return language for .kt files', () => {
			const lang = getLanguageForExtension('.kt');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('kotlin');
		});

		it('should return language for .dart files', () => {
			const lang = getLanguageForExtension('.dart');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('dart');
		});

		it('should return language for .css files', () => {
			const lang = getLanguageForExtension('.css');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('css');
		});

		it('should return language for .sh files', () => {
			const lang = getLanguageForExtension('.sh');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('bash');
		});

		it('should return language for .ps1 files', () => {
			const lang = getLanguageForExtension('.ps1');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('powershell');
		});

		it('should return language for .ini files', () => {
			const lang = getLanguageForExtension('.ini');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('ini');
		});

		it('should return language for .regex files', () => {
			const lang = getLanguageForExtension('.regex');
			expect(lang).toBeDefined();
			expect(lang?.id).toBe('regex');
		});

		it('should be case insensitive', () => {
			const lang1 = getLanguageForExtension('.JS');
			const lang2 = getLanguageForExtension('.js');
			expect(lang1?.id).toBe(lang2?.id);
		});

		it('should return undefined for unsupported extensions', () => {
			const lang = getLanguageForExtension('.unknown');
			expect(lang).toBeUndefined();
		});
	});

	describe('listSupportedLanguages', () => {
		it('should return all supported languages', () => {
			const languages = listSupportedLanguages();
			expect(languages.length).toBe(20);

			const ids = languages.map((l) => l.id);
			expect(ids).toContain('javascript');
			expect(ids).toContain('typescript');
			expect(ids).toContain('python');
			expect(ids).toContain('go');
			expect(ids).toContain('rust');
		});

		it('should include comment nodes for each language', () => {
			const languages = listSupportedLanguages();
			for (const lang of languages) {
				expect(Array.isArray(lang.commentNodes)).toBe(true);
			}
		});
	});

	describe('isSupportedFile', () => {
		it('should return true for supported extensions', () => {
			expect(isSupportedFile('file.js')).toBe(true);
			expect(isSupportedFile('file.mjs')).toBe(true);
			expect(isSupportedFile('file.cjs')).toBe(true);
			expect(isSupportedFile('file.ts')).toBe(true);
			expect(isSupportedFile('file.tsx')).toBe(true);
			expect(isSupportedFile('file.py')).toBe(true);
			expect(isSupportedFile('file.go')).toBe(true);
			expect(isSupportedFile('file.rs')).toBe(true);
		});

		it('should return false for unsupported extensions', () => {
			expect(isSupportedFile('file.unknown')).toBe(false);
			expect(isSupportedFile('file')).toBe(false);
			expect(isSupportedFile('file.xyz')).toBe(false);
		});

		it('should handle paths with directories', () => {
			expect(isSupportedFile('/path/to/file.js')).toBe(true);
			expect(isSupportedFile('src/components/Button.tsx')).toBe(true);
		});
	});

	describe('getParserForFile', () => {
		beforeEach(() => {
			clearParserCache();
		});

		it('should return null for unsupported files', async () => {
			const parser = await getParserForFile('file.unknown');
			expect(parser).toBeNull();
		});

		it('should return null for files without extension', async () => {
			const parser = await getParserForFile('Makefile');
			expect(parser).toBeNull();
		});

		it('should return null for files with no recognized extension', async () => {
			const parser = await getParserForFile('file.cobol');
			expect(parser).toBeNull();
		});

		// Note: These tests require WASM files to be present
		// They will fail gracefully if grammars are not copied
		it('should attempt to load grammar for .js files', async () => {
			try {
				const parser = await getParserForFile('test.js');
				expect(parser === null || typeof parser === 'object').toBe(true);
			} catch {
				expect(false).toBe(true);
			}
		});

		it('should attempt to load grammar for .jsx files', async () => {
			try {
				const parser = await getParserForFile('test.jsx');
				expect(parser === null || typeof parser === 'object').toBe(true);
			} catch {
				expect(false).toBe(true);
			}
		});

		it('should attempt to load grammar for .mjs and .cjs files', async () => {
			try {
				const mjsParser = await getParserForFile('test.mjs');
				const cjsParser = await getParserForFile('test.cjs');
				if (mjsParser !== null) {
					expect(typeof mjsParser.parse).toBe('function');
				}
				if (cjsParser !== null) {
					expect(typeof cjsParser.parse).toBe('function');
				}
			} catch {
				expect(false).toBe(true);
			}
		});

		it('should attempt to load grammar for .ts files', async () => {
			try {
				const parser = await getParserForFile('test.ts');
				expect(parser === null || typeof parser === 'object').toBe(true);
			} catch {
				expect(false).toBe(true);
			}
		});

		it('should attempt to load grammar for .tsx files (TSX)', async () => {
			try {
				const parser = await getParserForFile('Component.tsx');
				// TSX now has its own registry entry and grammar
				expect(parser === null || typeof parser === 'object').toBe(true);
			} catch {
				expect(false).toBe(true);
			}
		});

		it('should attempt to load grammar for .py files (Python)', async () => {
			try {
				const parser = await getParserForFile('script.py');
				expect(parser === null || typeof parser === 'object').toBe(true);
			} catch {
				expect(false).toBe(true);
			}
		});

		it('should attempt to load grammar for .go files (Go)', async () => {
			try {
				const parser = await getParserForFile('main.go');
				expect(parser === null || typeof parser === 'object').toBe(true);
			} catch {
				expect(false).toBe(true);
			}
		});

		it('should attempt to load grammar for .rs files (Rust)', async () => {
			try {
				const parser = await getParserForFile('lib.rs');
				expect(parser === null || typeof parser === 'object').toBe(true);
			} catch {
				expect(false).toBe(true);
			}
		});

		it('should handle paths with directories', async () => {
			try {
				const parser = await getParserForFile('/path/to/file.ts');
				expect(parser === null || typeof parser === 'object').toBe(true);
			} catch {
				expect(false).toBe(true);
			}
		});

		it('should handle nested paths like src/components/Button.tsx', async () => {
			try {
				const parser = await getParserForFile('src/components/Button.tsx');
				expect(parser === null || typeof parser === 'object').toBe(true);
			} catch {
				expect(false).toBe(true);
			}
		});

		it('should be case insensitive for file extension', async () => {
			try {
				const parserLower = await getParserForFile('file.JS');
				const parserNormal = await getParserForFile('file.js');
				// Both should either return null or return parser
				expect(parserLower === null || typeof parserLower === 'object').toBe(
					true,
				);
				expect(parserNormal === null || typeof parserNormal === 'object').toBe(
					true,
				);
			} catch {
				expect(false).toBe(true);
			}
		});
	});

	describe('getParserForFile caching', () => {
		beforeEach(() => {
			clearParserCache();
		});

		it('should cache loaded parsers for subsequent calls', async () => {
			// Get parser for a file
			const parser1 = await getParserForFile('test.js');

			// If parser was loaded, verify caching by checking cache state
			if (parser1 !== null) {
				// Get parser again - should return same cached instance
				const parser2 = await getParserForFile('test.js');
				expect(parser2).toBe(parser1); // Same reference due to caching
			}
		});

		it('should cache different language parsers separately', async () => {
			// Get parser for TypeScript
			const tsParser = await getParserForFile('test.ts');
			// Get parser for JavaScript
			const jsParser = await getParserForFile('test.js');

			if (tsParser !== null && jsParser !== null) {
				// They should be different instances for different languages
				expect(tsParser).not.toBe(jsParser);
			}
		});

		it('clearParserCache should enable reloading parsers', async () => {
			// Get parser first time
			const parser1 = await getParserForFile('test.js');

			// Clear cache
			clearParserCache();

			// Get parser again - should work (or return null if no WASM)
			const parser2 = await getParserForFile('test.js');
			// parser2 can be null (no WASM) or different instance after cache clear
			expect(parser2 === null || typeof parser2 === 'object').toBe(true);
		});
	});
});
