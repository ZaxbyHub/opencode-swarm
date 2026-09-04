/**
 * Issue #2475 (#2259): strong-mode env override translation into the runner
 * policy, plus the PR-review PRR-003 metacharacter fail-closed routing.
 *
 * _wrapWithRunner previously SKIPPED null overrides ("runner policy has no
 * unset mechanism"), silently dropping the declared PATH/TEMP/TMP/DYLD_* nulls.
 * Now nulls go to policy.env_unsets and are removed from env_allowlist; the
 * Rust runner applies them after the allowlist copy and before its managed
 * PATH/TEMP/TMP rewrites (see mode::build_child_env, which uppercases every
 * key because Windows env lookup is case-insensitive).
 *
 * PRR-003: the runner transport embeds the command as a raw cmd /c string
 * with NO metacharacter escaping, so a command containing & | < > " could
 * split the wrapper line and execute a suffix OUTSIDE the runner's
 * AppContainer/restricted token. wrapCommand must route such commands to the
 * PowerShell fallback (opaque Base64 transport, still fully wrapped) instead
 * of the runner.
 *
 * Platform: win32-gated (the executor's probe path is Windows-specific).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';

const isWin = process.platform === 'win32';

import { NativeWindowsSandboxExecutor } from '../../../src/sandbox/win32/native-sandbox-executor';
import {
	_resetProbeCache,
	_internals as runnerInternals,
} from '../../../src/sandbox/win32/runner-client';

const realFindRunnerBinary = runnerInternals.findRunnerBinary;
const realSpawnRunner = runnerInternals.spawnRunner;

const goodProbeJson = JSON.stringify({
	app_container_available: false,
	lpac_available: false,
	restricted_token_available: true,
	private_desktop_creatable: true,
	integrity_level: 'medium',
	is_admin: false,
	os_version: '10.0.22631',
	arch: 'x86_64',
	runner_version: '0.1.0',
	protocol_schema_version: 1,
});

afterEach(() => {
	(
		runnerInternals as { findRunnerBinary: typeof realFindRunnerBinary }
	).findRunnerBinary = realFindRunnerBinary;
	(runnerInternals as { spawnRunner: typeof realSpawnRunner }).spawnRunner =
		realSpawnRunner;
	_resetProbeCache();
});

function mockStrongRunner() {
	(
		runnerInternals as { findRunnerBinary: () => string | null }
	).findRunnerBinary = () => 'C:\\fake\\swarm-sandbox-runner.exe';
	(runnerInternals as { spawnRunner: typeof realSpawnRunner }).spawnRunner = ((
		_cmd: string,
		_args: string[],
		_opts: unknown,
	) => ({
		status: 0,
		stdout: goodProbeJson,
		stderr: '',
		error: null,
	})) as typeof realSpawnRunner;
}

function readWrittenPolicy(wrapped: string): Record<string, unknown> {
	// The wrapped command embeds the ABSOLUTE policy path ("type <path>").
	// Extract it directly instead of re-joining a temp-dir prefix: the OS
	// temp root's 8.3 short names (RUNNER~1) and cross-platform realpath
	// differences make a join from the test's canonical temp dir miss the
	// file the executor actually wrote (PR review PRR-013).
	const match =
		/type ("?)([A-Za-z]:[^"|]*swarm-sandbox-policies[^"|]*\.json)\1/.exec(
			wrapped,
		);
	expect(match).not.toBeNull();
	const policyPath = match?.[2] as string;
	expect(fs.existsSync(policyPath)).toBe(true);
	const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<
		string,
		unknown
	>;
	fs.rmSync(policyPath, { force: true });
	return policy;
}

describe('NativeWindowsSandboxExecutor — env_unsets policy translation (#2475)', () => {
	test.skipIf(!isWin)(
		'every declared null override lands in env_unsets and leaves the allowlist',
		() => {
			mockStrongRunner();
			_resetProbeCache();
			const executor = new NativeWindowsSandboxExecutor(['C:\\ws']);
			expect(executor.strength).toBe('strong');

			// Drive the overrides from the executor's own declared set (PR
			// review PRR-014) so the test tracks the real contract instead of a
			// hand-copied subset.
			const overrides = executor.getEnvOverrides();
			const nullKeys = Object.entries(overrides)
				.filter(([, v]) => v === null)
				.map(([k]) => k);
			expect(nullKeys.length).toBeGreaterThan(0);

			const wrapped = executor.wrapCommand(
				'echo hi',
				['C:\\ws'],
				undefined,
				overrides,
			);

			const policy = readWrittenPolicy(wrapped);
			const unsets = policy.env_unsets as string[];
			const allowlist = policy.env_allowlist as string[];

			for (const key of nullKeys) {
				expect(unsets).toContain(key);
				expect(
					allowlist.some(
						(allowed) => allowed.toUpperCase() === key.toUpperCase(),
					),
				).toBe(false);
			}
		},
	);

	test.skipIf(!isWin)(
		'string overrides land in env_overrides with their declared values',
		() => {
			mockStrongRunner();
			_resetProbeCache();
			const executor = new NativeWindowsSandboxExecutor(['C:\\ws']);

			const wrapped = executor.wrapCommand('echo hi', ['C:\\ws'], undefined, {
				...executor.getEnvOverrides(),
				HTTP_PROXY: 'http://127.0.0.1:1',
			});

			const policy = readWrittenPolicy(wrapped);
			const overrides = policy.env_overrides as Record<string, string>;
			expect(overrides.HTTP_PROXY).toBe('http://127.0.0.1:1');
		},
	);

	test.skipIf(!isWin)(
		'without overrides the policy keeps the default allowlist and empty unsets',
		() => {
			mockStrongRunner();
			_resetProbeCache();
			const executor = new NativeWindowsSandboxExecutor(['C:\\ws']);

			const wrapped = executor.wrapCommand('echo hi', ['C:\\ws']);
			const policy = readWrittenPolicy(wrapped);

			expect(policy.env_unsets).toEqual([]);
			expect(policy.env_allowlist).toContain('PATH');
			expect(policy.env_allowlist).toContain('TEMP');
		},
	);
});

describe('NativeWindowsSandboxExecutor — metacharacter fail-closed routing (PRR-003)', () => {
	test.skipIf(!isWin)(
		'a compound command with & routes to the PowerShell wrapper, never the runner',
		() => {
			mockStrongRunner();
			_resetProbeCache();
			const executor = new NativeWindowsSandboxExecutor(['C:\\ws']);
			expect(executor.strength).toBe('strong');

			const wrapped = executor.wrapCommand('echo a & del C:\\x', ['C:\\ws']);

			// PowerShell wrapper transport: opaque Base64 -EncodedCommand.
			expect(wrapped).toContain('-EncodedCommand');
			// And NOT the runner transport, whose raw cmd /c line the & could
			// split outside the sandbox boundary.
			expect(wrapped).not.toContain('swarm-sandbox-runner');
		},
	);

	test.skipIf(!isWin)(
		'a simple command still uses the runner transport (strong confinement)',
		() => {
			mockStrongRunner();
			_resetProbeCache();
			const executor = new NativeWindowsSandboxExecutor(['C:\\ws']);

			const wrapped = executor.wrapCommand('echo hi', ['C:\\ws']);

			expect(wrapped).toContain('swarm-sandbox-runner');
			expect(wrapped).not.toContain('-EncodedCommand');
		},
	);

	test.skipIf(!isWin)(
		'every cmd metacharacter class routes away from the runner',
		() => {
			mockStrongRunner();
			_resetProbeCache();
			const executor = new NativeWindowsSandboxExecutor(['C:\\ws']);

			for (const [label, cmd] of [
				['pipe', 'type a | findstr x'],
				['redirect-out', 'echo x > out.txt'],
				['redirect-in', 'sort < in.txt'],
				['double-quote', 'echo "hello world"'],
			] as const) {
				const wrapped = executor.wrapCommand(cmd, ['C:\\ws']);
				expect(
					wrapped.includes('-EncodedCommand'),
					`${label} must route to the PowerShell wrapper`,
				).toBe(true);
				expect(
					wrapped.includes('swarm-sandbox-runner'),
					`${label} must not reach the runner transport`,
				).toBe(false);
			}
		},
	);
});
