import { describe, expect, test } from 'bun:test';
import { isPolicyProtectedPath } from '../../../src/security/protected-path-policy.js';

describe('central protected path policy', () => {
	test('protects security, evaluation, release, secret, and nested control paths', () => {
		for (const candidate of [
			'src/security/x.ts',
			'src/evaluation/runner.ts',
			'.github/workflows/ci.yml',
			'docs/releases/pending/x.md',
			'pkg/.git/config',
			'.env',
		]) {
			expect(isPolicyProtectedPath(candidate)).toBe(true);
		}
	});
	test('supports exact user additions without prefix confusion', () => {
		expect(
			isPolicyProtectedPath('private/gate.json', {
				includeDefaults: false,
				additional: ['private'],
			}),
		).toBe(true);
		expect(
			isPolicyProtectedPath('private-copy/gate.json', {
				includeDefaults: false,
				additional: ['private'],
			}),
		).toBe(false);
	});
});
