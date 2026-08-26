import { describe, expect, test } from 'bun:test';
import { _internals } from '../../../src/lang/symbol-graph';
import { _internals as builderInternals } from '../../../src/tools/repo-graph/builder';

const { parseDartImport, parseRubyRequire, parsePhpUse } = _internals;

describe('parseDartImport (direct, via _internals seam — PR #2361 R10)', () => {
	test('bare import is namespace with no bindings', () => {
		expect(parseDartImport("import 'foo.dart';")).toEqual({
			specifier: 'foo.dart',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('empty specifier is rejected', () => {
		expect(parseDartImport("import '';")).toBeNull();
	});

	test('alias import is namespace with no fake named binding', () => {
		expect(parseDartImport("import 'foo.dart' as f;")).toEqual({
			specifier: 'foo.dart',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('show import produces named bindings', () => {
		expect(parseDartImport("import 'foo.dart' show A, B;")).toEqual({
			specifier: 'foo.dart',
			importType: 'named',
			bindings: [
				{ imported: 'A', local: 'A' },
				{ imported: 'B', local: 'B' },
			],
		});
	});

	test('multiline show clause parses whole (statement joined by caller)', () => {
		expect(parseDartImport("import 'x.dart' show Alpha\n    , Beta;")).toEqual({
			specifier: 'x.dart',
			importType: 'named',
			bindings: [
				{ imported: 'Alpha', local: 'Alpha' },
				{ imported: 'Beta', local: 'Beta' },
			],
		});
	});

	test('alias combined with show stays namespace', () => {
		expect(parseDartImport("import 'x.dart' as p show Alpha, Beta;")).toEqual({
			specifier: 'x.dart',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('deferred import is a namespace import of the URI', () => {
		expect(parseDartImport("import 'x.dart' deferred as y;")).toEqual({
			specifier: 'x.dart',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('conditional import records BOTH URIs', () => {
		expect(
			parseDartImport("import 'x.dart' if (dart.library.io) 'io.dart';"),
		).toEqual([
			{ specifier: 'x.dart', importType: 'namespace', bindings: [] },
			{ specifier: 'io.dart', importType: 'namespace', bindings: [] },
		]);
	});

	test('export directive is a re-export edge with exported bindings', () => {
		expect(parseDartImport("export 'api.dart' show PublicApi;")).toEqual({
			specifier: 'api.dart',
			importType: 'named',
			bindings: [{ imported: 'PublicApi', local: 'PublicApi' }],
			reExport: true,
			exportedBindings: [{ imported: 'PublicApi', exported: 'PublicApi' }],
		});
	});

	test('non-import text is rejected', () => {
		expect(parseDartImport('void main() {}')).toBeNull();
		expect(parseDartImport('')).toBeNull();
	});
});

describe('parseRubyRequire (direct)', () => {
	test('require is a namespace import', () => {
		expect(parseRubyRequire("require 'json'")).toEqual({
			specifier: 'json',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('require_relative without a prefix is normalized relative', () => {
		expect(parseRubyRequire("require_relative 'helper'")).toEqual({
			specifier: './helper',
			importType: 'default',
			bindings: [],
		});
	});

	test('require_relative with an explicit ./ prefix is not double-prefixed', () => {
		expect(parseRubyRequire("require_relative './helper'")).toEqual({
			specifier: './helper',
			importType: 'default',
			bindings: [],
		});
	});

	test('require_relative with ../ stays relative', () => {
		expect(parseRubyRequire("require_relative '../lib/helper'")).toEqual({
			specifier: '../lib/helper',
			importType: 'default',
			bindings: [],
		});
	});

	test('bare specifier text (no require keyword) is rejected', () => {
		expect(parseRubyRequire('json')).toBeNull();
	});
});

describe('parsePhpUse (direct)', () => {
	test('aliased use binds the short name', () => {
		expect(parsePhpUse('use App\\Models\\User as U;')).toEqual({
			specifier: 'App\\Models\\User',
			importType: 'named',
			bindings: [{ imported: 'User', local: 'U' }],
		});
	});

	test('non-aliased use is a namespace import with no bindings', () => {
		expect(parsePhpUse('use App\\Models\\User;')).toEqual({
			specifier: 'App\\Models\\User',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('use function / use const prefixes are accepted', () => {
		expect(parsePhpUse('use function App\\helpers;')).toEqual({
			specifier: 'App\\helpers',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('grouped use is skipped entirely (documented limitation)', () => {
		expect(parsePhpUse('use A\\B, C\\D;')).toBeNull();
	});

	test('non-use text is rejected', () => {
		expect(parsePhpUse('$x = 1;')).toBeNull();
	});
});

describe('builder sync-path file import parsers (direct)', () => {
	test('parseDartFileImports captures multiline show and re-exports', () => {
		const parsed = builderInternals.parseDartFileImports(
			"import 'x.dart' show Alpha\n    , Beta;\nexport 'api.dart' show P;\n",
		);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toMatchObject({
			specifier: 'x.dart',
			importType: 'named',
			importedSymbols: ['Alpha', 'Beta'],
		});
		expect(parsed[1]).toMatchObject({
			specifier: 'api.dart',
			reExport: true,
		});
	});

	test('parseRubyFileImports normalizes require_relative', () => {
		const parsed = builderInternals.parseRubyFileImports(
			"require_relative 'helper'\nrequire 'json'\n",
		);
		expect(parsed[0]).toMatchObject({
			specifier: './helper',
			importType: 'default',
		});
		expect(parsed[1]).toMatchObject({
			specifier: 'json',
			importType: 'namespace',
		});
	});

	test('parsePhpFileImports parses aliased and skips grouped use', () => {
		const parsed = builderInternals.parsePhpFileImports(
			'use A\\B as C;\nuse X\\Y, Z\\W;\n',
		);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({
			specifier: 'A\\B',
			importType: 'named',
			importedSymbols: ['B'],
		});
	});
});

describe('regex time budgets for the dynamic-language parsers (PRR-019)', () => {
	test('bounded php modifier star stays fast on adversarial modifier runs', () => {
		const re =
			/\b(?:(public|protected|private|static|final|abstract)\s+){0,6}function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
		const hostile = 'public '.repeat(32_768); // ~230KB
		const t0 = performance.now();
		let count = 0;
		for (const _ of hostile.matchAll(re)) count++;
		const ms = performance.now() - t0;
		// the unbounded star measured ~7s at this size; the bound keeps it
		// comfortably under a second (measured ~5-15ms)
		expect(ms).toBeLessThan(1000);
		expect(count).toBe(0);
	});

	test('extractFileSymbols stays bounded on a hostile php modifier file', async () => {
		const hostile = '<?php\n' + 'public '.repeat(32_768) + '\n';
		const t0 = performance.now();
		const facts = await extractFileSymbolsForTime('php', hostile);
		const ms = performance.now() - t0;
		expect(ms).toBeLessThan(2000);
		expect(facts).toBeDefined();
	}, 10_000);
});

async function extractFileSymbolsForTime(grammarId: string, source: string) {
	const { extractFileSymbols } = await import('../../../src/lang/symbol-graph');
	return extractFileSymbols(grammarId, source);
}
