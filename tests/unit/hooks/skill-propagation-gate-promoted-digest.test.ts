/**
 * #3822 K1 — promoted external skills are digest-bound to their promotion
 * record on every propagation/discovery path.
 *
 * `validateSkillReference` resolves the promotion record for artifacts under
 * `.opencode/skills/generated/` BY CANONICAL PATH (path-first): frontmatter
 * provenance is not the lookup key, the structured candidate record is.
 * Fail-closed on digest mismatch, missing record (when the artifact claims
 * promoted provenance), and tampering — including rehash-after-tamper, where
 * the attacker recomputes the advisory frontmatter digest but cannot touch
 * the record.
 *
 * Legacy rule (approved ASK-2): records promoted before the structured
 * full-file hash still validate — either because their recorded hash is the
 * pre-change RAW whole-file SHA-256 (byte-identical to the canonical digest
 * of a digest-line-less artifact) or, when no full-file hash exists at all,
 * via the body-only candidate sha256.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import { validateSkillReference } from '../../../src/hooks/skill-propagation-gate.js';
import {
	ARTIFACT_DIGEST_PLACEHOLDER_LINE,
	computeArtifactDigest,
	PROMOTED_ARTIFACT_MAX_BYTES,
} from '../../../src/services/external-skill-identity.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	external_skill_promote,
	_internals as promoteInternals,
} from '../../../src/tools/external-skill-promote.js';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SKILL_BODY =
	'This is a safe skill body with no dangerous patterns for the digest gate tests.';

const AUDIENCE_CONTEXT = {
	runner: 'opencode',
	audiences: ['swarm-plugin'],
} as never;

function sha256(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

/**
 * Independent canonical-digest oracle (line-based replacement, structurally
 * different from computeArtifactDigest's regex) and computed with
 * node:crypto — the stamped digest is never verified against the same
 * implementation that produced it (FB-112 self-oracle removal).
 */
function independentCanonicalDigest(content: string): string {
	const lines = content.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith('content_digest:')) {
			const cr = lines[i].indexOf('\r');
			lines[i] =
				cr === -1
					? ARTIFACT_DIGEST_PLACEHOLDER_LINE
					: ARTIFACT_DIGEST_PLACEHOLDER_LINE + lines[i].slice(cr);
			break;
		}
	}
	return sha256(lines.join('\n'));
}

async function callPromote(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_promote as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

function validate(directory: string, reference: string) {
	return validateSkillReference(directory, reference, AUDIENCE_CONTEXT, {
		enforceAudience: false,
	});
}

function skillReference(slug: string): string {
	return `file:.opencode/skills/generated/${slug}/SKILL.md`;
}

function skillPath(directory: string, slug: string): string {
	return path.join(
		directory,
		'.opencode',
		'skills',
		'generated',
		slug,
		'SKILL.md',
	);
}

/** Old-style (pre-#3822) promoted artifact frontmatter — no content_digest line. */
function legacyArtifactMarkdown(
	candidateId: string,
	slug: string,
	body: string,
	bodySha: string,
): string {
	return [
		'---',
		'promoted_from: external-skill-candidate',
		`slug: ${slug}`,
		`candidate_id: ${candidateId}`,
		'source_url: https://example.com/skill.md',
		'source_type: github',
		'publisher: test-publisher',
		`sha256: ${bodySha}`,
		'promoted_at: 2026-01-15T12:00:00.000Z',
		'promoted_by: user',
		'skill_origin: promoted_external',
		'version: 1',
		'---',
		'',
		body,
	].join('\n');
}

interface SeededHistoryEntry {
	verdict: string;
	timestamp: string;
	actor: string;
	reason?: string;
	target_path?: string;
	promoted_content_hash?: string;
}

async function seedCandidateRecord(
	directory: string,
	overrides: {
		evaluation_verdict?: string;
		evaluation_history?: SeededHistoryEntry[];
		skill_body?: string;
		sha256?: string;
	},
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const skillBody = overrides.skill_body ?? SKILL_BODY;
	return store.add({
		source_url: 'https://example.com/skill.md',
		source_type: 'github',
		publisher: 'test-publisher',
		sha256: overrides.sha256 ?? sha256(skillBody),
		fetched_at: withFrozenClock(
			() => new Date(Date.now() - 60_000).toISOString(),
			{ fixedNow: Date.now() },
		),
		skill_name: 'digest-gate-skill',
		skill_body: skillBody,
		risk_flags: [],
		evaluation_verdict: (overrides.evaluation_verdict ??
			'passed') as ExternalSkillCandidate['evaluation_verdict'],
		evaluation_history: (overrides.evaluation_history ??
			[]) as ExternalSkillCandidate['evaluation_history'],
	});
}

/** Promote a real candidate through the production tool and return its path. */
async function promoteReal(directory: string, slug: string): Promise<string> {
	const candidate = await seedCandidateRecord(directory, {
		evaluation_verdict: 'passed',
	});
	const raw = await callPromote(
		{ candidate_id: candidate.id, slug, approver: 'user' },
		directory,
	);
	const parsed = JSON.parse(raw) as { success: boolean; error?: string };
	expect(parsed.success, raw).toBe(true);
	return skillPath(directory, slug);
}

describe('skill propagation gate — promoted external skill digest binding (#3822 K1)', () => {
	let projectDir: string;
	const originalLoadConfig = promoteInternals.loadConfig;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-digest-gate-');
		fs.rmSync(projectDir, { recursive: true, force: true });
		fs.mkdirSync(projectDir, { recursive: true });
		promoteInternals.loadConfig = () =>
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
		promoteInternals.loadConfig = originalLoadConfig;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('the promoted artifact carries a content_digest matching its canonical digest', async () => {
		const artifactPath = await promoteReal(projectDir, 'digest-stamped');
		const content = fs.readFileSync(artifactPath, 'utf-8');
		const match = /^content_digest: ([0-9a-f]{64})$/m.exec(content);
		expect(match, content).not.toBeNull();
		expect(match?.[1]).toBe(independentCanonicalDigest(content));

		// The structured record carries the same canonical digest. Note the
		// store also appends an automatic (actor 'system') verdict-change
		// entry WITHOUT the structured fields — the audit entry carrying them
		// is the authoritative promotion record.
		const store = createExternalSkillStore(projectDir, {
			max_candidates: 500,
		});
		const candidates = await store.list();
		const promoted = candidates.find(
			(c) => c.evaluation_verdict === 'promoted',
		);
		expect(promoted).toBeDefined();
		const entry = promoted!.evaluation_history.find(
			(e) => e.verdict === 'promoted' && e.actor === 'user',
		);
		expect(entry?.promoted_content_hash).toBe(match?.[1]);
	});

	test('matching bytes propagate (happy path)', async () => {
		await promoteReal(projectDir, 'happy-digest-skill');
		const result = validate(projectDir, skillReference('happy-digest-skill'));
		expect(result.valid, result.reason ?? '').toBe(true);
	});

	test('mutated on-disk bytes are refused', async () => {
		const artifactPath = await promoteReal(projectDir, 'tampered-skill');
		fs.appendFileSync(artifactPath, '\n<!-- injected after approval -->\n');
		const result = validate(projectDir, skillReference('tampered-skill'));
		expect(result.valid).toBe(false);
		expect(result.reason).toBe(
			'promoted external skill content digest does not match the recorded promotion hash',
		);
	});

	test('rehash-after-tamper is still refused (the record wins)', async () => {
		const artifactPath = await promoteReal(projectDir, 'rehashed-skill');
		// Attacker edits the body AND recomputes the advisory frontmatter
		// digest over the tampered bytes.
		let content = fs.readFileSync(artifactPath, 'utf-8');
		content = content.replace(
			SKILL_BODY,
			`${SKILL_BODY}\nInjected instruction after approval.`,
		);
		content = content.replace(
			/^content_digest: [0-9a-f]{64}$/m,
			`content_digest: ${computeArtifactDigest(content)}`,
		);
		fs.writeFileSync(artifactPath, content, 'utf-8');

		const result = validate(projectDir, skillReference('rehashed-skill'));
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('recorded promotion hash');
	});

	test('provenance-field removal is still resolved by path and refused', async () => {
		const artifactPath = await promoteReal(projectDir, 'stripped-skill');
		// Remove skill_origin AND candidate_id — the frontmatter no longer
		// claims promoted provenance, but the canonical path still resolves
		// to the promotion record.
		let content = fs.readFileSync(artifactPath, 'utf-8');
		content = content
			.replace(/^skill_origin: promoted_external\r?\n/m, '')
			.replace(/^candidate_id: [0-9a-f-]+\r?\n/m, '');
		fs.writeFileSync(artifactPath, content, 'utf-8');

		const result = validate(projectDir, skillReference('stripped-skill'));
		expect(result.valid).toBe(false);
		// The digest-mismatch reason can only be produced when the record was
		// found by path — an ordinary generated skill would have validated.
		expect(result.reason).toContain('recorded promotion hash');
	});

	test('candidate-id substitution is refused', async () => {
		const artifactPath = await promoteReal(projectDir, 'swapped-id-skill');
		let content = fs.readFileSync(artifactPath, 'utf-8');
		content = content.replace(
			/^candidate_id: [0-9a-f-]+$/m,
			'candidate_id: 00000000-0000-4000-a000-00000000000f',
		);
		fs.writeFileSync(artifactPath, content, 'utf-8');

		const result = validate(projectDir, skillReference('swapped-id-skill'));
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('candidate_id mismatch');
	});

	test('provenance claim without a matching record is refused', async () => {
		const artifactPath = skillPath(projectDir, 'orphan-claim-skill');
		fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
		fs.writeFileSync(
			artifactPath,
			legacyArtifactMarkdown(
				'00000000-0000-4000-a000-0000000000ff',
				'orphan-claim-skill',
				SKILL_BODY,
				sha256(SKILL_BODY),
			),
			'utf-8',
		);

		const result = validate(projectDir, skillReference('orphan-claim-skill'));
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('no matching promotion record');
	});

	test('ordinary generated skill with no candidate store validates unchanged', () => {
		const artifactPath = skillPath(projectDir, 'plain-generated');
		fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
		fs.writeFileSync(
			artifactPath,
			[
				'---',
				'name: plain-generated',
				'description: An ordinary generated skill.',
				'skill_origin: generated',
				'version: 1',
				'---',
				'',
				SKILL_BODY,
			].join('\n'),
			'utf-8',
		);

		const result = validate(projectDir, skillReference('plain-generated'));
		expect(result.valid, result.reason ?? '').toBe(true);
	});

	test('legacy record with the pre-change raw whole-file hash still validates', async () => {
		const slug = 'legacy-raw-hash';
		const artifactPath = skillPath(projectDir, slug);

		// Seed first so the artifact's candidate_id matches the record id.
		const candidate = await seedCandidateRecord(projectDir, {});
		const artifact = legacyArtifactMarkdown(
			candidate.id,
			slug,
			SKILL_BODY,
			sha256(SKILL_BODY),
		);
		fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
		fs.writeFileSync(artifactPath, artifact, 'utf-8');

		// Pre-#3822 promote recorded the RAW whole-file SHA-256. The record is
		// amended directly (store.add cannot know the hash before the
		// artifact's candidate_id — and therefore its bytes — exist).
		const recordPath = path.join(
			projectDir,
			'.swarm',
			'skills',
			'candidates',
			`${candidate.id}.json`,
		);
		const rawRecord = JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as {
			evaluation_verdict: string;
			evaluation_history: SeededHistoryEntry[];
		};
		rawRecord.evaluation_verdict = 'promoted';
		rawRecord.evaluation_history = [
			{
				verdict: 'promoted',
				timestamp: '2026-01-15T12:00:00.000Z',
				actor: 'user',
				reason: `Promoted to .opencode/skills/generated/${slug}/SKILL.md — re-validation passed`,
				target_path: artifactPath,
				promoted_content_hash: sha256(artifact),
			},
		];
		fs.writeFileSync(
			recordPath,
			JSON.stringify(rawRecord, null, '\t'),
			'utf-8',
		);

		const result = validate(projectDir, skillReference(slug));
		expect(result.valid, result.reason ?? '').toBe(true);
	});

	test('legacy record without a structured hash validates via body-only sha256 (ASK-2)', async () => {
		const slug = 'legacy-body-hash';
		const artifactPath = skillPath(projectDir, slug);

		// No promoted_content_hash at all — only the candidate body sha256.
		const candidate = await seedCandidateRecord(projectDir, {
			evaluation_verdict: 'promoted',
			evaluation_history: [
				{
					verdict: 'promoted',
					timestamp: '2026-01-15T12:00:00.000Z',
					actor: 'user',
					reason: `Promoted to .opencode/skills/generated/${slug}/SKILL.md — re-validation passed`,
					target_path: artifactPath,
				},
			],
		});
		const artifact = legacyArtifactMarkdown(
			candidate.id,
			slug,
			SKILL_BODY,
			sha256(SKILL_BODY),
		);
		fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
		fs.writeFileSync(artifactPath, artifact, 'utf-8');

		const result = validate(projectDir, skillReference(slug));
		expect(result.valid, result.reason ?? '').toBe(true);

		// The legacy path still refuses a tampered body.
		fs.appendFileSync(artifactPath, '\n<!-- post-approval edit -->\n');
		const tampered = validate(projectDir, skillReference(slug));
		expect(tampered.valid).toBe(false);
		expect(tampered.reason).toContain('body');
	});

	test('oversized promoted artifact fails closed', async () => {
		const artifactPath = await promoteReal(projectDir, 'oversized-skill');
		fs.writeFileSync(
			artifactPath,
			`x`.repeat(PROMOTED_ARTIFACT_MAX_BYTES + 1),
			'utf-8',
		);
		const result = validate(projectDir, skillReference('oversized-skill'));
		expect(result.valid).toBe(false);
		expect(result.reason).toContain('digest bound');
	});
});
