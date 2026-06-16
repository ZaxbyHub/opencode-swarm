import { describe, expect, test } from 'bun:test';
import {
	containsControlCharacters,
	isIPv4ZeroNetwork,
	isPrivateHost,
	MAX_URL_LEN,
	parseGitRemoteUrl,
	sanitizeErrorEcho,
	sanitizeUrl,
	validateAndSanitizeGithubUrl,
} from '../../../src/commands/_shared/url-security';

describe('url-security shared helpers', () => {
	describe('isPrivateHost', () => {
		test('blocks the full 127.0.0.0/8 loopback range', () => {
			expect(isPrivateHost(new URL('https://127.0.0.2/'))).toBe(true);
		});

		test('blocks the 169.254.0.0/16 link-local range', () => {
			expect(isPrivateHost(new URL('https://169.254.10.20/'))).toBe(true);
		});

		test('blocks IPv4-mapped 127.x loopback addresses', () => {
			expect(isPrivateHost(new URL('https://[::ffff:127.0.0.2]/'))).toBe(true);
		});

		test('blocks IPv4-mapped 169.254.x link-local addresses', () => {
			expect(isPrivateHost(new URL('https://[::ffff:169.254.10.20]/'))).toBe(
				true,
			);
		});

		test('blocks IPv4-mapped 10.x private addresses', () => {
			expect(isPrivateHost(new URL('https://[::ffff:10.0.0.2]/'))).toBe(true);
		});

		test('blocks IPv4-mapped 172.16.x private addresses', () => {
			expect(isPrivateHost(new URL('https://[::ffff:172.16.0.2]/'))).toBe(true);
		});

		test('blocks IPv4-mapped 192.168.x private addresses', () => {
			expect(isPrivateHost(new URL('https://[::ffff:192.168.1.2]/'))).toBe(
				true,
			);
		});

		test('blocks IPv4-mapped 0.0.0.0 zero network', () => {
			expect(isPrivateHost(new URL('https://[::ffff:0.0.0.0]/'))).toBe(true);
		});

		test('blocks 0.0.0.0/8 zero network range', () => {
			expect(isPrivateHost(new URL('https://0.1.2.3/'))).toBe(true);
		});

		test('blocks 0.0.0.0 exact match', () => {
			expect(isPrivateHost(new URL('https://0.0.0.0/'))).toBe(true);
		});

		test('allows public github.com hosts', () => {
			expect(isPrivateHost(new URL('https://github.com/'))).toBe(false);
		});
	});

	describe('isIPv4ZeroNetwork', () => {
		test('true for zero-network hosts', () => {
			expect(isIPv4ZeroNetwork('0.0.0.0')).toBe(true);
			expect(isIPv4ZeroNetwork('0.1.2.3')).toBe(true);
			expect(isIPv4ZeroNetwork('0.255.255.255')).toBe(true);
		});

		test('false for non-zero-network hosts', () => {
			expect(isIPv4ZeroNetwork('1.2.3.4')).toBe(false);
			expect(isIPv4ZeroNetwork('10.0.0.1')).toBe(false);
			expect(isIPv4ZeroNetwork('127.0.0.1')).toBe(false);
		});
	});

	describe('parseGitRemoteUrl', () => {
		test('rejects HTTPS remote with control character in owner', () => {
			expect(
				parseGitRemoteUrl('https://github.com/own\ter/repo.git'),
			).toBeNull();
		});

		test('rejects HTTPS remote with control character in repo', () => {
			expect(
				parseGitRemoteUrl('https://github.com/owner/rep\toname.git'),
			).toBeNull();
		});

		test('rejects SSH remote with control character in owner', () => {
			expect(parseGitRemoteUrl('git@github.com:own\ter/repo.git')).toBeNull();
		});

		test('rejects path remote with control character in owner or repo', () => {
			expect(
				parseGitRemoteUrl('http://proxy.example.com/git/own\ter/repo.git'),
			).toBeNull();
			expect(
				parseGitRemoteUrl('http://proxy.example.com/git/owner/rep\toname.git'),
			).toBeNull();
		});

		test('allows clean HTTPS remote', () => {
			expect(
				parseGitRemoteUrl('https://github.com/clean-owner/clean-repo.git'),
			).toEqual({ owner: 'clean-owner', repo: 'clean-repo' });
		});
	});

	describe('sanitizeErrorEcho', () => {
		test('strips control characters from echoed input', () => {
			expect(sanitizeErrorEcho('owner/repo\tbad#42\n')).toBe(
				'owner/repo bad#42',
			);
		});

		test('truncates long echoed input to a bounded preview', () => {
			const sanitized = sanitizeErrorEcho(`owner/${'a'.repeat(120)}#42`);
			expect(sanitized.length).toBeLessThanOrEqual(81);
			expect(sanitized.endsWith('…')).toBe(true);
		});
	});

	describe('sanitizeUrl', () => {
		test('strips query string', () => {
			expect(
				sanitizeUrl('https://github.com/owner/repo/issues/42?foo=bar'),
			).toBe('https://github.com/owner/repo/issues/42');
		});

		test('strips fragment', () => {
			expect(
				sanitizeUrl('https://github.com/owner/repo/issues/42#section'),
			).toBe('https://github.com/owner/repo/issues/42');
		});

		test('strips both query and fragment together', () => {
			expect(
				sanitizeUrl('https://github.com/owner/repo/issues/42?foo=bar#section'),
			).toBe('https://github.com/owner/repo/issues/42');
		});

		test('strips MODE header suffix', () => {
			expect(
				sanitizeUrl('https://github.com/owner/repo/issues/42 [MODE: EXECUTE]'),
			).toBe('https://github.com/owner/repo/issues/42');
		});

		test('strips multiple MODE header suffixes', () => {
			expect(
				sanitizeUrl(
					'https://github.com/owner/repo/issues/42 [MODE: EXECUTE] [MODE: PR_REVIEW]',
				),
			).toBe('https://github.com/owner/repo/issues/42');
		});

		test('strips credentials', () => {
			expect(
				sanitizeUrl('https://user:pass@github.com/owner/repo/issues/42'),
			).toBe('https://github.com/owner/repo/issues/42');
		});

		test('truncates URLs exceeding MAX_URL_LEN', () => {
			const longPath = 'a'.repeat(3000);
			const url = `https://github.com/owner/${longPath}/issues/42`;
			expect(sanitizeUrl(url).length).toBeLessThanOrEqual(MAX_URL_LEN);
		});

		test('returns empty string for empty input', () => {
			expect(sanitizeUrl('')).toBe('');
		});

		test('trims whitespace around the URL', () => {
			expect(sanitizeUrl('  https://github.com/owner/repo/issues/42  ')).toBe(
				'https://github.com/owner/repo/issues/42',
			);
		});
	});

	describe('containsControlCharacters', () => {
		test('true for strings containing control characters', () => {
			expect(containsControlCharacters('foo\tbar\nbaz')).toBe(true);
			expect(containsControlCharacters('own\ter/repo')).toBe(true);
		});

		test('true for strings containing carriage return', () => {
			expect(containsControlCharacters('foo\rbar')).toBe(true);
		});

		test('false for strings with only printable characters and regular whitespace', () => {
			expect(containsControlCharacters('owner/repo/issues/42')).toBe(false);
			expect(containsControlCharacters('hello world')).toBe(false);
			expect(containsControlCharacters('  spaced  ')).toBe(false);
		});

		test('false for empty string', () => {
			expect(containsControlCharacters('')).toBe(false);
		});
	});

	describe('validateAndSanitizeGithubUrl', () => {
		test('accepts a valid GitHub issue URL', () => {
			const result = validateAndSanitizeGithubUrl(
				'https://github.com/owner/repo/issues/42',
				'issues',
			);
			expect('sanitized' in result).toBe(true);
			if ('sanitized' in result) {
				expect(result.sanitized).toBe(
					'https://github.com/owner/repo/issues/42',
				);
			}
		});

		test('accepts a valid GitHub pull-request URL', () => {
			const result = validateAndSanitizeGithubUrl(
				'https://github.com/owner/repo/pull/123',
				'pull',
			);
			expect('sanitized' in result).toBe(true);
			if ('sanitized' in result) {
				expect(result.sanitized).toBe('https://github.com/owner/repo/pull/123');
			}
		});

		test('rejects http scheme', () => {
			const result = validateAndSanitizeGithubUrl(
				'http://github.com/owner/repo/issues/42',
				'issues',
			);
			expect('error' in result).toBe(true);
		});

		test('rejects private localhost host', () => {
			const result = validateAndSanitizeGithubUrl(
				'https://localhost/owner/repo/issues/42',
				'issues',
			);
			expect('error' in result).toBe(true);
		});

		test('rejects malformed path with missing issue number', () => {
			const result = validateAndSanitizeGithubUrl(
				'https://github.com/owner/repo/issues/',
				'issues',
			);
			expect('error' in result).toBe(true);
		});
	});
});
