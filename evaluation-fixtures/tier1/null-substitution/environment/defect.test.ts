import { expect, test } from 'bun:test';
import { displayName } from './defect';
test('preserves a real name', () => expect(displayName('Ada')).toBe('Ada'));
