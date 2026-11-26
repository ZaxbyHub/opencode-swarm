/**
 * #3822 K3 + ASK-3 — promote-side identity bindings.
 *
 *   K3    — a target slug colliding with a BUNDLED_PROJECT_SKILLS entry is
 *           refused with a structured error carrying the `reserved` token.
 *   ASK-3 — the optional `expected_sha256` argument binds promotion to the
 *           reviewed candidate bytes: a mismatch is a stale-base refusal.
 *
 * Also pins that the written artifact carries the advisory `content_digest`
 * frontmatter line and that the structured record's `promoted_content_hash`
 * is the canonical artifact digest (see external-skill-identity.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUNDLED_PROJECT_SKILLS } from '../../../src/config/bundled-skills.js';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	_internals,
	external_skill_promote,
} from '../../../src/tools/external-skill-promote.js';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SKILL_BODY =
	'This is a safe skill body with no dangerous patterns for promote identity tests.';

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

async function seedPassedCandidate(
	directory: string,
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	return store.add({
		source_url: 'https://example.com/skill.md',
		source_type: 'github',
		publisher: 'test-publisher',
		sha256: sha256(SKILL_BODY),
		fetched_at: withFrozenClock(
			() => new Date(Date.now() - 60_000).toISOString(),
			{ fixedNow: Date.now() },
		),
		skill_name: 'promote-identity-skill',
		skill_body: SKILL_BODY,
		risk_flags: [],
		evaluation_verdict: 'passed',
		evaluation_history: [
			{
				verdict: 'passed',
				timestamp: '2026-01-15T12:00:00.000Z',
				actor: 'system',
				reason: 'All gates passed',
			},
		],
	});
}

describe('external_skill_promote — identity bindings (#3822 K3 / ASK-3)', () => {
	let projectDir: string;
	const originalLoadConfig = _internals.loadConfig;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-promote-identity-');
		fs.mkdirSync(projectDir, { recursive: true });
		_internals.loadConfig = () =>
			({
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
			}) as never;
	});

	afterEach(() => {
		_internals.loadConfig = originalLoadConfig;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('a bundled skill slug is refused as reserved', async () => {
		const candidate = await seedPassedCandidate(projectDir);
		const bundledSlug = BUNDLED_PROJECT_SKILLS[0];
		expect(bundledSlug).toBeTruthy();

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: bundledSlug, approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('reserved');

		expect(
			fs.existsSync(
				path.join(
					projectDir,
					'.opencode',
					'skills',
					'generated',
					bundledSlug,
					'SKILL.md',
				),
			),
		).toBe(false);

		const store = createExternalSkillStore(projectDir, {
			max_candidates: 500,
		});
		const unchanged = await store.get(candidate.id);
		expect(unchanged?.evaluation_verdict).toBe('passed');
	});

	test('expected_sha256 mismatch is refused as a stale base', async () => {
		const candidate = await seedPassedCandidate(projectDir);

		const raw = await callPromote(
			{
				candidate_id: candidate.id,
				slug: 'stale-refused-skill',
				approver: 'user',
				expected_sha256: sha256('different reviewed content'),
			},
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toBe(
			'stale candidate: content changed since review (expected_sha256 mismatch)',
		);
		expect(
			fs.existsSync(
				path.join(
					projectDir,
					'.opencode',
					'skills',
					'generated',
					'stale-refused-skill',
					'SKILL.md',
				),
			),
		).toBe(false);
	});

	test('expected_sha256 matching the reviewed body succeeds', async () => {
		const candidate = await seedPassedCandidate(projectDir);

		const raw = await callPromote(
			{
				candidate_id: candidate.id,
				slug: 'fresh-base-skill',
				approver: 'user',
				expected_sha256: sha256(SKILL_BODY),
			},
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(true);
		expect(
			fs.existsSync(
				path.join(
					projectDir,
					'.opencode',
					'skills',
					'generated',
					'fresh-base-skill',
					'SKILL.md',
				),
			),
		).toBe(true);
	});

	test('malformed expected_sha256 is refused', async () => {
		const candidate = await seedPassedCandidate(projectDir);

		const raw = await callPromote(
			{
				candidate_id: candidate.id,
				slug: 'malformed-hash-skill',
				approver: 'user',
				expected_sha256: 'not-a-hash',
			},
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('64-character hex');
	});

	test('the artifact carries the advisory content_digest and the record the canonical hash', async () => {
		const candidate = await seedPassedCandidate(projectDir);

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'digest-skill', approver: 'user' },
			projectDir,
		);
		expect(JSON.parse(raw).success, raw).toBe(true);

		const artifactPath = path.join(
			projectDir,
			'.opencode',
			'skills',
			'generated',
			'digest-skill',
			'SKILL.md',
		);
		const content = fs.readFileSync(artifactPath, 'utf-8');
		const match = /^content_digest: ([0-9a-f]{64})$/m.exec(content);
		expect(match, content).not.toBeNull();
		// Independent oracle (FB-112): canonicalize the artifact INLINE per the
		// identity spec — replace the FIRST content_digest line up to the first
		// CR or LF — then hash with node:crypto. Never via computeArtifactDigest
		// itself, which would make this a self-oracle.
		const canonical = content.replace(
			/^content_digest:[^\r\n]*/m,
			'content_digest: <recorded>',
		);
		expect(match?.[1]).toBe(sha256(canonical));

		const store = createExternalSkillStore(projectDir, {
			max_candidates: 500,
		});
		const updated = await store.get(candidate.id);
		const entry = updated?.evaluation_history.find(
			(e) => e.verdict === 'promoted' && e.actor === 'user',
		);
		expect(entry?.promoted_content_hash).toBe(match?.[1]);
	});
});
