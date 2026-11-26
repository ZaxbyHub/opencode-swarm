/**
 * Stage B rounds 4+5 — promote must bound what it writes to what the verifier
 * can verify (PR #3942 feedback).
 *
 * Round 4: the final artifact (body + frontmatter) must stay within
 * PROMOTED_ARTIFACT_MAX_BYTES or the promoted skill is dead on arrival
 * (oversized artifact refused by the verifier and by revoke).
 *
 * Round 5: a FIXED reserve for the promotion history entry is insufficient —
 * the audit entry duplicates publisher and source_url (each individually
 * valid up to the validator's 10k per-field cap) and copies prior evaluation
 * details, so a near-bound candidate can pass a fixed-reserve check yet
 * produce a post-update record over PROMOTION_RECORD_MAX_BYTES. Promote must
 * measure the EXACT post-update record (same builder the store's update
 * uses) before any write.
 *
 * Fixture notes: the validator scans every field (including each history
 * reason and publisher/source_url) and flags values over 10k chars plus long
 * base64-alphabet runs, so all long fixture fields are space-broken and under
 * 10k; record size is grown with MANY small history entries. The promote
 * timestamp is stubbed fixed so sizes are exactly predictable; the store's
 * own system-entry timestamp is always a fixed-length ISO string.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import {
	PROMOTED_ARTIFACT_MAX_BYTES,
	PROMOTION_RECORD_MAX_BYTES,
	verifyPromotedExternalSkillSync,
} from '../../../src/services/external-skill-identity.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	external_skill_promote,
	_internals as promoteInternals,
} from '../../../src/tools/external-skill-promote.js';
import { external_skill_revoke } from '../../../src/tools/external-skill-revoke.js';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** Fixed promote timestamp so artifact sizes are exactly predictable. */
const FIXED_TS = '2026-06-09T12:00:00.000Z';

const SMALL_BODY =
	'Safe skill body with no dangerous patterns for bounds tests.';

/** ~9,000-char metadata — under the validator's 10k per-field cap. */
const LONG_PUBLISHER = 'pub '.repeat(1_400).trimEnd();
const LONG_SOURCE_URL = `https://example.com/s/${'u '.repeat(2_600).trimEnd()}`;

type HistoryEntry = ExternalSkillCandidate['evaluation_history'][number];

/**
 * History-entry reason length. The validator flags values over 10k chars (an
 * error at promote's low trust), so every reason stays at this small length;
 * record size is grown with MANY small entries, never one huge field. The
 * filler is space-broken so it can never match base64_long_run.
 */
const ENTRY_REASON_LEN = 200;

function reasonOfLength(len: number): string {
	return 'x '.repeat(Math.floor(len / 2)).padEnd(len, 'x');
}

/** N identical 'passed' entries; the last reason is extended by `lastPad`. */
function makeHistory(count: number, lastPad: number): HistoryEntry[] {
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

async function callTool(
	tool: unknown,
	args: unknown,
	directory: string,
): Promise<string> {
	return (
		tool as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

/** Seed a passed long-metadata candidate with the given body and history. */
async function seedCandidate(
	directory: string,
	history: HistoryEntry[],
	skillBody: string = SMALL_BODY,
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	return store.add({
		source_url: LONG_SOURCE_URL,
		source_type: 'github',
		publisher: LONG_PUBLISHER,
		sha256: sha256(skillBody),
		fetched_at: withFrozenClock(
			() => new Date(Date.now() - 60_000).toISOString(),
			{ fixedNow: Date.now() },
		),
		skill_name: 'bounds-skill',
		skill_body: skillBody,
		risk_flags: [],
		evaluation_verdict: 'passed',
		evaluation_history: history,
	});
}

/** On-disk byte length of the record file the real store persisted. */
function persistedRecordBytes(directory: string, id: string): number {
	return fs.statSync(
		path.join(directory, '.swarm', 'skills', 'candidates', `${id}.json`),
	).size;
}

/** Tab-indented JSON byte length of the candidate promote will measure. */
function recordBytes(candidate: ExternalSkillCandidate): number {
	return Buffer.byteLength(JSON.stringify(candidate, null, '\t'), 'utf8');
}

/**
 * Seed a long-metadata candidate whose PRE-update record serialization is
 * EXACTLY `target` bytes (calibrated per-entry marginal, sub-marginal pad on
 * the last reason). Precondition asserts the landed size.
 */
async function seedCandidateWithRecordBytes(
	directory: string,
	target: number,
): Promise<ExternalSkillCandidate> {
	const one = await seedCandidate(directory, makeHistory(1, 0));
	const two = await seedCandidate(directory, makeHistory(2, 0));
	const marginal = recordBytes(two) - recordBytes(one);
	const base = recordBytes(one) - marginal; // size with an empty history
	let count = Math.max(1, Math.floor((target - base) / marginal));
	let pad = target - base - count * marginal;
	if (pad < 0) {
		count -= 1;
		pad += marginal;
	}
	const candidate = await seedCandidate(directory, makeHistory(count, pad));
	expect(recordBytes(candidate)).toBe(target);
	return candidate;
}

/**
 * Empirically measure how many bytes a successful promotion ADDS to the
 * persisted record (system entry + audit entry duplicating the long metadata
 * into provenance_snapshot), by promoting a minimal-history twin and diffing
 * the persisted record size. The twin MUST run in the SAME directory as the
 * real fixture and under a slug of the SAME LENGTH ('twin-slug-xx' vs
 * 'bounds-skill'): the audit entry embeds both the absolute project path
 * (target_path) and the slug (reason), so either length difference would
 * shift the delta. Uses only observable bytes — no duplication of promote's
 * audit-entry builder.
 */
async function measurePromotionDelta(directory: string): Promise<number> {
	const twin = await seedCandidate(directory, makeHistory(1, 0));
	const pre = persistedRecordBytes(directory, twin.id);
	const raw = await callTool(
		external_skill_promote,
		{ candidate_id: twin.id, slug: 'twin-slug-xx', approver: 'user' },
		directory,
	);
	expect(JSON.parse(raw).success, raw).toBe(true);
	return persistedRecordBytes(directory, twin.id) - pre;
}

/** Byte length of the artifact promote writes (buildSkillMarkdown layout). */
function artifactBytes(
	candidate: ExternalSkillCandidate,
	body: string,
): number {
	const lines = [
		'---',
		'promoted_from: external-skill-candidate',
		'slug: bounds-skill',
		`candidate_id: ${candidate.id}`,
		`source_url: ${candidate.source_url}`,
		`source_type: ${candidate.source_type}`,
		`publisher: ${candidate.publisher}`,
		`sha256: ${candidate.sha256}`,
		`content_digest: ${'d'.repeat(64)}`,
		`promoted_at: ${FIXED_TS}`,
		'promoted_by: user',
		'skill_origin: promoted_external',
		'version: 1',
		'---',
		'',
	];
	return Buffer.byteLength(lines.join('\n') + '\n' + body, 'utf8');
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

function writeConfig(directory: string): void {
	const configDir = path.join(directory, '.opencode');
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
}

describe('external_skill_promote — verifier-bound writes (Stage B rounds 4+5)', () => {
	let projectDir: string;
	const originalGetTimestamp = promoteInternals.getTimestamp;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-promote-bounds-');
		writeConfig(projectDir);
		promoteInternals.getTimestamp = () => FIXED_TS;
	});

	afterEach(() => {
		promoteInternals.getTimestamp = originalGetTimestamp;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('artifact 1 byte over PROMOTED_ARTIFACT_MAX_BYTES is refused before any write', async () => {
		// Frontmatter overhead is stable for fixed metadata: measure it with a
		// small body, then size the body so the final artifact is exactly
		// bound+1 bytes. The huge body never reaches re-validation (the
		// artifact bound check fires first), so plain 'a' filler is fine.
		const calib = await seedCandidate(projectDir, makeHistory(1, 0));
		const overhead = artifactBytes(calib, '');
		const body = 'a'.repeat(PROMOTED_ARTIFACT_MAX_BYTES + 1 - overhead);
		const big = await seedCandidate(projectDir, makeHistory(1, 0), body);
		expect(artifactBytes(big, body)).toBe(PROMOTED_ARTIFACT_MAX_BYTES + 1);

		const raw = await callTool(
			external_skill_promote,
			{ candidate_id: big.id, slug: 'bounds-skill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('PROMOTED_ARTIFACT');
		expect(parsed.error).toContain(`${PROMOTED_ARTIFACT_MAX_BYTES + 1}`);

		expect(fs.existsSync(artifactPath(projectDir, 'bounds-skill'))).toBe(false);
		const store = createExternalSkillStore(projectDir, {
			max_candidates: 500,
		});
		const unchanged = await store.get(big.id);
		expect(unchanged?.evaluation_verdict).toBe('passed');
	});

	test('post-update record over the cap (long metadata) is refused before any write', async () => {
		// publisher + source_url (~5-6k each, kept under the gate's 16 KiB
		// frontmatter window) are duplicated into the audit entry's
		// provenance_snapshot, so the promotion delta is dominated by the
		// candidate's own metadata rather than a small constant. Seed the
		// pre-update record 512 bytes below the overflow threshold:
		// pre + delta == cap + 512 > cap.
		const delta = await measurePromotionDelta(projectDir);
		expect(delta).toBeGreaterThan(8 * 1024);

		const candidate = await seedCandidateWithRecordBytes(
			projectDir,
			PROMOTION_RECORD_MAX_BYTES - delta + 512,
		);
		expect(
			artifactBytes(candidate, SMALL_BODY),
			'fixture artifact must be well inside the artifact bound',
		).toBeLessThan(PROMOTED_ARTIFACT_MAX_BYTES / 2);

		const raw = await callTool(
			external_skill_promote,
			{ candidate_id: candidate.id, slug: 'bounds-skill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('PROMOTION_RECORD');

		expect(fs.existsSync(artifactPath(projectDir, 'bounds-skill'))).toBe(false);
		const store = createExternalSkillStore(projectDir, {
			max_candidates: 500,
		});
		const unchanged = await store.get(candidate.id);
		expect(unchanged?.evaluation_verdict).toBe('passed');
	});

	test('candidate at the EXACT post-update record bound (long metadata) promotes, verifies, revokes, and persists within the cap', async () => {
		const delta = await measurePromotionDelta(projectDir);

		const candidate = await seedCandidateWithRecordBytes(
			projectDir,
			PROMOTION_RECORD_MAX_BYTES - delta,
		);

		const raw = await callTool(
			external_skill_promote,
			{ candidate_id: candidate.id, slug: 'bounds-skill', approver: 'user' },
			projectDir,
		);
		expect(JSON.parse(raw).success, raw).toBe(true);

		// The ACTUALLY-persisted record must be exactly at (never over)
		// the verifier's read cap.
		const persisted = persistedRecordBytes(projectDir, candidate.id);
		expect(persisted).toBeLessThanOrEqual(PROMOTION_RECORD_MAX_BYTES);
		expect(persisted).toBe(PROMOTION_RECORD_MAX_BYTES);

		const target = artifactPath(projectDir, 'bounds-skill');
		const written = fs.readFileSync(target, 'utf-8');
		expect(Buffer.byteLength(written, 'utf-8')).toBe(
			artifactBytes(candidate, SMALL_BODY),
		);

		// The propagation-gate verifier must accept exactly what promote
		// wrote, including the just-updated history-carrying record.
		expect(verifyPromotedExternalSkillSync(projectDir, target)).toEqual({
			ok: true,
		});

		// And revoke must be able to retire it.
		const revokeRaw = await callTool(
			external_skill_revoke,
			{ candidate_id: candidate.id, reason: 'bounds round-trip' },
			projectDir,
		);
		const revoked = JSON.parse(revokeRaw) as {
			success: boolean;
			skill_file_removed?: boolean;
			error?: string;
		};
		expect(revoked.success, revokeRaw).toBe(true);
		expect(revoked.skill_file_removed).toBe(true);
		expect(fs.existsSync(target)).toBe(false);
	});
});
