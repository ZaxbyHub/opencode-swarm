/**
 * Issue #2476 (AC5) — Windows .cmd/.bat execution for the pkg-audit npm and
 * cargo paths.
 *
 * Pins the `resolveAuditCommand` contract added with the #2476 hardening:
 * on win32 a `.cmd`/`.bat` hit from `resolveExecutableFromPath` cannot be
 * spawned directly by Node (EINVAL since CVE-2024-27980), so it must be
 * routed through `cmd.exe /d /s /c call "<absolute path>"` — the form
 * empirically verified on Windows for paths containing spaces. A `.exe` hit
 * spawns directly, and POSIX (or a failed resolution) keeps the historical
 * bare name. The final test executes the routed argv through the real
 * `bunSpawn` seam so the quoting contract is proven, not just asserted.
 *
 * Fixtures plant binaries via a PATH replacement (save/restore in finally);
 * `resolveExecutableFromPath` reads `process.env.PATH` at call time.
 */

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/tools/pkg-audit';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const IS_WIN = process.platform === 'win32';

/** Run `fn` with PATH replaced by `dir` (isolation from the host toolchain). */
function withPathReplacement(dir: string, fn: () => void): void {
	const previous = process.env.PATH;
	process.env.PATH = dir;
	try {
		fn();
	} finally {
		process.env.PATH = previous;
	}
}

describe('pkg-audit resolveAuditCommand — #2476 AC5 win32 routing', () => {
	it.skipIf(!IS_WIN)(
		'routes a .cmd hit through cmd.exe with a call-quoted absolute tail (space-containing path)',
		() => {
			const tmp = canonicalMkdtemp('pkg-audit-cmd-');
			try {
				const spacedDir = path.join(tmp, 'space dir');
				fs.mkdirSync(spacedDir);
				fs.writeFileSync(
					path.join(spacedDir, 'npm.cmd'),
					'@echo off\r\necho probe-npm-ok\r\n',
				);
				let command: string[] = [];
				withPathReplacement(spacedDir, () => {
					command = _internals.resolveAuditCommand('npm');
				});
				expect(command).toEqual([
					'cmd.exe',
					'/d',
					'/s',
					'/c',
					'call "' + path.join(spacedDir, 'npm.cmd') + '"',
				]);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!IS_WIN)('routes a .bat hit through the same cmd.exe form', () => {
		const tmp = canonicalMkdtemp('pkg-audit-bat-');
		try {
			const batDir = path.join(tmp, 'bat dir');
			fs.mkdirSync(batDir);
			fs.writeFileSync(
				path.join(batDir, 'npm.bat'),
				'@echo off\r\necho probe-npm-ok\r\n',
			);
			let command: string[] = [];
			withPathReplacement(batDir, () => {
				command = _internals.resolveAuditCommand('npm');
			});
			expect(command).toEqual([
				'cmd.exe',
				'/d',
				'/s',
				'/c',
				'call "' + path.join(batDir, 'npm.bat') + '"',
			]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it.skipIf(!IS_WIN)('spawns a resolved .exe directly without cmd.exe', () => {
		const tmp = canonicalMkdtemp('pkg-audit-exe-');
		try {
			fs.writeFileSync(path.join(tmp, 'cargo.exe'), 'stub');
			let command: string[] = [];
			withPathReplacement(tmp, () => {
				command = _internals.resolveAuditCommand('cargo');
			});
			expect(command).toEqual([path.join(tmp, 'cargo.exe')]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it.skipIf(!IS_WIN)(
		'falls back to the bare name when resolution finds nothing',
		() => {
			const tmp = canonicalMkdtemp('pkg-audit-missing-');
			try {
				let npmCommand: string[] = [];
				let cargoCommand: string[] = [];
				withPathReplacement(tmp, () => {
					npmCommand = _internals.resolveAuditCommand('npm');
					cargoCommand = _internals.resolveAuditCommand('cargo');
				});
				expect(npmCommand).toEqual(['npm']);
				expect(cargoCommand).toEqual(['cargo']);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(IS_WIN)('keeps the historical bare name on POSIX', () => {
		expect(_internals.resolveAuditCommand('npm')).toEqual(['npm']);
		expect(_internals.resolveAuditCommand('cargo')).toEqual(['cargo']);
	});

	it.skipIf(!IS_WIN)(
		'falls back to the bare name when the resolved .cmd path contains a cmd metacharacter',
		() => {
			const tmp = canonicalMkdtemp('pkg-audit-meta-');
			try {
				const metaDir = path.join(tmp, 'a&b');
				fs.mkdirSync(metaDir);
				fs.writeFileSync(
					path.join(metaDir, 'npm.cmd'),
					'@echo off\r\necho probe-npm-ok\r\n',
				);
				let command: string[] = [];
				withPathReplacement(metaDir, () => {
					command = _internals.resolveAuditCommand('npm');
				});
				// The metacharacter guard rejects the whole cmd.exe form rather
				// than interpolating the path into a verbatim command line.
				expect(command).toEqual(['npm']);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!IS_WIN)(
		'executes the routed argv through bunSpawn for a space-containing .cmd path',
		async () => {
			const tmp = canonicalMkdtemp('pkg-audit-exec-');
			try {
				const spacedDir = path.join(tmp, 'space dir');
				fs.mkdirSync(spacedDir);
				fs.writeFileSync(
					path.join(spacedDir, 'npm.cmd'),
					'@echo off\r\necho probe-npm-ok\r\n',
				);
				let command: string[] = [];
				withPathReplacement(spacedDir, () => {
					command = [..._internals.resolveAuditCommand('npm'), '--version'];
				});
				expect(command[0]).toBe('cmd.exe');

				const proc = _internals.bunSpawn(command, {
					stdout: 'pipe',
					stderr: 'pipe',
					cwd: tmp,
					...(command[0] === 'cmd.exe'
						? { windowsVerbatimArguments: true }
						: {}),
				});
				const [stdout, stderr] = await Promise.all([
					proc.stdout.text(),
					proc.stderr.text(),
				]);
				const exitCode = await proc.exited;
				expect(stderr).toBe('');
				expect(exitCode).toBe(0);
				expect(stdout).toContain('probe-npm-ok');
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		15_000,
	);
});
