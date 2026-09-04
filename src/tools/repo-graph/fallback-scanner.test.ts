import { describe, expect, it, mock } from 'bun:test';
import {
	type FallbackScannerDependencies,
	runFallbackScan,
} from './fallback-scanner';

const filePath = 'C:\\repo\\src\\main.ts';
const absoluteRoot = 'C:\\repo';

function dependencies(
	overrides: Partial<FallbackScannerDependencies> = {},
): FallbackScannerDependencies {
	return {
		statFile: () => ({ size: 20, mtime: new Date(1234), mtimeMs: 1234 }),
		readFile: () => "import { dep } from './dep';\nexport const main = dep();",
		isBinaryContent: () => false,
		extractExports: () => ({ exports: ['main'], exportLines: { main: 2 } }),
		parseImports: () => [
			{
				specifier: './dep',
				importType: 'named',
				importedSymbols: ['dep'],
				bindings: [{ imported: 'dep', local: 'dep' }],
				reExport: false,
			},
		],
		stripComments: (content) => content,
		toModuleName: () => 'src/main.ts',
		getLanguage: () => 'typescript',
		extractOntology: () => ({ role: 'source', confidence: 0.9, signals: [] }),
		resolveSpecifier: () => 'C:\\repo\\src\\dep.ts',
		usedSymbolsForImport: () => ['dep'],
		isScannableSourcePath: () => true,
		...overrides,
	};
}

describe('runFallbackScan', () => {
	it('enforces the size bound before reading or parsing', () => {
		const readFile = mock(() => '');
		const parseImports = mock(() => []);
		const result = runFallbackScan({
			filePath,
			absoluteRoot,
			maxFileSize: 10,
			dependencies: dependencies({
				statFile: () => ({ size: 11, mtime: new Date(1234), mtimeMs: 1234 }),
				readFile,
				parseImports,
			}),
		});

		expect(result).toEqual({
			status: 'skipped',
			reason: 'oversized',
			moduleName: 'src/main.ts',
			sizeBytes: 11,
			mtimeMs: 1234,
		});
		expect(readFile).not.toHaveBeenCalled();
		expect(parseImports).not.toHaveBeenCalled();
	});

	it('classifies unreadable and binary inputs without invoking parsers', () => {
		const parseImports = mock(() => []);
		const unreadable = runFallbackScan({
			filePath,
			absoluteRoot,
			maxFileSize: 100,
			dependencies: dependencies({
				readFile: () => {
					throw new Error('denied');
				},
				parseImports,
			}),
		});
		const binary = runFallbackScan({
			filePath,
			absoluteRoot,
			maxFileSize: 100,
			dependencies: dependencies({
				isBinaryContent: () => true,
				parseImports,
			}),
		});

		expect(unreadable).toMatchObject({
			status: 'skipped',
			reason: 'unreadable',
		});
		expect(binary).toMatchObject({
			status: 'skipped',
			reason: 'binary',
			sizeBytes: 20,
			mtimeMs: 1234,
		});
		expect(parseImports).not.toHaveBeenCalled();
	});

	it('builds a deterministic node and sorted dependency edges', () => {
		const result = runFallbackScan({
			filePath,
			absoluteRoot,
			maxFileSize: 100,
			hasManifest: () => true,
			dependencies: dependencies({
				parseImports: () => [
					{
						specifier: './z',
						importType: 'default',
						importedSymbols: ['default'],
						bindings: [],
						reExport: false,
					},
					{
						specifier: './a',
						importType: 'named',
						importedSymbols: ['a'],
						bindings: [],
						reExport: false,
					},
				],
				resolveSpecifier: (_root, _file, specifier) =>
					`C:\\repo\\src\\${specifier.slice(2)}.ts`,
			}),
		});

		expect(result.status).toBe('scanned');
		if (result.status !== 'scanned') throw new Error('expected scanned result');
		expect(result.node).toMatchObject({
			filePath,
			moduleName: 'src/main.ts',
			exports: ['main'],
			imports: ['./z', './a'],
			language: 'typescript',
			sizeBytes: 20,
			mtimeMs: 1234,
		});
		expect(result.edges.map((edge) => edge.importSpecifier)).toEqual([
			'./a',
			'./z',
		]);
	});

	it('fails open when extraction or parsing rejects malformed content', () => {
		const result = runFallbackScan({
			filePath,
			absoluteRoot,
			maxFileSize: 100,
			dependencies: dependencies({
				parseImports: () => {
					throw new Error('malformed');
				},
			}),
		});

		expect(result).toEqual({
			status: 'skipped',
			reason: 'malformed',
			moduleName: 'src/main.ts',
			language: 'unknown',
			sizeBytes: 20,
			mtimeMs: 1234,
		});
	});

	it('fails open across module naming, ontology, and resolution boundaries', () => {
		const cases: Partial<FallbackScannerDependencies>[] = [
			{
				toModuleName: () => {
					throw new Error('bad module path');
				},
			},
			{
				extractOntology: () => {
					throw new Error('bad ontology');
				},
			},
			{
				resolveSpecifier: () => {
					throw new Error('bad resolution');
				},
			},
		];

		for (const overrides of cases) {
			expect(
				runFallbackScan({
					filePath,
					absoluteRoot,
					maxFileSize: 100,
					dependencies: dependencies(overrides),
				}),
			).toMatchObject({ status: 'skipped', reason: 'malformed' });
		}
	});
});
