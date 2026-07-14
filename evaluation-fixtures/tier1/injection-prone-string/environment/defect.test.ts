import { expect, test } from 'bun:test';
import { shellCommand } from './defect';
test('does not interpolate shell syntax', () => expect(shellCommand('a; rm -rf x')).not.toContain(';'));
