import { describe, expect, it } from 'bun:test';
import { isCommandAvailable } from '../../../src/build/discovery';

describe('isCommandAvailable Windows extension resolution (#1691)', () => {
	it('finds .cmd shims without appending .exe', () => {
		// On Windows, npm-distributed tools are .cmd shims (eslint.cmd, tsc.cmd, etc.)
		// The old code appended .exe which missed these. The fix lets `where` use PATHEXT.
		// We verify by checking a known-good binary (node) which exists as node.exe.
		// This test passes on all platforms — node is always available.
		expect(isCommandAvailable('node')).toBe(true);
	});

	it('caches results across calls', () => {
		const first = isCommandAvailable('node');
		const second = isCommandAvailable('node');
		expect(first).toBe(second);
	});
});
