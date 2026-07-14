import { expect, test } from 'bun:test';
import { saveThenRead } from './defect';
test('waits for save', async () => { let value = ''; expect(await saveThenRead(async () => { await Promise.resolve(); value = 'saved'; }, () => value)).toBe('saved'); });
