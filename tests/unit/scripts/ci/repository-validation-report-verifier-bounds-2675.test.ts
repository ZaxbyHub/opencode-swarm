import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import {
	MAX_ARTIFACTS,
	MAX_EXPECTED_FILE_BYTES,
	MAX_REPORT_SCAN_DEPTH,
	verifyReports,
} from '../../../../scripts/ci/verify-repository-validation-reports';
import { createSafeTestDir } from '../../../helpers/safe-test-dir';

async function withFixture<T>(
	fn: (directory: string) => T | Promise<T>,
): Promise<T> {
	const { dir, cleanup } = createSafeTestDir('validation-verifier-bounds-');
	try {
		return await fn(dir);
	} finally {
		cleanup();
	}
}

describe('issue #2675 report verifier resource bounds', () => {
	test('fails closed when recursive report traversal exceeds its depth bound', async () => {
		await withFixture((directory) => {
			const reports = path.join(directory, 'reports');
			let nested = reports;
			for (let depth = 0; depth <= MAX_REPORT_SCAN_DEPTH; depth += 1) {
				nested = path.join(nested, `level-${depth}`);
				mkdirSync(nested, { recursive: true });
			}
			expect(() =>
				verifyReports({ directory: reports, root: directory, surface: 'unit' }),
			).toThrow(
				`report directory traversal exceeds depth ${MAX_REPORT_SCAN_DEPTH}`,
			);
		});
	});

	test('rejects an oversized expected-file manifest before splitting or normalizing it', async () => {
		await withFixture((directory) => {
			const expected = path.join(directory, 'expected.txt');
			writeFileSync(expected, 'x'.repeat(MAX_EXPECTED_FILE_BYTES + 1), 'utf8');
			expect(() =>
				verifyReports({
					directory: path.join(directory, 'reports'),
					root: directory,
					surface: 'unit',
					expectedFilesPath: expected,
				}),
			).toThrow(`expected file list exceeds ${MAX_EXPECTED_FILE_BYTES} bytes`);
		});
	});

	test('bounds artifact-prefix matrix expansion before allocating expected artifact names', async () => {
		await withFixture((directory) => {
			expect(() =>
				verifyReports({
					directory,
					root: directory,
					surface: 'unit',
					artifactPrefix: 'validation-',
					expectedOs: Array.from(
						{ length: MAX_ARTIFACTS + 1 },
						(_, index) => `os-${index}`,
					),
					shards: 1,
				}),
			).toThrow(`expected validation artifact count exceeds ${MAX_ARTIFACTS}`);
		});
	});
});
