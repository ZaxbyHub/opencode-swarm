/**
 * #2062 gap-closure (group E): status-service's `configFingerprintMatch` must
 * be version-aware, mirroring the provider pattern in
 * `src/memory/sqlite-provider.ts` and `src/memory/local-jsonl-provider.ts`.
 *
 * A legacy cohort-config file (no `algorithm_version`) still compares
 * normally. A file stamped with a DIFFERENT algorithm version must not
 * report a false mismatch — digests from different algorithms are not
 * comparable, so `configFingerprintMatch` stays `undefined` (unknown)
 * rather than `false`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MemoryConfigSchema } from '../../../src/config/schema';
import { resolveLinkDir } from '../../../src/hooks/knowledge-link';
import {
	buildMemoryCohortFingerprintInput,
	computeMemoryCohortFingerprint,
	FINGERPRINT_ALGORITHM_VERSION,
	_internals as fingerprintInternals,
} from '../../../src/memory/redaction';
import { getStatusData } from '../../../src/services/status-service';

function makeTmp(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe('#2062 F-012 status-service configFingerprintMatch algorithm_version handling', () => {
	const dirs: string[] = [];
	let prevXdgData: string | undefined;
	let prevXdgConfig: string | undefined;
	let prevLocalAppData: string | undefined;
	let prevHome: string | undefined;

	beforeEach(() => {
		prevXdgData = process.env.XDG_DATA_HOME;
		prevXdgConfig = process.env.XDG_CONFIG_HOME;
		prevLocalAppData = process.env.LOCALAPPDATA;
		prevHome = process.env.HOME;
		const isolated = makeTmp('sfp-isolated-');
		dirs.push(isolated);
		process.env.XDG_DATA_HOME = path.join(isolated, 'xdg-data');
		process.env.XDG_CONFIG_HOME = path.join(isolated, 'xdg-config');
		process.env.LOCALAPPDATA = path.join(isolated, 'localappdata');
		process.env.HOME = isolated;
	});

	afterEach(() => {
		// #2062 R3: restore the bump seam here, not in a per-test try/finally, so
		// a throwing test cannot leak a simulated version into later tests.
		fingerprintInternals.currentAlgorithmVersion =
			FINGERPRINT_ALGORITHM_VERSION;
		if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdgData;
		if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = prevXdgConfig;
		if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = prevLocalAppData;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		for (const d of dirs.splice(0)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	function setUpLinkedWorktree(stored: Record<string, unknown>): string {
		const worktree = makeTmp('sfp-worktree-');
		dirs.push(worktree);
		const linkId = 'sfp-cohort';
		mkdirSync(path.join(worktree, '.swarm'), { recursive: true });
		writeFileSync(
			path.join(worktree, '.swarm', 'memory-link.json'),
			JSON.stringify({
				version: 2,
				linkId,
				createdAt: '2026-01-01T00:00:00.000Z',
			}),
			'utf-8',
		);
		const cohortMemoryDir = path.join(resolveLinkDir(linkId), 'memory');
		mkdirSync(cohortMemoryDir, { recursive: true });
		writeFileSync(
			path.join(cohortMemoryDir, 'memory-cohort-config.json'),
			JSON.stringify(stored),
			'utf-8',
		);
		return worktree;
	}

	const matchingFingerprint = (): string =>
		computeMemoryCohortFingerprint(
			buildMemoryCohortFingerprintInput(MemoryConfigSchema.parse({})),
		);

	test('legacy config with no algorithm_version still compares normally (match)', async () => {
		const worktree = setUpLinkedWorktree({
			fingerprint: matchingFingerprint(),
		});
		const status = await getStatusData(worktree, {});
		expect(status.memoryCohort?.linked).toBe(true);
		expect(status.memoryCohort?.configFingerprintMatch).toBe(true);
	});

	test('legacy config with no algorithm_version still compares normally (mismatch)', async () => {
		const worktree = setUpLinkedWorktree({ fingerprint: 'deadbeefdead' });
		const status = await getStatusData(worktree, {});
		expect(status.memoryCohort?.configFingerprintMatch).toBe(false);
	});

	test('differing algorithm_version does not report a false mismatch', async () => {
		const worktree = setUpLinkedWorktree({
			fingerprint: 'deadbeefdead',
			algorithm_version: FINGERPRINT_ALGORITHM_VERSION + 1,
		});
		const status = await getStatusData(worktree, {});
		// Digests from a different algorithm version are not comparable — the
		// field must stay unknown (undefined), never a false `false`.
		expect(status.memoryCohort?.configFingerprintMatch).toBeUndefined();
	});

	test('matching stored algorithm_version keeps the real mismatch signal', async () => {
		const worktree = setUpLinkedWorktree({
			fingerprint: 'deadbeefdead',
			algorithm_version: FINGERPRINT_ALGORITHM_VERSION,
		});
		const status = await getStatusData(worktree, {});
		expect(status.memoryCohort?.configFingerprintMatch).toBe(false);
	});

	test('present but non-numeric algorithm_version reports unknown, not a match', async () => {
		// The digest below is byte-correct for this config, so assuming the
		// current version would report `true` off an uninterpretable stamp.
		const worktree = setUpLinkedWorktree({
			fingerprint: matchingFingerprint(),
			algorithm_version: 'not-a-number',
		});
		const status = await getStatusData(worktree, {});
		expect(status.memoryCohort?.linked).toBe(true);
		expect(status.memoryCohort?.configFingerprintMatch).toBeUndefined();
	});

	test('current version but missing fingerprint reports unknown, not a mismatch', async () => {
		// The version is comparable, but there is no digest to compare. Reading
		// `stored.fingerprint` unguarded yields `undefined === expected` → a
		// reported MISMATCH for a merely malformed file. Both providers already
		// guard this; the reporting surfaces now do too.
		const worktree = setUpLinkedWorktree({
			algorithm_version: FINGERPRINT_ALGORITHM_VERSION,
		});
		const status = await getStatusData(worktree, {});
		expect(status.memoryCohort?.linked).toBe(true);
		expect(status.memoryCohort?.configFingerprintMatch).toBeUndefined();
	});

	test('legacy config under a simulated version bump reports unknown', async () => {
		// An absent field means algorithm v1, so once the current version is 2 the
		// digests are not comparable — even a byte-identical one. Before the R3 fix
		// the absent field defaulted to the CURRENT version, so this compared
		// anyway and reported a match that means nothing.
		fingerprintInternals.currentAlgorithmVersion = 2;
		const worktree = setUpLinkedWorktree({
			fingerprint: matchingFingerprint(),
		});
		const status = await getStatusData(worktree, {});
		expect(status.memoryCohort?.configFingerprintMatch).toBeUndefined();
	});
});
