import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { searchWorkspaceLiteral } from '../../../src/tools/search';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmp = '';
afterEach(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	tmp = '';
});

describe('bounded Node literal-search fallback', () => {
	test('skips NUL-bearing binary files while finding text matches', async () => {
		tmp = canonicalMkdtemp('search-binary-fallback-');
		fs.writeFileSync(
			path.join(tmp, 'binary.bin'),
			Buffer.from([0, 83, 69, 67, 82, 69, 84]),
		);
		fs.writeFileSync(path.join(tmp, 'source.ts'), 'const value = "SECRET";\n');
		const result = await searchWorkspaceLiteral({
			query: 'SECRET',
			mode: 'literal',
			maxResults: 10,
			maxLines: 100,
			workspace: tmp,
		});
		expect(result.total).toBe(1);
		expect(result.matches).toHaveLength(1);
		expect(result.matches?.[0]?.file).toBe('source.ts');
	});
});
