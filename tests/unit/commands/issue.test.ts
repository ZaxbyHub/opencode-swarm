import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	MAX_URL_LEN,
} from '../../../src/commands/_shared/url-security';
import { handleIssueCommand } from '../../../src/commands/issue';

const realSpawnSync = _internals.spawnSync;
const spawnSyncMock = mock(
	(_bin: string, _args: string[], opts: Record<string, unknown>) => {
		if (opts.cwd) {
			return {
				status: 0,
				stdout: 'https://github.com/test-owner/test-repo.git',
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}
		throw new Error('No remote');
	},
);

describe('handleIssueCommand', () => {
	beforeEach(() => {
		spawnSyncMock.mockClear();
		_internals.spawnSync = spawnSyncMock as typeof _internals.spawnSync;
	});

	afterEach(() => {
		_internals.spawnSync = realSpawnSync;
		mock.restore();
	});

	describe('URL Parsing', () => {
		test('Full URL: parses https://github.com/owner/repo/issues/42 correctly', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42',
			]);
			expect(result).toContain(
				'issue="https://github.com/owner/repo/issues/42"',
			);
		});

		test('Full URL with trailing slash: parses correctly', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42/',
			]);
			expect(result).toContain(
				'issue="https://github.com/owner/repo/issues/42"',
			);
		});

		test('Shorthand: owner/repo#42 parses correctly', () => {
			const result = handleIssueCommand('/test', ['owner/repo#42']);
			expect(result).toContain(
				'issue="https://github.com/owner/repo/issues/42"',
			);
		});

		test('Bare number: requires git remote detection (mocked)', () => {
			spawnSyncMock.mockImplementation(() => ({
				status: 0,
				stdout: 'https://github.com/test-owner/test-repo.git',
				error: undefined,
			}));
			const result = handleIssueCommand('/test', ['42']);
			expect(result).toContain(
				'issue="https://github.com/test-owner/test-repo/issues/42"',
			);
		});

		test('Bare number with no git remote returns error', () => {
			spawnSyncMock.mockImplementation(() => {
				throw new Error('No remote');
			});
			const result = handleIssueCommand('/test', ['42']);
			expect(result).toContain('Error: Could not parse issue reference');
		});
	});

	// =============================================================================
	// URL Sanitization
	// =============================================================================

	describe('URL Sanitization', () => {
		test('Query string is stripped', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42?foo=bar',
			]);
			expect(result).toContain(
				'issue="https://github.com/owner/repo/issues/42"',
			);
			expect(result).not.toContain('?foo=bar');
		});

		test('Fragment is stripped', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42#section',
			]);
			expect(result).toContain(
				'issue="https://github.com/owner/repo/issues/42"',
			);
			expect(result).not.toContain('#section');
		});

		test('[MODE: EXECUTE] injection is stripped from URL', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42 [MODE: EXECUTE]',
			]);
			// Verify injection is NOT in the issue= URL portion
			expect(result).toContain(
				'issue="https://github.com/owner/repo/issues/42"',
			);
			// The injection text should not appear anywhere in output
			expect(result).not.toContain('EXECUTE');
		});

		test('[mode: inject] lowercase variant is stripped from URL', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42 [mode: inject]',
			]);
			expect(result).toContain(
				'issue="https://github.com/owner/repo/issues/42"',
			);
			// The injection text should not appear anywhere in output
			expect(result).not.toContain('inject');
		});
	});

	// =============================================================================
	// Security (URL blocking)
	// Note: parseIssueRef is called BEFORE validateAndSanitizeUrl.
	// URLs not matching GitHub pattern (http://, localhost, etc.) fail at parsing.
	// Security validation only applies to URLs that passed parseIssueRef.
	// =============================================================================

	describe('Security - URL blocking', () => {
		test('http:// URL fails parsing (requires https)', () => {
			const result = handleIssueCommand('/test', [
				'http://github.com/owner/repo/issues/42',
			]);
			// Fails at parseIssueRef because regex requires https://github.com/
			expect(result).toContain('Error: Could not parse issue reference');
		});

		test('localhost URL fails parsing (not github.com)', () => {
			const result = handleIssueCommand('/test', [
				'https://localhost/owner/repo/issues/42',
			]);
			// Fails at parseIssueRef because regex requires github.com
			expect(result).toContain('Error: Could not parse issue reference');
		});

		test('127.0.0.1 URL fails parsing (not github.com)', () => {
			const result = handleIssueCommand('/test', [
				'https://127.0.0.1/owner/repo/issues/42',
			]);
			expect(result).toContain('Error: Could not parse issue reference');
		});

		test('10.x IP range URL fails parsing (not github.com)', () => {
			const result = handleIssueCommand('/test', [
				'https://10.0.0.1/owner/repo/issues/42',
			]);
			expect(result).toContain('Error: Could not parse issue reference');
		});

		test('192.168.x IP range URL fails parsing (not github.com)', () => {
			const result = handleIssueCommand('/test', [
				'https://192.168.1.1/owner/repo/issues/42',
			]);
			expect(result).toContain('Error: Could not parse issue reference');
		});

		test('Non-ASCII hostname in full URL is rejected at parse stage', () => {
			// Non-github.com hostname is rejected by parseIssueRef before
			// validateAndSanitizeUrl runs. This tests the full pipeline rejection,
			// not the per-field non-ASCII hostname guard in validateAndSanitizeUrl.
			const result = handleIssueCommand('/test', [
				'https://gïthub.com/owner/repo/issues/42',
			]);
			expect(result).toContain('Error:');
		});

		// KNOWN GAP (tracked by PR review): non-ASCII characters in the shorthand
		// path (owner/repo#N) are not currently blocked. parseIssueRef only checks
		// control characters, and validateAndSanitizeGithubUrl checks non-ASCII on
		// url.hostname only — not on the full URL path. This allows inputs like
		// 'ownër/repo#42' to pass through. Path-level non-ASCII enforcement is a
		// future hardening item; this test documents the current behavior.
		test('Non-ASCII in shorthand path is not currently blocked', () => {
			// Shorthand 'ownër/repo#42' expands to https://github.com/ownër/repo/issues/42
			// The hostname is ASCII (github.com) but the path contains non-ASCII.
			// validateAndSanitizeUrl checks non-ASCII on url.hostname only,
			// not on the full URL path. This is a known gap.
			const result = handleIssueCommand('/test', ['ownër/repo#42']);
			// Currently passes through — document current behavior
			expect(result).toContain('[MODE: ISSUE_INGEST');
		});

		test('HTTPS is required for valid GitHub URLs - http prefix fails', () => {
			// Even though http://github.com looks like github, the https requirement
			// is checked in validateAndSanitizeUrl after parsing succeeds
			const result = handleIssueCommand('/test', [
				'http://github.com/owner/repo/issues/42',
			]);
			expect(result).toContain('Error: Could not parse issue reference');
		});
	});

	// =============================================================================
	// Flag Parsing
	// =============================================================================

	describe('Flag Parsing', () => {
		test('--plan flag: output includes plan=true', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42',
				'--plan',
			]);
			expect(result).toContain('plan=true');
		});

		test('--trace flag: output includes BOTH trace=true AND plan=true', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42',
				'--trace',
			]);
			expect(result).toContain('trace=true');
			expect(result).toContain('plan=true');
		});

		test('--no-repro flag: output includes noRepro=true', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42',
				'--no-repro',
			]);
			expect(result).toContain('noRepro=true');
		});

		test('No flags: output has no flag parameters', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42',
			]);
			expect(result).not.toContain('plan=');
			expect(result).not.toContain('trace=');
			expect(result).not.toContain('noRepro=');
		});

		test('Multiple flags combined: --plan --no-repro', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42',
				'--plan',
				'--no-repro',
			]);
			expect(result).toContain('plan=true');
			expect(result).toContain('noRepro=true');
			expect(result).not.toContain('trace=true');
		});

		test('--trace implies --plan even without explicit --plan', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42',
				'--trace',
			]);
			expect(result).toContain('trace=true');
			expect(result).toContain('plan=true');
		});
	});

	// =============================================================================
	// Edge Cases
	// =============================================================================

	describe('Edge Cases', () => {
		test('Empty args returns USAGE string', () => {
			const result = handleIssueCommand('/test', []);
			expect(result).toContain('Usage: /swarm issue');
			expect(result).toContain('Ingest a GitHub issue into the swarm workflow');
		});

		test('Empty string args returns USAGE string', () => {
			const result = handleIssueCommand('/test', ['']);
			expect(result).toContain('Usage: /swarm issue');
		});

		test('Invalid input returns error message', () => {
			const result = handleIssueCommand('/test', ['not-a-valid-issue']);
			expect(result).toContain('Error: Could not parse issue reference');
		});

		test('Control characters in shorthand owner or repo are rejected', () => {
			const result = handleIssueCommand('/test', ['owner/repo\tname#42']);
			expect(result).toContain('Error: Could not parse issue reference');
			expect(result).not.toContain('\t');
		});

		test('URL exceeding MAX_URL_LEN is truncated', () => {
			// Build a URL whose total length clearly exceeds MAX_URL_LEN so the
			// truncation path in sanitizeUrl is exercised.
			const longRepo = 'a'.repeat(MAX_URL_LEN + 100);
			const inputUrl = `https://github.com/owner/${longRepo}/issues/42`;
			const result = handleIssueCommand('/test', [inputUrl]);
			// Truncation cuts the path mid-repo, so the resulting URL no longer
			// matches the github issue pattern and validation returns an error.
			expect(result).toContain('Error:');
			// The echoed input preview is bounded by sanitizeErrorEcho (80 chars
			// default), so the output must not contain the full long repo.
			expect(result).not.toContain(longRepo);
			// If a URL is emitted in the output, it must respect MAX_URL_LEN.
			const urlMatch = result.match(/issue="([^"]+)"/);
			if (urlMatch) {
				expect(urlMatch[1].length).toBeLessThanOrEqual(MAX_URL_LEN);
			}
		});

		test('Non-GitHub URL (gitlab) fails parsing', () => {
			// gitlab URLs fail at parseIssueRef because regex requires github.com
			const result = handleIssueCommand('/test', [
				'https://gitlab.com/owner/repo/issues/42',
			]);
			expect(result).toContain('Error: Could not parse issue reference');
		});

		test('Bare number outside github.com context still uses remote', () => {
			spawnSyncMock.mockImplementation(() => ({
				status: 0,
				stdout: 'git@github.com:test-owner/test-repo.git',
				error: undefined,
			}));
			const result = handleIssueCommand('/test', ['100']);
			expect(result).toContain('test-owner');
			expect(result).toContain('test-repo');
			expect(result).toContain('100');
		});

		// Regression for DD-C014 (deep-dive audit, issue #1235):
		// `parseGitRemoteUrl` previously returned null for proxy remotes and
		// GitHub Enterprise hostnames, causing bare-number issue resolution to
		// silently fail with a misleading "Could not parse issue reference" error
		// for users on those remote shapes.
		test('Bare number with proxy remote (path-style) resolves owner/repo', () => {
			spawnSyncMock.mockImplementation(() => ({
				status: 0,
				stdout: 'http://proxy.example.com/git/owner/repo.git',
				error: undefined,
			}));
			const result = handleIssueCommand('/test', ['77']);
			expect(result).toContain(
				'issue="https://github.com/owner/repo/issues/77"',
			);
		});

		test('Bare number with GitHub Enterprise host (path-style) resolves owner/repo', () => {
			spawnSyncMock.mockImplementation(() => ({
				status: 0,
				stdout: 'https://github.acme.com/owner/repo.git',
				error: undefined,
			}));
			const result = handleIssueCommand('/test', ['88']);
			expect(result).toContain(
				'issue="https://github.com/owner/repo/issues/88"',
			);
		});
	});

	// =============================================================================
	// Output Format
	// =============================================================================

	describe('Output Format', () => {
		test('Output starts with [MODE: ISSUE_INGEST', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42',
			]);
			expect(result.startsWith('[MODE: ISSUE_INGEST')).toBe(true);
		});

		test('Output contains issue= with full URL', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42',
			]);
			expect(result).toContain(
				'issue="https://github.com/owner/repo/issues/42"',
			);
		});

		test('Output ends with ]', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42',
			]);
			expect(result.endsWith(']')).toBe(true);
		});

		test('Output with flags has correct spacing', () => {
			const result = handleIssueCommand('/test', [
				'https://github.com/owner/repo/issues/42',
				'--plan',
				'--trace',
			]);
			expect(result).toMatch(
				/\[MODE: ISSUE_INGEST issue="[^"]+" plan=true trace=true\]/,
			);
		});
	});

	// afterEach merged into the single block at the top of this describe block
});
