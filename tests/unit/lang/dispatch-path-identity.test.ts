import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import '../../../src/lang/backends';
import { clearDispatchCache, pickBackend } from '../../../src/lang/dispatch';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

afterEach(() => {
	clearDispatchCache();
});

describe('language dispatch path identity (#2474)', () => {
	test('observes the current project after an alias retarget', async () => {
		const firstDir = canonicalMkdtemp('dispatch-alias-a-');
		const secondDir = canonicalMkdtemp('dispatch-alias-b-');
		const alias = `${firstDir}-alias`;
		try {
			fs.writeFileSync(path.join(firstDir, 'package.json'), '{"name":"a"}');
			fs.writeFileSync(
				path.join(secondDir, 'go.mod'),
				'module example.test/b\n',
			);
			const linkType = process.platform === 'win32' ? 'junction' : 'dir';
			fs.symlinkSync(firstDir, alias, linkType);

			expect((await pickBackend(firstDir))?.id).toBe('typescript');
			expect((await pickBackend(alias))?.id).toBe('typescript');

			fs.rmSync(alias, { recursive: true, force: true });
			fs.symlinkSync(secondDir, alias, linkType);
			expect((await pickBackend(alias))?.id).toBe('go');
		} finally {
			fs.rmSync(alias, { recursive: true, force: true });
			fs.rmSync(firstDir, { recursive: true, force: true });
			fs.rmSync(secondDir, { recursive: true, force: true });
		}
	});
});
