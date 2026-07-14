import { expect, test } from 'bun:test';
import { pageStart } from './defect';
test('first page begins at zero', () => expect(pageStart(0, 20)).toBe(0));
