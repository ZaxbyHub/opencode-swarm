import { describe, expect, test } from 'bun:test';
import {
	collectCommonJsExports,
	getSymbolVisibilityInfo,
	SYMBOL_API_SURFACE_KIND_VALUES,
	SYMBOL_EXPORTED_REASON_VALUES,
	SYMBOL_VISIBILITY_VALUES,
	type SymbolVisibilityNode,
} from '../../../src/lang/symbol-visibility';

function node(
	type: string,
	text: string,
	parent: SymbolVisibilityNode | null = null,
): SymbolVisibilityNode {
	const n: SymbolVisibilityNode = {
		type,
		text,
		parent,
		children: [],
	};
	if (parent) parent.children.push(n);
	return n;
}

describe('symbol visibility shared API', () => {
	test('exports the exact metadata value sets', () => {
		expect(SYMBOL_VISIBILITY_VALUES).toEqual([
			'public',
			'internal',
			'protected',
			'private',
			'package',
			'unknown',
		]);
		expect(SYMBOL_EXPORTED_REASON_VALUES).toEqual([
			'explicit_export',
			'top_level_public',
			'naming_convention',
			'modifier',
			'header_declaration',
			'namespace_public',
			'module_public',
			'unknown',
		]);
		expect(SYMBOL_API_SURFACE_KIND_VALUES).toEqual([
			'export',
			'public',
			'entrypoint',
			'test',
			'private',
			'unknown',
		]);
	});

	test('returns the exact SymbolVisibilityInfo shape', () => {
		const root = node('program', 'export function api() {}');
		const def = node('function_declaration', 'export function api() {}', root);
		const info = getSymbolVisibilityInfo({
			grammarId: 'typescript',
			localName: 'api',
			kind: 'function',
			defNode: def,
			rootNode: root,
			isTopLevel: true,
			explicitExported: true,
		});

		expect(info).toEqual({
			exported: true,
			visibility: 'public',
			exportedReason: 'explicit_export',
			apiSurfaceKind: 'export',
		});
	});

	test('does not promote a public method inside a private container', () => {
		const root = node(
			'program',
			'private class Hidden { public void Run() {} }',
		);
		const cls = node('class_declaration', 'private class Hidden', root);
		const method = node('method_declaration', 'public void Run() {}', cls);

		const info = getSymbolVisibilityInfo({
			grammarId: 'csharp',
			localName: 'Run',
			kind: 'method',
			defNode: method,
			rootNode: root,
			isTopLevel: false,
			explicitExported: false,
		});

		expect(info).toMatchObject({
			exported: false,
			visibility: 'private',
			apiSurfaceKind: 'private',
		});
	});
});

describe('CommonJS export collection', () => {
	test('maps alias forms to external export names', () => {
		const exports = collectCommonJsExports(`
const local = 1;
module.exports = { publicName: local, direct };
exports.other = renamed;
module.exports.third = thirdLocal;
`);

		expect(exports.get('local')).toMatchObject({
			exportedName: 'publicName',
			localName: 'local',
			exportedReason: 'explicit_export',
		});
		expect(exports.get('direct')?.exportedName).toBe('direct');
		expect(exports.get('renamed')?.exportedName).toBe('other');
		expect(exports.get('thirdLocal')?.exportedName).toBe('third');
	});

	test('ignores comments and string/template literal bodies', () => {
		const exports = collectCommonJsExports(`
// exports.fake = commented;
const s = "module.exports.fake = stringy";
const t = \`exports.fake = templated\`;
/* module.exports.fake = blockComment; */
exports.real = actual;
`);

		expect(exports.has('commented')).toBe(false);
		expect(exports.has('stringy')).toBe(false);
		expect(exports.has('templated')).toBe(false);
		expect(exports.has('blockComment')).toBe(false);
		expect(exports.get('actual')?.exportedName).toBe('real');
	});

	test('keeps the earliest external mapping for duplicate local exports', () => {
		const exports = collectCommonJsExports(`
exports.first = local;
exports.second = local;
`);

		expect(exports.get('local')?.exportedName).toBe('first');
	});

	test('known limitation: nested braces in object literal drop subsequent exports', () => {
		// The [^}]* regex stops at the first `}`, so exports after a nested
		// object are silently dropped. Dot-assignment is the workaround.
		const exports = collectCommonJsExports(`
module.exports = { config: { port: 3000 }, handler };
exports.workaround = alsoExported;
`);

		// handler is dropped — known limitation of the [^}]* regex
		expect(exports.has('handler')).toBe(false);
		// dot-assignment form still works
		expect(exports.get('alsoExported')?.exportedName).toBe('workaround');
	});
});
