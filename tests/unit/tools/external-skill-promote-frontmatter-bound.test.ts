/**
 * Stage B round 9 — a successful promotion must be consumable by the real
 * propagation gate (PR #3942 feedback).
 *
 * The gate reads only the first SKILL_FRONTMATTER_READ_BYTES (16 KiB) of a
 * SKILL.md to extract its metadata and rejects a skill whose closing
 * frontmatter fence is not inside that window BEFORE identity verification
 * ever runs. publisher / source_url (each up to the validator's 10,000-char
 * field cap) are written raw into the frontmatter, so promote must refuse —
 * before writing anything — a candidate whose frontmatter would not fit.
 *
 * The at-bound case is calibrated by promoting a TWIN candidate (same-length
 * slug, same fixed timestamp, same-length ids/hashes) and padding the
 * publisher by the exact remaining byte count, then asserting the written
 * frontmatter equals the window exactly and the REAL gate metadata reader
 * (readSkillMetadata) reports a valid frontmatter.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import {
	readSkillMetadata,
	SKILL_FRONTMATTER_READ_BYTES,
} from '../../../src/hooks/skill-scoring.js';
import { verifyPromotedExternalSkillSync } from '../../../src/services/external-skill-identity.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	external_skill_promote,
	_internals as promoteInternals,
} from '../../../src/tools/external-skill-promote.js';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const FIXED_TS = '2026-06-09T12:00:00.000Z';
const BODY =
	'Safe skill body with no dangerous patterns for frontmatter tests.';
const BASE_PUBLISHER = 'pub '.repeat(1_400).trimEnd();
const SOURCE_URL = `https://example.com/s/${'u '.repeat(2_600).trimEnd()}`;

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

async function seed(
	directory: string,
	publisher: string,
	sourceUrl: string,
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	return store.add({
		source_url: sourceUrl,
		source_type: 'github',
		publisher,
		sha256: sha256(BODY),
		fetched_at: withFrozenClock(
			() => new Date(Date.now() - 60_000).toISOString(),
			{ fixedNow: Date.now() },
		),
		skill_name: 'fm-skill',
		skill_body: BODY,
		risk_flags: [],
		evaluation_verdict: 'passed',
		evaluation_history: [],
	});
}

function relArtifact(slug: string): string {
	return `.opencode/skills/generated/${slug}/SKILL.md`;
}

function absArtifact(directory: string, slug: string): string {
	return path.join(directory, ...relArtifact(slug).split('/'));
}

/** Bytes from the opening fence through the closing fence (inclusive). */
function frontmatterBytes(markdown: string): number {
	const lines = markdown.split('\n');
	const end = lines.findIndex(
		(line, index) => index > 0 && line.trim() === '---',
	);
	return Buffer.byteLength(lines.slice(0, end + 1).join('\n'), 'utf8');
}

describe('external_skill_promote — frontmatter must fit the gate metadata window (Stage B round 9)', () => {
	let projectDir: string;
	const originalGetTimestamp = promoteInternals.getTimestamp;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-promote-fm-');
		const configDir = path.join(projectDir, '.opencode');
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, 'opencode-swarm.json'),
			JSON.stringify({
				external_skills: {
					curation_enabled: true,
					max_candidates: 500,
					max_bytes_per_candidate: 1_048_576,
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
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('publisher + source_url of ~9,000 chars each (valid per field) are refused before any write', async () => {
		const bigPublisher = 'pub '.repeat(2_250).trimEnd();
		const bigUrl = `https://example.com/s/${'u '.repeat(4_400).trimEnd()}`;
		const candidate = await seed(projectDir, bigPublisher, bigUrl);

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'big-slug', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('SKILL_FRONTMATTER_READ_BYTES');
		expect(fs.existsSync(absArtifact(projectDir, 'big-slug'))).toBe(false);

		const store = createExternalSkillStore(projectDir, { max_candidates: 500 });
		const unchanged = await store.get(candidate.id);
		expect(unchanged?.evaluation_verdict).toBe('passed');
	});

	test('frontmatter EXACTLY at the window promotes and the real gate metadata reader accepts it; one byte over is refused', async () => {
		// Twin promotion measures the fixed per-candidate frontmatter size.
		const twin = await seed(projectDir, BASE_PUBLISHER, SOURCE_URL);
		const twinRaw = await callPromote(
			{ candidate_id: twin.id, slug: 'twin-slug', approver: 'user' },
			projectDir,
		);
		expect(JSON.parse(twinRaw).success, twinRaw).toBe(true);
		const twinBytes = frontmatterBytes(
			fs.readFileSync(absArtifact(projectDir, 'twin-slug'), 'utf-8'),
		);
		const remaining = SKILL_FRONTMATTER_READ_BYTES - twinBytes;
		expect(remaining, 'twin must leave room to pad').toBeGreaterThan(2);

		// Pad publisher + source_url by exactly `remaining` bytes in total
		// (ASCII; space-broken so the validator's long-run heuristics do not
		// trip; split so each field stays under the validator's 10,000-char
		// per-field cap).
		const spaced = (len: number): string =>
			' a'.repeat(Math.ceil(len / 2)).slice(0, len);
		const padPublisher = spaced(Math.min(remaining, 4_000));
		const padUrl = spaced(remaining - padPublisher.length);
		const exact = await seed(
			projectDir,
			BASE_PUBLISHER + padPublisher,
			SOURCE_URL + padUrl,
		);
		const exactRaw = await callPromote(
			{ candidate_id: exact.id, slug: 'edge-slug', approver: 'user' },
			projectDir,
		);
		expect(JSON.parse(exactRaw).success, exactRaw).toBe(true);
		const written = fs.readFileSync(
			absArtifact(projectDir, 'edge-slug'),
			'utf-8',
		);
		expect(frontmatterBytes(written)).toBe(SKILL_FRONTMATTER_READ_BYTES);

		// The REAL gate metadata reader sees a valid frontmatter, and the
		// identity verifier accepts the artifact.
		const metadata = readSkillMetadata(relArtifact('edge-slug'), projectDir);
		expect(metadata.frontmatterStatus).toBe('valid');
		expect(
			verifyPromotedExternalSkillSync(
				projectDir,
				absArtifact(projectDir, 'edge-slug'),
			),
		).toEqual({ ok: true });

		// One byte over the window is refused before anything is written.
		const over = await seed(
			projectDir,
			`${BASE_PUBLISHER + padPublisher}a`,
			SOURCE_URL + padUrl,
		);
		const overRaw = await callPromote(
			{ candidate_id: over.id, slug: 'over-slug', approver: 'user' },
			projectDir,
		);
		const parsedOver = JSON.parse(overRaw) as {
			success: boolean;
			error?: string;
		};
		expect(parsedOver.success, overRaw).toBe(false);
		expect(parsedOver.error).toContain('SKILL_FRONTMATTER_READ_BYTES');
		expect(fs.existsSync(absArtifact(projectDir, 'over-slug'))).toBe(false);
	});
});
