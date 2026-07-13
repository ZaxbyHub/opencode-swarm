import { expect, test } from 'bun:test';
import { canRetry } from './defect';
test('allows attempts below the maximum', () => expect(canRetry(1, 3)).toBe(true));
