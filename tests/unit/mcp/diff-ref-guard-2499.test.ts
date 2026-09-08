import { describe, expect, test } from 'bun:test';
import { diff as diffTool } from '../../../src/tools/diff';

/**
 * #2499 review feedback: the MCP `diff` adapter must reject flag-shaped
 * base refs. SAFE_REF_PATTERN admits '-'-prefixed strings, and the git argv
 * splices `base` before flags like --numstat, so an unguarded `--output`
 * made git consume the next argv element as an output filename (a write
 * vector from a read-only surface).
 */

describe('diff base ref flag guard (#2499 review)', () => {
	test('a flag-shaped base ref is rejected before any git invocation', async () => {
		const result = await diffTool.execute(
			{ base: '--output' },
			{ directory: process.cwd() },
		);
		const parsed: unknown =
			typeof result === 'string' ? JSON.parse(result) : result;
		const text = JSON.stringify(parsed);
		expect(text).toContain('must not begin with a dash');
	});

	test('legitimate refs still pass validation shape', async () => {
		const result = await diffTool.execute(
			{ base: 'HEAD~1' },
			{ directory: process.cwd() },
		);
		const text = typeof result === 'string' ? result : JSON.stringify(result);
		expect(text).not.toContain('must not begin with a dash');
	});
});
