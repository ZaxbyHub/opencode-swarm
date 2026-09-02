import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	clearToolchainCache,
	_internals as discoveryInternals,
} from '../../../src/build/discovery';
import { pkg_audit } from '../../../src/tools/pkg-audit';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

// Composer availability is controlled through the discovery module's
// `_internals.spawnSyncImpl` DI seam (with `clearToolchainCache` before/after)
// instead of a file-scope `mock.module`. The mock.module form delegated to a
// captured pre-mock namespace import — but Bun retroactively patches the
// original module's export slots on `mock.module`, so `realDiscovery.
// isCommandAvailable` resolved to the wrapper itself: the delegation branch
// was infinite tail recursion (an unkillable loop under JSC proper tail
// calls), hanging any later file in the shared process that called
// `isCommandAvailable` for a non-composer command (issue #2260/#2477).
let mockIsCommandAvailable = true;

// Mock for Bun.spawn
let originalSpawn: typeof Bun.spawn;
let spawnCalls: Array<{ cmd: string[]; opts: unknown }> = [];
let mockExitCode: number = 0;
let mockStdout: string = '';
let mockStderr: string = '';
let mockSpawnError: Error | null = null;

function mockSpawn(cmd: string[], opts: unknown) {
	spawnCalls.push({ cmd, opts });

	if (mockSpawnError) {
		throw mockSpawnError;
	}

	// Create mock readable streams
	const encoder = new TextEncoder();
	const stdoutReadable = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(mockStdout));
			controller.close();
		},
	});
	const stderrReadable = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(mockStderr));
			controller.close();
		},
	});

	return {
		stdout: stdoutReadable,
		stderr: stderrReadable,
		exited: Promise.resolve(mockExitCode),
		exitCode: mockExitCode,
	} as unknown as ReturnType<typeof Bun.spawn>;
}

// Temp directories for ecosystem detection tests
let tempDir: string;
let originalCwd: string;

// Helper to create mock context
function getMockContext(): ToolContext {
	return {
		sessionID: 'test-session',
		messageID: 'test-message',
		agent: 'test-agent',
		directory: tempDir,
		worktree: tempDir,
		abort: new AbortController().signal,
		metadata: () => ({}),
		ask: async () => undefined,
	};
}

describe('pkg-audit composer audit', () => {
	let originalSpawnSync: typeof discoveryInternals.spawnSyncImpl;

	beforeEach(() => {
		originalSpawnSync = discoveryInternals.spawnSyncImpl;
		clearToolchainCache();
		// The real `isCommandAvailable` probes PATH via `_internals.spawnSyncImpl`
		// and caches the `result.success` per command. Only the composer probe is
		// faked (to follow `mockIsCommandAvailable`); every other command's probe
		// delegates to the captured real spawn so `auto`-ecosystem availability
		// guards keep their fidelity (review F-006/PRR-007).
		discoveryInternals.spawnSyncImpl = (cmd, opts) => {
			if (Array.isArray(cmd) && cmd[1] === 'composer') {
				return {
					stdout: new Uint8Array(),
					stderr: new Uint8Array(),
					exitCode: mockIsCommandAvailable ? 0 : 127,
					success: mockIsCommandAvailable,
				};
			}
			return originalSpawnSync(cmd, opts);
		};

		originalSpawn = Bun.spawn;
		spawnCalls = [];
		mockExitCode = 0;
		mockStdout = '';
		mockStderr = '';
		mockSpawnError = null;
		Bun.spawn = mockSpawn;

		// Save current directory and create temp dir
		originalCwd = process.cwd();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-audit-test-')),
		);
		process.chdir(tempDir);
	});

	afterEach(() => {
		try {
			// Unthrowable restores first (plain property set + Map.clear) so the
			// throw-capable steps below can never skip them (review F-002): a
			// chdir/rmSync throw previously leaked the Bun.spawn global patch,
			// the seam, and the flag reset across files.
			discoveryInternals.spawnSyncImpl = originalSpawnSync;
			clearToolchainCache();
			Bun.spawn = originalSpawn;
			try {
				process.chdir(originalCwd);
			} catch {
				// originalCwd may be gone; proceed with cleanup regardless.
			}
			try {
				// tempDir is realpath'd under os.tmpdir(): the containment guard
				// passes; retries EBUSY/EPERM/ENOTEMPTY (the same #2017/#2028
				// teardown class hardened elsewhere in this PR).
				safeRmRecursive(tempDir);
			} catch {
				// Bounded retry exhausted — leave the dir to the OS.
			}
		} finally {
			// Reset mock state
			mockIsCommandAvailable = true;
		}
	});

	// ============ Exit Code 0: Clean ============
	describe('exit code 0 (clean)', () => {
		it('should return clean:true with no findings when exit code is 0', async () => {
			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.findings.length).toBe(0);
			expect(parsed.totalCount).toBe(0);
			expect(parsed.ecosystem).toBe('composer');
		});
	});

	// ============ Exit Code 2: Abandoned Packages ============
	describe('exit code 2 (abandoned packages)', () => {
		it('should return clean:true with abandoned package note when exit code is 2', async () => {
			mockExitCode = 2;
			mockStdout = JSON.stringify({
				advisories: {},
				abandoned: { 'vendor/old-package': 'vendor/new-package' },
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.findings.length).toBe(0);
			expect(parsed.note).toContain('vendor/old-package');
		});

		it('should handle multiple abandoned packages', async () => {
			mockExitCode = 2;
			mockStdout = JSON.stringify({
				advisories: {},
				abandoned: {
					'vendor/old-package1': 'vendor/new-package1',
					'vendor/old-package2': 'vendor/new-package2',
				},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('vendor/old-package1');
			expect(parsed.note).toContain('vendor/old-package2');
		});

		it('should return clean:true with generic note when abandoned but no packages listed', async () => {
			mockExitCode = 2;
			mockStdout = JSON.stringify({
				advisories: {},
				abandoned: {},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('abandoned packages');
		});
	});

	// ============ Exit Code 1: Security Vulnerabilities ============
	describe('exit code 1 (security vulnerabilities)', () => {
		it('should return clean:false with findings when exit code is 1 and CVE present', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/vulnerable-pkg': [
						{
							advisoryId: 'GHSA-test-0001',
							packageName: 'vendor/vulnerable-pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'SQL Injection in vulnerable-pkg',
							link: 'https://github.com/advisories/GHSA-test-0001',
							cve: 'CVE-2024-12345',
							affectedVersions: '>=1.0.0 <1.5.0',
							sources: [],
						},
					],
				},
				abandoned: {},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(false);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].severity).toBe('high');
			expect(parsed.findings[0].cve).toBe('CVE-2024-12345');
			expect(parsed.findings[0].package).toBe('vendor/vulnerable-pkg');
		});

		it('should return moderate severity when CVE is not present', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/vulnerable-pkg': [
						{
							advisoryId: 'GHSA-test-0001',
							packageName: 'vendor/vulnerable-pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Security issue in vulnerable-pkg',
							link: 'https://github.com/advisories/GHSA-test-0001',
							cve: '', // empty CVE
							affectedVersions: '>=1.0.0 <1.5.0',
							sources: [],
						},
					],
				},
				abandoned: {},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings[0].severity).toBe('moderate');
			expect(parsed.findings[0].cve).toBe(null);
		});

		it('should parse multiple vulnerabilities correctly', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg1': [
						{
							advisoryId: 'GHSA-001',
							packageName: 'vendor/pkg1',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Issue 1',
							link: 'https://github.com/advisories/GHSA-001',
							cve: 'CVE-2024-0001',
							affectedVersions: '>=1.0.0',
							sources: [],
						},
					],
					'vendor/pkg2': [
						{
							advisoryId: 'GHSA-002',
							packageName: 'vendor/pkg2',
							reportedAt: '2024-01-02T00:00:00+00:00',
							title: 'Issue 2',
							link: 'https://github.com/advisories/GHSA-002',
							cve: '', // no CVE
							affectedVersions: '>=2.0.0',
							sources: [],
						},
					],
				},
				abandoned: {},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings.length).toBe(2);
			expect(parsed.totalCount).toBe(2);
		});

		it('should count high severity findings correctly', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg1': [
						{
							advisoryId: 'GHSA-001',
							packageName: 'vendor/pkg1',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Issue 1',
							link: 'https://github.com/advisories/GHSA-001',
							cve: 'CVE-2024-0001',
							affectedVersions: '>=1.0.0',
							sources: [],
						},
					],
				},
				abandoned: {},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.highCount).toBe(1);
			expect(parsed.criticalCount).toBe(0);
		});
	});

	// ============ Exit Code 3: Vulnerabilities AND Abandoned ============
	describe('exit code 3 (vulnerabilities AND abandoned)', () => {
		it('should return clean:false with findings when exit code is 3', async () => {
			mockExitCode = 3;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/vulnerable-pkg': [
						{
							advisoryId: 'GHSA-test-0001',
							packageName: 'vendor/vulnerable-pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Critical vulnerability',
							link: 'https://github.com/advisories/GHSA-test-0001',
							cve: 'CVE-2024-99999',
							affectedVersions: '>=1.0.0 <2.0.0',
							sources: [],
						},
					],
				},
				abandoned: { 'vendor/old-pkg': 'vendor/new-pkg' },
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(false);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].cve).toBe('CVE-2024-99999');
		});
	});

	// ============ Malformed JSON ============
	describe('malformed JSON handling', () => {
		it('should return clean:false with note about invalid JSON when exit code is 1', async () => {
			mockExitCode = 1;
			mockStdout = 'not valid json at all';

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(false);
			expect(parsed.note).toContain('not valid JSON');
		});

		it('should return clean:true with note about invalid JSON when exit code is 2', async () => {
			mockExitCode = 2;
			mockStdout = 'not valid json';

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('not valid JSON');
		});
	});

	// ============ Composer Not Available ============
	describe('composer not available', () => {
		it('should return clean:true with note about composer not found', async () => {
			mockIsCommandAvailable = false; // simulate composer missing

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('composer not installed');
		});
	});

	// ============ Ecosystem Detection ============
	describe('ecosystem detection', () => {
		it('should auto-detect composer from composer.lock presence', async () => {
			// Create composer.lock
			fs.writeFileSync(path.join(tempDir, 'composer.lock'), '{}');

			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toContain('composer');
		});
	});
});
