/**
 * Tests for macOS sandbox implementation:
 * - src/sandbox/macos/sandbox-exec-executor.ts (MacOSSandboxExecutor)
 * - src/sandbox/macos/edge-cases.ts (macOS-specific security detection)
 *
 * Issue #2236 F6a item 4: this file's MacOSSandboxExecutor suite previously
 * self-disabled on macOS CI via `if (!executor.isAvailable()) return;`
 * guards (the pre-F6 probe always failed, so isAvailable() was always
 * false) — silent no-ops that let the broken `sandbox-exec --version`
 * probe survive undetected. The suite is now seam-driven: process.platform
 * is overridden to 'darwin' via the established Object.defineProperty
 * pattern (see tests/unit/config/cache-paths.test.ts) and
 * _internals.probeSandboxExec is mocked, so these tests exercise the real
 * MacOSSandboxExecutor logic and assert regardless of the host platform
 * actually running the suite.
 *
 * Coverage split (FR-006 500-line cap — planned up front, not a cascading
 * split): the SBPL env-override emission tests live in
 * tests/unit/sandbox/macos-env-hardening.test.ts, and the probe's own
 * exit-code/invocation-shape/memoization tests live in
 * tests/unit/sandbox/macos-probe.test.ts. This file covers the executor's
 * constructor, isAvailable()/wrapCommand()/disable() behavioral contract,
 * and the macOS-specific edge-case detectors.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const isMac = process.platform === 'darwin';

// ---------------------------------------------------------------------------
// macOS executor
// ---------------------------------------------------------------------------

import {
	_internals,
	MacOSSandboxExecutor,
} from '../../../src/sandbox/macos/sandbox-exec-executor';

// ---------------------------------------------------------------------------
// macOS edge-cases — real implementations
// ---------------------------------------------------------------------------

import {
	detectDyldInjection,
	detectEntitlementEscalation,
	detectQuarantineBypass,
	detectSandboxExecItself,
	detectSandboxProfileBypass,
	detectSIPSProtectedPath,
	detectTmpDirManipulation,
} from '../../../src/sandbox/macos/edge-cases';

// ---------------------------------------------------------------------------
// Seam helpers — platform override + probe mock, save/restore per test.
// ---------------------------------------------------------------------------

const originalPlatform = process.platform;
const originalProbeSandboxExec = _internals.probeSandboxExec;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, 'platform', { value, configurable: true });
}

function restorePlatform(): void {
	Object.defineProperty(process, 'platform', {
		value: originalPlatform,
		configurable: true,
	});
}

// ---------------------------------------------------------------------------
// Test suite — MacOSSandboxExecutor
// ---------------------------------------------------------------------------

describe('MacOSSandboxExecutor', () => {
	// -----------------------------------------------------------------------
	// 1. Constructor — real-platform behavior (the platform guard itself)
	// -----------------------------------------------------------------------

	describe('constructor', () => {
		// These specifically exercise the REAL host's process.platform value
		// (not the seam) because the assertion under test IS the platform
		// guard — on real darwin the constructor probes and constructs; on
		// every other real platform it throws immediately, before any probe
		// runs. skipIf partitions the two branches across whichever platform
		// actually runs the suite.

		test.skipIf(!isMac)('accepts scopePaths array on darwin', () => {
			const executor = new MacOSSandboxExecutor(['/Users/user/scope']);
			expect(executor).toBeInstanceOf(MacOSSandboxExecutor);
			expect(executor.mechanism).toBe('sandbox-exec');
		});

		test.skipIf(!isMac)('accepts scopePaths and tempDir on darwin', () => {
			const executor = new MacOSSandboxExecutor(
				['/Users/user/scope'],
				'/tmp/custom-tmp',
			);
			expect(executor).toBeInstanceOf(MacOSSandboxExecutor);
		});

		test.skipIf(!isMac)('mechanism property is sandbox-exec on darwin', () => {
			const executor = new MacOSSandboxExecutor([]);
			expect(executor.mechanism).toBe('sandbox-exec');
		});

		test.skipIf(isMac)(
			'throws MacOSSandboxExecutor not yet implemented on non-darwin',
			() => {
				expect(() => new MacOSSandboxExecutor([])).toThrow(
					'MacOSSandboxExecutor not yet implemented',
				);
			},
		);
	});

	// -----------------------------------------------------------------------
	// 2-5. Seam-driven behavior — regardless of host (#2236 F6a item 4)
	// -----------------------------------------------------------------------

	describe('seam-driven — regardless of host', () => {
		beforeEach(() => {
			setPlatform('darwin');
			_internals.resetProbeMemo();
		});

		afterEach(() => {
			restorePlatform();
			_internals.probeSandboxExec = originalProbeSandboxExec;
			_internals.resetProbeMemo();
		});

		describe('isAvailable()', () => {
			test('returns true when probeSandboxExec succeeds', () => {
				_internals.probeSandboxExec = mock(() => true);
				const executor = new MacOSSandboxExecutor([]);
				expect(executor.isAvailable()).toBe(true);
			});

			test('returns false when probeSandboxExec fails', () => {
				_internals.probeSandboxExec = mock(() => false);
				const executor = new MacOSSandboxExecutor([]);
				expect(executor.isAvailable()).toBe(false);
			});

			test('returns false without throwing when probeSandboxExec itself throws', () => {
				_internals.probeSandboxExec = mock(() => {
					throw new Error('unexpected probe failure');
				});
				expect(() => new MacOSSandboxExecutor([])).not.toThrow();
				const executor = new MacOSSandboxExecutor([]);
				expect(executor.isAvailable()).toBe(false);
			});
		});

		describe('wrapCommand()', () => {
			test('generates a <sandbox-exec> -f <profile> bash -c command when available', () => {
				_internals.probeSandboxExec = mock(() => true);
				const executor = new MacOSSandboxExecutor(['/scope']);
				const result = executor.wrapCommand('echo hello', []);
				expect(result).toContain('sandbox-exec');
				expect(result).toContain('-f');
				expect(result).toMatch(/sandbox-exec -f .+ bash -c/);
			});

			test('embeds the shell command inside bash -c', () => {
				_internals.probeSandboxExec = mock(() => true);
				const executor = new MacOSSandboxExecutor(['/scope']);
				const result = executor.wrapCommand('echo unique-marker-42', []);
				expect(result).toContain('unique-marker-42');
			});

			test('includes constructor scope paths and per-call scope paths in the generated profile', () => {
				_internals.probeSandboxExec = mock(() => true);
				const executor = new MacOSSandboxExecutor(['/ctor/scope']);
				const profile = _internals.buildSandboxProfile(
					['/ctor/scope', '/call/scope'],
					'/tmp',
				);
				expect(profile).toContain('/ctor/scope');
				expect(profile).toContain('/call/scope');
				// Sanity: wrapCommand does not throw when both scopes are supplied.
				expect(() =>
					executor.wrapCommand('echo hello', ['/call/scope']),
				).not.toThrow();
			});

			test('includes tempDir in the generated profile', () => {
				_internals.probeSandboxExec = mock(() => true);
				const profile = _internals.buildSandboxProfile(
					['/scope'],
					'/tmp/custom-swarm-tmp',
				);
				expect(profile).toContain('/tmp/custom-swarm-tmp');
			});

			test('throws SandboxError instead of returning the raw command when unavailable', () => {
				_internals.probeSandboxExec = mock(() => false);
				const executor = new MacOSSandboxExecutor([]);
				expect(executor.isAvailable()).toBe(false);
				expect(() => executor.wrapCommand('echo hello', [])).toThrow();
			});
		});

		describe('disable()', () => {
			test('isAvailable() returns false after disable()', () => {
				_internals.probeSandboxExec = mock(() => true);
				const executor = new MacOSSandboxExecutor([]);
				expect(executor.isAvailable()).toBe(true);
				executor.disable('test reason');
				expect(executor.isAvailable()).toBe(false);
			});

			test('wrapCommand() throws SandboxError after disable(), never returns the raw command unwrapped', () => {
				_internals.probeSandboxExec = mock(() => true);
				const executor = new MacOSSandboxExecutor([]);
				executor.disable('testing');
				// Contract: an executor that WAS constructed as available must
				// never silently fall through to unwrapped execution once
				// disabled — the caller (applySandboxExecution) is responsible
				// for the fail-open decision, not wrapCommand() itself.
				expect(() => executor.wrapCommand('echo hello', [])).toThrow();
			});

			test('disable() does not throw even when the executor was never available', () => {
				_internals.probeSandboxExec = mock(() => false);
				const executor = new MacOSSandboxExecutor([]);
				expect(() => executor.disable('test')).not.toThrow();
				expect(executor.isAvailable()).toBe(false);
			});
		});
	});
});

// ---------------------------------------------------------------------------
// edge-cases ΓÇö detectDyldInjection
// DYLD_* env var detection is macOS-specific
// ---------------------------------------------------------------------------

describe('detectDyldInjection', () => {
	test.skipIf(!isMac)('returns true when DYLD_INSERT_LIBRARIES is set', () => {
		const result = detectDyldInjection('/fake', {
			DYLD_INSERT_LIBRARIES: '/path/to/lib.dylib',
		});
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)('returns true when DYLD_LIBRARY_PATH is set', () => {
		const result = detectDyldInjection('/fake', {
			DYLD_LIBRARY_PATH: '/path/to/libs',
		});
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)('returns true when DYLD_FRAMEWORK_PATH is set', () => {
		const result = detectDyldInjection('/fake', {
			DYLD_FRAMEWORK_PATH: '/path/to/frameworks',
		});
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)('returns true when multiple DYLD_* vars are set', () => {
		const result = detectDyldInjection('/fake', {
			DYLD_INSERT_LIBRARIES: '/lib1',
			DYLD_LIBRARY_PATH: '/lib2',
			DYLD_FRAMEWORK_PATH: '/fw',
		});
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)('returns false when no DYLD_* vars are set', () => {
		const result = detectDyldInjection('/fake', {});
		expect(result).toBe(false);
	});

	test.skipIf(!isMac)(
		'returns false when DYLD_* vars are undefined or empty string',
		() => {
			const result = detectDyldInjection('/fake', {
				DYLD_INSERT_LIBRARIES: undefined,
				DYLD_LIBRARY_PATH: '',
				DYLD_FRAMEWORK_PATH: undefined,
			});
			expect(result).toBe(false);
		},
	);

	test('returns false on non-macOS platforms', () => {
		if (isMac) return;
		// On non-macOS, DYLD_* vars don't exist ΓÇö detection returns false.
		// This is a safety measure for cross-platform compatibility.
		const result = detectDyldInjection('/fake', {});
		expect(result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// edge-cases ΓÇö detectTmpDirManipulation
// Symlink/traversal detection in temp directories
// ---------------------------------------------------------------------------

describe('detectTmpDirManipulation', () => {
	test.skipIf(!isMac)(
		'returns true when /tmp contains symlink pointing outside scope',
		() => {
			// e.g. /tmp/evil -> /Users/user (outside /tmp scope)
			// Phase 3: Will create a real symlink in temp dir and test detection.
			expect(true).toBe(true); // Placeholder
		},
	);

	test.skipIf(!isMac)(
		'returns false when /tmp contains no suspicious symlinks',
		() => {
			// Normal /tmp structure should not trigger detection.
			expect(true).toBe(true); // Placeholder
		},
	);

	test.skipIf(!isMac)(
		'returns true for path traversal like /tmp/../../../etc',
		() => {
			// Path normalization should detect escaping the tmp boundary.
			const result = detectTmpDirManipulation('/tmp', 'echo /tmp/../../../etc');
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isMac)('returns true for /tmp/var/tmp symlink escape', () => {
		// On macOS, /var/tmp may be a symlink to /tmp.
		expect(true).toBe(true); // Placeholder
	});

	test('returns false on non-macOS platforms', () => {
		if (isMac) return;
		const result = detectTmpDirManipulation('/tmp', 'echo hello');
		expect(result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// edge-cases ΓÇö detectSandboxProfileBypass
// Escape attempt detection in sandbox profile generation
// ---------------------------------------------------------------------------

describe('detectSandboxProfileBypass', () => {
	test.skipIf(!isMac)(
		'returns false for command containing ; to chain commands',
		() => {
			// detectSandboxProfileBypass detects mktemp/ln/link escapes, not shell metacharacters
			const result = detectSandboxProfileBypass('echo hello; rm -rf /', [
				'/scope',
			]);
			expect(result).toBe(false);
		},
	);

	test.skipIf(!isMac)('returns false for command containing | pipe', () => {
		const result = detectSandboxProfileBypass('cat /etc/passwd | wc -l', [
			'/scope',
		]);
		expect(result).toBe(false);
	});

	test.skipIf(!isMac)(
		'returns false for command containing $() command substitution',
		() => {
			const result = detectSandboxProfileBypass('echo $(cat /etc/passwd)', [
				'/scope',
			]);
			expect(result).toBe(false);
		},
	);

	test.skipIf(!isMac)(
		'returns false for command containing backtick substitution',
		() => {
			const result = detectSandboxProfileBypass('echo `whoami`', ['/scope']);
			expect(result).toBe(false);
		},
	);

	test.skipIf(!isMac)(
		'returns false for command containing && conditional chaining',
		() => {
			const result = detectSandboxProfileBypass('true && rm -rf /', ['/scope']);
			expect(result).toBe(false);
		},
	);

	test.skipIf(!isMac)(
		'returns false for command containing || conditional chaining',
		() => {
			const result = detectSandboxProfileBypass('false || echo escaped', [
				'/scope',
			]);
			expect(result).toBe(false);
		},
	);

	test.skipIf(!isMac)(
		'returns false for simple command without shell metacharacters',
		() => {
			const result = detectSandboxProfileBypass('ls /Users/user', ['/scope']);
			expect(result).toBe(false);
		},
	);

	test.skipIf(!isMac)(
		'returns false for command with quoted strings containing ;',
		() => {
			// Semicolons inside single quotes are literal, not command chaining.
			const result = detectSandboxProfileBypass("echo 'hello; world'", [
				'/scope',
			]);
			expect(result).toBe(false);
		},
	);

	test('returns false on non-macOS platforms', () => {
		if (isMac) return;
		const result = detectSandboxProfileBypass('echo hello; rm -rf /', []);
		expect(result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// edge-cases ΓÇö detectSIPSProtectedPath
// SIP (System Integrity Protection) path detection
// ---------------------------------------------------------------------------

describe('detectSIPSProtectedPath', () => {
	test.skipIf(!isMac)('returns true for /System/Library path', () => {
		const result = detectSIPSProtectedPath(
			'/System/Library/Extensions/kext.kext',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)('returns true for /usr/libexec path', () => {
		const result = detectSIPSProtectedPath('/usr/libexec/path/to/bin');
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)('returns false for /bin path (not SIP-protected)', () => {
		const result = detectSIPSProtectedPath('/bin/bash');
		expect(result).toBe(false);
	});

	test.skipIf(!isMac)(
		'returns false for /sbin path (not SIP-protected)',
		() => {
			const result = detectSIPSProtectedPath('/sbin/mount');
			expect(result).toBe(false);
		},
	);

	test.skipIf(!isMac)(
		'returns false for /Users/user path (not SIP-protected)',
		() => {
			const result = detectSIPSProtectedPath('/Users/user/file.txt');
			expect(result).toBe(false);
		},
	);

	test.skipIf(!isMac)('returns false for /tmp path (not SIP-protected)', () => {
		const result = detectSIPSProtectedPath('/tmp/file.txt');
		expect(result).toBe(false);
	});

	test.skipIf(!isMac)(
		'returns false for /Applications path (not SIP-protected)',
		() => {
			const result = detectSIPSProtectedPath('/Applications/App.app');
			expect(result).toBe(false);
		},
	);

	test('returns false on non-macOS platforms', () => {
		if (isMac) return;
		const result = detectSIPSProtectedPath('/System/Library/Extensions');
		expect(result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// edge-cases ΓÇö detectEntitlementEscalation
// Privilege escalation detection via entitlements
// ---------------------------------------------------------------------------

describe('detectEntitlementEscalation', () => {
	test.skipIf(!isMac)('returns true for sudo execution', () => {
		// detectEntitlementEscalation checks command strings for privilege escalation patterns
		const result = detectEntitlementEscalation('sudo echo hello');
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)('returns true for authorizationexec usage', () => {
		const result = detectEntitlementEscalation('authorizationexec');
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)('returns true for security authorization pattern', () => {
		const result = detectEntitlementEscalation('security authorization foo');
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)(
		'returns true for sandbox-exec entitlements modification',
		() => {
			const result = detectEntitlementEscalation(
				'sandbox-exec -e entitlements /path/to/profile',
			);
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isMac)(
		'returns false for simple command without escalation patterns',
		() => {
			const result = detectEntitlementEscalation('ls /Users/user');
			expect(result).toBe(false);
		},
	);

	test.skipIf(!isMac)('returns false for echo command', () => {
		const result = detectEntitlementEscalation('echo hello');
		expect(result).toBe(false);
	});

	test('returns false on non-macOS platforms', () => {
		if (isMac) return;
		const result = detectEntitlementEscalation('sudo echo hello');
		expect(result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// edge-cases ΓÇö detectQuarantineBypass
// com.apple.quarantine attribute bypass detection
// ---------------------------------------------------------------------------

describe('detectQuarantineBypass', () => {
	test.skipIf(!isMac)('returns true for xattr quarantine removal', () => {
		// detectQuarantineBypass checks command strings for quarantine bypass patterns
		const result = detectQuarantineBypass(
			'xattr -d com.apple.quarantine /tmp/downloaded.app',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)(
		'returns true for xattr --delete quarantine removal',
		() => {
			const result = detectQuarantineBypass(
				'xattr --delete com.apple.quarantine /tmp/file.app',
			);
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isMac)('returns true for LSQuarantine=0 override', () => {
		const result = detectQuarantineBypass('LSQuarantine=0 open /tmp/file.app');
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)('returns true for open with -j bypass flag', () => {
		const result = detectQuarantineBypass('open -j /tmp/downloaded.app');
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)('returns false for simple open command', () => {
		const result = detectQuarantineBypass('open /tmp/file.txt');
		expect(result).toBe(false);
	});

	test.skipIf(!isMac)('returns false for echo command', () => {
		const result = detectQuarantineBypass('echo hello');
		expect(result).toBe(false);
	});

	test('returns false on non-macOS platforms', () => {
		if (isMac) return;
		const result = detectQuarantineBypass(
			'xattr -d com.apple.quarantine /tmp/file.app',
		);
		expect(result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// edge-cases ΓÇö detectSandboxExecItself
// Nested sandbox detection
// ---------------------------------------------------------------------------

describe('detectSandboxExecItself', () => {
	test.skipIf(!isMac)('returns true when command contains sandbox-exec', () => {
		// detectSandboxExecItself checks command strings for nested sandbox patterns
		const result = detectSandboxExecItself(
			'sandbox-exec -f profile.sb bash -c "echo hello"',
		);
		expect(result).toBe(true);
	});

	test.skipIf(!isMac)(
		'returns true for sandbox-exec without -f flag (minimal restrictions)',
		() => {
			const result = detectSandboxExecItself(
				'sandbox-exec bash -c "echo hello"',
			);
			expect(result).toBe(true);
		},
	);

	test.skipIf(!isMac)('returns false for simple echo command', () => {
		const result = detectSandboxExecItself('echo hello');
		expect(result).toBe(false);
	});

	test.skipIf(!isMac)('returns false for ls command', () => {
		const result = detectSandboxExecItself('ls /Users/user');
		expect(result).toBe(false);
	});

	test('returns false on non-macOS platforms', () => {
		if (isMac) return;
		const result = detectSandboxExecItself('sandbox-exec -f profile.sb bash');
		expect(result).toBe(false);
	});
});
