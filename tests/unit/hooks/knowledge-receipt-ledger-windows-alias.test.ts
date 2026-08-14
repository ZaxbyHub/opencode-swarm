import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
	_internals,
	type ReceiptStoreError,
} from '../../../src/hooks/knowledge-receipt-ledger-storage.js';

function directoryInfo(dev: number, ino: number) {
	return {
		dev,
		ino,
		isDirectory: () => true,
		isSymbolicLink: () => false,
	};
}

describe('receipt mutation parent canonical aliases', () => {
	test('accepts two path spellings with the same filesystem identity', async () => {
		const lexicalParent = path.resolve('receipt-parent-short-name');
		const canonicalParent = `${lexicalParent}-canonical-spelling`;
		const result = await _internals.validateMutationParent(
			path.join(lexicalParent, 'knowledge-receipts-v2.jsonl'),
			{
				realpath: async () => canonicalParent,
				lstat: async () => directoryInfo(7, 42),
			} as never,
		);

		expect(result).toBe(canonicalParent);
	});

	test('rejects a canonical parent that resolves to a different directory', async () => {
		const lexicalParent = path.resolve('receipt-parent-before-swap');
		let calls = 0;
		const action = _internals.validateMutationParent(
			path.join(lexicalParent, 'knowledge-receipts-v2.jsonl'),
			{
				realpath: async () => `${lexicalParent}-swapped`,
				lstat: async () => directoryInfo(7, calls++ === 0 ? 42 : 99),
			} as never,
		);

		await expect(action).rejects.toEqual(
			expect.objectContaining<Partial<ReceiptStoreError>>({
				code: 'store_unavailable',
				message: 'receipt artifact parent identity changed before mutation',
			}),
		);
	});
});
