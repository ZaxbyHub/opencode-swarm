import { describe, expect, test } from 'bun:test';
import {
	isTier3Path,
	matchesTier3,
} from '../../../src/parallel/tier3-classifier';

describe('isTier3Path', () => {
	test('exact basename: auth.ts', () => {
		expect(isTier3Path('auth.ts')).toBe(true);
	});

	test('exact basename: permission.ts', () => {
		expect(isTier3Path('permission.ts')).toBe(true);
	});

	test('exact basename: permissions.ts', () => {
		expect(isTier3Path('permissions.ts')).toBe(true);
	});

	test('exact basename: crypto.ts', () => {
		expect(isTier3Path('crypto.ts')).toBe(true);
	});

	test('exact basename: secret.ts', () => {
		expect(isTier3Path('secret.ts')).toBe(true);
	});

	test('exact basename: secrets.ts', () => {
		expect(isTier3Path('secrets.ts')).toBe(true);
	});
	test('exact basename: secretscan.ts', () => {
		expect(isTier3Path('secretscan.ts')).toBe(true);
	});

	test('keyword prefix with separator: auth-handler.ts', () => {
		expect(isTier3Path('auth-handler.ts')).toBe(true);
	});

	test('keyword prefix with underscore: auth_middleware.ts', () => {
		expect(isTier3Path('auth_middleware.ts')).toBe(true);
	});

	test('keyword prefix with dot: auth.config.ts', () => {
		expect(isTier3Path('auth.config.ts')).toBe(true);
	});

	test('keyword prefix: permission-checker.ts', () => {
		expect(isTier3Path('permission-checker.ts')).toBe(true);
	});

	test('keyword prefix: secret-key.ts', () => {
		expect(isTier3Path('secret-key.ts')).toBe(true);
	});

	test('keyword prefix: crypto-utils.ts', () => {
		expect(isTier3Path('crypto-utils.ts')).toBe(true);
	});

	test('keyword prefix: security-config.ts', () => {
		expect(isTier3Path('security-config.ts')).toBe(true);
	});

	test('directory segment: src/auth/session.ts', () => {
		expect(isTier3Path('src/auth/session.ts')).toBe(true);
	});

	test('directory segment: src/security/validator.ts', () => {
		expect(isTier3Path('src/security/validator.ts')).toBe(true);
	});

	test('nested directory: src/security/crypto/keys.ts', () => {
		expect(isTier3Path('src/security/crypto/keys.ts')).toBe(true);
	});

	test('directory segment: packages/auth/index.ts', () => {
		expect(isTier3Path('packages/auth/index.ts')).toBe(true);
	});

	test('directory segment: src/permission/checker.ts', () => {
		expect(isTier3Path('src/permission/checker.ts')).toBe(true);
	});

	test('directory segment: src/secret/store.ts', () => {
		expect(isTier3Path('src/secret/store.ts')).toBe(true);
	});

	test('basename pattern: architect.ts', () => {
		expect(isTier3Path('architect.ts')).toBe(true);
	});

	test('basename pattern: delegation-gate.ts', () => {
		expect(isTier3Path('delegation-gate.ts')).toBe(true);
	});

	test('basename pattern: guardrails.ts', () => {
		expect(isTier3Path('guardrails.ts')).toBe(true);
	});

	test('basename pattern: guardrail-check.ts', () => {
		expect(isTier3Path('guardrail-check.ts')).toBe(true);
	});

	test('basename pattern: adversarial-test.ts', () => {
		expect(isTier3Path('adversarial-test.ts')).toBe(true);
	});

	test('basename pattern: sanitize-input.ts', () => {
		expect(isTier3Path('sanitize-input.ts')).toBe(true);
	});

	test('basename pattern: security-middleware.ts', () => {
		expect(isTier3Path('security-middleware.ts')).toBe(true);
	});

	test('Windows separators: src\\auth\\session.ts', () => {
		expect(isTier3Path('src\\auth\\session.ts')).toBe(true);
	});

	test('Windows separators: src\\security\\crypto\\keys.ts', () => {
		expect(isTier3Path('src\\security\\crypto\\keys.ts')).toBe(true);
	});

	test('case insensitivity: AUTH.ts', () => {
		expect(isTier3Path('AUTH.ts')).toBe(true);
	});

	test('case insensitivity: Security.ts (basename pattern)', () => {
		expect(isTier3Path('Security.ts')).toBe(true);
	});

	test('false positive rejection: author.ts', () => {
		expect(isTier3Path('author.ts')).toBe(false);
	});

	test('false positive rejection: authority.ts', () => {
		expect(isTier3Path('authority.ts')).toBe(false);
	});

	test('false positive rejection: secretary.ts', () => {
		expect(isTier3Path('secretary.ts')).toBe(false);
	});

	test('exact basename match: authenticate.ts', () => {
		expect(isTier3Path('authenticate.ts')).toBe(true);
	});

	test('exact basename match: authorization.ts', () => {
		expect(isTier3Path('authorization.ts')).toBe(true);
	});

	test('false positive rejection: cryptographic.ts', () => {
		expect(isTier3Path('cryptographic.ts')).toBe(false);
	});

	test('benign file in non-sensitive directory: src/utils/helper.ts', () => {
		expect(isTier3Path('src/utils/helper.ts')).toBe(false);
	});

	test('benign file: index.ts', () => {
		expect(isTier3Path('index.ts')).toBe(false);
	});

	test('benign file: config.ts', () => {
		expect(isTier3Path('config.ts')).toBe(false);
	});
});

describe('matchesTier3', () => {
	test('returns true if any file matches', () => {
		expect(matchesTier3(['src/utils/helper.ts', 'src/auth/session.ts'])).toBe(
			true,
		);
	});

	test('returns false if no files match', () => {
		expect(matchesTier3(['src/utils/helper.ts', 'src/models/user.ts'])).toBe(
			false,
		);
	});

	test('returns false for empty array', () => {
		expect(matchesTier3([])).toBe(false);
	});
});
