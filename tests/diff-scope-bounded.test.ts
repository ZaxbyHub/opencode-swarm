/**
 * Regression tests for the same defect class as
 * `gitignore-warning-bounded.test.ts`, applied to
 * `src/hooks/diff-scope.ts:getChangedFiles`.
 *
 * Tests use the file-scoped `_internals` DI seam from `diff-scope.ts`
 * rather than `mock.module`, because `mock.module` mutations leak across
 * unrelated suites in Bun's shared test-runner process.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals, validateDiffScope } from '../src/hooks/diff-scope';

const realBunSpawn = _internals.bunSpawn;
const EXPECTED_PER_CALL_TIMEOUT_MS = 1_500;

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
});

describe('validateDiffScope getChangedFiles — bounded execution', () => {
	test('every git bunSpawn call passes timeout + stdin:ignore', async () => {
		const observed: Array<Record<string, unknown>> = [];
		const killCalls = { count: 0 };
		_internals.bunSpawn = ((
			_cmd: string[],
			options?: Record<string, unknown>,
		) => {
			if (options) observed.push(options);
			return {
				stdout: { text: () => Promise.resolve('') },
				stderr: { text: () => Promise.resolve('') },
				exited: Promise.resolve(1), // non-zero so getChangedFiles returns null
				exitCode: 1,
				kill: () => {
					killCalls.count += 1;
				},
			};
		}) as unknown as typeof realBunSpawn;

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-scope-bounded-'));
		try {
			fs.mkdirSync(path.join(dir, '.swarm'));
			fs.writeFileSync(
				path.join(dir, '.swarm', 'plan.json'),
				JSON.stringify({
					phases: [
						{
							tasks: [{ id: '1.1', files_touched: ['src/foo.ts'] }],
						},
					],
				}),
				'utf8',
			);

			const result = await validateDiffScope('1.1', dir);
			// Both bunSpawn calls return exit 1, so getChangedFiles → null →
			// validateDiffScope → null. The contract under test is "every
			// spawn site passes the new options," not the return value.
			expect(result).toBeNull();

			expect(observed.length).toBe(2);
			for (const opts of observed) {
				expect(opts.cwd).toBe(dir);
				expect(opts.timeout).toBe(EXPECTED_PER_CALL_TIMEOUT_MS);
				expect(opts.stdin).toBe('ignore');
				expect(opts.stdout).toBe('pipe');
				expect(opts.stderr).toBe('pipe');
			}
			expect(killCalls.count).toBe(2);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
