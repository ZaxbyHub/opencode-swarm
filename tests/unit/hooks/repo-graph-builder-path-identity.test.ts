import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rebaseOntoWorkspace } from '../../../src/hooks/repo-graph-builder';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('repo graph path identity (#2474)', () => {
	test('rebases a real path onto a symlink or junction workspace root', () => {
		const fixtureRoot = canonicalMkdtemp('repo-graph-rebase-');
		const realRoot = path.join(fixtureRoot, 'real-root');
		const lexicalRoot = path.join(fixtureRoot, 'lexical-root');
		const realFile = path.join(realRoot, 'src', 'main.ts');
		fs.mkdirSync(path.dirname(realFile), { recursive: true });
		fs.writeFileSync(realFile, 'export const x = 1;\n');
		try {
			fs.symlinkSync(
				realRoot,
				lexicalRoot,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			const rebased = rebaseOntoWorkspace(
				fs.realpathSync(realFile),
				fs.realpathSync(realRoot),
				lexicalRoot,
			);
			expect(rebased.replace(/\\/g, '/')).toBe(
				`${lexicalRoot.replace(/\\/g, '/')}/src/main.ts`,
			);
		} finally {
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});
