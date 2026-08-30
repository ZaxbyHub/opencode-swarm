import { describe, expect, test } from 'bun:test';
import { COMMAND_REGISTRY } from './registry.js';

describe('declarative harness command tool policies', () => {
	test('keeps the inspection command surface intentionally absent from tools', () => {
		const keys = [
			'blueprint validate',
			'blueprint current',
			'blueprint history',
			'blueprint diff',
			'blueprint export',
			'harness candidate validate',
			'harness candidate show',
			'harness candidate diff',
		] as const;

		for (const key of keys) {
			expect(COMMAND_REGISTRY[key].toolPolicy).toBe('none');
		}
	});
});
