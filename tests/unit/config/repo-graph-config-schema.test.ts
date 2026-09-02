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
import {
	PluginConfigSchema,
	RepoGraphConfigSchema,
} from '../../../src/config/schema';

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

describe('RepoGraphConfigSchema freshness policy (issue #1986)', () => {
	it('materializes safe defaults when the entire section is omitted', () => {
		const parsed = PluginConfigSchema.parse({});
		expect(parsed.repo_graph).toEqual({
			enabled: true,
			init_refresh: true,
			refresh_cap: 50,
			walk_budget_ms: 5_000,
			max_files: 10_000,
			exclude_dirs: [],
			// Issue #1534: storage mode defaults to json; repo-graph.json stays
			// authoritative and the SQLite index is strictly opt-in.
			storage: 'json',
		});
	});

	it('accepts the documented boundary values', () => {
		const parsed = RepoGraphConfigSchema.parse({
			enabled: false,
			init_refresh: false,
			refresh_cap: 0,
			walk_budget_ms: 60_000,
			max_files: 100_000,
		});
		expect(parsed).toMatchObject({
			enabled: false,
			init_refresh: false,
			refresh_cap: 0,
			walk_budget_ms: 60_000,
			max_files: 100_000,
		});
	});

	it.each([
		['refresh_cap', -1],
		['refresh_cap', 501],
		['walk_budget_ms', 999],
		['walk_budget_ms', 60_001],
		['max_files', 99],
		['max_files', 100_001],
		['max_files', 100.5],
	] as const)('rejects out-of-policy %s=%s', (key, value) => {
		expect(() => RepoGraphConfigSchema.parse({ [key]: value })).toThrow();
	});
});
