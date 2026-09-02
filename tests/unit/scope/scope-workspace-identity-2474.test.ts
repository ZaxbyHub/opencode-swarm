import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalWorkspaceIdentity } from '../../../src/scope/scope-binding.js';
import { canonicalMkdtemp, canonicalTmpDir } from '../../helpers/tmpdir';

const cleanup: string[] = [];

afterEach(() => {
	for (const target of cleanup.splice(0).reverse()) {
		fs.rmSync(target, { recursive: true, force: true });
	}
});

describe('scope workspace physical identity (#2474)', () => {
	test('accepts a physical alias without widening to a foreign root', () => {
		const root = canonicalMkdtemp('scope-id-');
		const foreign = canonicalMkdtemp('scope-id-foreign-');
		const alias = `${root}-alias`;
		cleanup.push(root, foreign, alias);
		fs.symlinkSync(
			root,
			alias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		expect(canonicalWorkspaceIdentity(alias)).toBe(
			canonicalWorkspaceIdentity(root),
		);
		expect(canonicalWorkspaceIdentity(foreign)).not.toBe(
			canonicalWorkspaceIdentity(root),
		);
	});

	test('fails closed for a missing workspace', () => {
		const missing = path.join(canonicalTmpDir(), 'scope-id-missing-2474');
		expect(canonicalWorkspaceIdentity(missing)).toBeNull();
	});
});
