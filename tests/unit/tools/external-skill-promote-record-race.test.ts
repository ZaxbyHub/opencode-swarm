/**
 * Stage B round 6 — promote must survive the store.update read-modify-write
 * gap (PR #3942 feedback).
 *
 *   (1) A concurrent mutation landing between promote's read and the store's
 *       re-read inside update() can push the PERSISTED record over
 *       PROMOTION_RECORD_MAX_BYTES even though promote's pre-write
 *       measurement passed. promote therefore passes the cap INTO the real
 *       store.update ({ maxRecordBytes }) so the bound is enforced on the
 *       ACTUAL merged object; a RecordTooLargeError triggers the
 *       ownership-safe artifact cleanup and an actionable failure.
 *   (2) update() returns null when the candidate vanished at update time;
 *       promote must treat that as a failure (with cleanup), never success —
 *       otherwise an orphan artifact with a provenance claim and no record is
 *       left behind.
 *
 * Both races are seam-injected through the store's `_internals.fs.readFile`
 * (the exact read update() re-reads): the second read of the candidate file
 * returns a doctored record with a concurrent history append (1) or fails
 * with ENOENT (2).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import { PROMOTION_RECORD_MAX_BYTES } from '../../../src/services/external-skill-identity.js';
import {
	createExternalSkillStore,
	_internals as storeInternals,
} from '../../../src/services/external-skill-store.js';
import {
	external_skill_promote,
	_internals as promoteInternals,
} from '../../../src/tools/external-skill-promote.js';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const FIXED_TS = '2026-06-09T12:00:00.000Z';
const SMALL_BODY = 'Safe skill body with no dangerous patterns for race tests.';
/** ~9,000-char metadata — under the validator's 10k per-field cap. */
const LONG_PUBLISHER = 'pub '.repeat(1_400).trimEnd();
const LONG_SOURCE_URL = `https://example.com/s/${'u '.repeat(2_600).trimEnd()}`;

type HistoryEntry = ExternalSkillCandidate['evaluation_history'][number];

const ENTRY_REASON_LEN = 200;

function reasonOfLength(len: number): string {
	return 'x '.repeat(Math.floor(len / 2)).padEnd(len, 'x');
}

function makeHistory(count: number, lastPad = 0): HistoryEntry[] {
	const entries: HistoryEntry[] = [];
	for (let i = 0; i < count; i++) {
		const len = i === count - 1 ? ENTRY_REASON_LEN + lastPad : ENTRY_REASON_LEN;
		entries.push({
			verdict: 'passed',
			timestamp: '2026-01-15T12:00:00.000Z',
			actor: 'system',
			reason: reasonOfLength(len),
		});
	}
	return entries;
}

function sha256(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

async function callPromote(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_promote as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

async function seedCandidate(
	directory: string,
	history: HistoryEntry[],
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	return store.add({
		source_url: LONG_SOURCE_URL,
		source_type: 'github',
		publisher: LONG_PUBLISHER,
		sha256: sha256(SMALL_BODY),
		fetched_at: withFrozenClock(
			() => new Date(Date.now() - 60_000).toISOString(),
			{ fixedNow: Date.now() },
		),
		skill_name: 'race-skill',
		skill_body: SMALL_BODY,
		risk_flags: [],
		evaluation_verdict: 'passed',
		evaluation_history: history,
	});
}

function recordBytes(candidate: ExternalSkillCandidate): number {
	return Buffer.byteLength(JSON.stringify(candidate, null, '\t'), 'utf8');
}

/**
 * Seed a long-metadata candidate whose record is ~`nearCap` bytes (within
 * one entry's marginal of the target — exactness is not needed here, the
 * injected concurrent entry is ~8 KB so the merge overflows the cap with
 * room to spare on either side of the target).
 */
async function seedNearCap(
	directory: string,
	nearCap: number,
): Promise<ExternalSkillCandidate> {
	const one = await seedCandidate(directory, makeHistory(1));
	const two = await seedCandidate(directory, makeHistory(2));
	const marginal = recordBytes(two) - recordBytes(one);
	const base = recordBytes(one) - marginal;
	const count = Math.max(1, Math.floor((nearCap - base) / marginal));
	return seedCandidate(directory, makeHistory(count));
}

function artifactPath(directory: string, slug: string): string {
	return path.join(
		directory,
		'.opencode',
		'skills',
		'generated',
		slug,
		'SKILL.md',
	);
}

describe('external_skill_promote — store.update race handling (Stage B round 6)', () => {
	let projectDir: string;
	const originalGetTimestamp = promoteInternals.getTimestamp;
	const originalReadFile = storeInternals.fs.readFile;
	const originalDeleteSkillFile = promoteInternals.deleteSkillFile;
	const originalReadSkillFile = promoteInternals.readSkillFile;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-promote-race-');
		const configDir = path.join(projectDir, '.opencode');
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, 'opencode-swarm.json'),
			JSON.stringify({
				external_skills: {
					curation_enabled: true,
					max_candidates: 500,
					max_bytes_per_candidate: PROMOTION_RECORD_MAX_BYTES,
					eviction_policy: 'fifo',
					ttl_days: 90,
					evaluation_enabled: true,
					sources: [],
					max_candidates_per_discovery: 50,
					max_concurrent_fetches: 5,
					fetch_timeout_ms: 30_000,
				},
			}),
			'utf-8',
		);
		promoteInternals.getTimestamp = () => FIXED_TS;
	});

	afterEach(() => {
		promoteInternals.getTimestamp = originalGetTimestamp;
		storeInternals.fs.readFile = originalReadFile;
		promoteInternals.deleteSkillFile = originalDeleteSkillFile;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('concurrent history append between read and update => promote fails, artifact cleaned, record unchanged', async () => {
		// Pre-update record ~20 KB below the cap: promote's pre-write
		// measurement passes, but the concurrent entry (~80 KB) plus the
		// promotion delta (~19 KB long-metadata audit entry) pushes the
		// ACTUAL merged record well over the cap inside store.update.
		const candidate = await seedNearCap(
			projectDir,
			PROMOTION_RECORD_MAX_BYTES - 20_000,
		);
		const recordFile = path.join(
			projectDir,
			'.swarm',
			'skills',
			'candidates',
			`${candidate.id}.json`,
		);
		const recordBefore = fs.readFileSync(recordFile, 'utf-8');

		// Seam: the SECOND read of this candidate's file (store.update's
		// re-read) returns the record plus a concurrent history append.
		let reads = 0;
		storeInternals.fs.readFile = (async (p: unknown, ...rest: unknown[]) => {
			if (typeof p === 'string' && p === recordFile) {
				reads += 1;
				if (reads === 2) {
					const raw = (await originalReadFile(
						p as never,
						...(rest as never[]),
					)) as string;
					const parsed = JSON.parse(raw) as ExternalSkillCandidate;
					parsed.evaluation_history.push({
						verdict: 'passed',
						timestamp: '2026-01-15T13:00:00.000Z',
						actor: 'system',
						// ~80 KB: overflows the cap by a wide, platform-independent
						// margin (path/timestamp byte lengths differ per OS; the
						// ~8 KB margin used before was not enough on Linux CI).
						reason: 'x '.repeat(40_000),
					});
					return JSON.stringify(parsed);
				}
			}
			return originalReadFile(p as never, ...(rest as never[]));
		}) as typeof storeInternals.fs.readFile;

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'race-skill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		// The underlying cause (record bound) must be preserved and named.
		expect(parsed.error).toContain('Failed to promote candidate');
		expect(parsed.error).toContain('exceeding');

		// The just-written artifact must be cleaned up (ownership-safe).
		expect(fs.existsSync(artifactPath(projectDir, 'race-skill'))).toBe(false);
		// The on-disk record must be UNCHANGED (the throw precedes the write).
		expect(fs.readFileSync(recordFile, 'utf-8')).toBe(recordBefore);
	});

	test('candidate vanished at update time (update returns null) => promote fails and cleans the artifact', async () => {
		const candidate = await seedCandidate(projectDir, makeHistory(1));
		const recordFile = path.join(
			projectDir,
			'.swarm',
			'skills',
			'candidates',
			`${candidate.id}.json`,
		);

		// Seam: the SECOND read of this candidate's file fails with ENOENT —
		// the candidate "disappeared" between promote's read and update's
		// re-read, so update() returns null without writing.
		let reads = 0;
		storeInternals.fs.readFile = (async (p: unknown, ...rest: unknown[]) => {
			if (typeof p === 'string' && p === recordFile) {
				reads += 1;
				if (reads === 2) {
					const err = new Error(
						'ENOENT: no such file or directory',
					) as NodeJS.ErrnoException;
					err.code = 'ENOENT';
					throw err;
				}
			}
			return originalReadFile(p as never, ...(rest as never[]));
		}) as typeof storeInternals.fs.readFile;

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'race-skill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('disappeared');

		// The artifact must NOT survive as an orphan with a provenance claim.
		expect(fs.existsSync(artifactPath(projectDir, 'race-skill'))).toBe(false);
	});

	test('null update + FAILED removal => the error never claims the artifact was removed', async () => {
		const candidate = await seedCandidate(projectDir, makeHistory(1));
		const recordFile = path.join(
			projectDir,
			'.swarm',
			'skills',
			'candidates',
			`${candidate.id}.json`,
		);
		let reads = 0;
		storeInternals.fs.readFile = (async (p: unknown, ...rest: unknown[]) => {
			if (typeof p === 'string' && p === recordFile) {
				reads += 1;
				if (reads === 2) {
					const err = new Error('ENOENT') as NodeJS.ErrnoException;
					err.code = 'ENOENT';
					throw err;
				}
			}
			return originalReadFile(p as never, ...(rest as never[]));
		}) as typeof storeInternals.fs.readFile;
		// Removal fails (e.g. EPERM/EBUSY): the orphan survives.
		promoteInternals.deleteSkillFile = (async () => {
			throw new Error('EPERM');
		}) as typeof promoteInternals.deleteSkillFile;

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'race-skill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('disappeared');
		expect(parsed.error).toContain('could not be confirmed removed');
		expect(parsed.error).not.toContain('artifact was removed');
		// The orphan really is still there — the message told the truth.
		expect(fs.existsSync(artifactPath(projectDir, 'race-skill'))).toBe(true);
	});

	test('default readSkillFile: ENOENT => null, any other failure propagates (never null)', async () => {
		// Captured BEFORE any test replaced the seam (afterEach restores them).
		const read = originalReadSkillFile;
		expect(await read(path.join(projectDir, 'does-not-exist.txt'))).toBeNull();
		const dir = path.join(projectDir, 'a-directory');
		fs.mkdirSync(dir);
		// Reading a directory fails with EISDIR (not ENOENT): cleanup must see
		// the failure, not an "absent file".
		await expect(read(dir)).rejects.toBeDefined();
	});

	test('default deleteSkillFile: ENOENT resolves, any other failure propagates', async () => {
		const del = originalDeleteSkillFile;
		await del(path.join(projectDir, 'does-not-exist.txt'));
		const dir = path.join(projectDir, 'a-nonempty-directory');
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, 'child.txt'), 'x', 'utf-8');
		// unlink() on a directory fails (EISDIR/EPERM): it must surface so
		// cleanup never reports a removal that did not happen.
		await expect(del(dir)).rejects.toBeDefined();
		expect(fs.existsSync(dir)).toBe(true);
	});
});
