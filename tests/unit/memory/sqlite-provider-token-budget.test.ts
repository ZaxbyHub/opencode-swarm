import { describe, expect, test } from 'bun:test';
import { _test_exports as sqliteProviderTestExports } from '../../../src/memory/sqlite-provider';
import type { RecallResultItem } from '../../../src/memory/types';

function item(text: string): RecallResultItem {
	return { record: { text } } as unknown as RecallResultItem;
}

describe('quality recall token-budget packing', () => {
	test('skips an oversized ranked item so a later compact item can fit', () => {
		const oversized = item('x'.repeat(256));
		const compact = item('small');

		const selected =
			sqliteProviderTestExports.capQualityRecallItemsByTokenBudget(
				[oversized, compact],
				32,
			);

		expect(selected).toEqual([compact]);
	});
});
