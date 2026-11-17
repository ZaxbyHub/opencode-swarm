/**
 * #3664 cap fixture: writes more than any small maxOutputBytes cap to BOTH
 * streams and exits 0 cleanly. The reader drains both to EOF (complete),
 * so the saved logs are bounded but the observation is complete.
 */
import { expect, test } from 'bun:test';

test('writes past the byte cap and exits cleanly', () => {
	const chunk = 'x'.repeat(256);
	// 4 KiB each — far past a 1024-byte cap, trivially fast.
	for (let i = 0; i < 16; i += 1) {
		console.log(chunk);
		console.error(chunk);
	}
	expect(true).toBe(true);
});
