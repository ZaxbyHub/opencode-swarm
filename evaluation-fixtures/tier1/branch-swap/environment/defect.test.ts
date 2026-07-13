import { expect, test } from 'bun:test';
import { accessLabel } from './defect';
test('labels administrators', () => expect(accessLabel(true)).toBe('admin'));
