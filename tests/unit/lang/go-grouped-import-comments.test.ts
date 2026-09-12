import { describe, expect, test } from 'bun:test';
import { _internals as goInternals } from '../../../src/lang/backends/go.js';

/**
 * Go grouped-import comment handling (issue #2492 AC6): a quoted string inside
 * a // or block comment within a grouped import block must NOT become a
 * phantom import edge, while real grouped, alias, dot, and side-effect
 * imports are retained. Mirrors frozen acceptance check
 * .agents/issue-traces/2492-test-mutation-scope/repro/c6-go-grouped-import-comments.ts.
 */

const GROUPED_SOURCE = [
	'package main',
	'',
	'import (',
	'\t"fmt" // migrate from "legacy/db/pkg"',
	'\talias "modern/sql/pkg"',
	'\t_ "side/effect/pkg"',
	'\t. "dot/import/pkg"',
	'\t/* block comment mentioning "block/cmt/pkg" */',
	'\t"plain/pkg"',
	')',
].join('\n');

describe('Go grouped-import quoted-comment false edges (issue #2492 AC6)', () => {
	test('quoted strings inside // and block comments create no phantom edges', () => {
		const imports = goInternals.extractImports('main.go', GROUPED_SOURCE);
		expect(imports).not.toContain('legacy/db/pkg');
		expect(imports).not.toContain('block/cmt/pkg');
	});

	test('real grouped, alias, dot, and side-effect imports are retained', () => {
		const imports = goInternals.extractImports('main.go', GROUPED_SOURCE);
		expect(imports).toContain('fmt');
		expect(imports).toContain('modern/sql/pkg');
		expect(imports).toContain('side/effect/pkg');
		expect(imports).toContain('dot/import/pkg');
		expect(imports).toContain('plain/pkg');
	});

	test('comment-only block yields no imports at all', () => {
		const src = 'import (\n\t// see "docs/pkg" for details\n)\n';
		expect(goInternals.extractImports('main.go', src)).toEqual([]);
	});

	test('single-line import form is unaffected by the comment strip', () => {
		const src = 'import "single/pkg"\nimport aliased "aliased/pkg"\n';
		const imports = goInternals.extractImports('main.go', src);
		expect(imports).toContain('single/pkg');
		expect(imports).toContain('aliased/pkg');
	});
});
