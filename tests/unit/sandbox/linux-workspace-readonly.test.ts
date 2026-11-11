/**
 * The Linux Bubblewrap sandbox used to bind only the writable scope paths,
 * so a coder whose scope was `tests/x.test.js` could not even read `src/`
 * inside the sandbox (`Cannot find module '../src/x.js'`). The session
 * workspace is now mounted read-only BEFORE the writable scope binds, so the
 * scope stays writable and the rest of the workspace is readable but not
 * writable. Bind order matters: bwrap mounts in argument order and a later
 * `--ro-bind` of the root would mask an earlier writable scope bind.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	BubblewrapSandboxExecutor,
} from '../../../src/sandbox/linux/bubblewrap-executor';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const isLinux = process.platform === 'linux';

/** POSIX single-quote a value for interpolation into a shell command. */
function q(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function wrap(
	readonlyRoots: readonly string[] | undefined,
	scope: string[] = ['/ws/tests/t.js'],
): string {
	// wrapCommand only checks the cached availability flag, which the
	// constructor sets from the probe seam; stub the probe so the string shape
	// can be asserted on any platform, restoring it before returning.
	const originalProbe = _internals.probeBwrap;
	_internals.probeBwrap = () => true;
	try {
		const executor = new BubblewrapSandboxExecutor([]);
		return executor.wrapCommand('ls', scope, undefined, undefined, {
			network_mode: 'off',
			readonly_roots: readonlyRoots,
		});
	} finally {
		_internals.probeBwrap = originalProbe;
	}
}

describe('BubblewrapSandboxExecutor: read-only workspace roots', () => {
	test('mounts the /tmp tmpfs before a read-only root under /tmp', () => {
		// A workspace under the temp dir must stay visible: the tmpfs is mounted
		// first, then the read-only root on top of it (bwrap applies in argument order).
		const cmd = wrap(['/tmp/ws'], ['/tmp/ws/tests/t.js']);
		const tmpfs = cmd.indexOf("--tmpfs '/tmp'");
		const ro = cmd.indexOf("--ro-bind '/tmp/ws' '/tmp/ws'");
		expect(tmpfs).toBeGreaterThan(-1);
		expect(ro).toBeGreaterThan(-1);
		expect(tmpfs).toBeLessThan(ro);
	});

	test('mounts each readonly root with --ro-bind before the first scope --bind', () => {
		const cmd = wrap(['/ws']);
		const ro = cmd.indexOf("--ro-bind '/ws' '/ws'");
		const rw = cmd.indexOf("--bind '/ws/tests/t.js' '/ws/tests/t.js'");
		expect(ro).toBeGreaterThan(-1);
		expect(rw).toBeGreaterThan(-1);
		expect(ro).toBeLessThan(rw);
	});

	test('emits no workspace --ro-bind when readonly_roots is absent or empty', () => {
		for (const cmd of [wrap(undefined), wrap([])]) {
			expect(cmd).not.toContain("--ro-bind '/ws'");
			// System read-only binds are unchanged.
			expect(cmd).toContain('--ro-bind /usr /usr');
		}
	});

	test('drops relative, empty and filesystem-root entries and dedupes', () => {
		const cmd = wrap(['/ws', 'relative/dir', '', '/', '/ws']);
		expect(cmd.match(/--ro-bind '\/ws' '\/ws'/g)).toHaveLength(1);
		expect(cmd).not.toContain('relative/dir');
		expect(cmd).not.toContain("--ro-bind '/' '/'");
	});

	test('shell-escapes a readonly root containing a single quote', () => {
		const cmd = wrap(["/ws/it's"]);
		expect(cmd).toContain("--ro-bind '/ws/it'\\''s' '/ws/it'\\''s'");
	});
});

describe('probe shell quoting helper', () => {
	test('q() single-quotes a path and escapes embedded single quotes', () => {
		expect(q('/ws/a b')).toBe("'/ws/a b'");
		expect(q("/ws/it's")).toBe("'/ws/it'\\''s'");
	});
});

describe.skipIf(!isLinux)(
	'BubblewrapSandboxExecutor: real bwrap visibility',
	() => {
		const executor = new BubblewrapSandboxExecutor([]);
		test.skipIf(!executor.isAvailable())(
			'a scoped file is writable, a sibling is readable but not writable',
			() => {
				const ws = canonicalMkdtemp('bwrap-visibility-');
				try {
					mkdirSync(path.join(ws, 'src'));
					mkdirSync(path.join(ws, 'tests'));
					mkdirSync(path.join(ws, '.sandbox-tmp'));
					writeFileSync(
						path.join(ws, 'src', 'lib.js'),
						'module.exports = 1;\n',
					);
					const scoped = path.join(ws, 'tests', 't.js');
					writeFileSync(scoped, '// t\n');
					const probe = [
						`cat ${q(`${ws}/src/lib.js`)} >/dev/null && echo READ_SIBLING_OK`,
						`echo w >> ${q(scoped)} && echo WRITE_SCOPED_OK`,
						`(echo w >> ${q(`${ws}/src/lib.js`)}) 2>/dev/null && echo WRITE_SIBLING_ALLOWED || echo WRITE_SIBLING_DENIED`,
						`(touch ${q(`${ws}/tests/new.js`)}) 2>/dev/null && echo CREATE_UNSCOPED_ALLOWED || echo CREATE_UNSCOPED_DENIED`,
					].join('; ');
					// Keep the sandbox tmpfs inside the workspace so this probe does not
					// depend on where the OS tmpdir sits.
					const wrapped = executor.wrapCommand(
						probe,
						[scoped],
						path.join(ws, '.sandbox-tmp'),
						undefined,
						{ network_mode: 'off', readonly_roots: [ws] },
					);
					const out = execFileSync('bash', ['-c', wrapped], {
						encoding: 'utf8',
						timeout: 30_000,
						stdio: ['ignore', 'pipe', 'pipe'],
					});
					expect(out).toContain('READ_SIBLING_OK');
					expect(out).toContain('WRITE_SCOPED_OK');
					expect(out).toContain('WRITE_SIBLING_DENIED');
					expect(out).toContain('CREATE_UNSCOPED_DENIED');
					expect(readFileSync(scoped, 'utf8')).toBe('// t\nw\n');
					expect(readFileSync(path.join(ws, 'src', 'lib.js'), 'utf8')).toBe(
						'module.exports = 1;\n',
					);
				} finally {
					rmSync(ws, { recursive: true, force: true });
				}
			},
		);
	},
);
