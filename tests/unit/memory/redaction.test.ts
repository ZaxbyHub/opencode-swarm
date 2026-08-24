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

	// FR-09 / DD-06: env_secret must require at least one letter-starting prefix segment
	// Negative: bare key names in URL query params must NOT be redacted
	test('env_secret does not match bare URL query param ?key=', () => {
		const text = 'https://example.com/?key=abcdefgh';
		expect(findSecrets(text).filter((f) => f.type === 'env_secret')).toEqual(
			[],
		);
		expect(redactSecrets(text)).toBe(text);
	});

	test('env_secret does not match bare URL query param &token=', () => {
		const text = 'https://example.com/?foo=bar&token=abcdefgh';
		expect(findSecrets(text).filter((f) => f.type === 'env_secret')).toEqual(
			[],
		);
		expect(redactSecrets(text)).toBe(text);
	});

	test('env_secret does not match bare PASSWORD= at start of line', () => {
		const text = 'PASSWORD=abcdefgh';
		expect(findSecrets(text).filter((f) => f.type === 'env_secret')).toEqual(
			[],
		);
		expect(redactSecrets(text)).toBe(text);
	});

	// FR-09 / DD-06: env_secret requires letter-starting prefix segment
	// (intentional tightening — numeric-starting env vars like 1_PASSWORD
	// no longer match to reduce URL false positives like ?key=)
	test('env_secret does not match numeric-starting env var 0_PASSWORD=', () => {
		const text = '0_PASSWORD=somepassword';
		expect(findSecrets(text).filter((f) => f.type === 'env_secret')).toEqual(
			[],
		);
		expect(redactSecrets(text)).toBe(text);
	});

	test('env_secret does not match numeric-starting env var 123_TOKEN=', () => {
		const text = '123_TOKEN=abcdefgh';
		expect(findSecrets(text).filter((f) => f.type === 'env_secret')).toEqual(
			[],
		);
		expect(redactSecrets(text)).toBe(text);
	});

	// Positive: prefixed env secrets must still match
	test('env_secret matches API_KEY=', () => {
		const text = 'API_KEY=abcdefgh';
		expect(findSecrets(text).map((f) => f.type)).toContain('env_secret');
		expect(redactSecrets(text)).toBe('[REDACTED:env_secret]');
	});

	test('env_secret matches multi-segment MY_API_SECRET=', () => {
		const text = 'MY_API_SECRET=abcdefgh';
		expect(findSecrets(text).map((f) => f.type)).toContain('env_secret');
		expect(redactSecrets(text)).toBe('[REDACTED:env_secret]');
	});

	test('env_secret matches DATABASE_PASSWORD=', () => {
		const text = 'DATABASE_PASSWORD=somepassword';
		expect(findSecrets(text).map((f) => f.type)).toContain('env_secret');
		expect(redactSecrets(text)).toBe('[REDACTED:env_secret]');
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

	// FR-08 / DD-05: GitLab tokens
	test('redacts gitlab tokens (glpat)', () => {
		const text = 'glpat-1234567890abcdef';
		expect(findSecrets(text).map((f) => f.type)).toContain('gitlab_token');
		expect(redactSecrets(text)).toBe('[REDACTED:gitlab_token]');
	});
	test('does not redact short gitlab token lookalikes', () => {
		const text = 'glpat-short';
		expect(findSecrets(text)).toEqual([]);
		expect(redactSecrets(text)).toBe(text);
	});

	// FR-08 / DD-05: Slack tokens
	test('redacts slack tokens', () => {
		const text = 'xoxb-1234567890-abcdef';
		expect(findSecrets(text).map((f) => f.type)).toContain('slack_token');
		expect(redactSecrets(text)).toBe('[REDACTED:slack_token]');
	});
	test('does not redact short slack token lookalikes', () => {
		const text = 'xoxb-short';
		expect(findSecrets(text)).toEqual([]);
		expect(redactSecrets(text)).toBe(text);
	});

	// FR-08 / DD-05: JWT tokens
	test('redacts jwt tokens', () => {
		const text = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123-_xyz';
		expect(findSecrets(text).map((f) => f.type)).toContain('jwt_token');
		expect(redactSecrets(text)).toBe('[REDACTED:jwt_token]');
	});
	test('does not redact incomplete jwt lookalikes', () => {
		const text = 'eyJonly';
		expect(findSecrets(text)).toEqual([]);
		expect(redactSecrets(text)).toBe(text);
	});

	// FR-08 / DD-05: AWS secret access key
	test('redacts aws secret access key assignments', () => {
		const text =
			'AWS_SECRET_ACCESS_KEY=ABCD1234567890EFGHIJKLMNOPQRSTUVWXYZ1234';
		// findSecrets should detect aws_secret_access_key type (env_secret also fires but aws pattern is also present)
		const findings = findSecrets(text);
		expect(findings.map((f) => f.type)).toContain('aws_secret_access_key');
		// redactSecrets fires env_secret first; just verify the secret value is gone
		const redacted = redactSecrets(text);
		expect(redacted).not.toContain('ABCD1234567890EFGHIJKLMNOPQRSTUVWXYZ1234');
	});
	test('does not redact short aws secret access key lookalikes', () => {
		const text = 'AWS_SECRET_ACCESS_KEY=short';
		expect(findSecrets(text)).toEqual([]);
		expect(redactSecrets(text)).toBe(text);
	});

	// FR-08 / DD-05: Stripe secret keys
	test('redacts stripe secret keys', () => {
		const text = 'sk_live_' + '1234567890abcdefghijklmn';
		expect(findSecrets(text).map((f) => f.type)).toContain('stripe_secret_key');
		expect(redactSecrets(text)).toBe('[REDACTED:stripe_secret_key]');
	});
	test('does not redact short stripe secret key lookalikes', () => {
		const text = 'sk_live_short';
		expect(findSecrets(text)).toEqual([]);
		expect(redactSecrets(text)).toBe(text);
	});

	// FR-08 / DD-05: Google API keys
	test('redacts google api keys', () => {
		// Must be exactly 39 chars: AIza (4) + 35 more
		const text = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';
		expect(findSecrets(text).map((f) => f.type)).toContain('google_api_key');
		expect(redactSecrets(text)).toBe('[REDACTED:google_api_key]');
	});
	test('does not redact short google api key lookalikes', () => {
		const text = 'AIzaShort';
		expect(findSecrets(text)).toEqual([]);
		expect(redactSecrets(text)).toBe(text);
	});

	// FR-08 / DD-05: OpenSSH private key blocks
	test('redacts openssh private key blocks', () => {
		const text = [
			'-----BEGIN OPENSSH PRIVATE KEY-----',
			'ABCDEFGHIJKLMNOP',
			'-----END OPENSSH PRIVATE KEY-----',
		].join('\n');
		// findSecrets reports both private_key_block (broader) and openssh_private_key_block (specific)
		const findings = findSecrets(text);
		expect(findings.map((f) => f.type)).toContain('openssh_private_key_block');
		// redactSecrets fires private_key_block first (broader match wins for single redaction)
		expect(redactSecrets(text)).toBe('[REDACTED:private_key_block]');
	});
	test('does not redact text merely mentioning openssh', () => {
		const text = 'This text mentions openssh but has no key block.';
		expect(findSecrets(text)).toEqual([]);
		expect(redactSecrets(text)).toBe(text);
	});

	// #1466 (DD-05 context heuristic): AWS secret near an access key id
	test('redacts a 40-char secret on the same line as an AKIA access key id', () => {
		const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123'; // 40 chars base64-ish
		const text = `config: AKIAIOSFODNN7EXAMPLE secret ${secret}`;
		expect(findSecrets(text).map((f) => f.type)).toContain(
			'aws_secret_access_key_context',
		);
	});
	test('does not redact a 40-char secret on a DIFFERENT line than the AKIA id', () => {
		const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123';
		const text = `access: AKIAIOSFODNN7EXAMPLE\nsecret: ${secret}`;
		expect(findSecrets(text).map((f) => f.type)).not.toContain(
			'aws_secret_access_key_context',
		);
	});
	test('does not redact a 40-char base64 token with no AKIA context', () => {
		const text = 'hash: ZW50cnkgcGFzc3dvcmQgZXhhbXBsZSB0b2tlbg==';
		expect(findSecrets(text)).toEqual([]);
	});
	test('does not redact when the secret is more than 200 chars after the AKIA id', () => {
		const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123';
		const filler = 'x'.repeat(220);
		const text = `AKIAIOSFODNN7EXAMPLE ${filler} ${secret}`;
		expect(findSecrets(text).map((f) => f.type)).not.toContain(
			'aws_secret_access_key_context',
		);
	});
	test('redacts SecretAccessKey JSON-style labeled secrets', () => {
		const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123';
		const text = `"SecretAccessKey": "${secret}"`;
		expect(findSecrets(text).map((f) => f.type)).toContain(
			'aws_secret_access_key',
		);
	});
});
