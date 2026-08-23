import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

function bySpec(
	imports: NonNullable<
		Awaited<ReturnType<typeof extractFileSymbols>>
	>['imports'],
	specifier: string,
) {
	return imports.find((i) => i.specifier === specifier);
}

describe('extractFileSymbols JVM/.NET import forms', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('java: named, wildcard, static named, static wildcard, and multiple imports', async () => {
		const facts = await extractFileSymbols(
			'java',
			[
				'import java.util.List;',
				'import java.util.*;',
				'import static java.lang.Math.max;',
				'import static java.util.Collections.*;',
				'public class Main {}',
			].join('\n'),
		);

		expect(facts).not.toBeNull();
		expect(facts!.imports).toHaveLength(4);

		expect(bySpec(facts!.imports, 'java.util.List')).toEqual({
			specifier: 'java.util.List',
			importType: 'named',
			bindings: [{ imported: 'List', local: 'List' }],
		});

		expect(bySpec(facts!.imports, 'java.util.*')).toEqual({
			specifier: 'java.util.*',
			importType: 'namespace',
			bindings: [],
		});

		expect(bySpec(facts!.imports, 'java.lang.Math')).toEqual({
			specifier: 'java.lang.Math',
			importType: 'named',
			bindings: [{ imported: 'max', local: 'max' }],
		});

		const staticWildcard = bySpec(facts!.imports, 'java.util.Collections.*');
		expect(staticWildcard).toBeDefined();
		expect(staticWildcard!.importType).toBe('namespace');
	});

	test('java: never-referenced import does not leak into refs', async () => {
		const facts = await extractFileSymbols(
			'java',
			'import com.example.Repo;\npublic class Main { public void run() { int x = 1; } }',
		);

		expect(facts).not.toBeNull();
		const refIdentifiers = facts!.refs.map((r) => r.identifier);
		expect(refIdentifiers).toContain('x');
		expect(refIdentifiers).not.toContain('Repo');
	});

	test('java: trailing whitespace/comment and commented-out import', async () => {
		const facts = await extractFileSymbols(
			'java',
			[
				'import java.util.List;   // list import',
				'// import com.example.X;',
				'public class Main {}',
			].join('\n'),
		);

		expect(facts).not.toBeNull();
		expect(facts!.imports).toHaveLength(1);
		expect(bySpec(facts!.imports, 'java.util.List')).toBeDefined();
		expect(bySpec(facts!.imports, 'com.example.X')).toBeUndefined();
	});

	test('kotlin: plain named import, aliased import (final segment), and wildcard', async () => {
		const facts = await extractFileSymbols(
			'kotlin',
			[
				'import kotlin.collections.List',
				'import kotlin.text.Regex as Rx',
				'import kotlin.math.*',
			].join('\n'),
		);

		expect(facts).not.toBeNull();
		expect(facts!.imports).toHaveLength(3);

		expect(bySpec(facts!.imports, 'kotlin.collections.List')).toEqual({
			specifier: 'kotlin.collections.List',
			importType: 'named',
			bindings: [{ imported: 'List', local: 'List' }],
		});

		expect(bySpec(facts!.imports, 'kotlin.text.Regex')).toEqual({
			specifier: 'kotlin.text.Regex',
			importType: 'named',
			bindings: [{ imported: 'Regex', local: 'Rx' }],
		});

		expect(bySpec(facts!.imports, 'kotlin.math.*')).toEqual({
			specifier: 'kotlin.math.*',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('kotlin: never-referenced aliased import does not leak into refs', async () => {
		const facts = await extractFileSymbols(
			'kotlin',
			'import kotlin.text.Regex as Rx\nfun run() { val x = 1 }',
		);

		expect(facts).not.toBeNull();
		const refIdentifiers = facts!.refs.map((r) => r.identifier);
		expect(refIdentifiers).not.toContain('Rx');
	});

	test('csharp: namespace usings (plain, nested, static, global) and named aliases', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			[
				'using System;',
				'using System.Collections.Generic;',
				'using static System.Math;',
				'using Alias = System.Text.StringBuilder;',
				'using S = System;',
				'global using System.Linq;',
				'class Program {}',
			].join('\n'),
		);

		expect(facts).not.toBeNull();
		expect(facts!.imports).toHaveLength(6);

		expect(bySpec(facts!.imports, 'System')).toEqual({
			specifier: 'System',
			importType: 'namespace',
			bindings: [],
		});

		expect(bySpec(facts!.imports, 'System.Collections.Generic')).toEqual({
			specifier: 'System.Collections.Generic',
			importType: 'namespace',
			bindings: [],
		});

		const staticUsing = bySpec(facts!.imports, 'System.Math');
		expect(staticUsing).toBeDefined();
		expect(staticUsing!.importType).toBe('namespace');

		expect(bySpec(facts!.imports, 'System.Text.StringBuilder')).toEqual({
			specifier: 'System.Text.StringBuilder',
			importType: 'named',
			bindings: [{ imported: 'StringBuilder', local: 'Alias' }],
		});

		const singleSegmentAlias = facts!.imports.filter(
			(i) => i.specifier === 'System' && i.importType === 'named',
		);
		expect(singleSegmentAlias).toEqual([
			{
				specifier: 'System',
				importType: 'named',
				bindings: [{ imported: 'System', local: 'S' }],
			},
		]);

		expect(bySpec(facts!.imports, 'System.Linq')).toEqual({
			specifier: 'System.Linq',
			importType: 'namespace',
			bindings: [],
		});
	});

	test('csharp: never-referenced import does not leak into refs', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			'using System;\nusing System.Text;\nclass Program { void Run() { int x = 1; } }',
		);

		expect(facts).not.toBeNull();
		const refIdentifiers = facts!.refs.map((r) => r.identifier);
		expect(refIdentifiers).toContain('x');
		expect(refIdentifiers).not.toContain('System');
		expect(refIdentifiers).not.toContain('Text');
	});

	test('csharp: using-declaration and using-statement are not import directives', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			[
				'using System.IO;',
				'class Program {',
				'  void Run(string p) {',
				'    using var stream = File.OpenRead(p);',
				'    using (var t = Open()) { }',
				'  }',
				'}',
			].join('\n'),
		);

		expect(facts).not.toBeNull();
		expect(facts!.imports).toHaveLength(1);
		expect(bySpec(facts!.imports, 'System.IO')).toBeDefined();
		expect(bySpec(facts!.imports, 'var')).toBeUndefined();
	});
});
