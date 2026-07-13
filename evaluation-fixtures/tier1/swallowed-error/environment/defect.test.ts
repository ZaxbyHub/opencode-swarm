import { expect, test } from 'bun:test';
import { required } from './defect';
test('propagates failures', async () => expect(required(async () => { throw new Error('boom'); })).rejects.toThrow('boom'));
