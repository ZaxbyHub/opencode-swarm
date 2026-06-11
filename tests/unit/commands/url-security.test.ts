import { describe, expect, test } from 'bun:test';
import {
	isPrivateHost,
	sanitizeErrorEcho,
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

		test('allows public github.com hosts', () => {
			expect(isPrivateHost(new URL('https://github.com/'))).toBe(false);
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
});
