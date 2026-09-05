/**
 * Issue #2483 review finding FB-21: the loader suite only asserted the
 * NEGATIVE (retention is excluded from the legacy-defaults object literal),
 * which would stay green even if `retention` stopped materializing entirely.
 * This pins the POSITIVE default: with no config files present, the loader
 * materializes `retention` as `{ enabled: true, dry_run: false }` — the
 * production values the post-init sweep task reads in src/index.ts.
 *
 * (loader.test.ts is over the FR-006 500-line cap and cannot grow; this is
 * the sanctioned sibling-file placement.)
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { loadPluginConfig } = await import('../../../src/config/loader.js');

const tempRoots: string[] = [];

afterEach(() => {
	for (const dir of tempRoots) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort teardown */
		}
	}
	tempRoots.length = 0;
});

describe('retention config materializes production defaults (review FB-21)', () => {
	it('loadPluginConfig on an empty temp dir yields retention { enabled: true, dry_run: false }', () => {
		const dir = canonicalMkdtemp('retention-defaults-2483-');
		tempRoots.push(dir);
		const config = loadPluginConfig(dir);
		expect(config.retention).toEqual({ enabled: true, dry_run: false });
	});
});
