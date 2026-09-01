import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	search,
	searchWorkspaceLiteral,
} from '../../../src/tools/search';
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

	test('routes the tool fallback through the injectable seam', async () => {
		tmp = canonicalMkdtemp('search-fallback-seam-');
		const original = _internals.fallbackSearch;
		const originalResolve = _internals.resolveRipgrepBinary;
		let called = false;
		_internals.resolveRipgrepBinary = () => null;
		_internals.fallbackSearch = async (opts) => {
			called = true;
			return original(opts);
		};
		try {
			const result = await (
				search as unknown as {
					execute: (
						args: Record<string, unknown>,
						directory: string,
					) => Promise<string>;
				}
			).execute(
				{ query: 'SECRET', mode: 'literal', max_results: 10, max_lines: 100 },
				tmp,
			);
			expect(JSON.parse(result).engine).toBe('fallback');
			expect(called).toBe(true);
		} finally {
			_internals.fallbackSearch = original;
			_internals.resolveRipgrepBinary = originalResolve;
		}
	});
});
