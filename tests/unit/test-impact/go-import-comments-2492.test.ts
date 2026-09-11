import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, buildImpactMap } from '../../../src/test-impact/analyzer';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('go-import-comments-2492-');
	fs.writeFileSync(
		path.join(tempDir, 'go.mod'),
		'module example.com/impact\n\ngo 1.22\n',
	);
	_internals._clearGoModuleCache();
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
	_internals._clearGoModuleCache();
});

function writePackage(name: string): string {
	const packageDir = path.join(tempDir, 'pkg', name);
	fs.mkdirSync(packageDir, { recursive: true });
	fs.writeFileSync(path.join(packageDir, 'impl.go'), `package ${name}\n`);
	return `${_internals.normalizePath(packageDir)}/impl.go`;
}

describe('Go impact imports — regression for issue #2492', () => {
	test('ignores quoted comments while retaining grouped, alias, dot, and side-effect imports', async () => {
		const groupedPath = writePackage('grouped');
		const aliasPath = writePackage('aliaspkg');
		const dotPath = writePackage('dotpkg');
		const sideEffectPath = writePackage('sideeffect');
		const lineCommentPath = writePackage('linecomment');
		const blockCommentPath = writePackage('blockcomment');
		const testFile = path.join(tempDir, 'imports_test.go');

		fs.writeFileSync(
			testFile,
			`package impact

import (
	"example.com/impact/pkg/grouped"
	alias "example.com/impact/pkg/aliaspkg"
	. "example.com/impact/pkg/dotpkg"
	_ "example.com/impact/pkg/sideeffect"
	// "example.com/impact/pkg/linecomment"
	/* alias "example.com/impact/pkg/blockcomment" */
)

func TestImports(t *testing.T) {}
`,
		);

		const impactMap = await buildImpactMap(tempDir);
		const testPath = _internals.normalizePath(testFile);

		expect(impactMap[groupedPath]).toEqual([testPath]);
		expect(impactMap[aliasPath]).toEqual([testPath]);
		expect(impactMap[dotPath]).toEqual([testPath]);
		expect(impactMap[sideEffectPath]).toEqual([testPath]);
		expect(impactMap[lineCommentPath]).toBeUndefined();
		expect(impactMap[blockCommentPath]).toBeUndefined();
	});
});
