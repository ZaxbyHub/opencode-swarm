import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { _test_exports } from '../../../../scripts/ci/verify-repository-validation-reports';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

describe('repository validation report verifier file hardening — issue #2701', () => {
	test('rejects a symlink before opening an expected-file manifest', () => {
		const root = canonicalMkdtemp('validation-verifier-file-');
		try {
			const target = path.join(root, 'target.txt');
			const link = path.join(root, 'expected.txt');
			writeFileSync(target, 'safe\n', 'utf8');
			try {
				symlinkSync(target, link);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (
					process.platform === 'win32' &&
					['EACCES', 'EPERM', 'ENOTSUP'].includes(code ?? '')
				)
					return;
				throw error;
			}

			expect(() =>
				_test_exports.readBoundedText(link, 128, 'expected file list'),
			).toThrow(/must be a regular file/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('rejects a Windows directory junction as a manifest path when junctions are available', () => {
		if (process.platform !== 'win32') return;
		const root = canonicalMkdtemp('validation-verifier-junction-');
		try {
			const targetDirectory = path.join(root, 'target');
			const junction = path.join(root, 'expected.txt');
			mkdirSync(targetDirectory);
			writeFileSync(path.join(targetDirectory, 'nested.txt'), 'safe\n', 'utf8');
			try {
				symlinkSync(targetDirectory, junction, 'junction');
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (['EACCES', 'EPERM', 'ENOTSUP', 'EINVAL'].includes(code ?? ''))
					return;
				throw error;
			}

			expect(() =>
				_test_exports.readBoundedText(junction, 128, 'expected file list'),
			).toThrow(/must be a regular file/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// Windows has no supported FIFO primitive in the CI runtime; the junction
	// test above covers its portable non-regular-path assurance instead.
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
