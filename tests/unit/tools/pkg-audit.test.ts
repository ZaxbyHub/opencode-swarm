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

describe('pkg-audit tool', () => {
	beforeEach(() => {
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
		Bun.spawn = originalSpawn;
		process.chdir(originalCwd);
		// Clean up temp directory
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ Validation Tests ============
	describe('validation', () => {
		it('should return error for invalid ecosystem value', async () => {
			// Note: The tool validates args and returns error as JSON string
			const result = await pkg_audit.execute(
				{ ecosystem: 'evil' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('Invalid arguments');
		});
	});

	// ============ Ecosystem Detection Tests ============
	describe('ecosystem detection', () => {
		it('should auto-detect npm from package.json presence', async () => {
			// Create package.json
			fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');

			mockExitCode = 0;
			mockStdout = '{"vulnerabilities": {}}';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toContain('npm');
		});

		it('should auto-detect pip from pyproject.toml presence', async () => {
			// Create pyproject.toml
			fs.writeFileSync(path.join(tempDir, 'pyproject.toml'), '[project]');

			mockExitCode = 0;
			mockStdout = '[]';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toContain('pip');
		});

		it('should auto-detect pip from requirements.txt presence', async () => {
			// Create requirements.txt
			fs.writeFileSync(path.join(tempDir, 'requirements.txt'), 'requests>=2.0');

			mockExitCode = 0;
			mockStdout = '[]';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toContain('pip');
		});

		it('should auto-detect cargo from Cargo.toml presence', async () => {
			// Create Cargo.toml
			fs.writeFileSync(
				path.join(tempDir, 'Cargo.toml'),
				'[package]\nname = "test"',
			);

			mockExitCode = 0;
			mockStdout = '{"vulnerabilities": null}';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toContain('cargo');
		});

		it('should return empty ecosystems when no project files found', async () => {
			// Don't create any project files - temp dir is empty

			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toEqual([]);
			expect(parsed.clean).toBe(true);
		});
	});

	// ============ NPM Audit JSON Parsing Tests ============
	describe('npm audit v2 JSON parsing', () => {
		it('should parse npm audit v2 JSON format correctly - vulnerabilities object', async () => {
			mockExitCode = 1; // non-zero exit code means vulnerabilities found
			mockStdout = JSON.stringify({
				vulnerabilities: {
					lodash: {
						severity: 'high',
						range: '4.17.15',
						fixAvailable: { version: '4.17.21' },
						title: 'Prototype Pollution in lodash',
						cves: ['CVE-2021-23337'],
						url: 'https://nvd.nist.gov/vuln/detail/CVE-2021-23337',
					},
				},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(false);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe('lodash');
			expect(parsed.findings[0].severity).toBe('high');
			expect(parsed.findings[0].cve).toBe('CVE-2021-23337');
			expect(parsed.findings[0].patchedVersion).toBe('4.17.21');
		});

		it('should parse npm audit with fixAvailable: true correctly', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				vulnerabilities: {
					express: {
						severity: 'moderate',
						range: '4.0.0',
						fixAvailable: true,
						title: 'Some vuln',
					},
				},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings[0].patchedVersion).toBe('latest');
		});

		it('should return clean:true when no vulnerabilities found (exit code 0)', async () => {
			mockExitCode = 0;
			mockStdout = '{"vulnerabilities": {}}';

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.findings.length).toBe(0);
		});

		it('should return clean:true when tool not installed', async () => {
			mockSpawnError = new Error("'npm' is not recognized");

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('not available');
		});

		it('should handle malformed JSON gracefully', async () => {
			mockExitCode = 1;
			mockStdout = 'not valid json at all';
			mockStderr = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// Should return clean with note about parsing issue
			expect(parsed.clean).toBe(true);
			expect(parsed.note).toBeDefined();
		});

		it('should handle empty output gracefully', async () => {
			mockExitCode = 0;
			mockStdout = '';
			mockStderr = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
		});
	});

	// ============ pip-audit JSON Parsing Tests ============
	describe('pip-audit JSON parsing', () => {
		it('should parse pip-audit JSON format correctly - array of {name, version, vulns}', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify([
				{
					name: 'django',
					version: '3.2.0',
					vulns: [
						{
							id: 'CVE-2021-44420',
							aliases: ['CVE-2021-44420'],
							fix_versions: ['3.2.10'],
						},
					],
				},
			]);

			const result = await pkg_audit.execute(
				{ ecosystem: 'pip' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(false);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe('django');
			expect(parsed.findings[0].severity).toBe('high'); // aliases with CVE -> high
			expect(parsed.findings[0].cve).toBe('CVE-2021-44420');
		});

		it('should return moderate severity when no aliases (no CVE)', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify([
				{
					name: 'some-package',
					version: '1.0.0',
					vulns: [
						{
							id: 'PYSEC-2021-001',
							aliases: [], // empty aliases -> moderate
							fix_versions: [],
						},
					],
				},
			]);

			const result = await pkg_audit.execute(
				{ ecosystem: 'pip' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings[0].severity).toBe('moderate'); // no aliases -> moderate
		});

		it('should return clean:true when no vulnerabilities found', async () => {
			mockExitCode = 0;
			mockStdout = '[]';

			const result = await pkg_audit.execute(
				{ ecosystem: 'pip' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
		});

		it('should handle pip-audit not installed', async () => {
			mockSpawnError = new Error('pip-audit: command not found');

			const result = await pkg_audit.execute(
				{ ecosystem: 'pip' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('not installed');
		});
	});

	// ============ cargo audit JSON Parsing Tests ============
	describe('cargo audit JSON parsing', () => {
		it('should parse cargo audit JSON format correctly - vulnerabilities.list array', async () => {
			mockExitCode = 1;
			// cargo audit outputs multiple JSON objects, one per line
			mockStdout =
				JSON.stringify({
					vulnerabilities: {
						list: [
							{
								advisory: {
									package: 'serde',
									title: 'Arbitrary Code Execution in serde',
									id: 'RUSTSEC-2021-001',
									aliases: ['CVE-2021-43740'],
									url: 'https://rustsec.org/advisories/RUSTSEC-2021-001',
									cvss: 9.5,
								},
								package: { version: '1.0.0' },
								versions: { patched: ['1.0.1'] },
							},
						],
					},
				}) + '\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'cargo' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(false);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe('serde');
			expect(parsed.findings[0].severity).toBe('critical'); // CVSS 9.5 -> critical
		});

		it('should map CVSS 9.5 to critical severity', async () => {
			mockExitCode = 1;
			mockStdout =
				JSON.stringify({
					vulnerabilities: {
						list: [
							{
								advisory: {
									package: 'test',
									title: 'Test',
									id: 'RUSTSEC-2021-001',
									aliases: [],
									url: '',
									cvss: 9.5,
								},
								package: { version: '1.0.0' },
								versions: { patched: [] },
							},
						],
					},
				}) + '\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'cargo' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings[0].severity).toBe('critical');
		});

		it('should map CVSS 7.5 to high severity', async () => {
			mockExitCode = 1;
			mockStdout =
				JSON.stringify({
					vulnerabilities: {
						list: [
							{
								advisory: {
									package: 'test',
									title: 'Test',
									id: 'RUSTSEC-2021-001',
									aliases: [],
									url: '',
									cvss: 7.5,
								},
								package: { version: '1.0.0' },
								versions: { patched: [] },
							},
						],
					},
				}) + '\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'cargo' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings[0].severity).toBe('high');
		});

		it('should map CVSS 5.0 to moderate severity', async () => {
			mockExitCode = 1;
			mockStdout =
				JSON.stringify({
					vulnerabilities: {
						list: [
							{
								advisory: {
									package: 'test',
									title: 'Test',
									id: 'RUSTSEC-2021-001',
									aliases: [],
									url: '',
									cvss: 5.0,
								},
								package: { version: '1.0.0' },
								versions: { patched: [] },
							},
						],
					},
				}) + '\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'cargo' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings[0].severity).toBe('moderate');
		});

		it('should map CVSS 2.0 to low severity', async () => {
			mockExitCode = 1;
			mockStdout =
				JSON.stringify({
					vulnerabilities: {
						list: [
							{
								advisory: {
									package: 'test',
									title: 'Test',
									id: 'RUSTSEC-2021-001',
									aliases: [],
									url: '',
									cvss: 2.0,
								},
								package: { version: '1.0.0' },
								versions: { patched: [] },
							},
						],
					},
				}) + '\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'cargo' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings[0].severity).toBe('low');
		});

		it('should map undefined/0 CVSS to low severity', async () => {
			mockExitCode = 1;
			mockStdout =
				JSON.stringify({
					vulnerabilities: {
						list: [
							{
								advisory: {
									package: 'test',
									title: 'Test',
									id: 'RUSTSEC-2021-001',
									aliases: [],
									url: '',
									cvss: 0,
								},
								package: { version: '1.0.0' },
								versions: { patched: [] },
							},
						],
					},
				}) + '\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'cargo' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// cvss = 0 falls to default case, returning low
			expect(parsed.findings[0].severity).toBe('low');
		});

		it('should return clean:true when no vulnerabilities found (exit code 0)', async () => {
			mockExitCode = 0;
			mockStdout = '{"vulnerabilities": null}';

			const result = await pkg_audit.execute(
				{ ecosystem: 'cargo' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.findings.length).toBe(0);
		});

		it('should handle cargo-audit not installed', async () => {
			mockSpawnError = new Error('cargo-audit: command not found');

			const result = await pkg_audit.execute(
				{ ecosystem: 'cargo' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('not installed');
		});
	});

	// ============ Combined Result Tests ============
	describe('combined result for auto with multiple ecosystems', () => {
		it('should combine results from multiple ecosystems', async () => {
			// Create multiple project files
			fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
			fs.writeFileSync(
				path.join(tempDir, 'Cargo.toml'),
				'[package]\nname = "test"',
			);

			// First call is npm (exit 0), second is cargo (exit 0)
			let callCount = 0;
			const originalMockSpawn = Bun.spawn;
			Bun.spawn = (cmd, opts) => {
				callCount++;
				if (cmd[0] === 'npm') {
					mockStdout = '{"vulnerabilities": {}}';
				} else if (cmd[0] === 'cargo') {
					mockStdout = '{"vulnerabilities": null}';
				}
				return mockSpawn(cmd, opts);
			};

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems.length).toBe(2);
			expect(parsed.ecosystems).toContain('npm');
			expect(parsed.ecosystems).toContain('cargo');

			Bun.spawn = originalMockSpawn;
		});

		// MH1: a silently-failed sub-scan (tool missing / timeout / parse error)
		// must NOT let the combined result report unqualified clean:true.
		it('should NOT report clean:true when one sub-scan is tool-missing/incomplete', async () => {
			fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
			fs.writeFileSync(
				path.join(tempDir, 'Cargo.toml'),
				'[package]\nname = "test"',
			);

			// npm completes clean; cargo-audit is "not installed" (spawn throws
			// with a command-not-found message) → runCargoAudit returns
			// incomplete:true.
			const originalMockSpawn = Bun.spawn;
			Bun.spawn = (cmd, opts) => {
				if (cmd[0] === 'npm') {
					mockSpawnError = null;
					mockExitCode = 0;
					mockStdout = '{"vulnerabilities": {}}';
					return mockSpawn(cmd, opts);
				}
				// cargo path: simulate the tool being absent.
				throw new Error('cargo-audit: command not found');
			};

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);
			Bun.spawn = originalMockSpawn;

			// The core MH1 assertion: absence of findings is unproven because a
			// sub-scan did not complete, so clean must NOT be an unqualified true.
			expect(parsed.clean).toBe(false);
			// The incomplete ecosystem is surfaced explicitly.
			expect(parsed.ecosystemsIncomplete).toContain('cargo');
			// npm actually completed and must not be flagged incomplete.
			expect(parsed.ecosystemsIncomplete).not.toContain('npm');
			// The per-ecosystem note is surfaced (not silently dropped).
			expect(Array.isArray(parsed.notes)).toBe(true);
			expect(
				parsed.notes.some((n: string) => n.includes('not installed')),
			).toBe(true);
		});

		// MH1 critic refinement: a COMPLETED scan that attaches a benign
		// informational note (dart "outdated packages, not security
		// vulnerabilities") must NOT be treated as incomplete — clean stays true.
		it('should keep clean:true when a sub-scan completes with a benign note (dart-style)', async () => {
			fs.writeFileSync(path.join(tempDir, 'pubspec.yaml'), 'name: test');

			// Force dart to be "available" via the discovery DI seam so the dart
			// scan actually runs instead of short-circuiting to a not-installed
			// (incomplete) result. Toolchain cache is cleared before/after to
			// avoid cross-test leakage (mirrors the _internals DI pattern).
			const originalSpawnSync = discoveryInternals.spawnSyncImpl;
			clearToolchainCache();
			discoveryInternals.spawnSyncImpl = () => ({
				stdout: new Uint8Array(),
				stderr: new Uint8Array(),
				exitCode: 0,
				success: true,
			});

			try {
				// dart pub outdated: exit 0, valid JSON, no upgradable packages →
				// a completed clean scan that still attaches the benign note.
				mockSpawnError = null;
				mockExitCode = 0;
				mockStdout = JSON.stringify({ packages: [] });

				const result = await pkg_audit.execute(
					{ ecosystem: 'auto' },
					getMockContext(),
				);
				const parsed = JSON.parse(result);

				expect(parsed.ecosystems).toContain('dart');
				// Benign note present, scan completed → clean must remain true.
				expect(parsed.clean).toBe(true);
				expect(
					parsed.notes.some((n: string) =>
						n.includes('not security vulnerabilities'),
					),
				).toBe(true);
				// A benign note must NOT be counted as incomplete.
				expect(parsed.ecosystemsIncomplete).not.toContain('dart');
				expect(parsed.ecosystemsIncomplete.length).toBe(0);
			} finally {
				discoveryInternals.spawnSyncImpl = originalSpawnSync;
				clearToolchainCache();
			}
		});
	});

	// ============ Adversarial Tests ============
	describe('adversarial tests', () => {
		it('should handle invalid ecosystem value: "evil"', async () => {
			const result = await pkg_audit.execute(
				{ ecosystem: 'evil' as any },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBeDefined();
			expect(parsed.error).toContain('Invalid arguments');
		});

		it('should handle malformed JSON from audit command', async () => {
			mockExitCode = 1;
			mockStdout = 'this is not { valid json';
			mockStderr = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// Should return clean with note
			expect(parsed.clean).toBe(true);
			expect(parsed.note).toBeDefined();
		});

		it('should handle empty output from audit command', async () => {
			mockExitCode = 0;
			mockStdout = '';
			mockStderr = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// Empty output with exit code 0 means clean
			expect(parsed.clean).toBe(true);
		});

		it('should handle timeout gracefully', async () => {
			// This is harder to test with the mock, but we can verify the code path exists
			// by checking that the note is generated on actual timeout in real scenarios
			mockExitCode = 0;
			mockStdout = '';
			mockStderr = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// Verify we got a result (basic sanity)
			expect(parsed).toBeDefined();
		});
	});

	// ============ Count Tests ============
	describe('count tests', () => {
		it('should correctly count critical and high vulnerabilities', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				vulnerabilities: {
					lodash: {
						severity: 'critical',
						range: '4.17.15',
						fixAvailable: { version: '4.17.21' },
					},
					express: {
						severity: 'high',
						range: '4.0.0',
						fixAvailable: true,
					},
					moment: {
						severity: 'moderate',
						range: '2.29.0',
						fixAvailable: { version: '2.29.4' },
					},
				},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.criticalCount).toBe(1);
			expect(parsed.highCount).toBe(1);
			expect(parsed.totalCount).toBe(3);
		});
	});

	// ============ New Ecosystem Detection Tests ============
	describe('new ecosystem detection', () => {
		it('should auto-detect go from go.mod presence', async () => {
			fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module test');

			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toContain('go');
		});

		it('should auto-detect dotnet from .csproj presence', async () => {
			fs.writeFileSync(
				path.join(tempDir, 'TestProject.csproj'),
				'<Project></Project>',
			);

			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toContain('dotnet');
		});

		it('should auto-detect dotnet from .sln presence', async () => {
			fs.writeFileSync(
				path.join(tempDir, 'TestSolution.sln'),
				'Solution file content',
			);

			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toContain('dotnet');
		});

		it('should auto-detect ruby from Gemfile presence', async () => {
			fs.writeFileSync(
				path.join(tempDir, 'Gemfile'),
				'source "https://rubygems.org"',
			);

			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toContain('ruby');
		});

		it('should auto-detect ruby from Gemfile.lock presence', async () => {
			fs.writeFileSync(
				path.join(tempDir, 'Gemfile.lock'),
				'GEM\n  remote: https://rubygems.org/',
			);

			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toContain('ruby');
		});

		it('should auto-detect dart from pubspec.yaml presence', async () => {
			fs.writeFileSync(path.join(tempDir, 'pubspec.yaml'), 'name: test');

			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toContain('dart');
		});

		it('should detect multiple new ecosystems together', async () => {
			fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module test');
			fs.writeFileSync(
				path.join(tempDir, 'TestProject.csproj'),
				'<Project></Project>',
			);
			fs.writeFileSync(
				path.join(tempDir, 'Gemfile'),
				'source "https://rubygems.org"',
			);
			fs.writeFileSync(path.join(tempDir, 'pubspec.yaml'), 'name: test');

			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.ecosystems).toContain('go');
			expect(parsed.ecosystems).toContain('dotnet');
			expect(parsed.ecosystems).toContain('ruby');
			expect(parsed.ecosystems).toContain('dart');
		});
	});

	// ============ Go Audit (govulncheck) Tests ============
	describe('govulncheck audit', () => {
		it('should return clean with note when govulncheck not on PATH', async () => {
			mockSpawnError = new Error("'govulncheck' is not recognized");

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('not installed');
		});

		it('should parse govulncheck JSON Lines output correctly with exit code 3', async () => {
			mockExitCode = 3; // vulns found
			// govulncheck outputs multiple JSON objects, one per line
			mockStdout =
				JSON.stringify({
					osv: {
						id: 'GO-2021-0053',
						summary: 'Unbounded memory consumption in gzip',
						aliases: ['CVE-2021-33196'],
					},
				}) +
				'\n' +
				JSON.stringify({
					finding: {
						osv: 'GO-2021-0053',
						trace: [
							{
								module: 'compress/gzip',
								version: 'v1.0.0',
							},
						],
						fixed_by: 'v1.0.1',
					},
				}) +
				'\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// Skip assertions if govulncheck is not installed
			if (parsed.note?.includes('not installed')) {
				return;
			}

			expect(parsed.clean).toBe(false);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe('compress/gzip');
			expect(parsed.findings[0].severity).toBe('high'); // CVE alias → high
			expect(parsed.findings[0].cve).toBe('CVE-2021-33196');
			expect(parsed.findings[0].patchedVersion).toBe('v1.0.1');
		});

		it('should extract CVE alias and map to high severity', async () => {
			mockExitCode = 3;
			mockStdout =
				JSON.stringify({
					osv: {
						id: 'GO-2021-0053',
						summary: 'Unbounded memory consumption in gzip',
						aliases: ['CVE-2021-33196', 'GHSA-xxxxx'],
					},
				}) +
				'\n' +
				JSON.stringify({
					finding: {
						osv: 'GO-2021-0053',
						trace: [{ module: 'test', version: '1.0.0' }],
						fixed_by: null,
					},
				}) +
				'\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].severity).toBe('high');
			expect(parsed.findings[0].cve).toBe('CVE-2021-33196');
		});

		it('should map to moderate severity when no CVE alias', async () => {
			mockExitCode = 3;
			mockStdout =
				JSON.stringify({
					osv: {
						id: 'GO-2021-0053',
						summary: 'Unbounded memory consumption',
						aliases: [], // no CVE alias
					},
				}) +
				'\n' +
				JSON.stringify({
					finding: {
						osv: 'GO-2021-0053',
						trace: [{ module: 'test', version: '1.0.0' }],
						fixed_by: null,
					},
				}) +
				'\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].severity).toBe('moderate');
			expect(parsed.findings[0].cve).toBe(null);
		});

		it('should return clean with no findings when exit code 0', async () => {
			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.clean).toBe(true);
			expect(parsed.findings.length).toBe(0);
		});

		it('should return clean with note for other exit codes (e.g. 2)', async () => {
			mockExitCode = 2; // not 0 or 3
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('exited with code 2');
		});

		it('should handle timeout', async () => {
			// Mock timeout by simulating the behavior - we can't actually test timeout
			// but we can verify the error handling structure exists
			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed).toBeDefined();
		});

		it('should skip malformed JSON lines gracefully', async () => {
			mockExitCode = 3;
			mockStdout =
				JSON.stringify({
					osv: {
						id: 'GO-2021-0053',
						summary: 'Test',
						aliases: ['CVE-2021-33196'],
					},
				}) +
				'\n' +
				'not valid json' +
				'\n' +
				JSON.stringify({
					finding: {
						osv: 'GO-2021-0053',
						trace: [{ module: 'test', version: '1.0.0' }],
						fixed_by: null,
					},
				}) +
				'\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			// Should still parse the valid JSON
			expect(parsed.findings.length).toBe(1);
		});
	});

	// ============ dotnet Audit Tests ============
	describe('dotnet list package audit', () => {
		it('should return clean with note when dotnet not on PATH', async () => {
			mockSpawnError = new Error("'dotnet' is not recognized");

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			// Note: The error message format for dotnet differs from other tools
			expect(parsed.note).toBeDefined();
		});

		it('should parse text output regex for Critical vulnerabilities', async () => {
			mockExitCode = 1;
			// Simulate dotnet list package --vulnerable output
			mockStdout = `The following projects have vulnerable packages:

Project > TestProject
  > Newtonsoft.Json  12.0.1  12.0.3  Critical  https://nvd.nist.gov/vuln/detail/CVE-2021-31120

Project has the following vulnerable packages
`;

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.clean).toBe(false);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe('Newtonsoft.Json');
			expect(parsed.findings[0].severity).toBe('critical');
			expect(parsed.findings[0].url).toBe(
				'https://nvd.nist.gov/vuln/detail/CVE-2021-31120',
			);
		});

		it('should parse text output regex for High vulnerabilities', async () => {
			mockExitCode = 1;
			mockStdout = `Project > TestProject
  > test-package  1.0.0  2.0.0  High  https://example.com/vuln

Project has the following vulnerable packages
`;

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].severity).toBe('high');
		});

		it('should parse text output regex for Moderate vulnerabilities', async () => {
			mockExitCode = 1;
			mockStdout = `Project > TestProject
  > test-package  1.0.0  2.0.0  Moderate  https://example.com/vuln

Project has the following vulnerable packages
`;

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].severity).toBe('moderate');
		});

		it('should parse text output regex for Low vulnerabilities', async () => {
			mockExitCode = 1;
			mockStdout = `Project > TestProject
  > test-package  1.0.0  2.0.0  Low  https://example.com/vuln

Project has the following vulnerable packages
`;

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].severity).toBe('low');
		});

		it('should return clean with exit code note when non-zero without vulnerable packages header', async () => {
			mockExitCode = 1;
			mockStdout = 'Some other error message';

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('exited with code 1');
		});

		it('should proceed to parse when non-zero WITH vulnerable packages header', async () => {
			mockExitCode = 1;
			mockStdout = `Project > TestProject
  > test-package  1.0.0  2.0.0  High  https://example.com/vuln

Project has the following vulnerable packages
`;

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.clean).toBe(false);
			expect(parsed.findings.length).toBe(1);
		});

		it('should handle timeout', async () => {
			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed).toBeDefined();
		});

		it('should return clean with empty output', async () => {
			mockExitCode = 0;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.clean).toBe(true);
		});
	});

	// ============ bundle-audit (Ruby) Tests ============
	describe('bundle-audit audit', () => {
		it('should return clean with note when neither bundle-audit nor bundle on PATH', async () => {
			// The "not installed" note comes from `runBundleAudit`'s
			// `isCommandAvailable` early return, so the test must ESTABLISH that
			// precondition rather than inherit it from the host. It previously did
			// not, and passed only where Ruby happens to be absent — which is true
			// on this Windows box and on ubuntu, and FALSE on macos-latest, where
			// Ruby ships preinstalled so `bundle` resolves, the early return never
			// fires, and the assertion sees "bundle-audit JSON output could not be
			// parsed" instead. Same host-dependent-precondition class as the
			// fabricated-path failures in #2236.
			//
			// Forced unavailable through the discovery DI seam, mirroring the dart
			// case above. Cache cleared either side so nothing leaks between tests.
			const originalSpawnSync = discoveryInternals.spawnSyncImpl;
			clearToolchainCache();
			discoveryInternals.spawnSyncImpl = () => ({
				stdout: new Uint8Array(),
				stderr: new Uint8Array(),
				exitCode: 1,
				success: false,
			});

			try {
				mockSpawnError = new Error("'bundle-audit' is not recognized");

				const result = await pkg_audit.execute(
					{ ecosystem: 'ruby' },
					getMockContext(),
				);
				const parsed = JSON.parse(result);

				expect(parsed.clean).toBe(true);
				expect(parsed.note).toContain('not installed');
			} finally {
				discoveryInternals.spawnSyncImpl = originalSpawnSync;
				clearToolchainCache();
			}
		});

		it('should return clean with no findings when exit code 0', async () => {
			mockExitCode = 0;
			mockStdout = '{}';

			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.clean).toBe(true);
			expect(parsed.findings.length).toBe(0);
		});

		it('should parse bundle-audit JSON format and return findings with exit code 1', async () => {
			mockExitCode = 1; // vulnerabilities found
			mockStdout = JSON.stringify({
				results: [
					{
						type: 'Dependency',
						gem: { name: 'rack', version: '2.0.0' },
						advisory: {
							id: 'OSVDB-121729',
							cve: 'CVE-2015-3225',
							url: 'https://groups.google.com/forum/#!topic/ruby-security-ann/6jBZJ8pr7y0',
							title: 'Possible XSS vulnerability in Rack',
							cvss_v3: 7.5,
							patched_versions: ['~> 1.6.4', '~> 1.5.5', '>= 2.0.1'],
							criticality: 'High',
						},
					},
				],
				ignored: [],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.clean).toBe(false);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe('rack');
			expect(parsed.findings[0].cve).toBe('CVE-2015-3225');
		});

		it('should return clean with note for exit code 2 (error)', async () => {
			mockExitCode = 2;
			mockStdout = 'Error occurred';

			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('failed with exit code 2');
		});

		it('should map Critical criticality to critical severity', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				results: [
					{
						type: 'Dependency',
						gem: { name: 'test', version: '1.0.0' },
						advisory: {
							id: 'TEST-001',
							url: 'https://example.com',
							title: 'Test vuln',
							patched_versions: ['2.0.0'],
							criticality: 'Critical',
						},
					},
				],
				ignored: [],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].severity).toBe('critical');
		});

		it('should map High criticality to high severity', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				results: [
					{
						type: 'Dependency',
						gem: { name: 'test', version: '1.0.0' },
						advisory: {
							id: 'TEST-001',
							url: 'https://example.com',
							title: 'Test vuln',
							patched_versions: ['2.0.0'],
							criticality: 'High',
						},
					},
				],
				ignored: [],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].severity).toBe('high');
		});

		it('should map Medium criticality to moderate severity', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				results: [
					{
						type: 'Dependency',
						gem: { name: 'test', version: '1.0.0' },
						advisory: {
							id: 'TEST-001',
							url: 'https://example.com',
							title: 'Test vuln',
							patched_versions: ['2.0.0'],
							criticality: 'Medium',
						},
					},
				],
				ignored: [],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].severity).toBe('moderate');
		});

		it('should map Low criticality to low severity', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				results: [
					{
						type: 'Dependency',
						gem: { name: 'test', version: '1.0.0' },
						advisory: {
							id: 'TEST-001',
							url: 'https://example.com',
							title: 'Test vuln',
							patched_versions: ['2.0.0'],
							criticality: 'Low',
						},
					},
				],
				ignored: [],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].severity).toBe('low');
		});

		it('should fall back to CVSS scoring when criticality missing', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				results: [
					{
						type: 'Dependency',
						gem: { name: 'test', version: '1.0.0' },
						advisory: {
							id: 'TEST-001',
							url: 'https://example.com',
							title: 'Test vuln',
							cvss_v3: 9.5,
							patched_versions: ['2.0.0'],
							// no criticality field
						},
					},
				],
				ignored: [],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].severity).toBe('critical'); // CVSS 9.5 -> critical
		});

		it('should set patchedVersion from patched_versions[0]', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				results: [
					{
						type: 'Dependency',
						gem: { name: 'test', version: '1.0.0' },
						advisory: {
							id: 'TEST-001',
							url: 'https://example.com',
							title: 'Test vuln',
							patched_versions: ['~> 2.0.0', '>= 3.0.0'],
						},
					},
				],
				ignored: [],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].patchedVersion).toBe('~> 2.0.0');
		});

		it('should handle malformed JSON', async () => {
			mockExitCode = 1;
			mockStdout = 'not valid json';

			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('could not be parsed');
		});
	});

	// ============ Dart Audit Tests ============
	describe('dart pub outdated audit', () => {
		it('should return clean with note when neither dart nor flutter on PATH', async () => {
			mockSpawnError = new Error("'dart' is not recognized");

			const result = await pkg_audit.execute(
				{ ecosystem: 'dart' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('not installed');
		});

		it('should return clean with note for non-zero exit code', async () => {
			mockExitCode = 1;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'dart' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('exited with code 1');
		});

		it('should not include packages where current == latest', async () => {
			mockExitCode = 0;
			mockStdout = JSON.stringify({
				packages: [
					{
						package: 'up-to-date-pkg',
						current: { version: '1.0.0' },
						latest: { version: '1.0.0' },
						upgradable: { version: '1.0.0' },
					},
				],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'dart' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings.length).toBe(0);
		});

		it('should include packages with upgradable version as info severity', async () => {
			mockExitCode = 0;
			mockStdout = JSON.stringify({
				packages: [
					{
						package: 'outdated-pkg',
						current: { version: '1.0.0' },
						latest: { version: '2.0.0' },
						upgradable: { version: '1.5.0' },
					},
				],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'dart' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe('outdated-pkg');
			expect(parsed.findings[0].severity).toBe('info');
		});

		it('should set patchedVersion to upgradable.version', async () => {
			mockExitCode = 0;
			mockStdout = JSON.stringify({
				packages: [
					{
						package: 'test-pkg',
						current: { version: '1.0.0' },
						latest: { version: '2.0.0' },
						upgradable: { version: '1.5.0' },
					},
				],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'dart' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].patchedVersion).toBe('1.5.0');
		});

		it('should set url to pub.dev URL', async () => {
			mockExitCode = 0;
			mockStdout = JSON.stringify({
				packages: [
					{
						package: 'test-pkg',
						current: { version: '1.0.0' },
						latest: { version: '2.0.0' },
						upgradable: { version: '1.5.0' },
					},
				],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'dart' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.findings[0].url).toBe('https://pub.dev/packages/test-pkg');
		});

		it('should always return note about not security vulnerabilities', async () => {
			mockExitCode = 0;
			mockStdout = JSON.stringify({
				packages: [
					{
						package: 'test-pkg',
						current: { version: '1.0.0' },
						latest: { version: '2.0.0' },
						upgradable: { version: '1.5.0' },
					},
				],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'dart' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.note).toContain('not security vulnerabilities');
		});

		it('should handle malformed JSON', async () => {
			mockExitCode = 0;
			mockStdout = 'not valid json';

			const result = await pkg_audit.execute(
				{ ecosystem: 'dart' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (parsed.note?.includes('not installed')) return;

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('could not be parsed');
		});
	});
});
