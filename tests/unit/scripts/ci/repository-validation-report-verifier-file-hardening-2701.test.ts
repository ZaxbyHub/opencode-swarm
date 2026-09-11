import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { _test_exports } from '../../../../scripts/ci/verify-repository-validation-reports';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

describe('repository validation report verifier file hardening — issue #2701', () => {
	test.skipIf(process.platform === 'win32')(
		'rejects a symlink before opening an expected-file manifest',
		() => {
			const root = canonicalMkdtemp('validation-verifier-file-');
			try {
				const target = path.join(root, 'target.txt');
				const link = path.join(root, 'expected.txt');
				writeFileSync(target, 'safe\n', 'utf8');
				symlinkSync(target, link);

				expect(() =>
					_test_exports.readBoundedText(link, 128, 'expected file list'),
				).toThrow(/must be a regular file/);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === 'win32')(
		'rejects FIFOs without blocking expected manifests or JSON reports',
		async () => {
			const root = canonicalMkdtemp('validation-verifier-fifo-');
			const reports = path.join(root, 'reports');
			const fifo = path.join(reports, 'unit-shard-1-0.json');
			mkdirSync(reports);
			const maker = Bun.spawn(['mkfifo', fifo], {
				cwd: root,
				stdin: 'ignore',
				stdout: 'ignore',
				stderr: 'ignore',
				timeout: 1_000,
			});
			try {
				expect(await maker.exited).toBe(0);
				expect(() =>
					_test_exports.readBoundedText(fifo, 128, 'expected file list'),
				).toThrow(/must be a regular file/);
				expect(() =>
					_test_exports.readBoundedReport(fifo, {
						reportFiles: 0,
						reportBytes: 0,
						expectedFileBytes: 0,
					}),
				).toThrow(/must be a regular file/);
			} finally {
				try {
					maker.kill('SIGKILL');
				} catch {
					// The short-lived mkfifo process may have exited already.
				}
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
