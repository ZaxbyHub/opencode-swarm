/**
 * Integration tests for the full discover → validate → promote → revoke lifecycle
 * of the external skill curation pipeline.
 *
 * Exercises all seven curation tools (discover, list, inspect, promote, revoke,
 * reject, delete) end-to-end, verifying state transitions and audit trails at
 * each step.  Also tests error paths: rejecting candidates, promoting rejected
 * candidates, double-promotion, and revoking non-existent SKILL.md files.
 *
 * Uses the _internals DI seam on all tools and the validator — no mock.module.
 * Uses os.tmpdir() + path.join() for all temp directories.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import {
	createExternalSkillStore,
	_internals as storeInternals,
} from '../../../src/services/external-skill-store.js';
import { _internals as validatorInternals } from '../../../src/services/external-skill-validator.js';
import { external_skill_delete } from '../../../src/tools/external-skill-delete.js';
import {
	_internals as discoverInternals,
	external_skill_discover,
} from '../../../src/tools/external-skill-discover.js';
import { external_skill_inspect } from '../../../src/tools/external-skill-inspect.js';
import { external_skill_list } from '../../../src/tools/external-skill-list.js';
import {
	external_skill_promote,
	_internals as promoteInternals,
} from '../../../src/tools/external-skill-promote.js';
import { external_skill_reject } from '../../../src/tools/external-skill-reject.js';
import {
	external_skill_revoke,
	_internals as revokeInternals,
} from '../../../src/tools/external-skill-revoke.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Call any tool's execute function with a directory context. */
async function callTool(
	tool: unknown,
	args: unknown,
	directory: string,
): Promise<string> {
	return (
		tool as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

/** Create a unique temp directory for this test run. */
async function createTempDir(prefix: string): Promise<string> {
	const tmpDir = path.join(
		os.tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	await fs.mkdir(tmpDir, { recursive: true });
	return tmpDir;
}

/** Remove a temp directory recursively (best-effort). */
async function removeTempDir(tmpDir: string): Promise<void> {
	try {
		await fs.rm(tmpDir, { force: true, recursive: true });
	} catch {
		// Best-effort cleanup
	}
}

/** Write a test opencode-swarm.json config with external_skills enabled. */
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

/** Compute SHA-256 hash for content. */
function computeHash(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

/** Seed a candidate directly into the store, bypassing validation. */
async function seedCandidate(
	directory: string,
	overrides: Partial<Omit<ExternalSkillCandidate, 'id'>> = {},
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const skillBody = overrides.skill_body ?? 'Safe skill body content.';
	const sha256 = overrides.sha256 ?? computeHash(skillBody);
	const fetchedAt = overrides.fetched_at ?? '2026-06-09T12:00:00.000Z';
	return store.add({
		source_url: 'https://example.com/skill.md',
		source_type: 'github',
		publisher: 'test-publisher',
		risk_flags: [],
		evaluation_history: [],
		...overrides,
		sha256,
		fetched_at: fetchedAt,
		skill_body: skillBody,
	} as Omit<ExternalSkillCandidate, 'id'>);
}

/** Deterministic timestamp for all tests. */
const FIXED_TIMESTAMP = '2026-06-09T12:00:00.000Z';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('external skill lifecycle — discover to delete happy path', () => {
	let tmpDir: string;
	let writtenFilePath: string | null;
	let writtenFileContent: string | null;

	// Saved originals for all tool _internals
	let origDiscoverFetchContent: typeof discoverInternals.fetchContent;
	let origDiscoverTimestamp: typeof discoverInternals.getTimestamp;
	let origDiscoverSha256: typeof discoverInternals.computeSha256;
	let origDiscoverUuid: typeof discoverInternals.uuid;
	let origValidatorSha256: typeof validatorInternals.computeSha256;
	let origValidatorTimestamp: typeof validatorInternals.getTimestamp;
	let origPromoteWriteSkillFile: typeof promoteInternals.writeSkillFile;
	let origPromoteTimestamp: typeof promoteInternals.getTimestamp;
	let origPromoteFileExists: typeof promoteInternals.fileExists;
	let origRevokeTimestamp: typeof revokeInternals.getTimestamp;
	let origStoreRandomUUID: typeof storeInternals.randomUUID;

	beforeAll(async () => {
		tmpDir = await createTempDir('lifecycle-happy');
		writtenFilePath = null;
		writtenFileContent = null;

		// Save originals
		origDiscoverFetchContent = discoverInternals.fetchContent;
		origDiscoverTimestamp = discoverInternals.getTimestamp;
		origDiscoverSha256 = discoverInternals.computeSha256;
		origDiscoverUuid = discoverInternals.uuid;
		origValidatorSha256 = validatorInternals.computeSha256;
		origValidatorTimestamp = validatorInternals.getTimestamp;
		origPromoteWriteSkillFile = promoteInternals.writeSkillFile;
		origPromoteTimestamp = promoteInternals.getTimestamp;
		origPromoteFileExists = promoteInternals.fileExists;
		origRevokeTimestamp = revokeInternals.getTimestamp;
		origStoreRandomUUID = storeInternals.randomUUID;

		// Write config file
		await writeTestConfig(tmpDir);

		// Discover overrides — mock fetchContent, deterministic hash/timestamp
		discoverInternals.fetchContent = async () => ({
			content: 'Safe skill body content for integration test.',
			finalUrl: 'https://github.com/example/skill',
		});
		discoverInternals.computeSha256 = () =>
			computeHash('Safe skill body content for integration test.');
		discoverInternals.getTimestamp = () => FIXED_TIMESTAMP;
		discoverInternals.uuid = () => '00000000-0000-4000-a000-000000000001';

		// Store UUID — this is what actually generates the candidate ID
		storeInternals.randomUUID = () => '00000000-0000-4000-a000-000000000001';

		// Validator overrides — must match discover's hash and timestamp
		validatorInternals.computeSha256 = () =>
			computeHash('Safe skill body content for integration test.');
		validatorInternals.getTimestamp = () => FIXED_TIMESTAMP;

		// Promote overrides — capture SKILL.md write to temp dir
		promoteInternals.writeSkillFile = async (
			filePath: string,
			content: string,
		): Promise<void> => {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content, 'utf-8');
			writtenFilePath = filePath;
			writtenFileContent = content;
		};
		promoteInternals.fileExists = async (
			filePath: string,
		): Promise<boolean> => {
			try {
				await fs.access(filePath, fs.constants.F_OK);
				return true;
			} catch {
				return false;
			}
		};
		promoteInternals.getTimestamp = () => FIXED_TIMESTAMP;

		// Revoke timestamp
		revokeInternals.getTimestamp = () => FIXED_TIMESTAMP;
	});

	afterAll(async () => {
		// Restore all _internals
		discoverInternals.fetchContent = origDiscoverFetchContent;
		discoverInternals.getTimestamp = origDiscoverTimestamp;
		discoverInternals.computeSha256 = origDiscoverSha256;
		discoverInternals.uuid = origDiscoverUuid;
		validatorInternals.computeSha256 = origValidatorSha256;
		validatorInternals.getTimestamp = origValidatorTimestamp;
		promoteInternals.writeSkillFile = origPromoteWriteSkillFile;
		promoteInternals.getTimestamp = origPromoteTimestamp;
		promoteInternals.fileExists = origPromoteFileExists;
		revokeInternals.getTimestamp = origRevokeTimestamp;
		storeInternals.randomUUID = origStoreRandomUUID;

		await removeTempDir(tmpDir);
	});

	// Step 1: DISCOVER — fetch a skill, run validation, store in quarantine
	test('step 1: discover stores a quarantined candidate', async () => {
		const result = JSON.parse(
			await callTool(
				external_skill_discover,
				{
					source_type: 'github',
					source_url: 'https://github.com/example/skill',
					publisher: 'example-publisher',
					skill_name: 'example-skill',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(true);
		expect(result.candidate_id).toBe('00000000-0000-4000-a000-000000000001');
		expect(result.evaluation_verdict).toBe('passed');
		expect(result.gate_results).toBeDefined();
		expect(result.gate_results.length).toBe(3);
	});

	// Step 2: LIST — verify candidate appears with correct verdict
	test('step 2: list shows candidate in store', async () => {
		const result = JSON.parse(await callTool(external_skill_list, {}, tmpDir));

		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBe(1);
		expect(result[0].id).toBe('00000000-0000-4000-a000-000000000001');
		expect(result[0].source_type).toBe('github');
		expect(result[0].publisher).toBe('example-publisher');
	});

	// Step 3: INSPECT — verify full candidate details
	test('step 3: inspect returns full candidate record', async () => {
		const result = JSON.parse(
			await callTool(
				external_skill_inspect,
				{ candidate_id: '00000000-0000-4000-a000-000000000001' },
				tmpDir,
			),
		);

		expect(result.success !== false).toBe(true);
		expect(result.id).toBe('00000000-0000-4000-a000-000000000001');
		expect(result.skill_body).toBe(
			'Safe skill body content for integration test.',
		);
		expect(result.source_url).toBe('https://github.com/example/skill');
		expect(result.publisher).toBe('example-publisher');
		expect(result.evaluation_history.length).toBeGreaterThanOrEqual(1);
		expect(result.evaluation_history[0].verdict).toBe('passed');
		expect(result.evaluation_history[0].actor).toBe('system');
		expect(result.evaluation_history[0].gate_results).toBeDefined();
	});

	// Step 4: PROMOTE — re-validate, approve, write SKILL.md
	test('step 4: promote writes SKILL.md to target directory', async () => {
		const result = JSON.parse(
			await callTool(
				external_skill_promote,
				{
					candidate_id: '00000000-0000-4000-a000-000000000001',
					slug: 'example-skill',
					approver: 'user',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(true);
		expect(result.evaluation_verdict).toBe('promoted');
		expect(result.slug).toBe('example-skill');
		expect(writtenFilePath).toContain('example-skill');
		expect(writtenFilePath).toMatch(/SKILL\.md$/);
		expect(writtenFileContent).toContain(
			'promoted_from: external-skill-candidate',
		);
		expect(writtenFileContent).toContain('slug: example-skill');
		expect(writtenFileContent).toContain(
			'Safe skill body content for integration test.',
		);
	});

	// Step 5: VERIFY PROMOTED — check SKILL.md exists on disk with correct content
	test('step 5: verify SKILL.md exists with correct content and frontmatter', async () => {
		expect(writtenFilePath).not.toBeNull();
		const raw = await fs.readFile(writtenFilePath!, 'utf-8');
		expect(raw).toContain('---');
		expect(raw).toContain('promoted_from: external-skill-candidate');
		expect(raw).toContain('publisher: example-publisher');
		expect(raw).toContain('promoted_by: user');
		expect(raw).toContain('Safe skill body content for integration test.');
	});

	// Step 6: LIST AGAIN — verify candidate status changed to promoted
	test('step 6: list shows promoted status', async () => {
		const result = JSON.parse(await callTool(external_skill_list, {}, tmpDir));

		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBe(1);
		expect(result[0].evaluation_verdict).toBe('promoted');
	});

	// Step 7: REVOKE — retire the SKILL.md, stamp as revoked
	test('step 7: revoke removes SKILL.md and stamps candidate revoked', async () => {
		expect(writtenFilePath).not.toBeNull();

		const result = JSON.parse(
			await callTool(
				external_skill_revoke,
				{
					candidate_id: '00000000-0000-4000-a000-000000000001',
					reason: 'Security review found unsafe pattern',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(true);
		expect(result.evaluation_verdict).toBe('revoked');
		expect(result.skill_file_removed).toBe(true);
	});

	// Step 8: VERIFY REVOKED — SKILL.md gone, status is revoked
	test('step 8: verify SKILL.md gone and status is revoked', async () => {
		expect(writtenFilePath).not.toBeNull();
		const exists = await fs
			.access(writtenFilePath!, fs.constants.F_OK)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(false);

		const inspectResult = JSON.parse(
			await callTool(
				external_skill_inspect,
				{ candidate_id: '00000000-0000-4000-a000-000000000001' },
				tmpDir,
			),
		);
		expect(inspectResult.evaluation_verdict).toBe('revoked');

		// Verify audit trail has both promoted and revoked entries
		const verdicts = inspectResult.evaluation_history.map(
			(e: { verdict: string }) => e.verdict,
		);
		expect(verdicts).toContain('promoted');
		expect(verdicts).toContain('revoked');
	});

	// Step 9: DELETE — remove candidate from store
	test('step 9: delete removes the revoked candidate', async () => {
		const deleteResult = JSON.parse(
			await callTool(
				external_skill_delete,
				{ candidate_id: '00000000-0000-4000-a000-000000000001' },
				tmpDir,
			),
		);

		expect(deleteResult.success).toBe(true);
		expect(deleteResult.deleted).toBe(true);

		// Verify candidate is gone
		const listResult = JSON.parse(
			await callTool(external_skill_list, {}, tmpDir),
		);
		expect(listResult.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Error lifecycle tests
// ---------------------------------------------------------------------------

describe('external skill lifecycle — error paths', () => {
	let tmpDir: string;

	// Saved originals
	let origPromoteTimestamp: typeof promoteInternals.getTimestamp;
	let origPromoteFileExists: typeof promoteInternals.fileExists;
	let origPromoteWriteSkillFile: typeof promoteInternals.writeSkillFile;
	let origRevokeTimestamp: typeof revokeInternals.getTimestamp;
	let origValidatorSha256: typeof validatorInternals.computeSha256;
	let origValidatorTimestamp: typeof validatorInternals.getTimestamp;

	beforeEach(async () => {
		tmpDir = await createTempDir('lifecycle-error');

		origPromoteTimestamp = promoteInternals.getTimestamp;
		origPromoteFileExists = promoteInternals.fileExists;
		origPromoteWriteSkillFile = promoteInternals.writeSkillFile;
		origRevokeTimestamp = revokeInternals.getTimestamp;
		origValidatorSha256 = validatorInternals.computeSha256;
		origValidatorTimestamp = validatorInternals.getTimestamp;

		await writeTestConfig(tmpDir);

		// Fixed timestamps
		promoteInternals.getTimestamp = () => FIXED_TIMESTAMP;
		revokeInternals.getTimestamp = () => FIXED_TIMESTAMP;
		validatorInternals.computeSha256 = (content: string) =>
			computeHash(content);
		validatorInternals.getTimestamp = () => FIXED_TIMESTAMP;

		// Promote: write SKILL.md to real temp dir
		promoteInternals.writeSkillFile = async (
			filePath: string,
			content: string,
		): Promise<void> => {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content, 'utf-8');
		};
		promoteInternals.fileExists = async (
			filePath: string,
		): Promise<boolean> => {
			try {
				await fs.access(filePath, fs.constants.F_OK);
				return true;
			} catch {
				return false;
			}
		};
	});

	afterEach(async () => {
		promoteInternals.getTimestamp = origPromoteTimestamp;
		promoteInternals.fileExists = origPromoteFileExists;
		promoteInternals.writeSkillFile = origPromoteWriteSkillFile;
		revokeInternals.getTimestamp = origRevokeTimestamp;
		validatorInternals.computeSha256 = origValidatorSha256;
		validatorInternals.getTimestamp = origValidatorTimestamp;

		await removeTempDir(tmpDir);
	});

	test('reject persists the rejection reason in evaluation_history', async () => {
		const candidate = await seedCandidate(tmpDir, {
			evaluation_verdict: 'quarantined',
		});

		const result = JSON.parse(
			await callTool(
				external_skill_reject,
				{
					candidate_id: candidate.id,
					reason: 'Failed security audit — prompt injection patterns detected',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(true);
		expect(result.evaluation_verdict).toBe('rejected');
		expect(result.candidate_id).toBe(candidate.id);

		// Verify the rejection reason is persisted in history
		const store = createExternalSkillStore(tmpDir, { max_candidates: 500 });
		const updated = await store.get(candidate.id);
		expect(updated).not.toBeNull();
		expect(updated!.evaluation_verdict).toBe('rejected');
		expect(updated!.evaluation_history.length).toBeGreaterThanOrEqual(1);
		const lastEntry =
			updated!.evaluation_history[updated!.evaluation_history.length - 1];
		expect(lastEntry.verdict).toBe('rejected');
		expect(lastEntry.actor).toBe('user');
		expect(lastEntry.reason).toBe(
			'Failed security audit — prompt injection patterns detected',
		);
	});

	test('promoting a rejected candidate fails with error', async () => {
		const candidate = await seedCandidate(tmpDir, {
			evaluation_verdict: 'rejected',
			evaluation_history: [
				{
					verdict: 'rejected',
					timestamp: FIXED_TIMESTAMP,
					actor: 'user',
					reason: 'Security audit failure',
				},
			],
		});

		const result = JSON.parse(
			await callTool(
				external_skill_promote,
				{
					candidate_id: candidate.id,
					slug: 'rejected-skill',
					approver: 'user',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('must be evaluated');
	});

	test('promoting an already-promoted candidate fails', async () => {
		// Seed a candidate with promoted verdict and a promotion history entry
		const candidate = await seedCandidate(tmpDir, {
			evaluation_verdict: 'promoted',
			evaluation_history: [
				{
					verdict: 'passed',
					timestamp: FIXED_TIMESTAMP,
					actor: 'system',
					reason: 'Validation passed',
				},
				{
					verdict: 'promoted',
					timestamp: FIXED_TIMESTAMP,
					actor: 'user',
					reason:
						'Promoted to .opencode/skills/generated/double-promote/SKILL.md — re-validation passed',
				},
			],
		});

		const result = JSON.parse(
			await callTool(
				external_skill_promote,
				{
					candidate_id: candidate.id,
					slug: 'double-promote',
					approver: 'user',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('must be evaluated');
	});

	test('revoking a non-promoted candidate fails', async () => {
		const candidate = await seedCandidate(tmpDir, {
			evaluation_verdict: 'passed',
		});

		const result = JSON.parse(
			await callTool(
				external_skill_revoke,
				{
					candidate_id: candidate.id,
					reason: 'Trying to revoke a non-promoted skill',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Only promoted candidates');
	});

	test('revoking a candidate with missing promotion history fails gracefully', async () => {
		// Seed a promoted candidate WITHOUT the promotion history entry
		// (simulates corrupted history)
		const candidate = await seedCandidate(tmpDir, {
			evaluation_verdict: 'promoted',
			evaluation_history: [],
		});

		const result = JSON.parse(
			await callTool(
				external_skill_revoke,
				{
					candidate_id: candidate.id,
					reason: 'Test corrupted history',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('unable to determine the skill slug');
	});

	test('full error lifecycle: reject then delete', async () => {
		const candidate = await seedCandidate(tmpDir, {
			evaluation_verdict: 'quarantined',
		});

		// Reject it
		const rejectResult = JSON.parse(
			await callTool(
				external_skill_reject,
				{
					candidate_id: candidate.id,
					reason: 'Does not meet quality standards',
				},
				tmpDir,
			),
		);
		expect(rejectResult.success).toBe(true);
		expect(rejectResult.evaluation_verdict).toBe('rejected');

		// Verify list shows rejected
		const listResult = JSON.parse(
			await callTool(external_skill_list, { verdict: 'rejected' }, tmpDir),
		);
		expect(listResult.length).toBe(1);
		expect(listResult[0].id).toBe(candidate.id);

		// Delete it
		const deleteResult = JSON.parse(
			await callTool(
				external_skill_delete,
				{ candidate_id: candidate.id },
				tmpDir,
			),
		);
		expect(deleteResult.success).toBe(true);
		expect(deleteResult.deleted).toBe(true);

		// Verify store is empty
		const finalList = JSON.parse(
			await callTool(external_skill_list, {}, tmpDir),
		);
		expect(finalList.length).toBe(0);
	});
});
