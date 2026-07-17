import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const TEST_DIR = createSafeTestDir('destructive-command-lstat-').dir;

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		block_destructive_commands: true,
		...overrides,
	};
}

function makeBashInput(sessionID = 'test-session', command: string) {
	return { tool: 'bash', sessionID, callID: 'call-1' };
}

function makeBashOutput(command: string) {
	return { args: { command } };
}

const testUnlessWindows = process.platform === 'win32' ? test.skip : test;

beforeEach(() => {
	resetSwarmState();
	startAgentSession('test-session', 'coder', TEST_DIR);
});

afterAll(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

// Group 1: Junction / symlink CREATION blocking
describe('junction and symlink creation blocking', () => {
	test('mklink /J with external absolute target → BLOCKED', async () => {
		// On Linux, path.resolve('/tmp', 'C:\\path') treats the Windows path as relative,
		// so use a POSIX absolute path to reliably trigger the "outside cwd" detection.
		// On Windows, C:\opencode\... is properly recognized as an absolute external path.
		const externalTarget =
			process.platform === 'win32'
				? 'C:\\opencode\\dist3\\DocumentQA'
				: '/opt/opencode/dist3';
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: { command: `mklink /J link ${externalTarget}` },
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c1' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('mklink /D with external absolute target → BLOCKED', async () => {
		const externalTarget =
			process.platform === 'win32' ? 'C:\\Windows\\System32' : '/opt/system32';
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: { command: `mklink /D dirlink ${externalTarget}` },
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c1b' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('New-Item -ItemType Junction with external absolute target → BLOCKED', async () => {
		const externalTarget =
			process.platform === 'win32'
				? 'C:\\opencode\\dist3\\DocumentQA'
				: '/opt/opencode/dist3';
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: {
				command: `New-Item -ItemType Junction -Path link -Target ${externalTarget}`,
			},
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c2' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('New-Item -ItemType SymbolicLink with external absolute target → BLOCKED', async () => {
		const externalTarget =
			process.platform === 'win32'
				? 'C:\\sensitive\\data'
				: '/opt/sensitive/data';
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: {
				command: `New-Item -ItemType SymbolicLink -Path mylink -Target ${externalTarget}`,
			},
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c2b' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('ln -s /etc/passwd mylink → BLOCKED (POSIX absolute external target)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'ln -s /etc/passwd mylink' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c3' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('ln -s /home/user/secrets mylink → BLOCKED (POSIX absolute external target)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'ln -s /home/user/secrets mylink' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c3b' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('mklink /H hardlink (not a junction/symlink) → ALLOWED', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: { command: 'mklink /H hardlink.txt source.txt' },
		};
		// /H creates a hardlink — the guard only blocks /J and /D
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c4' },
				output,
			),
		).resolves.toBeUndefined();
	});

	test('ln (no -s flag, hardlink) → ALLOWED', async () => {
		startAgentSession('test-session', 'architect');
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'ln source.txt hardlink.txt' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c4b' },
				output,
			),
		).resolves.toBeUndefined();
	});

	test('ln -s relative/inside target → ALLOWED (resolves inside cwd)', async () => {
		startAgentSession('test-session', 'architect');
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'ln -s real-target mylink' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c4c' },
				output,
			),
		).resolves.toBeUndefined();
	});

	test('ln -s ../outside mylink → BLOCKED (relative path escaping cwd)', async () => {
		// path.resolve('/tmp', '../outside') = '/outside' which is outside /tmp → BLOCKED
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'ln -s ../outside mylink' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c4d' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('ln -s ../../etc/passwd mylink → BLOCKED (deep relative path escaping cwd)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'ln -s ../../etc/passwd mylink' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c4e' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('New-Item -Target /opt/sensitive -ItemType Junction -Path dist → BLOCKED (Target before ItemType)', async () => {
		// PS params are order-independent; -Target before -ItemType must still be caught
		const externalTarget =
			process.platform === 'win32'
				? 'C:\\opencode\\dist3\\DocumentQA'
				: '/opt/sensitive/data';
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: {
				command: `New-Item -Target ${externalTarget} -ItemType Junction -Path dist`,
			},
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c4f' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('New-Item -Path mylink -Target /opt/secret -ItemType SymbolicLink → BLOCKED (Target before ItemType)', async () => {
		const externalTarget =
			process.platform === 'win32' ? 'C:\\sensitive\\data' : '/opt/secret';
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: {
				command: `New-Item -Path mylink -Target ${externalTarget} -ItemType SymbolicLink`,
			},
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'c4g' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});
});

// ---------------------------------------------------------------------------
// Group 2: Unexpanded variable protection
// ---------------------------------------------------------------------------
describe('unexpanded variable protection', () => {
	test('rmdir /s /q $releaseDir\\DocumentQA → BLOCKED (unexpanded bash var)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: { command: 'rmdir /s /q $releaseDir\\DocumentQA' },
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'v1' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('Remove-Item -Recurse $env:APPDATA\\target → BLOCKED (PS env var)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: { command: 'Remove-Item -Recurse $env:APPDATA\\target' },
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'v2' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('rm -rf %USERPROFILE%\\important → BLOCKED (cmd.exe percent var)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: { command: 'rm -rf %USERPROFILE%\\important' },
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'v3' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('rm -rf ${BUILD_DIR}/output → BLOCKED (bash braced var)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'rm -rf ${BUILD_DIR}/output' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'v4' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('rm -rf $TMPDIR/work → BLOCKED (bare $ var)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'rm -rf $TMPDIR/work' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'v5' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});
});

// ---------------------------------------------------------------------------
// Group 3: System path blocking
// ---------------------------------------------------------------------------
describe('system path blocking', () => {
	test('rmdir /s /q C:\\Windows → BLOCKED (Windows system root)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'rmdir /s /q C:\\Windows' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 's1' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('rmdir /s /q C:\\Users → BLOCKED (Windows Users protected prefix)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'rmdir /s /q C:\\Users' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 's2' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('rm -rf /etc → BLOCKED (POSIX /etc protected prefix)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'rm -rf /etc' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 's3' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('rm -rf /home → BLOCKED (POSIX /home protected prefix)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'rm -rf /home' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 's4' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('rm -rf /usr/local/bin → BLOCKED (under /usr protected prefix)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'rm -rf /usr/local/bin' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 's5' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('rm -rf /var/log → BLOCKED (under /var protected prefix)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'rm -rf /var/log' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 's6' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});
});

// ---------------------------------------------------------------------------
// Group 4: POSIX long-form flags (--recursive --force)
// ---------------------------------------------------------------------------
describe('POSIX long-form flag detection', () => {
	test('rm --recursive --force /important → BLOCKED (long-form flags, absolute path)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: { command: 'rm --recursive --force /important' },
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'lf1' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('rm --force --recursive /etc/cron.d → BLOCKED (reversed long-form, system path)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: { command: 'rm --force --recursive /etc/cron.d' },
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'lf2' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});

	test('rm --recursive node_modules → ALLOWED (safe bare target)', async () => {
		// rmLongMatch captures 1–2 occurrences of --recursive/--force then the target.
		// node_modules is in DC_SAFE_TARGETS so it is allowed unconditionally.
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'rm --recursive node_modules' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'lf3' },
				output,
			),
		).resolves.toBeUndefined();
	});

	test('rm --recursive dist → ALLOWED (safe bare target)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = { args: { command: 'rm --recursive dist' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'lf4' },
				output,
			),
		).resolves.toBeUndefined();
	});

	test('rm --recursive --force src/generated → BLOCKED (unsafe relative path with long flags)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		const output = {
			args: { command: 'rm --recursive --force src/generated' },
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'lf5' },
				output,
			),
		).rejects.toThrow(/BLOCKED/);
	});
});

// ---------------------------------------------------------------------------
// Group 5: Real symlink detection via lstat ancestor walk
// ---------------------------------------------------------------------------
describe('lstat ancestor walk — real symlink detection', () => {
	testUnlessWindows(
		'rm -rf on a direct symlink directory → BLOCKED via lstat (symlink detected)',
		async () => {
			// Use realpathSync so that macOS /tmp → /private/tmp does not cause
			// a cwd/lstat mismatch when path.resolve() is called inside the guard.
			const tmpDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-lstat-')),
			);
			const realTarget = path.join(tmpDir, 'real-target');
			const symlinkName = 'symlink-dir';
			const symlinkPath = path.join(tmpDir, symlinkName);
			try {
				fs.mkdirSync(realTarget, { recursive: true });
				fs.symlinkSync(realTarget, symlinkPath, 'dir');

				const hooks = createGuardrailsHooks(tmpDir, undefined, defaultConfig());
				const output = { args: { command: `rm -rf ${symlinkName}` } };
				await expect(
					hooks.toolBefore(
						{ tool: 'bash', sessionID: 'test-session', callID: 'c10' },
						output,
					),
				).rejects.toThrow(/BLOCKED.*symlink/i);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		},
	);

	testUnlessWindows(
		'rm -rf on a path whose ancestor directory is a symlink → BLOCKED via lstat',
		async () => {
			const tmpDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-lstat-anc-')),
			);
			const realTarget = path.join(tmpDir, 'real-target');
			const symlinkName = 'sym-parent';
			const symlinkPath = path.join(tmpDir, symlinkName);
			try {
				// Create the subdirectory INSIDE the real target so that sym-parent/subdir
				// resolves through the symlink. This allows lstat to succeed on the leaf
				// (via symlink traversal for non-final path components), then detect the
				// symlink at the ancestor (sym-parent) on the walk upward.
				fs.mkdirSync(path.join(realTarget, 'subdir'), { recursive: true });
				fs.symlinkSync(realTarget, symlinkPath, 'dir');

				const hooks = createGuardrailsHooks(tmpDir, undefined, defaultConfig());
				// sym-parent/subdir exists (through the symlink). The lstat walk:
				// 1. lstat(tmpDir/sym-parent/subdir) → dir (follows sym-parent symlink for intermediate)
				// 2. lstat(tmpDir/sym-parent) → symlink → BLOCKED
				const output = {
					args: { command: `rm -rf ${symlinkName}/subdir` },
				};
				await expect(
					hooks.toolBefore(
						{ tool: 'bash', sessionID: 'test-session', callID: 'c11' },
						output,
					),
				).rejects.toThrow(/BLOCKED.*symlink/i);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		},
	);

	testUnlessWindows(
		'rm -rf on a real (non-symlink) directory → BLOCKED by generic unsafe-path rule, NOT by symlink check',
		async () => {
			const tmpDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-lstat-real-')),
			);
			const realDir = path.join(tmpDir, 'real-dir');
			try {
				fs.mkdirSync(realDir, { recursive: true });

				const hooks = createGuardrailsHooks(tmpDir, undefined, defaultConfig());
				// 'real-dir' is a plain directory, not in DC_SAFE_TARGETS.
				// The guard MUST block it (generic unsafe-path rule) but the error
				// must NOT mention symlink — that is the lstat-ancestor-walk path.
				let caughtError: Error | null = null;
				try {
					await hooks.toolBefore(
						{ tool: 'bash', sessionID: 'test-session', callID: 'c12' },
						{ args: { command: 'rm -rf real-dir' } },
					);
				} catch (e) {
					caughtError = e as Error;
				}
				expect(caughtError).not.toBeNull();
				expect(caughtError?.message).toMatch(/BLOCKED/);
				expect(caughtError?.message).not.toMatch(/symlink/i);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		},
	);

	testUnlessWindows(
		'rm -rf on a non-existent path → BLOCKED by generic rule (ENOENT silently skips lstat, not a symlink error)',
		async () => {
			const tmpDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-lstat-ne-')),
			);
			try {
				const hooks = createGuardrailsHooks(tmpDir, undefined, defaultConfig());
				// 'does-not-exist' does not exist — lstat gets ENOENT and breaks out of the walk.
				// The guard then falls through to the generic unsafe-path block.
				let caughtError: Error | null = null;
				try {
					await hooks.toolBefore(
						{ tool: 'bash', sessionID: 'test-session', callID: 'c13' },
						{ args: { command: 'rm -rf does-not-exist' } },
					);
				} catch (e) {
					caughtError = e as Error;
				}
				expect(caughtError).not.toBeNull();
				expect(caughtError?.message).toMatch(/BLOCKED/);
				expect(caughtError?.message).not.toMatch(/symlink/i);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		},
	);

	testUnlessWindows(
		'rm -rf node_modules where node_modules is a real symlink → BLOCKED (lstat runs before safe-list)',
		async () => {
			// lstat ancestor walk now runs BEFORE the DC_SAFE_TARGETS allowlist check,
			// so a symlinked node_modules is blocked even though "node_modules" is a safe name.
			// This prevents the K2.6 replay: mklink /J node_modules C:\important && rm -rf node_modules.
			const tmpDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-lstat-safe-')),
			);
			const realTarget = path.join(tmpDir, 'real-node-modules');
			const symlinkPath = path.join(tmpDir, 'node_modules');
			try {
				fs.mkdirSync(realTarget, { recursive: true });
				fs.symlinkSync(realTarget, symlinkPath, 'dir');

				const hooks = createGuardrailsHooks(tmpDir, undefined, defaultConfig());
				const output = { args: { command: 'rm -rf node_modules' } };
				await expect(
					hooks.toolBefore(
						{ tool: 'bash', sessionID: 'test-session', callID: 'c14' },
						output,
					),
				).rejects.toThrow(/BLOCKED/);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		},
	);
});

// ---------------------------------------------------------------------------
// Group 6: block_destructive_commands: false bypasses all guards
// ---------------------------------------------------------------------------
describe('block_destructive_commands: false bypasses all guards', () => {
	test('mklink /J with external target allowed when flag is false', async () => {
		const externalTarget =
			process.platform === 'win32'
				? 'C:\\opencode\\dist3\\DocumentQA'
				: '/opt/opencode/dist3';
		const hooks = createGuardrailsHooks(
			TEST_DIR,
			undefined,
			defaultConfig({ block_destructive_commands: false }),
		);
		const output = {
			args: { command: `mklink /J link ${externalTarget}` },
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'bypass1' },
				output,
			),
		).resolves.toBeUndefined();
	});

	test('ln -s /etc/passwd mylink allowed when flag is false', async () => {
		startAgentSession('test-session', 'architect');
		const hooks = createGuardrailsHooks(
			TEST_DIR,
			undefined,
			defaultConfig({ block_destructive_commands: false }),
		);
		const output = { args: { command: 'ln -s /etc/passwd mylink' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'bypass2' },
				output,
			),
		).resolves.toBeUndefined();
	});

	test('rm -rf /etc allowed when flag is false', async () => {
		const hooks = createGuardrailsHooks(
			TEST_DIR,
			undefined,
			defaultConfig({ block_destructive_commands: false }),
		);
		const output = { args: { command: 'rm -rf /etc' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'bypass3' },
				output,
			),
		).resolves.toBeUndefined();
	});

	test('rm -rf $VAR/path allowed when flag is false (unexpanded var bypass)', async () => {
		const hooks = createGuardrailsHooks(
			TEST_DIR,
			undefined,
			defaultConfig({ block_destructive_commands: false }),
		);
		const output = { args: { command: 'rm -rf $VAR/path' } };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'bypass4' },
				output,
			),
		).resolves.toBeUndefined();
	});

	test('Remove-Item -Recurse $env:APPDATA allowed when flag is false', async () => {
		const hooks = createGuardrailsHooks(
			TEST_DIR,
			undefined,
			defaultConfig({ block_destructive_commands: false }),
		);
		const output = {
			args: { command: 'Remove-Item -Recurse $env:APPDATA' },
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'bypass5' },
				output,
			),
		).resolves.toBeUndefined();
	});

	test('rm --recursive --force /important allowed when flag is false', async () => {
		const hooks = createGuardrailsHooks(
			TEST_DIR,
			undefined,
			defaultConfig({ block_destructive_commands: false }),
		);
		const output = {
			args: { command: 'rm --recursive --force /important' },
		};
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'test-session', callID: 'bypass6' },
				output,
			),
		).resolves.toBeUndefined();
	});
});
