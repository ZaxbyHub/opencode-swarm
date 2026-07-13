import { expect, test } from 'bun:test';
import { last } from './defect';
test('returns the final item', () => expect(last([1, 2])).toBe(2));
