import { beforeEach, describe, expect, test } from 'bun:test';
import { clearParserCache } from '../../../src/lang/runtime';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';

function byName(
	defs: NonNullable<Awaited<ReturnType<typeof extractFileSymbols>>>['defs'],
	name: string,
) {
	return defs.find((d) => d.name === name);
}

describe('extractFileSymbols visibility metadata and exported semantics', () => {
	beforeEach(() => {
		clearParserCache();
	});

	test('covers supported grammar public/private conventions', async () => {
		const cases: Array<{
			grammarId: string;
			source: string;
			publicName: string;
			privateName: string;
		}> = [
			{
				grammarId: 'typescript',
				source: 'export function publicFn() {}\nfunction privateFn() {}',
				publicName: 'publicFn',
				privateName: 'privateFn',
			},
			{
				grammarId: 'javascript',
				source: 'export function publicFn() {}\nfunction privateFn() {}',
				publicName: 'publicFn',
				privateName: 'privateFn',
			},
			{
				grammarId: 'tsx',
				source:
					'export function PublicComponent() { return <div />; }\nfunction PrivateComponent() { return <span />; }',
				publicName: 'PublicComponent',
				privateName: 'PrivateComponent',
			},
			{
				grammarId: 'python',
				source: 'def public_fn():\n    pass\n\ndef _private_fn():\n    pass\n',
				publicName: 'public_fn',
				privateName: '_private_fn',
			},
			{
				grammarId: 'rust',
				source: 'pub fn public_fn() {}\nfn private_fn() {}',
				publicName: 'public_fn',
				privateName: 'private_fn',
			},
			{
				grammarId: 'go',
				source: 'package main\n\nfunc PublicFn() {}\nfunc privateFn() {}',
				publicName: 'PublicFn',
				privateName: 'privateFn',
			},
			{
				grammarId: 'java',
				source: 'public class PublicC { private void privateMethod() {} }',
				publicName: 'PublicC',
				privateName: 'privateMethod',
			},
			{
				grammarId: 'kotlin',
				source: 'class PublicK\nprivate class PrivateK',
				publicName: 'PublicK',
				privateName: 'PrivateK',
			},
			{
				grammarId: 'csharp',
				source: 'public class PublicC { private void PrivateMethod() {} }',
				publicName: 'PublicC',
				privateName: 'PrivateMethod',
			},
			{
				grammarId: 'cpp',
				source:
					'int public_fn() { return 1; }\nstatic int private_fn() { return 2; }',
				publicName: 'public_fn',
				privateName: 'private_fn',
			},
			{
				grammarId: 'swift',
				source: 'public class PublicS {}\nfileprivate class PrivateS {}',
				publicName: 'PublicS',
				privateName: 'PrivateS',
			},
			{
				grammarId: 'dart',
				source:
					"import 'dart:io' as io;\n\nvoid publicFn() {\n\tio.stdout.writeln('x');\n}\n\nvoid _privateFn() {\n\tio.stdout.writeln('x');\n}\n",
				publicName: 'publicFn',
				privateName: '_privateFn',
			},
			{
				grammarId: 'ruby',
				source: 'class PublicC\nend\n\ndef _private_method\nend\n',
				publicName: 'PublicC',
				privateName: '_private_method',
			},
			{
				grammarId: 'php',
				source: '<?php\nclass PublicC {}\nfunction _private_fn() {}\n',
				publicName: 'PublicC',
				privateName: '_private_fn',
			},
		];

		for (const c of cases) {
			const facts = await extractFileSymbols(c.grammarId, c.source);
			expect(facts, c.grammarId).not.toBeNull();
			const publicDef = byName(facts!.defs, c.publicName);
			const privateDef = byName(facts!.defs, c.privateName);

			expect(publicDef, `${c.grammarId} public def`).toBeDefined();
			expect(publicDef!.exported, `${c.grammarId} public exported`).toBe(true);
			expect(publicDef!.visibilityInfo?.exported).toBe(true);
			expect(privateDef, `${c.grammarId} private def`).toBeDefined();
			expect(privateDef!.exported, `${c.grammarId} private exported`).toBe(
				false,
			);
			expect(privateDef!.visibilityInfo?.apiSurfaceKind).toBe('private');
		}
	});

	test('python literal __all__ overrides naming without synthesizing missing defs', async () => {
		const facts = await extractFileSymbols(
			'python',
			"__all__ = ['chosen', 'missing']\n\ndef chosen():\n    pass\n\ndef public_but_hidden():\n    pass\n",
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'chosen')?.exported).toBe(true);
		expect(byName(facts!.defs, 'public_but_hidden')?.exported).toBe(false);
		expect(byName(facts!.defs, 'missing')).toBeUndefined();
	});

	test('CommonJS alias exports use external names and metadata', async () => {
		const facts = await extractFileSymbols(
			'javascript',
			`function localImpl() { return 1; }
function hidden() { return 2; }
module.exports = { publicName: localImpl };`,
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'publicName')).toMatchObject({
			name: 'publicName',
			exported: true,
		});
		expect(byName(facts!.defs, 'publicName')?.visibilityInfo).toMatchObject({
			exportedReason: 'explicit_export',
			apiSurfaceKind: 'export',
		});
		expect(byName(facts!.defs, 'hidden')?.exported).toBe(false);
	});

	test('methods are not promoted into file-level exports by convention alone', async () => {
		const facts = await extractFileSymbols(
			'java',
			'public class PublicC { public void visibleMethod() {} }',
		);
		expect(facts).not.toBeNull();
		expect(byName(facts!.defs, 'PublicC')?.exported).toBe(true);
		expect(byName(facts!.defs, 'visibleMethod')?.exported).toBe(false);
		expect(
			byName(facts!.defs, 'visibleMethod')?.visibilityInfo?.visibility,
		).toBe('public');
	});
});
