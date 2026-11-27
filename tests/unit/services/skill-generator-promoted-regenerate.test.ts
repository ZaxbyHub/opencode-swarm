/**
 * FB-103 (PR #3942 feedback round 1) — regression: regenerateSkill must
 * refuse promoted-external / record-bound artifacts BEFORE any retire,
 * eval-stub write, rewrite, or source re-stamp.
 *
 * Prior buggy behavior: regenerateSkill rewrote the artifact in place while
 * PRESERVING `skill_origin: promoted_external`, so the promoted bytes silently
 * diverged from the structured promotion record's `promoted_content_hash`
 * (gate digest mismatch, revoke refusal on mismatch, re-promote EEXIST).
 *
 * Fixture: the REAL promote path (config load + candidate store + artifact
 * write through external_skill_promote), so the refusal is exercised against
 * a faithful structured record. The refusal must also hold when the record is
 * MISSING (orphaned provenance claim — fail closed) and when the provenance
 * frontmatter was STRIPPED but the record still binds the path (path-first
 * binding). promoted_content_hash is never re-stamped: the record is asserted
 * byte-identical after every refused call.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import {
	_internals as identityInternals,
	verifyPromotedExternalSkillSync,
} from '../../../src/services/external-skill-identity';
import { createExternalSkillStore } from '../../../src/services/external-skill-store';
import { regenerateSkill } from '../../../src/services/skill-generator';
import { external_skill_promote } from '../../../src/tools/external-skill-promote';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { withFrozenClockAsync } from '../../helpers/test-clock';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const PROMOTED_SLUG = 'deploy-checklist';
const ORDINARY_SLUG = 'release-gate';
const CLAIM_ONLY_SLUG = 'claim-only-skill';
const FROZEN_NOW_ISO = '2026-11-20T12:00:00.000Z';
const FROZEN_NOW_MS = Date.parse(FROZEN_NOW_ISO);
const SKILL_BODY = [
	'# Deploy Checklist',
	'',
	'Run the deployment checklist review before every release.',
].join('\n');

let tmp: string;
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	tmp = canonicalMkdtemp('swarm-promoted-regen-');
});

afterEach(() => {
	try {
		removeTreeWithRetry(tmp);
	} finally {
		isolatedEnv.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Fixtures (same shape as skill-improver-promoted-sweep.test.ts; inlined per
// the repo's sibling-suite convention so each file stays self-contained)
// ---------------------------------------------------------------------------

async function writeCurationConfig(directory: string): Promise<void> {
	const configDir = path.join(directory, '.opencode');
	await mkdir(configDir, { recursive: true });
	await writeFile(
		path.join(configDir, 'opencode-swarm.json'),
		JSON.stringify(
			{
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
			},
			null,
			2,
		),
		'utf-8',
	);
}

function makeEntry(
	id: string,
	fields: { lesson: string; tags: string[]; requiredActions?: string[] },
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: fields.lesson,
		category: 'process',
		tags: fields.tags,
		scope: 'global',
		confidence: 0.9,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2026-11-01T00:00:00.000Z',
				project_name: 't',
			},
			{
				phase_number: 2,
				confirmed_at: '2026-11-02T00:00:00.000Z',
				project_name: 't',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-11-01T00:00:00.000Z',
		updated_at: '2026-11-02T00:00:00.000Z',
		project_name: 't',
		triggers: ['deploy'],
		...(fields.requiredActions
			? { required_actions: fields.requiredActions }
			: {}),
	};
}

/** Knowledge whose lesson/tags match the promoted slug tokens (deploy, checklist). */
async function seedMatchingKnowledge(directory: string): Promise<void> {
	await mkdir(path.join(directory, '.swarm'), { recursive: true });
	const entries: SwarmKnowledgeEntry[] = [
		makeEntry('kb-deploy-1', {
			lesson: 'always run the deploy checklist before coder delegation',
			tags: ['deploy'],
			requiredActions: ['run the deploy checklist before merge'],
		}),
		makeEntry('kb-deploy-2', {
			lesson: 'the deploy checklist gates every release train',
			tags: ['checklist'],
		}),
	];
	await writeFile(
		resolveSwarmKnowledgePath(directory),
		entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		'utf-8',
	);
}

interface PromotedFixture {
	artifactPath: string;
	recordPath: string;
	candidateId: string;
}

async function promoteFixture(directory: string): Promise<PromotedFixture> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const candidate = await store.add({
		source_url: 'https://example.com/skills/deploy-checklist.md',
		source_type: 'github',
		publisher: 'example-publisher',
		sha256: createHash('sha256').update(SKILL_BODY).digest('hex'),
		fetched_at: '2026-11-20T11:59:00.000Z',
		skill_name: 'deploy-checklist',
		skill_body: SKILL_BODY,
		risk_flags: [],
		evaluation_verdict: 'passed',
		evaluation_history: [],
	});

	return withFrozenClockAsync(
		async () => {
			const result = JSON.parse(
				await (
					external_skill_promote as unknown as {
						execute: (
							args: unknown,
							ctx: { directory: string },
						) => Promise<string>;
					}
				).execute(
					{
						candidate_id: candidate.id,
						slug: PROMOTED_SLUG,
						approver: 'user',
					},
					{ directory },
				),
			) as { success: boolean; target_path?: string };

			// Fixture sanity: real promotion succeeded and verifies.
			expect(result.success).toBe(true);
			const artifactPath =
				result.target_path ??
				path.join(
					directory,
					'.opencode',
					'skills',
					'generated',
					PROMOTED_SLUG,
					'SKILL.md',
				);
			expect(verifyPromotedExternalSkillSync(directory, artifactPath)).toEqual({
				ok: true,
			});
			return {
				artifactPath,
				recordPath: path.join(
					directory,
					'.swarm',
					'skills',
					'candidates',
					`${candidate.id}.json`,
				),
				candidateId: candidate.id,
			};
		},
		{ fixedNow: FROZEN_NOW_MS, isoNow: FROZEN_NOW_ISO },
	);
}

// ---------------------------------------------------------------------------
// Regenerate tests
// ---------------------------------------------------------------------------

describe('regenerateSkill — regression: promoted artifacts refused (FB-103)', () => {
	it('refuses a promoted skill (matching knowledge present) without retire, stub, or rewrite', async () => {
		await writeCurationConfig(tmp);
		await seedMatchingKnowledge(tmp);
		const { artifactPath, recordPath } = await promoteFixture(tmp);
		const artifactBefore = readFileSync(artifactPath, 'utf-8');
		const recordBefore = readFileSync(recordPath, 'utf-8');

		// Previously this call re-clustered from the knowledge store and
		// rewrote the artifact in place while keeping skill_origin:
		// promoted_external (silent substitution).
		const result = await regenerateSkill(tmp, PROMOTED_SLUG, {
			evaluate: false,
		});

		expect(result.regenerated).toBe(false);
		expect(result.retired).not.toBe(true);
		expect(result.reason).toContain('promoted external skill');
		expect(readFileSync(artifactPath, 'utf-8')).toBe(artifactBefore);
		expect(readFileSync(recordPath, 'utf-8')).toBe(recordBefore);
		expect(existsSync(retiredMarker(tmp, PROMOTED_SLUG))).toBe(false);
		expect(
			existsSync(
				path.join(
					tmp,
					'.swarm',
					'skills',
					'evals',
					PROMOTED_SLUG,
					'auto-stub.json',
				),
			),
		).toBe(false);
		expect(verifyPromotedExternalSkillSync(tmp, artifactPath)).toEqual({
			ok: true,
		});
	});

	it('refuses an orphaned provenance claim (record deleted) — fail closed', async () => {
		await writeCurationConfig(tmp);
		await seedMatchingKnowledge(tmp);
		const { artifactPath, recordPath } = await promoteFixture(tmp);
		const artifactBefore = readFileSync(artifactPath, 'utf-8');
		rmSync(recordPath);

		// With the record gone the artifact still CLAIMS promoted provenance;
		// treating it as ordinary and regenerating would rewrite bytes under a
		// claim nobody can verify (and keep the promoted_external origin).
		const result = await regenerateSkill(tmp, PROMOTED_SLUG, {
			evaluate: false,
		});

		expect(result.regenerated).toBe(false);
		expect(result.retired).not.toBe(true);
		expect(result.reason).toContain('promoted external skill');
		const artifactAfter = readFileSync(artifactPath, 'utf-8');
		expect(artifactAfter).toBe(artifactBefore);
		expect(artifactAfter).toContain('skill_origin: promoted_external');
		expect(existsSync(retiredMarker(tmp, PROMOTED_SLUG))).toBe(false);
		expect(
			existsSync(
				path.join(
					tmp,
					'.swarm',
					'skills',
					'evals',
					PROMOTED_SLUG,
					'auto-stub.json',
				),
			),
		).toBe(false);
	});

	it('refuses a record-bound artifact whose provenance frontmatter was stripped (path-first binding)', async () => {
		await writeCurationConfig(tmp);
		// Matching knowledge is seeded so the pre-fix code would have gone all
		// the way to an in-place rewrite; the record binding must refuse first.
		await seedMatchingKnowledge(tmp);
		const { artifactPath, recordPath } = await promoteFixture(tmp);
		const stripped = readFileSync(artifactPath, 'utf-8')
			.split('\n')
			.filter(
				(line) =>
					!line.startsWith('promoted_from:') &&
					!line.startsWith('candidate_id:') &&
					!line.startsWith('skill_origin:'),
			)
			.join('\n');
		await writeFile(artifactPath, stripped, 'utf-8');
		const recordBefore = readFileSync(recordPath, 'utf-8');

		const result = await regenerateSkill(tmp, PROMOTED_SLUG, {
			evaluate: false,
		});

		expect(result.regenerated).toBe(false);
		expect(result.retired).not.toBe(true);
		expect(result.reason).toContain('promotion record');
		expect(readFileSync(artifactPath, 'utf-8')).toBe(stripped);
		expect(readFileSync(recordPath, 'utf-8')).toBe(recordBefore);
		expect(existsSync(retiredMarker(tmp, PROMOTED_SLUG))).toBe(false);
	});

	it('control: an ordinary generated skill still regenerates exactly as before', async () => {
		await seedMatchingKnowledgeForOrdinary(tmp);
		const ordinaryDir = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			ORDINARY_SLUG,
		);
		await mkdir(ordinaryDir, { recursive: true });
		const skillPath = path.join(ordinaryDir, 'SKILL.md');
		const original = [
			'---',
			`name: ${ORDINARY_SLUG}`,
			'status: active',
			'generated_at: 2026-01-01T00:00:00.000Z',
			'version: 1',
			'skill_origin: generated',
			'---',
			'',
			'# Ordinary stale skill (no source_knowledge_ids)',
			'',
		].join('\n');
		await writeFile(skillPath, original, 'utf-8');

		const result = await regenerateSkill(tmp, ORDINARY_SLUG, {
			evaluate: false,
		});

		expect(result.regenerated).toBe(true);
		expect(result.entryCount).toBeGreaterThan(0);
		const after = readFileSync(skillPath, 'utf-8');
		expect(after).not.toBe(original);
		// The renderer emits the version inside the metadata map, quoted.
		expect(after).toContain('version: "2"');
		expect(after).toContain('source_knowledge_ids: \'["kb-release-1"]\'');
	});

	it('refuses a promoted_from-only claim under an indeterminate store (Stage B FB-103, bytes unchanged)', async () => {
		// Stage B review: regenerateSkill checked only skill_origin ===
		// 'promoted_external', so an artifact claiming provenance with ONLY
		// 'promoted_from: external-skill-candidate' fell through — and with an
		// INDETERMINATE store (readdir EPERM) it regenerated, rewriting bytes
		// that carry a provenance claim nobody can verify.
		await writeCurationConfig(tmp);
		// Knowledge whose tokens match the claim-only slug so the pre-fix code
		// would reach a real in-place rewrite.
		await mkdir(path.join(tmp, '.swarm'), { recursive: true });
		await writeFile(
			resolveSwarmKnowledgePath(tmp),
			[
				JSON.stringify(
					makeEntry('kb-claim-1', {
						lesson: 'the claim only skill artifact must never be rewritten',
						tags: ['claim'],
					}),
				),
			].join('\n') + '\n',
			'utf-8',
		);
		const claimOnlyDir = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			CLAIM_ONLY_SLUG,
		);
		await mkdir(claimOnlyDir, { recursive: true });
		const claimOnlyArtifact = path.join(claimOnlyDir, 'SKILL.md');
		const claimOnlyContent = [
			'---',
			`name: ${CLAIM_ONLY_SLUG}`,
			'status: active',
			'generated_at: 2026-01-01T00:00:00.000Z',
			'version: 1',
			'promoted_from: external-skill-candidate',
			'---',
			'',
			SKILL_BODY,
		].join('\n');
		await writeFile(claimOnlyArtifact, claimOnlyContent, 'utf-8');

		const originalReaddir = identityInternals.readdirSync;
		identityInternals.readdirSync = (() => {
			throw Object.assign(new Error('store unreadable'), { code: 'EPERM' });
		}) as typeof import('node:fs').readdirSync;
		try {
			const result = await regenerateSkill(tmp, CLAIM_ONLY_SLUG, {
				evaluate: false,
			});
			expect(result.regenerated).toBe(false);
			expect(result.retired).not.toBe(true);
			expect(result.reason).toContain('promoted external skill');
		} finally {
			identityInternals.readdirSync = originalReaddir;
		}
		expect(readFileSync(claimOnlyArtifact, 'utf-8')).toBe(claimOnlyContent);
		expect(existsSync(retiredMarker(tmp, CLAIM_ONLY_SLUG))).toBe(false);
	});
});

function retiredMarker(directory: string, slug: string): string {
	return path.join(
		directory,
		'.opencode',
		'skills',
		'generated',
		slug,
		'retired.marker',
	);
}

/** Knowledge matching the ORDINARY control slug tokens (release, gate). */
async function seedMatchingKnowledgeForOrdinary(
	directory: string,
): Promise<void> {
	await mkdir(path.join(directory, '.swarm'), { recursive: true });
	const entries: SwarmKnowledgeEntry[] = [
		makeEntry('kb-release-1', {
			lesson: 'every release must pass the gate review before merge',
			tags: ['release'],
			requiredActions: ['pass the gate review'],
		}),
	];
	await writeFile(
		resolveSwarmKnowledgePath(directory),
		entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		'utf-8',
	);
}
