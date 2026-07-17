/**
 * Tests for Windows sandbox implementation:
 * - src/sandbox/win32/native-sandbox-executor.ts (NativeWindowsSandboxExecutor)
 * - src/sandbox/win32/restricted-environment-executor.ts (legacy EnvironmentExecutor)
 * - src/sandbox/win32/runner-client.ts (runner binary client)
 * - src/sandbox/win32/edge-cases.ts (Windows-specific security detection)
 *
 * Platform notes:
 * - Executor tests that use native runner are skipped on non-Windows platforms.
 * - Edge case positive tests (detecting real escape patterns) are skipped on non-Windows.
 * - Edge case negative tests (verifying safe commands return false) run on all platforms.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const isWin = process.platform === 'win32';

// Windows executor — NativeWindowsSandboxExecutor

import { NativeWindowsSandboxExecutor } from '../../../src/sandbox/win32/native-sandbox-executor';
import {
	_resetProbeCache,
	_internals as runnerInternals,
} from '../../../src/sandbox/win32/runner-client';

// Save real implementations
const realFindRunnerBinary = runnerInternals.findRunnerBinary;
const realSpawnRunner = runnerInternals.spawnRunner;

afterEach(() => {
	(
		runnerInternals as { findRunnerBinary: typeof realFindRunnerBinary }
	).findRunnerBinary = realFindRunnerBinary;
	(runnerInternals as { spawnRunner: typeof realSpawnRunner }).spawnRunner =
		realSpawnRunner;
	_resetProbeCache();
});

// Windows edge-cases — real implementations

import * as edge from '../../../src/sandbox/win32/edge-cases';

// WindowsSandboxExecutor — restricted-environment-executor.ts

import { SandboxError } from '../../../src/sandbox/executor';
import {
	_internals as reInternals,
	WindowsSandboxExecutor,
} from '../../../src/sandbox/win32/restricted-environment-executor';

// Save real implementation
const realProbeWindowsSandbox = reInternals.probeWindowsSandbox;

afterEach(() => {
	(
		reInternals as { probeWindowsSandbox: typeof realProbeWindowsSandbox }
	).probeWindowsSandbox = realProbeWindowsSandbox;
});

// Mock the sandbox probe so wrapCommand reaches string-level validation on all platforms.
function mockProbeAvailable() {
	(reInternals as { probeWindowsSandbox: () => boolean }).probeWindowsSandbox =
		() => true;
}

function decodeWrappedScript(wrapped: string): string {
	const payload = /-EncodedCommand\s+([A-Za-z0-9+/=]+)/.exec(wrapped)?.[1];
	return payload ? Buffer.from(payload, 'base64').toString('utf16le') : wrapped;
}

// Test suite — NativeWindowsSandboxExecutor
describe('NativeWindowsSandboxExecutor', () => {
	// 1. Constructor — mechanism property

	describe('constructor', () => {
		test.skipIf(!isWin)(
			'mechanism property reflects runner availability',
			() => {
				// Mock runner as unavailable to test fallback
				(
					runnerInternals as { findRunnerBinary: () => string | null }
				).findRunnerBinary = () => null;
				_resetProbeCache();
				const executor = new NativeWindowsSandboxExecutor([]);
				expect(
					executor.mechanism === 'powershell-wrapper' ||
						executor.mechanism.startsWith('native-runner/'),
				).toBe(true);
			},
		);

		test.skipIf(!isWin)('strength is weak when runner binary missing', () => {
			(
				runnerInternals as { findRunnerBinary: () => string | null }
			).findRunnerBinary = () => null;
			_resetProbeCache();

			const executor = new NativeWindowsSandboxExecutor([]);
			expect(executor.strength).toBe('weak');
		});
	});

	// 2. isAvailable()

	describe('isAvailable()', () => {
		test.skipIf(!isWin)(
			'returns true on Windows when PowerShell fallback works',
			() => {
				(
					runnerInternals as { findRunnerBinary: () => string | null }
				).findRunnerBinary = () => null;
				_resetProbeCache();

				const executor = new NativeWindowsSandboxExecutor([]);
				expect(typeof executor.isAvailable()).toBe('boolean');
				// Should be available at least via PowerShell fallback
				expect(executor.isAvailable()).toBe(true);
			},
		);

		test('returns false on non-Windows platforms', () => {
			if (isWin) return;
			(
				runnerInternals as { findRunnerBinary: () => string | null }
			).findRunnerBinary = () => null;
			_resetProbeCache();

			const executor = new NativeWindowsSandboxExecutor([]);
			expect(executor.isAvailable()).toBe(false);
		});
	});

	// 3. wrapCommand()

	describe('wrapCommand()', () => {
		test.skipIf(!isWin)('wraps with PowerShell when runner unavailable', () => {
			(
				runnerInternals as { findRunnerBinary: () => string | null }
			).findRunnerBinary = () => null;
			_resetProbeCache();

			const executor = new NativeWindowsSandboxExecutor([]);
			if (executor.isAvailable()) {
				const wrapped = executor.wrapCommand('echo hello', []);
				expect(wrapped.toLowerCase()).toContain('powershell');
			}
		});

		test.skipIf(!isWin)('throws when executor is disabled', () => {
			(
				runnerInternals as { findRunnerBinary: () => string | null }
			).findRunnerBinary = () => null;
			_resetProbeCache();

			const executor = new NativeWindowsSandboxExecutor([]);
			executor.disable('test');
			expect(() => executor.wrapCommand('echo hello', [])).toThrow();
		});

		test('throws when not available on non-Windows', () => {
			if (isWin) return;
			(
				runnerInternals as { findRunnerBinary: () => string | null }
			).findRunnerBinary = () => null;
			_resetProbeCache();

			const executor = new NativeWindowsSandboxExecutor([]);
			expect(() => executor.wrapCommand('echo hello', [])).toThrow();
		});
	});

	// 3b. wrapCommand() envOverrides forwarding

	describe('wrapCommand() envOverrides forwarding', () => {
		test.skipIf(!isWin)(
			'forwards envOverrides to PowerShell fallback when runner unavailable',
			() => {
				(
					runnerInternals as { findRunnerBinary: () => string | null }
				).findRunnerBinary = () => null;
				_resetProbeCache();

				const executor = new NativeWindowsSandboxExecutor([]);
				if (!executor.isAvailable()) return;
				const wrapped = executor.wrapCommand('echo hello', [], undefined, {
					MY_VAR: 'my_value',
				});
				// Should forward to PowerShell fallback which sets $env:MY_VAR
				expect(wrapped.toLowerCase()).toContain('powershell');
				expect(decodeWrappedScript(wrapped)).toContain(
					"$env:MY_VAR = 'my_value';",
				);
			},
		);

		test.skipIf(!isWin)(
			'forwards envOverrides to strong path (runner binary) when runner available',
			() => {
				// Keep runner available (use real findRunnerBinary)
				_resetProbeCache();

				const executor = new NativeWindowsSandboxExecutor([]);
				if (!executor.isAvailable() || !executor.hasNativeRunner) return;
				// The strong path pipes policy JSON to the runner binary
				// envOverrides are forwarded as the 4th parameter
				const wrapped = executor.wrapCommand(
					'echo hello',
					['/scope'],
					undefined,
					{ MY_VAR: 'runner_value' },
				);
				// Should use the runner binary path (cmd /c ... | runner ...)
				expect(wrapped).toContain('runner');
			},
		);

		test.skipIf(!isWin)(
			'applies envOverrides to policy JSON on strong path (runner binary)',
			() => {
				_resetProbeCache();

				const executor = new NativeWindowsSandboxExecutor([]);
				if (!executor.isAvailable() || !executor.hasNativeRunner) return;

				const wrapped = executor.wrapCommand(
					'echo hello',
					[process.cwd()],
					undefined,
					{ MY_VAR: 'runner_value' },
				);

				// Extract the policy file path from the wrapped command.
				// The command format is: cmd /c "type <policyFile> | <binary> ..."
				const policyFileMatch = wrapped.match(/type (.+?) \|/);
				expect(policyFileMatch).not.toBeNull();
				const policyFile = policyFileMatch![1];

				// Read the policy JSON and verify the env override is present.
				const policyContent = fs.readFileSync(policyFile, 'utf-8');
				const policy = JSON.parse(policyContent);
				expect(policy.env_overrides).toBeDefined();
				expect(policy.env_overrides.MY_VAR).toBe('runner_value');
			},
		);

		test.skipIf(!isWin)(
			'skips null envOverrides values on strong path (no unset mechanism in runner)',
			() => {
				_resetProbeCache();

				const executor = new NativeWindowsSandboxExecutor([]);
				if (!executor.isAvailable() || !executor.hasNativeRunner) return;

				const wrapped = executor.wrapCommand(
					'echo hello',
					[process.cwd()],
					undefined,
					{ MY_VAR_TO_UNSET: null },
				);

				// Extract and read the policy file
				const policyFileMatch = wrapped.match(/type (.+?) \|/);
				expect(policyFileMatch).not.toBeNull();
				const policyFile = policyFileMatch![1];

				const policyContent = fs.readFileSync(policyFile, 'utf-8');
				const policy = JSON.parse(policyContent);
				// null values should not be set in env_overrides (runner has no unset)
				expect(policy.env_overrides.MY_VAR_TO_UNSET).toBeUndefined();
			},
		);

		test.skipIf(!isWin)(
			'invalid env var key is silently skipped on strong path',
			() => {
				_resetProbeCache();

				const executor = new NativeWindowsSandboxExecutor([]);
				if (!executor.isAvailable() || !executor.hasNativeRunner) return;

				const wrapped = executor.wrapCommand(
					'echo hello',
					[process.cwd()],
					undefined,
					{ 'FOO:BAR': 'value' },
				);

				// Extract and read the policy file
				const policyFileMatch = wrapped.match(/type (.+?) \|/);
				expect(policyFileMatch).not.toBeNull();
				const policyFile = policyFileMatch![1];

				const policyContent = fs.readFileSync(policyFile, 'utf-8');
				const policy = JSON.parse(policyContent);
				// Invalid key must not appear in env_overrides
				expect(policy.env_overrides['FOO:BAR']).toBeUndefined();
				expect(
					Object.keys(policy.env_overrides).some((k) => k.includes('FOO')),
				).toBe(false);
			},
		);

		test.skipIf(!isWin)(
			'value with single quotes doubles them in PowerShell fallback',
			() => {
				(
					runnerInternals as { findRunnerBinary: () => string | null }
				).findRunnerBinary = () => null;
				_resetProbeCache();

				const executor = new NativeWindowsSandboxExecutor([]);
				if (!executor.isAvailable()) return;
				const wrapped = executor.wrapCommand('echo hello', [], undefined, {
					MY_VAR: "it's",
				});
				// Single quotes in PowerShell single-quoted strings are escaped by doubling
				expect(decodeWrappedScript(wrapped)).toContain(
					"$env:MY_VAR = 'it''s';",
				);
			},
		);

		test.skipIf(!isWin)(
			'invalid env var key is rejected silently in PowerShell fallback',
			() => {
				(
					runnerInternals as { findRunnerBinary: () => string | null }
				).findRunnerBinary = () => null;
				_resetProbeCache();

				const executor = new NativeWindowsSandboxExecutor([]);
				if (!executor.isAvailable()) return;
				// Key with colon is invalid per POSIX: [a-zA-Z_][a-zA-Z0-9_]*
				const wrapped = executor.wrapCommand('echo hello', [], undefined, {
					'FOO:BAR': 'value',
				});
				// Invalid key must not appear in the wrapped command
				expect(wrapped).not.toContain('FOO:BAR');
				expect(wrapped).not.toContain('$env:FOO');
			},
		);
	});

	// 4. getEnvOverrides()

	describe('getEnvOverrides()', () => {
		test.skipIf(!isWin)('returns env var scrubbing', () => {
			(
				runnerInternals as { findRunnerBinary: () => string | null }
			).findRunnerBinary = () => null;
			_resetProbeCache();

			const executor = new NativeWindowsSandboxExecutor([]);
			const env = executor.getEnvOverrides();
			expect(typeof env).toBe('object');
			expect(env).toHaveProperty('PATH');
			expect(env).toHaveProperty('LD_PRELOAD');
		});

		test('returns overrides regardless of platform', () => {
			(
				runnerInternals as { findRunnerBinary: () => string | null }
			).findRunnerBinary = () => null;
			_resetProbeCache();

			const executor = new NativeWindowsSandboxExecutor([]);
			if (executor.isAvailable()) {
				const env = executor.getEnvOverrides();
				expect(typeof env).toBe('object');
			}
		});
	});

	// 5. disable()

	describe('disable()', () => {
		test.skipIf(!isWin)('sets disabled and isAvailable() returns false', () => {
			(
				runnerInternals as { findRunnerBinary: () => string | null }
			).findRunnerBinary = () => null;
			_resetProbeCache();

			const executor = new NativeWindowsSandboxExecutor([]);
			executor.disable('test');
			expect(executor.isAvailable()).toBe(false);
			expect(executor.strength).toBe('none');
		});

		test('disable() is callable on non-Windows without throwing', () => {
			if (isWin) return;
			(
				runnerInternals as { findRunnerBinary: () => string | null }
			).findRunnerBinary = () => null;
			_resetProbeCache();

			const executor = new NativeWindowsSandboxExecutor([]);
			executor.disable('test');
			expect(executor.isAvailable()).toBe(false);
		});
	});

	// 6. hasNativeRunner / probeResult

	describe('probeResult', () => {
		test('probeResult is always defined', () => {
			(
				runnerInternals as { findRunnerBinary: () => string | null }
			).findRunnerBinary = () => null;
			_resetProbeCache();

			const executor = new NativeWindowsSandboxExecutor([]);
			expect(executor.probeResult).toBeDefined();
			expect(typeof executor.probeResult.available).toBe('boolean');
			expect(typeof executor.probeResult.mode).toBe('string');
		});

		test('hasNativeRunner is false when binary missing', () => {
			(
				runnerInternals as { findRunnerBinary: () => string | null }
			).findRunnerBinary = () => null;
			_resetProbeCache();

			const executor = new NativeWindowsSandboxExecutor([]);
			expect(executor.hasNativeRunner).toBe(false);
		});
	});
});

// edge-cases — detectPathTraversal
// Path traversal detection for Windows paths

describe('detectPathTraversal', () => {
	test.skipIf(!isWin)('returns true for ../ traversal attempt', () => {
		const result = edge.detectPathTraversal(
			'C:\\scope\\..\\..\\Windows\\System32',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for ..\\ traversal attempt', () => {
		const result = edge.detectPathTraversal(
			'C:\\scope\\..\\..\\Windows\\System32',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for multiple dot-dot segments', () => {
		const result = edge.detectPathTraversal('C:\\scope\\a\\b\\..\\..\\..\\etc');
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns false for path inside scope', () => {
		const result = edge.detectPathTraversal('C:\\scope\\myfile.txt');
		expect(result).toBe(false);
	});

	test.skipIf(!isWin)('returns false for normalized path inside scope', () => {
		const result = edge.detectPathTraversal('C:\\scope\\subdir\\file.txt');
		expect(result).toBe(false);
	});

	test('returns false on non-Windows platforms', () => {
		if (isWin) return;
		// On non-Windows, path traversal in Windows path format cannot succeed.
		const result = edge.detectPathTraversal('C:\\scope\\..\\..\\Windows');
		expect(result).toBe(false);
	});
});

// edge-cases — detectRegistryEscape
// Windows registry escape detection

describe('detectRegistryEscape', () => {
	test.skipIf(!isWin)('returns true for HKLM\\... escape attempt', () => {
		const result = edge.detectRegistryEscape('reg query HKLM\\Security\\SAM');
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for HKEY_LOCAL_MACHINE full form', () => {
		const result = edge.detectRegistryEscape(
			'reg query HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for HKCU escape attempt', () => {
		const result = edge.detectRegistryEscape(
			'reg query HKCU\\Software\\Classes',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)(
		'returns true for registry path with ..\\ attempt',
		() => {
			const result = edge.detectRegistryEscape(
				'reg query HKLM\\..\\HKLM\\Security\\SAM',
			);
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isWin)(
		'returns false for safe registry query inside scope',
		() => {
			// Only registry operations that escape the sandboxed scope are flagged
			const result = edge.detectRegistryEscape(
				'reg query HKCU\\Software\\Microsoft',
			);
			expect(result).toBe(false);
		},
	);

	test.skipIf(!isWin)('returns false for echo command', () => {
		const result = edge.detectRegistryEscape('echo hello');
		expect(result).toBe(false);
	});

	test('returns false on non-Windows platforms', () => {
		if (isWin) return;
		const result = edge.detectRegistryEscape('reg query HKLM\\Security\\SAM');
		expect(result).toBe(false);
	});
});

// edge-cases — detectPowerShellEscape
// PowerShell escape and bypass detection

describe('detectPowerShellEscape', () => {
	test.skipIf(!isWin)(
		'returns true for PowerShell -Command with bypass',
		() => {
			const result = edge.detectPowerShellEscape(
				'powershell -Command "Invoke-Expression (Get-Content C:\\Windows\\System32\\config\\SAM)"',
			);
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isWin)('returns true for -EncodedCommand base64 payload', () => {
		const result = edge.detectPowerShellEscape(
			'powershell -EncodedCommand SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAIABPAG4AZABvAHcAcwAgAE4AZQBtACkA',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for -ExecutionPolicy Bypass', () => {
		const result = edge.detectPowerShellEscape(
			'powershell -ExecutionPolicy Bypass -File C:\\temp\\script.ps1',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for -WindowStyle Hidden', () => {
		const result = edge.detectPowerShellEscape(
			'powershell -WindowStyle Hidden -Command "Invoke-WebRequest"',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for -NoProfile flag', () => {
		const result = edge.detectPowerShellEscape(
			'powershell -NoProfile -Command "Get-Process"',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)(
		'returns true for Invoke-Expression with variable expansion',
		() => {
			const result = edge.detectPowerShellEscape(
				'powershell -Command "$env:COMPUTERNAME"',
			);
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isWin)('returns false for simple echo command', () => {
		const result = edge.detectPowerShellEscape('echo hello');
		expect(result).toBe(false);
	});

	test.skipIf(!isWin)(
		'returns false for PowerShell without suspicious flags',
		() => {
			const result = edge.detectPowerShellEscape(
				'powershell -Command "Get-Date"',
			);
			expect(result).toBe(false);
		},
	);

	test('returns false on non-Windows platforms', () => {
		if (isWin) return;
		const result = edge.detectPowerShellEscape(
			'powershell -EncodedCommand SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAIABPAG4AZABvAHcAcwAgAE4AZQBtACkA',
		);
		expect(result).toBe(false);
	});
});

// edge-cases — detectWMIEscape
// WMI (Windows Management Instrumentation) escape detection

describe('detectWMIEscape', () => {
	test.skipIf(!isWin)(
		'returns true for wmic process call create escape',
		() => {
			const result = edge.detectWMIEscape(
				'wmic process call create "cmd.exe /c calc"',
			);
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isWin)('returns true for wmic path with escape attempt', () => {
		const result = edge.detectWMIEscape(
			'wmic /node:localhost path Win32_Process where "Name=\'cmd.exe\'" call terminate',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)(
		'returns true for Get-WmiObject with computer name',
		() => {
			const result = edge.detectWMIEscape(
				'powershell -Command "Get-WmiObject -Class Win32_Process -ComputerName ."',
			);
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isWin)('returns true for Invoke-WmiMethod', () => {
		const result = edge.detectWMIEscape(
			"powershell -Command \"Invoke-WmiMethod -Path 'Win32_Process' -Name Create -ArgumentList 'calc'\"",
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)(
		'returns true for Register-WmiEvent with malicious script',
		() => {
			const result = edge.detectWMIEscape(
				'powershell -Command "Register-WmiEvent -Action \'calc\'"',
			);
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isWin)('returns false for safe wmic query', () => {
		const result = edge.detectWMIEscape('wmic os get caption');
		expect(result).toBe(false);
	});

	test.skipIf(!isWin)('returns false for echo command', () => {
		const result = edge.detectWMIEscape('echo hello');
		expect(result).toBe(false);
	});

	test('returns false on non-Windows platforms', () => {
		if (isWin) return;
		const result = edge.detectWMIEscape(
			'wmic process call create "cmd.exe /c calc"',
		);
		expect(result).toBe(false);
	});
});

// edge-cases — detectServiceEscalation
// Windows service privilege escalation detection

describe('detectServiceEscalation', () => {
	test.skipIf(!isWin)('returns true for sc create escape', () => {
		const result = edge.detectServiceEscalation(
			'sc create MaliciousService binPath= "cmd.exe /c calc"',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for sc config withbinPath', () => {
		const result = edge.detectServiceEscalation(
			'sc config Spooler binPath= "C:\\temp\\evil.exe"',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)(
		'returns true for net start with malicious service',
		() => {
			const result = edge.detectServiceEscalation('net start MaliciousService');
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isWin)('returns true for sc delete escape attempt', () => {
		const result = edge.detectServiceEscalation('sc delete AudioSrv');
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for sc control with arbitrary code', () => {
		const result = edge.detectServiceEscalation('sc control Spooler 1337');
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)(
		'returns true for powershell New-Service with -OutFile',
		() => {
			const result = edge.detectServiceEscalation(
				"powershell -Command \"New-Service -Name 'Evil' -BinaryPathName 'calc'\"",
			);
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isWin)('returns false for safe sc query', () => {
		const result = edge.detectServiceEscalation('sc query Spooler');
		expect(result).toBe(false);
	});

	test.skipIf(!isWin)('returns false for echo command', () => {
		const result = edge.detectServiceEscalation('echo hello');
		expect(result).toBe(false);
	});

	test('returns false on non-Windows platforms', () => {
		if (isWin) return;
		const result = edge.detectServiceEscalation(
			'sc create MaliciousService binPath= "cmd.exe /c calc"',
		);
		expect(result).toBe(false);
	});
});

// edge-cases — detectDLLHijacking
// DLL search order hijacking detection

describe('detectDLLHijacking', () => {
	test.skipIf(!isWin)('returns true for path with null byte injection', () => {
		const result = edge.detectDLLHijacking(
			'C:\\scope\\app.exe\x00C:\\Windows\\System32\\evil.dll',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for UNC path in DLL reference', () => {
		const result = edge.detectDLLHijacking('\\\\server\\share\\malicious.dll');
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for relative path DLL traversal', () => {
		const result = edge.detectDLLHijacking(
			'..\\..\\Windows\\System32\\evil.dll',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for DLL load from temp directory', () => {
		const result = edge.detectDLLHijacking(
			'C:\\Users\\user\\AppData\\Local\\Temp\\evil.dll',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)(
		'returns false for DLL in system32 (legitimate path)',
		() => {
			const result = edge.detectDLLHijacking(
				'C:\\Windows\\System32\\kernel32.dll',
			);
			expect(result).toBe(false);
		},
	);

	test.skipIf(!isWin)('returns false for DLL inside scope', () => {
		const result = edge.detectDLLHijacking('C:\\scope\\mylib.dll');
		expect(result).toBe(false);
	});

	test.skipIf(!isWin)('returns false for exe without DLL reference', () => {
		const result = edge.detectDLLHijacking('C:\\scope\\app.exe');
		expect(result).toBe(false);
	});

	test('returns false on non-Windows platforms', () => {
		if (isWin) return;
		const result = edge.detectDLLHijacking(
			'C:\\Users\\user\\AppData\\Local\\Temp\\evil.dll',
		);
		expect(result).toBe(false);
	});
});

// edge-cases — detectTokenManipulation
// Windows access token manipulation detection

describe('detectTokenManipulation', () => {
	test.skipIf(!isWin)(
		'returns true for CreateProcessWithLogon API abuse',
		() => {
			const result = edge.detectTokenManipulation(
				'CreateProcessWithLogonW L"attacker" L"DOMAIN" L"pass" LOGON_WITH_PROFILE',
			);
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isWin)('returns true for DuplicateTokenEx manipulation', () => {
		const result = edge.detectTokenManipulation(
			'DuplicateTokenEx(hToken, TOKEN_ALL_ACCESS, &newToken)',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)('returns true for ImpersonateLoggedOnUser escape', () => {
		const result = edge.detectTokenManipulation(
			'ImpersonateLoggedOnUser(hToken)',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)(
		'returns true for RevertToSelf not paired with impersonation',
		() => {
			const result = edge.detectTokenManipulation('RevertToSelf()');
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isWin)('returns true for SetThreadToken with NULL', () => {
		const result = edge.detectTokenManipulation('SetThreadToken(NULL, hToken)');
		expect(result).toBe(true);
	});

	test.skipIf(!isWin)(
		'returns true for LogonUser with malicious parameters',
		() => {
			const result = edge.detectTokenManipulation(
				'LogonUserA("admin", "DOMAIN", "password", LOGON_TYPE_NEW_CREDENTIALS)',
			);
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isWin)('returns false for legitimate CreateProcess call', () => {
		const result = edge.detectTokenManipulation(
			'CreateProcessA(NULL, "notepad.exe", NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)',
		);
		expect(result).toBe(false);
	});

	test.skipIf(!isWin)('returns false for echo command', () => {
		const result = edge.detectTokenManipulation('echo hello');
		expect(result).toBe(false);
	});

	test('returns false on non-Windows platforms', () => {
		if (isWin) return;
		const result = edge.detectTokenManipulation(
			'ImpersonateLoggedOnUser(hToken)',
		);
		expect(result).toBe(false);
	});
});

// WindowsSandboxExecutor — PATH resolution and PS-native command branching

describe('WindowsSandboxExecutor', () => {
	describe('getEnvOverrides() PATH resolution', () => {
		const originalSystemRoot = process.env.SystemRoot;

		afterEach(() => {
			if (originalSystemRoot === undefined) {
				delete process.env.SystemRoot;
			} else {
				process.env.SystemRoot = originalSystemRoot;
			}
		});

		test('PATH includes System32 and uses SystemRoot env var', () => {
			process.env.SystemRoot = 'C:\\Windows';
			const executor = new WindowsSandboxExecutor([]);
			const path = executor.getEnvOverrides().PATH ?? '';
			expect(path.split(';').slice(0, 2).join(';')).toBe(
				'C:\\Windows\\System32;C:\\Windows',
			);
		});

		test('PATH falls back to C:\\Windows when SystemRoot is missing', () => {
			delete process.env.SystemRoot;
			const executor = new WindowsSandboxExecutor([]);
			const path = executor.getEnvOverrides().PATH ?? '';
			expect(path.split(';').slice(0, 2).join(';')).toBe(
				'C:\\Windows\\System32;C:\\Windows',
			);
		});

		test('PATH uses non-standard SystemRoot when it is valid', () => {
			process.env.SystemRoot = 'D:\\WinNT';
			const executor = new WindowsSandboxExecutor([]);
			const path = executor.getEnvOverrides().PATH ?? '';
			expect(path.split(';').slice(0, 2).join(';')).toBe(
				'D:\\WinNT\\System32;D:\\WinNT',
			);
		});
	});

	describe('wrapCommand() PowerShell-native command handling', () => {
		test('PS-native command (Remove-Item) uses Invoke-Expression not cmd /c', () => {
			mockProbeAvailable();
			const executor = new WindowsSandboxExecutor([]);
			expect(executor.isAvailable()).toBe(true); // Fail loud if mock did not apply
			const wrapped = decodeWrappedScript(
				executor.wrapCommand('Remove-Item foo.txt', []),
			);
			expect(wrapped.toLowerCase()).toContain('invoke-expression');
			expect(wrapped).not.toMatch(/cmd\s+\/c\s+"/i);
		});

		test('non-PS-native command (echo hello) uses cmd /c not Invoke-Expression', () => {
			mockProbeAvailable();
			const executor = new WindowsSandboxExecutor([]);
			expect(executor.isAvailable()).toBe(true); // Fail loud if mock did not apply
			const wrapped = decodeWrappedScript(
				executor.wrapCommand('echo hello', []),
			);
			expect(wrapped).toMatch(/cmd\.exe'\s+\/d\s+\/s\s+\/c\s+\$command/i);
		});

		test('Copy-Item is treated as PS-native and uses Invoke-Expression', () => {
			mockProbeAvailable();
			const executor = new WindowsSandboxExecutor([]);
			expect(executor.isAvailable()).toBe(true); // Fail loud if mock did not apply
			const wrapped = decodeWrappedScript(
				executor.wrapCommand('Copy-Item src.txt dest.txt', []),
			);
			expect(wrapped.toLowerCase()).toContain('invoke-expression');
		});
	});

	describe('wrapCommand() envOverrides', () => {
		test('omitted envOverrides produces no per-call env variable commands', () => {
			mockProbeAvailable();
			const executor = new WindowsSandboxExecutor([]);
			const wrapped = executor.wrapCommand('echo hello', []);
			// Should NOT have any user-defined per-call env vars (only system vars like TEMP, PATH)
			expect(decodeWrappedScript(wrapped)).not.toContain('$env:MY_VAR');
			expect(decodeWrappedScript(wrapped)).not.toContain(
				'Remove-Item Env:MY_VAR',
			);
		});

		test('undefined envOverrides produces no per-call env variable commands', () => {
			mockProbeAvailable();
			const executor = new WindowsSandboxExecutor([]);
			const wrapped = executor.wrapCommand(
				'echo hello',
				[],
				undefined,
				undefined,
			);
			expect(decodeWrappedScript(wrapped)).not.toContain('$env:MY_VAR');
			expect(decodeWrappedScript(wrapped)).not.toContain(
				'Remove-Item Env:MY_VAR',
			);
		});

		test('empty envOverrides {} produces no per-call env variable commands', () => {
			mockProbeAvailable();
			const executor = new WindowsSandboxExecutor([]);
			const wrapped = executor.wrapCommand('echo hello', [], undefined, {});
			expect(decodeWrappedScript(wrapped)).not.toContain('$env:MY_VAR');
			expect(decodeWrappedScript(wrapped)).not.toContain(
				'Remove-Item Env:MY_VAR',
			);
		});

		test('string value emits $env:KEY = VALUE in the PowerShell script', () => {
			mockProbeAvailable();
			const executor = new WindowsSandboxExecutor([]);
			const wrapped = executor.wrapCommand('echo hello', [], undefined, {
				MY_VAR: 'my_value',
			});
			// Should have $env:MY_VAR = 'my_value';
			expect(decodeWrappedScript(wrapped)).toContain(
				"$env:MY_VAR = 'my_value';",
			);
		});

		test('null value emits Remove-Item Env:KEY in the PowerShell script', () => {
			mockProbeAvailable();
			const executor = new WindowsSandboxExecutor([]);
			const wrapped = executor.wrapCommand('echo hello', [], undefined, {
				MY_VAR: null,
			});
			// Should have Remove-Item Env:MY_VAR
			expect(decodeWrappedScript(wrapped)).toContain('Remove-Item Env:MY_VAR');
		});

		test('multiple env overrides are all present', () => {
			mockProbeAvailable();
			const executor = new WindowsSandboxExecutor([]);
			const wrapped = executor.wrapCommand('echo hello', [], undefined, {
				VAR_A: 'value_a',
				VAR_B: null,
			});
			expect(decodeWrappedScript(wrapped)).toContain("$env:VAR_A = 'value_a';");
			expect(decodeWrappedScript(wrapped)).toContain('Remove-Item Env:VAR_B');
		});

		test('value with spaces is preserved in single-quoted PowerShell string', () => {
			mockProbeAvailable();
			const executor = new WindowsSandboxExecutor([]);
			const wrapped = executor.wrapCommand('echo hello', [], undefined, {
				MY_VAR: 'hello world',
			});
			// PowerShell single-quoted strings preserve content verbatim
			expect(decodeWrappedScript(wrapped)).toContain(
				"$env:MY_VAR = 'hello world';",
			);
		});

		test('value with single quotes doubles them for PS string escaping', () => {
			mockProbeAvailable();
			const executor = new WindowsSandboxExecutor([]);
			const wrapped = executor.wrapCommand('echo hello', [], undefined, {
				MY_VAR: "o'clock",
			});
			// Single quotes in PS single-quoted strings are escaped by doubling
			expect(decodeWrappedScript(wrapped)).toContain(
				"$env:MY_VAR = 'o''clock';",
			);
		});
	});
});

// getSafeWindowsPath — SystemRoot validation

describe('getSafeWindowsPath SystemRoot validation', () => {
	const originalSystemRoot = process.env.SystemRoot;

	afterEach(() => {
		if (originalSystemRoot === undefined) {
			delete process.env.SystemRoot;
		} else {
			process.env.SystemRoot = originalSystemRoot;
		}
	});

	test('uses C:\\Windows when SystemRoot is undefined', () => {
		delete process.env.SystemRoot;
		const executor = new WindowsSandboxExecutor([]);
		const path = executor.getEnvOverrides().PATH ?? '';
		expect(path.split(';').slice(0, 2).join(';')).toBe(
			'C:\\Windows\\System32;C:\\Windows',
		);
	});

	test('uses C:\\Windows when SystemRoot is empty string', () => {
		process.env.SystemRoot = '';
		const executor = new WindowsSandboxExecutor([]);
		const path = executor.getEnvOverrides().PATH ?? '';
		expect(path.split(';').slice(0, 2).join(';')).toBe(
			'C:\\Windows\\System32;C:\\Windows',
		);
	});

	test('uses C:\\Windows when SystemRoot is relative path', () => {
		process.env.SystemRoot = '..\\Windows';
		const executor = new WindowsSandboxExecutor([]);
		const path = executor.getEnvOverrides().PATH ?? '';
		expect(path.split(';').slice(0, 2).join(';')).toBe(
			'C:\\Windows\\System32;C:\\Windows',
		);
	});

	test('uses C:\\Windows when SystemRoot contains semicolon (PATH injection)', () => {
		process.env.SystemRoot = 'C:\\Windows;C:\\evil';
		const executor = new WindowsSandboxExecutor([]);
		const path = executor.getEnvOverrides().PATH ?? '';
		expect(path.split(';').slice(0, 2).join(';')).toBe(
			'C:\\Windows\\System32;C:\\Windows',
		);
		expect(path).not.toContain('C:\\evil');
	});

	test('uses SystemRoot when it is a valid absolute path', () => {
		process.env.SystemRoot = 'D:\\WinNT';
		const executor = new WindowsSandboxExecutor([]);
		const path = executor.getEnvOverrides().PATH ?? '';
		expect(path.split(';').slice(0, 2).join(';')).toBe(
			'D:\\WinNT\\System32;D:\\WinNT',
		);
	});

	test('uses C:\\Windows when SystemRoot contains quote characters', () => {
		process.env.SystemRoot = 'C:\\Windows"';
		const executor = new WindowsSandboxExecutor([]);
		const path = executor.getEnvOverrides().PATH ?? '';
		expect(path.split(';').slice(0, 2).join(';')).toBe(
			'C:\\Windows\\System32;C:\\Windows',
		);
	});
});

// WindowsSandboxExecutor — PowerShell command-body safety validation

describe('WindowsSandboxExecutor wrapCommand unsafe PS body detection', () => {
	test('throws UNSAFE_PS_COMMAND for statement separator', () => {
		mockProbeAvailable();
		const executor = new WindowsSandboxExecutor([]);
		try {
			executor.wrapCommand('Remove-Item foo; whoami', []);
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(SandboxError);
			expect((err as InstanceType<typeof SandboxError>).code).toBe(
				'UNSAFE_PS_COMMAND',
			);
		}
	});

	test('allows safe filesystem command without injection characters', () => {
		mockProbeAvailable();
		const executor = new WindowsSandboxExecutor([]);
		expect(() =>
			executor.wrapCommand('Get-ChildItem -Path "C:\\foo"', []),
		).not.toThrow();
	});

	test('throws UNSAFE_PS_COMMAND for subexpression', () => {
		mockProbeAvailable();
		const executor = new WindowsSandboxExecutor([]);
		try {
			executor.wrapCommand('Remove-Item -Path (Get-Foo).FullName', []);
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(SandboxError);
			expect((err as InstanceType<typeof SandboxError>).code).toBe(
				'UNSAFE_PS_COMMAND',
			);
		}
	});

	test('throws UNSAFE_PS_COMMAND for variable reference', () => {
		mockProbeAvailable();
		const executor = new WindowsSandboxExecutor([]);
		try {
			executor.wrapCommand('Get-ChildItem $env:TEMP', []);
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(SandboxError);
			expect((err as InstanceType<typeof SandboxError>).code).toBe(
				'UNSAFE_PS_COMMAND',
			);
		}
	});

	test('throws UNSAFE_PS_COMMAND for pipeline operator', () => {
		mockProbeAvailable();
		const executor = new WindowsSandboxExecutor([]);
		try {
			executor.wrapCommand(
				'Get-ChildItem | Where-Object { $_.Name -eq "foo" }',
				[],
			);
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(SandboxError);
			expect((err as InstanceType<typeof SandboxError>).code).toBe(
				'UNSAFE_PS_COMMAND',
			);
		}
	});

	test('recognizes Remove-Item alias (rm) as PS-native and validates body', () => {
		mockProbeAvailable();
		const executor = new WindowsSandboxExecutor([]);
		expect(() => executor.wrapCommand('rm foo.txt', [])).not.toThrow();
	});

	test('recognizes Get-ChildItem alias (ls) as PS-native and validates body', () => {
		mockProbeAvailable();
		const executor = new WindowsSandboxExecutor([]);
		expect(() => executor.wrapCommand('ls', [])).not.toThrow();
	});

	test('alias with injection still rejected', () => {
		mockProbeAvailable();
		const executor = new WindowsSandboxExecutor([]);
		// rm; whoami — alias matches, but body has ;, must be rejected
		let caught: unknown;
		try {
			executor.wrapCommand('rm; whoami', []);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(SandboxError);
		expect((caught as InstanceType<typeof SandboxError>).code).toBe(
			'UNSAFE_PS_COMMAND',
		);
	});
});
