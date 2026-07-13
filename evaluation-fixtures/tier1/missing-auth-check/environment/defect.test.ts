import { expect, test } from 'bun:test';
import { deleteAccount } from './defect';
test('blocks ordinary users', () => expect(() => deleteAccount('user', '42')).toThrow());
