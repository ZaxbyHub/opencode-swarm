/**
 * FB-103 (PR #3942 feedback round 1) — regression: the stale-active-skill
 * sweep must never mutate a promoted-external / record-bound generated skill.
 *
 * Prior buggy behavior: promoted artifacts carry no `source_knowledge_ids`,
 * so `reconcileStaleActiveSkills` (skill-improver.ts) classified them stale
 * and either regenerated them in place — rewriting bytes that are digest-bound
 * to a structured promotion record while KEEPING `skill_origin:
 * promoted_external` — or retired them when no re-derivable source existed.
 * Both silently invalidated the promotion binding (gate digest mismatch,
 * revoke refusal, re-promote EEXIST).
 *
 * Fixture: the REAL promote path (external_skill_promote tool execute with
 * real filesystem writes, real candidate store, real config load via
 * `.opencode/opencode-swarm.json`). Reachability note: curation is
 * default-disabled (`external_skills.curation_enabled` defaults false), so the
 * fixture writes the real enabling config the tool loads. The mutating sweep
 * itself is reached from runSkillImprover only in `draft_skills` write mode
 * (`skill_improver.write_mode`, default 'proposal' → dry run); calling
 * `reconcileStaleActiveSkills(directory, { dryRun: false })` directly is the
 * exact draft_skills-mode mutating invocation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import {
	_internals as identityInternals,
	verifyPromotedExternalSkillSync,
} from '../../../src/services/external-skill-identity';
import { createExternalSkillStore } from '../../../src/services/external-skill-store';
import { reconcileStaleActiveSkills } from '../../../src/services/skill-improver';
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
	tmp = canonicalMkdtemp('swarm-promoted-sweep-');
});

afterEach(() => {
	try {
		removeTreeWithRetry(tmp);
	} finally {
		isolatedEnv.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Real enabling config for the promote tool (curation is default-disabled). */
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

/** Seed the swarm knowledge store (JSONL) with maturity-eligible entries. */
async function seedKnowledge(
	directory: string,
	entries: SwarmKnowledgeEntry[],
): Promise<string> {
	const swarmDir = path.join(directory, '.swarm');
	await mkdir(swarmDir, { recursive: true });
	const storePath = resolveSwarmKnowledgePath(directory);
	await writeFile(
		storePath,
		entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		'utf-8',
	);
	return storePath;
}

/** Knowledge whose lesson/tags match the promoted slug tokens (deploy, checklist). */
function matchingKnowledge(): SwarmKnowledgeEntry[] {
	return [
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
}

interface PromotedFixture {
	artifactPath: string;
	recordPath: string;
	candidateId: string;
}

/**
 * Promote a real candidate through the real tool path (real config load, real
 * artifact write, real candidate-store record). Frozen clock keeps the
 * 90-day TTL gate deterministic regardless of when the suite runs.
 */
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

			// Fixture sanity only (the tool itself is covered by
			// external-skill-promote.test.ts): promotion succeeded and the
			// gate verifier accepts the freshly promoted artifact.
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
			expect(existsSync(artifactPath)).toBe(true);
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

function retiredMarkerPath(directory: string, slug: string): string {
	return path.join(
		directory,
		'.opencode',
		'skills',
		'generated',
		slug,
		'retired.marker',
	);
}

// ---------------------------------------------------------------------------
// Sweep tests
// ---------------------------------------------------------------------------

describe('reconcileStaleActiveSkills — regression: promoted skills untouched (FB-103)', () => {
	it('mutating sweep with matching knowledge skips the promoted skill and changes nothing', async () => {
		await writeCurationConfig(tmp);
		const knowledgePath = await seedKnowledge(tmp, matchingKnowledge());
		const { artifactPath, recordPath } = await promoteFixture(tmp);
		const artifactBefore = readFileSync(artifactPath, 'utf-8');
		const recordBefore = readFileSync(recordPath, 'utf-8');
		const knowledgeBefore = readFileSync(knowledgePath, 'utf-8');

		// Previously the sweep regenerated the promoted artifact in place
		// (bytes rewritten, knowledge stamped, eval stub written) while
		// keeping skill_origin: promoted_external — silent substitution.
		const result = await reconcileStaleActiveSkills(tmp, { dryRun: false });

		expect(result.skipped).toContain(PROMOTED_SLUG);
		expect(result.regenerated).not.toContain(PROMOTED_SLUG);
		expect(result.retired).not.toContain(PROMOTED_SLUG);
		expect(readFileSync(artifactPath, 'utf-8')).toBe(artifactBefore);
		expect(readFileSync(recordPath, 'utf-8')).toBe(recordBefore);
		expect(readFileSync(knowledgePath, 'utf-8')).toBe(knowledgeBefore);
		expect(existsSync(retiredMarkerPath(tmp, PROMOTED_SLUG))).toBe(false);
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

	it('mutating sweep with NO matching knowledge does not retire the promoted skill (previously retired)', async () => {
		await writeCurationConfig(tmp);
		const { artifactPath, recordPath } = await promoteFixture(tmp);
		const artifactBefore = readFileSync(artifactPath, 'utf-8');
		const recordBefore = readFileSync(recordPath, 'utf-8');

		// No knowledge store at all: previously regenerateSkill could not
		// re-derive a source, so the sweep retired the promoted skill.
		const result = await reconcileStaleActiveSkills(tmp, { dryRun: false });

		expect(result.skipped).toContain(PROMOTED_SLUG);
		expect(result.regenerated).not.toContain(PROMOTED_SLUG);
		expect(result.retired).not.toContain(PROMOTED_SLUG);
		expect(readFileSync(artifactPath, 'utf-8')).toBe(artifactBefore);
		expect(readFileSync(recordPath, 'utf-8')).toBe(recordBefore);
		expect(existsSync(retiredMarkerPath(tmp, PROMOTED_SLUG))).toBe(false);
		expect(verifyPromotedExternalSkillSync(tmp, artifactPath)).toEqual({
			ok: true,
		});
	});

	it('skips a record-bound artifact whose provenance frontmatter was stripped (path-first binding)', async () => {
		await writeCurationConfig(tmp);
		const { artifactPath, recordPath } = await promoteFixture(tmp);
		// Strip the provenance claim lines; the promotion record still binds
		// the PATH, so the sweep must still refuse to touch it.
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

		const result = await reconcileStaleActiveSkills(tmp, { dryRun: false });

		expect(result.skipped).toContain(PROMOTED_SLUG);
		expect(result.regenerated).not.toContain(PROMOTED_SLUG);
		expect(result.retired).not.toContain(PROMOTED_SLUG);
		expect(readFileSync(artifactPath, 'utf-8')).toBe(stripped);
		expect(readFileSync(recordPath, 'utf-8')).toBe(recordBefore);
		expect(existsSync(retiredMarkerPath(tmp, PROMOTED_SLUG))).toBe(false);
	});

	it('control: an ordinary stale generated skill is still reconciled exactly as before', async () => {
		await writeCurationConfig(tmp);
		await promoteFixture(tmp);
		const ordinaryDir = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			ORDINARY_SLUG,
		);
		await mkdir(ordinaryDir, { recursive: true });
		await writeFile(
			path.join(ordinaryDir, 'SKILL.md'),
			[
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
			].join('\n'),
			'utf-8',
		);

		// No knowledge seeded → the ordinary stale skill takes the same
		// terminal-retire path the sweep has always used. The promotion
		// record store exists in this fixture, proving an ordinary skill is
		// not blocked by the record scan.
		const result = await reconcileStaleActiveSkills(tmp, { dryRun: false });

		expect(result.retired).toContain(ORDINARY_SLUG);
		expect(result.skipped).not.toContain(ORDINARY_SLUG);
		expect(result.regenerated).not.toContain(ORDINARY_SLUG);
		expect(existsSync(retiredMarkerPath(tmp, ORDINARY_SLUG))).toBe(true);
		// The promoted skill in the same sweep is skipped, not retired.
		expect(result.skipped).toContain(PROMOTED_SLUG);
		expect(result.retired).not.toContain(PROMOTED_SLUG);
	});

	it('skips a promoted_from-only claim under an indeterminate store (Stage B FB-103, bytes unchanged)', async () => {
		// Stage B review: the sweep checked only skill_origin ===
		// 'promoted_external', so an artifact claiming provenance with ONLY
		// 'promoted_from: external-skill-candidate' fell through to the
		// record lookup — and an INDETERMINATE store (readdir EPERM) fell
		// through to reconciliation, rewriting the claimed bytes.
		await writeCurationConfig(tmp);
		await seedKnowledge(tmp, matchingKnowledge());
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
			const result = await reconcileStaleActiveSkills(tmp, { dryRun: false });
			expect(result.skipped).toContain(CLAIM_ONLY_SLUG);
			expect(result.regenerated).not.toContain(CLAIM_ONLY_SLUG);
			expect(result.retired).not.toContain(CLAIM_ONLY_SLUG);
		} finally {
			identityInternals.readdirSync = originalReaddir;
		}
		expect(readFileSync(claimOnlyArtifact, 'utf-8')).toBe(claimOnlyContent);
		expect(existsSync(retiredMarkerPath(tmp, CLAIM_ONLY_SLUG))).toBe(false);
	});
});
