import { describe, expect, test } from 'bun:test';
import { dedupeAnchors } from '../../../src/memory/outcome-events';
import { MemoryAnchorSchema } from '../../../src/memory/schema';

describe('memory anchor schema', () => {
	test('normalizes portable repository-relative anchors before deduplication', () => {
		expect(
			dedupeAnchors([
				{ file: '.\\src\\memory//schema.ts', symbol: 'parse' },
				{ file: 'src/memory/schema.ts', symbol: 'parse' },
			]),
		).toEqual([{ file: 'src/memory/schema.ts', symbol: 'parse' }]);
	});

	test.each([
		'/etc/passwd',
		'\\\\server\\share\\file.ts',
		'C:\\repo\\file.ts',
		'../outside.ts',
		'src/../../outside.ts',
		'src/secret\u0000.ts',
	])('rejects non-relative or unsafe path %s', (file) => {
		expect(MemoryAnchorSchema.safeParse({ file }).success).toBe(false);
	});
});
