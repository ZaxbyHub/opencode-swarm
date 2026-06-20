/**
 * Tests for RepoGraphConfigSchema.exclude_dirs validation (issue #1448).
 *
 * Verifies:
 * 1. Valid directory basenames parse and survive.
 * 2. Surrounding whitespace is trimmed.
 * 3. Empty and whitespace-only entries are rejected at config load rather
 *    than silently dropped (so the user gets feedback instead of a no-op).
 * 4. The field defaults to an empty array when omitted.
 */

import { describe, expect, it } from 'bun:test';
import { RepoGraphConfigSchema } from '../../../src/config/schema';

describe('RepoGraphConfigSchema.exclude_dirs', () => {
	it('accepts valid directory basenames', () => {
		const parsed = RepoGraphConfigSchema.parse({
			exclude_dirs: ['.svelte-kit', 'generated', 'vendor'],
		});
		expect(parsed.exclude_dirs).toEqual(['.svelte-kit', 'generated', 'vendor']);
	});

	it('trims surrounding whitespace on entries', () => {
		const parsed = RepoGraphConfigSchema.parse({
			exclude_dirs: ['  generated  ', '\t.svelte-kit\n'],
		});
		expect(parsed.exclude_dirs).toEqual(['generated', '.svelte-kit']);
	});

	it('rejects an empty-string entry', () => {
		expect(() => RepoGraphConfigSchema.parse({ exclude_dirs: [''] })).toThrow();
	});

	it('rejects a whitespace-only entry instead of silently ignoring it', () => {
		expect(() =>
			RepoGraphConfigSchema.parse({ exclude_dirs: ['   '] }),
		).toThrow();
		expect(() =>
			RepoGraphConfigSchema.parse({ exclude_dirs: ['\t'] }),
		).toThrow();
	});

	it('defaults to an empty array when omitted', () => {
		const parsed = RepoGraphConfigSchema.parse({});
		expect(parsed.exclude_dirs).toEqual([]);
	});
});
