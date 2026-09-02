import { describe, expect, test } from 'bun:test';
import { waitFor } from './wait-for';

describe('waitFor helper', () => {
	test('returns immediately when the predicate already holds', async () => {
		await waitFor(() => true, 100, 'already true');
	});

	test('returns once the predicate flips true', async () => {
		let ready = false;
		setTimeout(() => {
			ready = true;
		}, 30);
		await waitFor(() => ready, 2000, 'flips true');
	});

	test('throws a labeled error on budget exhaustion', async () => {
		await expect(waitFor(() => false, 60, 'never true')).rejects.toThrow(
			'[waitFor] never true — budget exhausted after 60ms',
		);
	});
});
