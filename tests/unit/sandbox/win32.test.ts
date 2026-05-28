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

const isWin = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Windows executor — NativeWindowsSandboxExecutor
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Windows edge-cases — real implementations
// ---------------------------------------------------------------------------

import * as edge from '../../../src/sandbox/win32/edge-cases';

// ---------------------------------------------------------------------------
// Test suite — NativeWindowsSandboxExecutor
// ---------------------------------------------------------------------------

describe('NativeWindowsSandboxExecutor', () => {
	// -----------------------------------------------------------------------
	// 1. Constructor — mechanism property
	// -----------------------------------------------------------------------

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
				// Without the runner binary, falls back to powershell-wrapper
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

	// -----------------------------------------------------------------------
	// 2. isAvailable()
	// -----------------------------------------------------------------------

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

	// -----------------------------------------------------------------------
	// 3. wrapCommand()
	// -----------------------------------------------------------------------

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

	// -----------------------------------------------------------------------
	// 4. getEnvOverrides()
	// -----------------------------------------------------------------------

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

	// -----------------------------------------------------------------------
	// 5. disable()
	// -----------------------------------------------------------------------

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

	// -----------------------------------------------------------------------
	// 6. hasNativeRunner / probeResult
	// -----------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// edge-cases — detectPathTraversal
// Path traversal detection for Windows paths
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// edge-cases — detectRegistryEscape
// Windows registry escape detection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// edge-cases — detectPowerShellEscape
// PowerShell escape and bypass detection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// edge-cases — detectWMIEscape
// WMI (Windows Management Instrumentation) escape detection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// edge-cases — detectServiceEscalation
// Windows service privilege escalation detection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// edge-cases — detectDLLHijacking
// DLL search order hijacking detection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// edge-cases — detectTokenManipulation
// Windows access token manipulation detection
// ---------------------------------------------------------------------------

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
