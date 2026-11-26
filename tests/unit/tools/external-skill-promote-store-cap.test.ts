/**
 * Closeout round — promote must not report success for a skill the identity
 * verifier will refuse because the candidate store is over its scan cap.
 *
 * The verifier reads NO record when the store holds more than
 * MAX_PROMOTION_RECORD_FILES files (it bounds the synchronous work on every
 * delegation) and refuses every CLAIMED artifact as indeterminate. Promoting
 * into such a store would report success for a dead-on-arrival skill, so
 * promote refuses BEFORE writing anything. The store size is injected through
 * promote's `countCandidateRecords` seam (writing ~1000 real files is slow on
 * Windows); the DEFAULT seam is exercised against a small real directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import { MAX_PROMOTION_RECORD_FILES } from '../../../src/services/external-skill-identity.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	external_skill_promote,
	_internals as promoteInternals,
} from '../../../src/tools/external-skill-promote.js';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const BODY = 'Safe skill body with no dangerous patterns for store-cap tests.';
const originalCount = promoteInternals.countCandidateRecords;

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

async function seed(directory: string): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	return store.add({
		source_url: 'https://example.com/skill',
		source_type: 'github',
		publisher: 'example',
		sha256: sha256(BODY),
		fetched_at: withFrozenClock(
			() => new Date(Date.now() - 60_000).toISOString(),
			{ fixedNow: Date.now() },
		),
		skill_name: 'cap-skill',
		skill_body: BODY,
		risk_flags: [],
		evaluation_verdict: 'passed',
		evaluation_history: [],
	});
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

describe('external_skill_promote — candidate store over the verifier scan cap (closeout round)', () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-promote-cap-');
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
	});

	afterEach(() => {
		promoteInternals.countCandidateRecords = originalCount;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('a store above the scan cap is refused before anything is written', async () => {
		const candidate = await seed(projectDir);
		promoteInternals.countCandidateRecords = async () =>
			MAX_PROMOTION_RECORD_FILES + 1;

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'cap-slug', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('MAX_PROMOTION_RECORD_FILES');
		expect(fs.existsSync(artifactPath(projectDir, 'cap-slug'))).toBe(false);

		const store = createExternalSkillStore(projectDir, { max_candidates: 500 });
		expect((await store.get(candidate.id))?.evaluation_verdict).toBe('passed');
	});

	test('a store exactly AT the cap still promotes', async () => {
		const candidate = await seed(projectDir);
		promoteInternals.countCandidateRecords = async () =>
			MAX_PROMOTION_RECORD_FILES;

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'cap-slug', approver: 'user' },
			projectDir,
		);
		expect(JSON.parse(raw).success, raw).toBe(true);
		expect(fs.existsSync(artifactPath(projectDir, 'cap-slug'))).toBe(true);
	});

	test('default countCandidateRecords: ENOENT => 0, counts only *.json, other failures propagate', async () => {
		const count = originalCount;
		expect(await count(projectDir)).toBe(0);

		const store = path.join(projectDir, '.swarm', 'skills', 'candidates');
		fs.mkdirSync(store, { recursive: true });
		fs.writeFileSync(path.join(store, 'a.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(store, 'b.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(store, 'notes.txt'), 'x', 'utf-8');
		expect(await count(projectDir)).toBe(2);

		// A store path that is a FILE (not a directory) is a non-ENOENT failure
		// (ENOTDIR): it must propagate, not be mistaken for an empty store.
		const brokenProject = canonicalMkdtemp('ext-skill-promote-cap-broken-');
		try {
			const swarmSkills = path.join(brokenProject, '.swarm', 'skills');
			fs.mkdirSync(swarmSkills, { recursive: true });
			fs.writeFileSync(path.join(swarmSkills, 'candidates'), 'x', 'utf-8');
			await expect(count(brokenProject)).rejects.toBeDefined();
		} finally {
			fs.rmSync(brokenProject, { recursive: true, force: true });
		}
	});
});
