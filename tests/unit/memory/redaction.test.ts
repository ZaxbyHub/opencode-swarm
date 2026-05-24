import { describe, expect, test } from 'bun:test';
import { findSecrets, redactSecrets } from '../../../src/memory';

describe('memory redaction', () => {
	test('does not treat metric-like TOKEN suffixes as env secrets', () => {
		expect(findSecrets('TOKEN_COUNT = twelve_items')).toEqual([]);
		expect(redactSecrets('TOKEN_COUNT = twelve_items')).toBe(
			'TOKEN_COUNT = twelve_items',
		);
	});

	test('redacts secret-like environment assignments', () => {
		const text = 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456';

		expect(findSecrets(text).map((finding) => finding.type)).toContain(
			'env_secret',
		);
		expect(redactSecrets(text)).toContain('[REDACTED:env_secret]');
		expect(redactSecrets(text)).not.toContain(
			'sk-abcdefghijklmnopqrstuvwxyz123456',
		);
	});

	test('redacts multiline private key blocks', () => {
		const text = [
			'-----BEGIN PRIVATE KEY-----',
			'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
			'-----END PRIVATE KEY-----',
		].join('\n');

		expect(findSecrets(text).map((finding) => finding.type)).toEqual([
			'private_key_block',
		]);
		expect(redactSecrets(text)).toBe('[REDACTED:private_key_block]');
	});
});
