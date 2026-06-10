/**
 * Tests for external-skill-revoke tool.
 *
 * Uses _internals DI seam for config and file-system injection — no
 * mock.module leakage.  Uses real temp directories for store I/O via
 * createExternalSkillStore.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	_internals,
	external_skill_revoke,
} from '../../../src/tools/external-skill-revoke.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call the tool's execute function with a directory context.
 */
async function callTool(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_revoke as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

/** Create a temp directory for test store state. */
async function createTempDir(): Promise<string> {
	const tmpBase = os.tmpdir();
	const tmpDir = path.join(
		tmpBase,
		`ext-skill-revoke-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	await fs.mkdir(tmpDir, { recursive: true });
	return tmpDir;
}

/** Remove a temp directory recursively. */
async function removeTempDir(tmpDir: string): Promise<void> {
	try {
		await fs.rm(tmpDir, { force: true, recursive: true });
	} catch {
		// Best-effort cleanup
	}
}

/** Create a .opencode/opencode-swarm.json config file with external_skills enabled. */
async function writeTestConfig(
	directory: string,
	overrides?: Record<string, unknown>,
): Promise<void> {
	const configDir = path.join(directory, '.opencode');
	await fs.mkdir(configDir, { recursive: true });

	const defaultConfig = {
		external_skills: {
			curation_enabled: true,
			max_candidates: 500,
			max_bytes_per_candidate: 1048576,
			eviction_policy: 'fifo',
			ttl_days: 90,
			evaluation_enabled: true,
			sources: [],
			max_candidates_per_discovery: 50,
			max_concurrent_fetches: 5,
			fetch_timeout_ms: 30000,
			...(overrides ?? {}),
		},
	};

	await fs.writeFile(
		path.join(configDir, 'opencode-swarm.json'),
		JSON.stringify(defaultConfig, null, 2),
		'utf-8',
	);
}

/**
 * Seed the store with a candidate in a given state and optionally write
 * the promoted SKILL.md file under .opencode/skills/generated/<slug>/.
 */
async function seedCandidate(
	directory: string,
	overrides: {
		evaluation_verdict?: string;
		evaluation_history?: Array<{
			verdict: string;
			timestamp: string;
			actor: string;
			reason?: string;
		}>;
		slug?: string;
	},
): Promise<{ candidate: ExternalSkillCandidate; skillPath: string }> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const slug = overrides.slug ?? 'test-skill';

	const candidate = await store.add({
		source_url: 'https://example.com/skill.md',
		source_type: 'github',
		publisher: 'test-publisher',
		sha256: 'a'.repeat(64),
		fetched_at: '2026-01-15T12:00:00.000Z',
		skill_name: 'test-skill',
		skill_body: 'Skill body content.',
		risk_flags: [],
		evaluation_verdict: (overrides.evaluation_verdict ??
			'pending') as ExternalSkillCandidate['evaluation_verdict'],
		evaluation_history: overrides.evaluation_history ?? [],
	});

	const skillPath = path.join(
		directory,
		'.opencode',
		'skills',
		'generated',
		slug,
		'SKILL.md',
	);

	return { candidate, skillPath };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('external_skill_revoke', () => {
	let tmpDir: string;

	let originalLoadConfig: typeof _internals.loadConfig;
	let originalRetireSkillFile: typeof _internals.retireSkillFile;
	let originalGetTimestamp: typeof _internals.getTimestamp;

	beforeEach(async () => {
		tmpDir = await createTempDir();
		originalLoadConfig = _internals.loadConfig;
		originalRetireSkillFile = _internals.retireSkillFile;
		originalGetTimestamp = _internals.getTimestamp;
	});

	afterEach(async () => {
		_internals.loadConfig = originalLoadConfig;
		_internals.retireSkillFile = originalRetireSkillFile;
		_internals.getTimestamp = originalGetTimestamp;
		await removeTempDir(tmpDir);
	});

	// -------------------------------------------------------------------------
	// Test 1: Returns disabled message when curation_enabled=false
	// -------------------------------------------------------------------------
	test('returns disabled message when curation_enabled is false', async () => {
		await writeTestConfig(tmpDir, { curation_enabled: false });

		const result = await callTool(
			{ candidate_id: 'some-id', reason: 'bad skill' },
			tmpDir,
		);

		expect(result).toBe(
			'External skill curation is not enabled. Set external_skills.curation_enabled to true in your opencode config.',
		);
	});

	// -------------------------------------------------------------------------
	// Test 2: Successfully revokes a promoted candidate, deletes SKILL.md
	// -------------------------------------------------------------------------
	test('successfully revokes a promoted candidate and deletes SKILL.md', async () => {
		await writeTestConfig(tmpDir);

		// Seed with a promoted candidate whose history references the slug
		const { candidate } = await seedCandidate(tmpDir, {
			evaluation_verdict: 'promoted',
			evaluation_history: [
				{
					verdict: 'passed',
					timestamp: '2026-01-15T12:01:00.000Z',
					actor: 'system',
					reason: 'Validation passed',
				},
				{
					verdict: 'promoted',
					timestamp: '2026-01-15T12:02:00.000Z',
					actor: 'user',
					reason:
						'Promoted to .opencode/skills/generated/test-skill/SKILL.md — re-validation passed',
				},
			],
			slug: 'test-skill',
		});

		// Write the SKILL.md so the revoke can delete it
		const skillPath = path.join(
			tmpDir,
			'.opencode',
			'skills',
			'generated',
			'test-skill',
			'SKILL.md',
		);
		await fs.mkdir(path.dirname(skillPath), { recursive: true });
		await fs.writeFile(skillPath, 'skill content', 'utf-8');

		const result = JSON.parse(
			await callTool(
				{ candidate_id: candidate.id, reason: 'Contains harmful instructions' },
				tmpDir,
			),
		);

		expect(result.success).toBe(true);
		expect(result.candidate_id).toBe(candidate.id);
		expect(result.evaluation_verdict).toBe('revoked');
		expect(result.skill_file_removed).toBe(true);

		// Verify SKILL.md is gone
		const exists = await fs
			.access(skillPath, fs.constants.F_OK)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(false);

		// Verify store state
		const store = createExternalSkillStore(tmpDir, { max_candidates: 500 });
		const updated = await store.get(candidate.id);
		expect(updated).not.toBeNull();
		expect(updated!.evaluation_verdict).toBe('revoked');
	});

	// -------------------------------------------------------------------------
	// Test 3: Rejects if candidate is not 'promoted' (e.g. 'passed')
	// -------------------------------------------------------------------------
	test('rejects revocation of a non-promoted candidate', async () => {
		await writeTestConfig(tmpDir);

		const { candidate } = await seedCandidate(tmpDir, {
			evaluation_verdict: 'passed',
			evaluation_history: [
				{
					verdict: 'passed',
					timestamp: '2026-01-15T12:01:00.000Z',
					actor: 'system',
					reason: 'Validation passed',
				},
			],
		});

		const result = JSON.parse(
			await callTool(
				{ candidate_id: candidate.id, reason: 'should not matter' },
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Only promoted candidates can be revoked');
	});

	// -------------------------------------------------------------------------
	// Test 4: Returns error for non-existent candidate_id
	// -------------------------------------------------------------------------
	test('returns error for non-existent candidate_id', async () => {
		await writeTestConfig(tmpDir);

		const result = JSON.parse(
			await callTool(
				{
					candidate_id: '00000000-0000-4000-a000-000000000000',
					reason: 'does not matter',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Candidate not found');
	});

	// -------------------------------------------------------------------------
	// Test 5: Returns error for missing candidate_id
	// -------------------------------------------------------------------------
	test('returns error when candidate_id is missing', async () => {
		await writeTestConfig(tmpDir);

		const result = JSON.parse(
			await callTool({ reason: 'some reason' }, tmpDir),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('candidate_id');
	});

	// -------------------------------------------------------------------------
	// Test 6: Returns error for missing reason
	// -------------------------------------------------------------------------
	test('returns error when reason is missing', async () => {
		await writeTestConfig(tmpDir);

		const result = JSON.parse(
			await callTool({ candidate_id: 'some-id' }, tmpDir),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('reason');
	});

	// -------------------------------------------------------------------------
	// Test 7: Handles already-deleted SKILL.md gracefully (ENOENT)
	// -------------------------------------------------------------------------
	test('handles already-deleted SKILL.md gracefully', async () => {
		await writeTestConfig(tmpDir);

		// Seed a promoted candidate but do NOT write the SKILL.md
		const { candidate } = await seedCandidate(tmpDir, {
			evaluation_verdict: 'promoted',
			evaluation_history: [
				{
					verdict: 'promoted',
					timestamp: '2026-01-15T12:02:00.000Z',
					actor: 'user',
					reason:
						'Promoted to .opencode/skills/generated/test-skill/SKILL.md — re-validation passed',
				},
			],
			slug: 'test-skill',
		});

		// Mock retireSkillFile to return false (simulating ENOENT handled)
		_internals.retireSkillFile = async (
			_filePath: string,
		): Promise<boolean> => {
			return false;
		};

		const result = JSON.parse(
			await callTool(
				{ candidate_id: candidate.id, reason: 'Already removed manually' },
				tmpDir,
			),
		);

		expect(result.success).toBe(true);
		expect(result.candidate_id).toBe(candidate.id);
		expect(result.evaluation_verdict).toBe('revoked');
		expect(result.skill_file_removed).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Test 8: Audit record added to evaluation_history
	// -------------------------------------------------------------------------
	test('adds audit record to evaluation_history with actor, reason, and timestamp', async () => {
		await writeTestConfig(tmpDir);

		const fixedTimestamp = '2026-06-09T10:30:00.000Z';
		_internals.getTimestamp = () => fixedTimestamp;

		const { candidate } = await seedCandidate(tmpDir, {
			evaluation_verdict: 'promoted',
			evaluation_history: [
				{
					verdict: 'promoted',
					timestamp: '2026-01-15T12:02:00.000Z',
					actor: 'user',
					reason:
						'Promoted to .opencode/skills/generated/test-skill/SKILL.md — re-validation passed',
				},
			],
			slug: 'test-skill',
		});

		await callTool(
			{ candidate_id: candidate.id, reason: 'Security vulnerability found' },
			tmpDir,
		);

		const store = createExternalSkillStore(tmpDir, { max_candidates: 500 });
		const updated = await store.get(candidate.id);
		expect(updated).not.toBeNull();

		// Find the user-actor revocation entry
		const revokeEntry = updated!.evaluation_history.find(
			(e) => e.actor === 'user' && e.verdict === 'revoked',
		);
		expect(revokeEntry).toBeDefined();
		expect(revokeEntry!.timestamp).toBe(fixedTimestamp);
		expect(revokeEntry!.reason).toContain(
			'Revoked: Security vulnerability found',
		);
		expect(revokeEntry!.reason).toContain('Skill file removed.');
	});

	// -------------------------------------------------------------------------
	// Test 9: Returns error when slug extraction fails (corrupted / path-traversal history)
	// -------------------------------------------------------------------------
	test('returns error when slug extraction fails from corrupted history', async () => {
		await writeTestConfig(tmpDir);

		// Seed a promoted candidate whose history reason contains a
		// path-traversal payload with backslashes — SAFE_SLUG_RE rejects it.
		const { candidate } = await seedCandidate(tmpDir, {
			evaluation_verdict: 'promoted',
			evaluation_history: [
				{
					verdict: 'promoted',
					timestamp: '2026-01-15T12:02:00.000Z',
					actor: 'user',
					reason:
						'Promoted to .opencode/skills/generated/..\\..\\target/SKILL.md — re-validation passed',
				},
			],
		});

		// Spy on retireSkillFile — it must NOT be called
		let retireCalled = false;
		_internals.retireSkillFile = async (
			_filePath: string,
		): Promise<boolean> => {
			retireCalled = true;
			return true;
		};

		const result = JSON.parse(
			await callTool(
				{ candidate_id: candidate.id, reason: 'Path traversal test' },
				tmpDir,
			),
		);

		// The tool must return an error because the slug cannot be extracted
		expect(result.success).toBe(false);
		expect(result.error).toContain('unable to determine the skill slug');
		expect(retireCalled).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Test 10: Returns error when promotion history is missing or has no promoted entry
	// -------------------------------------------------------------------------
	test('returns error when promotion history has no promoted entry', async () => {
		await writeTestConfig(tmpDir);

		// Seed a candidate marked as 'promoted' but with evaluation_history
		// that contains no 'promoted' verdict entry (corrupted state).
		const { candidate } = await seedCandidate(tmpDir, {
			evaluation_verdict: 'promoted',
			evaluation_history: [
				{
					verdict: 'passed',
					timestamp: '2026-01-15T12:01:00.000Z',
					actor: 'system',
					reason: 'Validation passed',
				},
			],
		});

		let retireCalled = false;
		_internals.retireSkillFile = async (
			_filePath: string,
		): Promise<boolean> => {
			retireCalled = true;
			return true;
		};

		const result = JSON.parse(
			await callTool(
				{ candidate_id: candidate.id, reason: 'Missing history test' },
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('unable to determine the skill slug');
		expect(retireCalled).toBe(false);

		// Verify the candidate is NOT stamped revoked — the error is returned
		// before any store mutation occurs.
		const store = createExternalSkillStore(tmpDir, { max_candidates: 500 });
		const unchanged = await store.get(candidate.id);
		expect(unchanged).not.toBeNull();
		expect(unchanged!.evaluation_verdict).toBe('promoted');
	});
});
