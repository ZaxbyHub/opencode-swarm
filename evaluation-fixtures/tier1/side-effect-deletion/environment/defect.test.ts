import { expect, test } from 'bun:test';
import { record } from './defect';
test('records the value', () => { const items: string[] = []; record(items, 'x'); expect(items).toEqual(['x']); });
