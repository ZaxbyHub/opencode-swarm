import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

describe('extractFileSymbols TS/JS family imports and re-exports', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('captures side-effect imports and re-export statements as import facts', async () => {
		const facts = await extractFileSymbols(
			'typescript',
			[
				`import './setup';`,
				`export { Foo as Bar, default as DefaultThing } from './barrel-source';`,
				`export * from './everything';`,
				`export * as ns from './namespace';`,
			].join('\n'),
		);

		expect(facts).not.toBeNull();
		expect(facts!.imports).toEqual([
			{
				specifier: './setup',
				importType: 'sideeffect',
				bindings: [],
			},
			{
				specifier: './barrel-source',
				importType: 'named',
				bindings: [
					{ imported: 'Foo', local: 'Bar' },
					{ imported: 'default', local: 'DefaultThing' },
				],
				reExport: true,
				startLine: 2,
				endLine: 2,
				exportedBindings: [
					{ imported: 'Foo', exported: 'Bar' },
					{ imported: 'default', exported: 'DefaultThing' },
				],
			},
			{
				specifier: './everything',
				importType: 'namespace',
				bindings: [],
				reExport: true,
				startLine: 3,
				endLine: 3,
			},
			{
				specifier: './namespace',
				importType: 'namespace',
				bindings: [{ imported: '*', local: 'ns' }],
				reExport: true,
				startLine: 4,
				endLine: 4,
				exportedBindings: [{ imported: '*', exported: 'ns' }],
			},
		]);
	});

	test('preserves type-only imports as non-runtime bindings', async () => {
		const facts = await extractFileSymbols(
			'typescript',
			`import type { Shape } from './types';
import { type OnlyType, run as execute } from './runtime';
export function call() { execute(); }`,
		);

		expect(facts).not.toBeNull();
		expect(facts!.imports).toEqual([
			{ specifier: './types', importType: 'named', bindings: [] },
			{
				specifier: './runtime',
				importType: 'named',
				bindings: [{ imported: 'run', local: 'execute' }],
			},
		]);
	});

	test('extracts TSX component-style functions with JSX references', async () => {
		const facts = await extractFileSymbols(
			'tsx',
			`import { Button as UIButton } from './button';
export function Panel() {
	return <UIButton />;
}`,
		);

		expect(facts).not.toBeNull();
		expect(facts!.defs.find((d) => d.name === 'Panel')).toMatchObject({
			kind: 'function',
			exported: true,
			startLine: 2,
			endLine: 4,
		});
		expect(facts!.imports).toEqual([
			{
				specifier: './button',
				importType: 'named',
				bindings: [{ imported: 'Button', local: 'UIButton' }],
			},
		]);
		expect(facts!.refs.some((r) => r.identifier === 'UIButton')).toBe(true);
	});

	test('captures JavaScript identifiers that contain dollar signs', async () => {
		const facts = await extractFileSymbols(
			'javascript',
			`import $default, { $api as api$ } from './runtime';
 export function call$() {
 	return api$($default);
 }`,
		);

		expect(facts).not.toBeNull();
		expect(facts!.imports).toEqual([
			{
				specifier: './runtime',
				importType: 'named',
				bindings: [
					{ imported: 'default', local: '$default' },
					{ imported: '$api', local: 'api$' },
				],
			},
		]);
		expect(facts!.defs.find((d) => d.name === 'call$')).toMatchObject({
			kind: 'function',
			exported: true,
		});
	});

	test('CRLF line endings produce correct startLine/endLine (issue #1526)', async () => {
		const crlfSource = [
			`export { foo } from './bar';`,
			`export { baz } from './qux';`,
		].join('\r\n');

		const lfSource = crlfSource.replace(/\r\n/g, '\n');

		const crlfFacts = await extractFileSymbols('typescript', crlfSource);
		const lfFacts = await extractFileSymbols('typescript', lfSource);

		expect(crlfFacts).not.toBeNull();
		expect(lfFacts).not.toBeNull();

		// tree-sitter normalizes CRLF, so line ranges should match LF source
		expect(crlfFacts!.imports).toEqual(lfFacts!.imports);
		expect(crlfFacts!.defs).toEqual(lfFacts!.defs);
		expect(crlfFacts!.refs).toEqual(lfFacts!.refs);
	});
});
