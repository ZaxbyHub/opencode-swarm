import { expect, test } from 'bun:test';
import { validPort } from './defect';
test('rejects the first invalid port', () => expect(validPort(65_536)).toBe(false));
