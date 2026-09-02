import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { pkg_audit } from '../../../src/tools/pkg-audit';
import {
	installComposerProbeSeam,
	restoreDiscoverySeam,
} from '../../helpers/discovery-seam';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

// Composer availability follows `mockIsCommandAvailable` through the shared
// discovery seam helper (never a file-scope mock.module — issue #2260/#2477).
let mockIsCommandAvailable = true;

// Mock for Bun.spawn
let originalSpawn: typeof Bun.spawn;
let mockExitCode: number = 0;
let mockStdout: string = '';
let mockStderr: string = '';
let mockSpawnError: Error | null = null;

function mockSpawn(cmd: string[], opts: unknown) {
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

// Temp directory
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

describe('pkg-audit composer audit adversarial', () => {
	beforeEach(() => {
		mockIsCommandAvailable = true; // composer probe follows this flag
		installComposerProbeSeam(() => mockIsCommandAvailable);

		originalSpawn = Bun.spawn;
		mockExitCode = 0;
		mockStdout = '';
		mockStderr = '';
		mockSpawnError = null;
		Bun.spawn = mockSpawn;

		originalCwd = process.cwd();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-audit-adv-test-')),
		);
		process.chdir(tempDir);
	});

	afterEach(() => {
		// Unthrowable restores first (review F-002); teardown is best-effort.
		restoreDiscoverySeam();
		Bun.spawn = originalSpawn;
		try {
			process.chdir(originalCwd);
			safeRmRecursive(tempDir); // retried EBUSY/EPERM (#2017/#2028 class)
		} catch {
			/* dir left to the OS after exhausted retries */
		}
	});

	// ===== 1. Oversized advisory title (10,000+ chars) =====
	describe('oversized advisory title', () => {
		it('should not crash with 10000-character title and store it as-is', async () => {
			mockExitCode = 1;
			const hugeTitle = 'X'.repeat(10_000);
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: 'GHSA-test',
							packageName: 'vendor/pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: hugeTitle,
							link: 'https://github.com/advisories/GHSA-test',
							cve: 'CVE-2024-99999',
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

			expect(parsed.clean).toBe(false);
			expect(parsed.findings.length).toBe(1);
			expect(parsed.findings[0].title).toBe(hugeTitle);
		});

		it('should handle 1MB title without crashing', async () => {
			mockExitCode = 1;
			const massiveTitle = 'BUFFER_OVERFLOW '.repeat(50_000);
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: 'GHSA-massive',
							packageName: 'vendor/pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: massiveTitle,
							link: 'https://github.com/advisories/GHSA-massive',
							cve: 'CVE-2024-00001',
							affectedVersions: '>=0',
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
			expect(parsed.findings[0].title).toBe(massiveTitle);
		});
	});

	// ===== 2. Injection in packageName =====
	describe('packageName injection attempts', () => {
		it('should store newline injection in packageName without executing it', async () => {
			mockExitCode = 1;
			const maliciousPkg = 'vendor/pkg\n; rm -rf /';
			mockStdout = JSON.stringify({
				advisories: {
					'malicious-key': [
						{
							advisoryId: 'GHSA-inject1',
							packageName: maliciousPkg,
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Injection test',
							link: 'https://github.com/advisories/GHSA-inject1',
							cve: 'CVE-2024-00002',
							affectedVersions: '*',
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
			expect(parsed.findings[0].package).toBe(maliciousPkg);
			expect(parsed.findings[0].package).toContain('\n');
		});

		it('should store shell metacharacters in packageName safely', async () => {
			mockExitCode = 1;
			const shellChars = 'pkg$(echo pwned)pkg`id`pkg';
			mockStdout = JSON.stringify({
				advisories: {
					'shell-key': [
						{
							advisoryId: 'GHSA-shell',
							packageName: shellChars,
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Shell injection',
							link: 'https://github.com/advisories/GHSA-shell',
							cve: 'CVE-2024-00003',
							affectedVersions: '*',
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

			expect(parsed.findings[0].package).toBe(shellChars);
		});

		it('should store path traversal attempt in packageName', async () => {
			mockExitCode = 1;
			const pathTraversal = '../../../etc/passwd';
			mockStdout = JSON.stringify({
				advisories: {
					'traversal-key': [
						{
							advisoryId: 'GHSA-traverse',
							packageName: pathTraversal,
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Path traversal',
							link: 'https://github.com/advisories/GHSA-traverse',
							cve: 'CVE-2024-00004',
							affectedVersions: '*',
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

			expect(parsed.findings[0].package).toBe(pathTraversal);
		});
	});

	// ===== 3. Injection in CVE field =====
	describe('CVE field injection attempts', () => {
		it('should store HTML/script injection in CVE field without executing', async () => {
			mockExitCode = 1;
			const maliciousCve = 'CVE-2024-<script>alert(1)</script>';
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: 'GHSA-xss',
							packageName: 'vendor/pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'XSS in CVE',
							link: 'https://github.com/advisories/GHSA-xss',
							cve: maliciousCve,
							affectedVersions: '*',
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

			expect(parsed.findings[0].cve).toBe(maliciousCve);
			expect(parsed.findings[0].cve).toContain('<script>');
		});

		it('should store template literal injection in CVE field', async () => {
			mockExitCode = 1;
			const templateCve = 'CVE-2024-${process.env.SECRET}';
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: 'GHSA-tpl',
							packageName: 'vendor/pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Template injection',
							link: 'https://github.com/advisories/GHSA-tpl',
							cve: templateCve,
							affectedVersions: '*',
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

			expect(parsed.findings[0].cve).toBe(templateCve);
		});

		it('should store SQL injection pattern in CVE field', async () => {
			mockExitCode = 1;
			const sqlCve = "CVE-2024-99999'; DROP TABLE users;--";
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: 'GHSA-sql',
							packageName: 'vendor/pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'SQL in CVE',
							link: 'https://github.com/advisories/GHSA-sql',
							cve: sqlCve,
							affectedVersions: '*',
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

			expect(parsed.findings[0].cve).toBe(sqlCve);
		});
	});

	// ===== 4. Null fields in advisory =====
	describe('null fields in advisory', () => {
		it('should handle null packageName without crashing', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: 'GHSA-null1',
							packageName: null,
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Null packageName',
							link: 'https://github.com/advisories/GHSA-null1',
							cve: 'CVE-2024-null1',
							affectedVersions: '*',
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
			expect(parsed.findings[0].package).toBe(null);
		});

		it('should handle null title without crashing', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: 'GHSA-null2',
							packageName: 'vendor/pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: null,
							link: 'https://github.com/advisories/GHSA-null2',
							cve: 'CVE-2024-null2',
							affectedVersions: '*',
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

			expect(parsed.findings[0].title).toBe(null);
		});

		it('should handle null CVE without crashing', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: 'GHSA-null3',
							packageName: 'vendor/pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Null CVE',
							link: 'https://github.com/advisories/GHSA-null3',
							cve: null,
							affectedVersions: '*',
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

			expect(parsed.findings[0].cve).toBe(null);
			expect(parsed.findings[0].severity).toBe('moderate'); // null CVE → moderate
		});

		it('should handle null link without crashing', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: 'GHSA-null4',
							packageName: 'vendor/pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Null link',
							link: null,
							cve: 'CVE-2024-null4',
							affectedVersions: '*',
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

			expect(parsed.findings[0].url).toBe(null);
		});

		it('should handle all-null advisory without crashing', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: null,
							packageName: null,
							reportedAt: null,
							title: null,
							link: null,
							cve: null,
							affectedVersions: null,
							sources: null,
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
			expect(parsed.findings[0].package).toBe(null);
			expect(parsed.findings[0].title).toBe(null);
			expect(parsed.findings[0].cve).toBe(null);
		});
	});

	// ===== 5. Empty advisories object with exit code 1 =====
	describe('empty advisories with exit code 1', () => {
		it('should return clean:false with 0 findings when advisories is empty despite exit code 1', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {},
				abandoned: {},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(false);
			expect(parsed.findings.length).toBe(0);
			expect(parsed.totalCount).toBe(0);
		});

		it('should return clean:false when advisories is undefined', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: undefined,
				abandoned: {},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(false);
		});
	});

	// ===== 6. Deeply nested / unexpected JSON structure =====
	describe('unexpected JSON structure', () => {
		it('should ignore unexpected top-level fields and still parse advisories', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				hacker: '<script>evil()</script>',
				__proto__: { polluted: true },
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: 'GHSA-ok',
							packageName: 'vendor/pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Normal advisory',
							link: 'https://github.com/advisories/GHSA-ok',
							cve: 'CVE-2024-ok',
							affectedVersions: '*',
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
			expect(parsed.findings[0].package).toBe('vendor/pkg');
		});

		it('should handle advisories as array instead of object gracefully', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: [
					{
						advisoryId: 'GHSA-array',
						packageName: 'vendor/pkg',
						reportedAt: '2024-01-01T00:00:00+00:00',
						title: 'Array advisory',
						link: 'https://github.com/advisories/GHSA-array',
						cve: 'CVE-2024-array',
						affectedVersions: '*',
						sources: [],
					},
				],
				abandoned: {},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// Object.values on array returns array indices, no advisories processed
			expect(parsed.clean).toBe(true);
			expect(parsed.findings.length).toBe(0);
		});

		it('should handle deeply nested malicious __proto__ in advisory fields', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: 'GHSA-proto',
							packageName: 'vendor/pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: { __proto__: { polluted: true }, value: 'safe title' },
							link: 'https://github.com/advisories/GHSA-proto',
							cve: 'CVE-2024-proto',
							affectedVersions: '*',
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
		});
	});

	// ===== 7. Exit code 1 with empty stdout =====
	describe('exit code 1 with empty stdout', () => {
		it('should return clean:false with error note when exit code 1 but stdout is empty', async () => {
			mockExitCode = 1;
			mockStdout = '';

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(false);
			expect(parsed.findings.length).toBe(0);
			expect(parsed.note).toContain('produced no output');
		});

		it('should handle exit code 1 with whitespace-only stdout', async () => {
			mockExitCode = 1;
			mockStdout = '   \n\t  ';

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(false);
			expect(parsed.note).toContain('produced no output');
		});
	});

	// ===== 8. Very large abandoned packages list (1000 entries) =====
	describe('large abandoned packages list', () => {
		it('should handle 1000 abandoned packages without crashing', async () => {
			mockExitCode = 2; // exit 2 = abandoned only (STATUS_ABANDONED bitmask)
			const abandoned: Record<string, string> = {};
			for (let i = 0; i < 1000; i++) {
				abandoned[`vendor/abandoned-pkg-${i}`] = `vendor/replacement-pkg-${i}`;
			}
			mockStdout = JSON.stringify({
				advisories: {},
				abandoned,
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('Abandoned packages detected');
		});

		it('should handle abandoned packages with injection characters', async () => {
			mockExitCode = 2; // exit 2 = abandoned only (STATUS_ABANDONED bitmask)
			const abandoned: Record<string, string> = {
				'vendor/evil-pkg\nrm -rf /': 'vendor/good-pkg',
				'vendor/$(whoami)': 'vendor/none',
			};
			mockStdout = JSON.stringify({
				advisories: {},
				abandoned,
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('Abandoned packages detected');
		});
	});

	// ===== 9. Unicode/emoji in package names =====
	describe('unicode/emoji in package names', () => {
		it('should handle unicode package names including emoji', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/unicode-pkg': [
						{
							advisoryId: 'GHSA-unicode',
							packageName: 'vendor/unicode-pkg 🚀',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Unicode package name with emoji 🚀🐔🔴',
							link: 'https://github.com/advisories/GHSA-unicode',
							cve: 'CVE-2024-unicode',
							affectedVersions: '*',
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

			expect(parsed.findings[0].package).toBe('vendor/unicode-pkg 🚀');
			expect(parsed.findings[0].title).toContain('🚀');
		});

		it('should handle RTL unicode override characters', async () => {
			mockExitCode = 1;
			const rtlOverride = 'vendor/\u202Epkg\u202E'; // RLO + LRI + PDF
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/rtl-key': [
						{
							advisoryId: 'GHSA-rtl',
							packageName: rtlOverride,
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'RTL override attack',
							link: 'https://github.com/advisories/GHSA-rtl',
							cve: 'CVE-2024-rtl',
							affectedVersions: '*',
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

			expect(parsed.findings[0].package).toBe(rtlOverride);
		});

		it('should handle zero-width characters in CVE', async () => {
			mockExitCode = 1;
			const zwCve = 'CVE-2024-\u200B\u200C\u200D99999'; // zero-width space/zero-width joiner
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/pkg': [
						{
							advisoryId: 'GHSA-zw',
							packageName: 'vendor/pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'Zero-width CVE',
							link: 'https://github.com/advisories/GHSA-zw',
							cve: zwCve,
							affectedVersions: '*',
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

			expect(parsed.findings[0].cve).toBe(zwCve);
		});
	});

	// ===== 10. Multiple advisories for same package =====
	describe('multiple advisories for same package', () => {
		it('should return all advisories for a package as separate findings', async () => {
			mockExitCode = 1;
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/multi-advisory-pkg': [
						{
							advisoryId: 'GHSA-first',
							packageName: 'vendor/multi-advisory-pkg',
							reportedAt: '2024-01-01T00:00:00+00:00',
							title: 'First vulnerability',
							link: 'https://github.com/advisories/GHSA-first',
							cve: 'CVE-2024-first',
							affectedVersions: '>=1.0.0 <1.2.0',
							sources: [],
						},
						{
							advisoryId: 'GHSA-second',
							packageName: 'vendor/multi-advisory-pkg',
							reportedAt: '2024-02-01T00:00:00+00:00',
							title: 'Second vulnerability',
							link: 'https://github.com/advisories/GHSA-second',
							cve: 'CVE-2024-second',
							affectedVersions: '>=2.0.0 <2.5.0',
							sources: [],
						},
						{
							advisoryId: 'GHSA-third',
							packageName: 'vendor/multi-advisory-pkg',
							reportedAt: '2024-03-01T00:00:00+00:00',
							title: 'Third vulnerability',
							link: 'https://github.com/advisories/GHSA-third',
							cve: null,
							affectedVersions: '>=0.5.0 <0.9.0',
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

			expect(parsed.findings.length).toBe(3);
			expect(parsed.totalCount).toBe(3);
			expect(parsed.findings.map((f: { cve: string | null }) => f.cve)).toEqual(
				['CVE-2024-first', 'CVE-2024-second', null],
			);
			expect(
				parsed.findings.filter(
					(f: { severity: string }) => f.severity === 'high',
				),
			).toHaveLength(2);
			expect(
				parsed.findings.filter(
					(f: { severity: string }) => f.severity === 'moderate',
				),
			).toHaveLength(1);
		});

		it('should handle 100 advisories for the same package without performance degradation', async () => {
			mockExitCode = 1;
			const advisories: Array<{
				advisoryId: string;
				packageName: string;
				reportedAt: string;
				title: string;
				link: string;
				cve: string | null;
				affectedVersions: string;
				sources: unknown[];
			}> = [];
			for (let i = 0; i < 100; i++) {
				advisories.push({
					advisoryId: `GHSA-${i}`,
					packageName: 'vendor/heavily-vulnerable',
					reportedAt: '2024-01-01T00:00:00+00:00',
					title: `Vulnerability #${i}`,
					link: `https://github.com/advisories/GHSA-${i}`,
					cve: i % 2 === 0 ? `CVE-2024-${i}` : null,
					affectedVersions: '*',
					sources: [],
				});
			}
			mockStdout = JSON.stringify({
				advisories: {
					'vendor/heavily-vulnerable': advisories,
				},
				abandoned: {},
			});

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.findings.length).toBe(100);
			expect(parsed.totalCount).toBe(100);
		});
	});

	// ===== MAX_OUTPUT_BYTES boundary =====
	describe('MAX_OUTPUT_BYTES truncation boundary', () => {
		it('should truncate stdout exceeding 50MB without crashing', async () => {
			mockExitCode = 1;
			const largePayload = 'X'.repeat(52_428_800 + 1000); // just over 50MB
			mockStdout = largePayload;

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// Should either parse what's left (possibly truncated JSON) or return error note
			// Most importantly: should NOT crash (no unhandled exception)
			expect(parsed.ecosystem).toBe('composer');
		});

		it('should handle exact 50MB output', async () => {
			mockExitCode = 1;
			// Valid JSON that is exactly at the limit (truncated first to fit valid JSON)
			const halfJson = JSON.stringify({
				advisories: { 'vendor/pkg': [{ title: 'X'.repeat(52_428_800 - 200) }] },
				abandoned: {},
			}).slice(0, 52_428_800);
			mockStdout = halfJson;

			const result = await pkg_audit.execute(
				{ ecosystem: 'composer' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			// Should gracefully handle truncated JSON
			expect(parsed.ecosystem).toBe('composer');
		});
	});
});
