import { expect, test } from 'bun:test';
import { normalized } from './defect';
test('handles missing input', () => expect(normalized(undefined)).toBe(''));
