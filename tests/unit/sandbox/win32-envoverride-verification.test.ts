/**
 * Additional Windows sandbox envOverride verification tests.
 *
 * These tests complement the coverage in win32.test.ts by targeting:
 * - Values containing '=' (equals sign) on the weak (PowerShell) path
 * - Values containing '=' (equals sign) on the strong (native runner) path
 * - Cross-platform injection correctness for Windows paths
 *
 * Platform: Windows only (these executors are Windows-specific)
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';

const isWin = process.platform === 'win32';

import { NativeWindowsSandboxExecutor } from '../../../src/sandbox/win32/native-sandbox-executor';
import {
	_internals as reInternals,
	WindowsSandboxExecutor,
} from '../../../src/sandbox/win32/restricted-environment-executor';
import {
	_resetProbeCache,
	_internals as runnerInternals,
} from '../../../src/sandbox/win32/runner-client';

// Save real implementations
const realFindRunnerBinary = runnerInternals.findRunnerBinary;
const realSpawnRunner = runnerInternals.spawnRunner;
const realProbeWindowsSandbox = reInternals.probeWindowsSandbox;

afterEach(() => {
	(
		runnerInternals as { findRunnerBinary: typeof realFindRunnerBinary }
	).findRunnerBinary = realFindRunnerBinary;
	(runnerInternals as { spawnRunner: typeof realSpawnRunner }).spawnRunner =
		realSpawnRunner;
	_resetProbeCache();
	(
		reInternals as { probeWindowsSandbox: typeof realProbeWindowsSandbox }
	).probeWindowsSandbox = realProbeWindowsSandbox;
});

function mockProbeAvailable() {
	(reInternals as { probeWindowsSandbox: () => boolean }).probeWindowsSandbox =
		() => true;
}

function decodeWrappedScript(wrapped: string): string {
	const payload = /-EncodedCommand\s+([A-Za-z0-9+/=]+)/.exec(wrapped)?.[1];
	return payload ? Buffer.from(payload, 'base64').toString('utf16le') : wrapped;
}

// ---------------------------------------------------------------------------
// Supplementary envOverride tests
// ---------------------------------------------------------------------------

describe('WindowsSandboxExecutor — envOverride verification (supplementary)', () => {
	// -----------------------------------------------------------------------
	// Equals sign in value — PowerShell single-quoted strings treat = as literal
	// -----------------------------------------------------------------------

	describe('weak path — equals sign in value', () => {
		test.skipIf(!isWin)(
			'value with embedded equals sign is preserved in PowerShell single-quoted string',
			() => {
				mockProbeAvailable();
				const executor = new WindowsSandboxExecutor([]);
				const wrapped = executor.wrapCommand('echo hello', [], undefined, {
					FOO: 'a=b=c',
				});
				// PowerShell single-quoted strings preserve content verbatim
				// So the value a=b=c should appear as-is in $env:FOO = 'a=b=c';
				expect(decodeWrappedScript(wrapped)).toContain("$env:FOO = 'a=b=c';");
			},
		);

		test.skipIf(!isWin)(
			'value that is just an equals sign is preserved correctly',
			() => {
				mockProbeAvailable();
				const executor = new WindowsSandboxExecutor([]);
				const wrapped = executor.wrapCommand('echo hello', [], undefined, {
					X: '=',
				});
				expect(decodeWrappedScript(wrapped)).toContain("$env:X = '=';");
			},
		);

		test.skipIf(!isWin)(
			'value with dollar sign is preserved in single-quoted string (no expansion)',
			() => {
				mockProbeAvailable();
				const executor = new WindowsSandboxExecutor([]);
				const wrapped = executor.wrapCommand('echo hello', [], undefined, {
					DOLLAR: '$HOME',
				});
				// PowerShell single-quoted strings do NOT expand variables
				expect(decodeWrappedScript(wrapped)).toContain(
					"$env:DOLLAR = '$HOME';",
				);
			},
		);

		test.skipIf(!isWin)(
			'value with semicolon is preserved (not a statement separator in single-quoted string)',
			() => {
				mockProbeAvailable();
				const executor = new WindowsSandboxExecutor([]);
				const wrapped = executor.wrapCommand('echo hello', [], undefined, {
					SEMI: 'a;b',
				});
				expect(decodeWrappedScript(wrapped)).toContain("$env:SEMI = 'a;b';");
			},
		);
	});

	// -----------------------------------------------------------------------
	// Security: key with shell metacharacters is rejected
	// -----------------------------------------------------------------------

	describe('weak path — invalid key rejection', () => {
		test.skipIf(!isWin)(
			'key with dollar sign (variable injection attempt) is rejected silently',
			() => {
				mockProbeAvailable();
				const executor = new WindowsSandboxExecutor([]);
				const wrapped = executor.wrapCommand('echo hello', [], undefined, {
					$FOO: 'value',
				});
				// $FOO is not a valid env var name — must not appear in PS script
				expect(decodeWrappedScript(wrapped)).not.toContain('$FOO');
				expect(decodeWrappedScript(wrapped)).not.toContain('$env:$');
			},
		);

		test.skipIf(!isWin)(
			'key with ampersand (call operator) is rejected silently',
			() => {
				mockProbeAvailable();
				const executor = new WindowsSandboxExecutor([]);
				const wrapped = executor.wrapCommand('echo hello', [], undefined, {
					'FOO&BAR': 'value',
				});
				expect(decodeWrappedScript(wrapped)).not.toContain('FOO&BAR');
				expect(decodeWrappedScript(wrapped)).not.toContain('$env:FOO');
			},
		);
	});
});

describe('NativeWindowsSandboxExecutor — envOverride verification (supplementary)', () => {
	// -----------------------------------------------------------------------
	// Equals sign in value — strong (native runner) path uses JSON policy
	// -----------------------------------------------------------------------

	describe('strong path — equals sign in value (native runner / policy JSON)', () => {
		test.skipIf(!isWin)(
			'value with embedded equals sign is serialized correctly in policy JSON',
			() => {
				// Force the strong path by keeping runner available
				_resetProbeCache();

				const executor = new NativeWindowsSandboxExecutor([]);
				if (!executor.isAvailable() || !executor.hasNativeRunner) return;

				const wrapped = executor.wrapCommand(
					'echo hello',
					[process.cwd()],
					undefined,
					{ FOO: 'a=b=c' },
				);

				// Extract the policy file path from the wrapped command
				const policyFileMatch = wrapped.match(/type (.+?) \|/);
				expect(policyFileMatch).not.toBeNull();
				const policyFile = policyFileMatch![1];

				// Read the policy JSON and verify the env override value is correct
				const policyContent = fs.readFileSync(policyFile, 'utf-8');
				const policy = JSON.parse(policyContent);
				expect(policy.env_overrides).toBeDefined();
				expect(policy.env_overrides.FOO).toBe('a=b=c');
			},
		);

		test.skipIf(!isWin)(
			'value that is just an equals sign is serialized correctly',
			() => {
				_resetProbeCache();

				const executor = new NativeWindowsSandboxExecutor([]);
				if (!executor.isAvailable() || !executor.hasNativeRunner) return;

				const wrapped = executor.wrapCommand(
					'echo hello',
					[process.cwd()],
					undefined,
					{ X: '=' },
				);

				const policyFileMatch = wrapped.match(/type (.+?) \|/);
				expect(policyFileMatch).not.toBeNull();
				const policyFile = policyFileMatch![1];

				const policyContent = fs.readFileSync(policyFile, 'utf-8');
				const policy = JSON.parse(policyContent);
				expect(policy.env_overrides.X).toBe('=');
			},
		);
	});

	// -----------------------------------------------------------------------
	// Cross-platform injection correctness
	// -----------------------------------------------------------------------

	describe('strong path — injection correctness', () => {
		test.skipIf(!isWin)(
			'envOverride is present in policy JSON with correct string value',
			() => {
				_resetProbeCache();

				const executor = new NativeWindowsSandboxExecutor([]);
				if (!executor.isAvailable() || !executor.hasNativeRunner) return;

				const wrapped = executor.wrapCommand(
					'echo hello',
					[process.cwd()],
					undefined,
					{ INJECT_ME: 'injected_value' },
				);

				const policyFileMatch = wrapped.match(/type (.+?) \|/);
				expect(policyFileMatch).not.toBeNull();
				const policyFile = policyFileMatch![1];

				const policyContent = fs.readFileSync(policyFile, 'utf-8');
				const policy = JSON.parse(policyContent);
				// The native runner reads policy.env_overrides and sets each key
				// as an environment variable in the sandboxed process.
				expect(policy.env_overrides.INJECT_ME).toBe('injected_value');
			},
		);

		test.skipIf(!isWin)(
			'mixed valid and invalid keys: valid appear in policy, invalid are silently dropped',
			() => {
				_resetProbeCache();

				const executor = new NativeWindowsSandboxExecutor([]);
				if (!executor.isAvailable() || !executor.hasNativeRunner) return;

				const wrapped = executor.wrapCommand(
					'echo hello',
					[process.cwd()],
					undefined,
					{
						VALID_KEY: 'valid_value',
						'INVALID;KEY': 'should_be_dropped',
						ANOTHER_VALID: 'another_value',
					},
				);

				const policyFileMatch = wrapped.match(/type (.+?) \|/);
				expect(policyFileMatch).not.toBeNull();
				const policyFile = policyFileMatch![1];

				const policyContent = fs.readFileSync(policyFile, 'utf-8');
				const policy = JSON.parse(policyContent);

				// Valid keys are present
				expect(policy.env_overrides.VALID_KEY).toBe('valid_value');
				expect(policy.env_overrides.ANOTHER_VALID).toBe('another_value');
				// Invalid key must not appear
				expect(policy.env_overrides['INVALID;KEY']).toBeUndefined();
				expect(
					Object.keys(policy.env_overrides).some((k) => k.includes('INVALID')),
				).toBe(false);
			},
		);
	});
});
