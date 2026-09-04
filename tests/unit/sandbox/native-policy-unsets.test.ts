/**
 * Issue #2475 (#2259): strong-mode env override translation into the runner
 * policy.
 *
 * _wrapWithRunner previously SKIPPED null overrides ("runner policy has no
 * unset mechanism"), silently dropping the declared PATH/TEMP/TMP/DYLD_* nulls.
 * Now nulls go to policy.env_unsets and are removed from env_allowlist; the
 * Rust runner applies them after the allowlist copy and before its managed
 * PATH/TEMP/TMP rewrites (see mode::build_child_env).
 *
 * Platform: win32-gated (the executor's probe path is Windows-specific).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const isWin = process.platform === 'win32';

import { NativeWindowsSandboxExecutor } from '../../../src/sandbox/win32/native-sandbox-executor';
import {
	_resetProbeCache,
	_internals as runnerInternals,
} from '../../../src/sandbox/win32/runner-client';
import { canonicalTmpDir } from '../../helpers/tmpdir';

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
	const rel = /swarm-sandbox-policies[\\/][A-Za-z0-9-]+\.json/.exec(
		wrapped,
	)?.[0];
	expect(rel).toBeDefined();
	const policyPath = path.join(canonicalTmpDir(), rel as string);
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
		'null overrides land in env_unsets and leave the allowlist; string overrides land in env_overrides',
		() => {
			mockStrongRunner();
			_resetProbeCache();
			const executor = new NativeWindowsSandboxExecutor(['C:\\ws']);
			expect(executor.strength).toBe('strong');

			const wrapped = executor.wrapCommand('echo hi', ['C:\\ws'], undefined, {
				PATH: null,
				TEMP: null,
				TMP: null,
				LD_PRELOAD: null,
				DYLD_INSERT_LIBRARIES: null,
				HTTP_PROXY: 'http://127.0.0.1:1',
			});

			const policy = readWrittenPolicy(wrapped);
			const unsets = policy.env_unsets as string[];
			const allowlist = policy.env_allowlist as string[];
			const overrides = policy.env_overrides as Record<string, string>;

			for (const key of [
				'PATH',
				'TEMP',
				'TMP',
				'LD_PRELOAD',
				'DYLD_INSERT_LIBRARIES',
			]) {
				expect(unsets).toContain(key);
				expect(
					allowlist.some(
						(allowed) => allowed.toUpperCase() === key.toUpperCase(),
					),
				).toBe(false);
			}
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
