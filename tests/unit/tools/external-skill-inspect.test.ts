/**
 * Tests for external-skill-inspect tool.
 *
 * Uses _internals DI seam for config injection — no mock.module leakage.
 * Uses real temp directories for store I/O via createExternalSkillStore.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	_internals,
	external_skill_inspect,
} from '../../../src/tools/external-skill-inspect.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call the tool's execute function with a directory context.
 *
 * createSwarmTool wraps tool() from @opencode-ai/plugin, which calls
 * execute as (args, ctx). The directory is injected via ctx.directory.
 */
async function callTool(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_inspect as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

/** Create a temp directory for test store state. */
async function createTempDir(): Promise<string> {
	const tmpBase = os.tmpdir();
	const tmpDir = path.join(
		tmpBase,
		`ext-skill-inspect-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

/** Seed the store with a candidate and return the candidate record. */
async function seedCandidate(
	directory: string,
	overrides: {
		source_url?: string;
		source_type?: string;
		publisher?: string;
		skill_name?: string;
		skill_description?: string;
		evaluation_verdict?: string;
		risk_flags?: string[];
		skill_body?: string;
		evaluation_history?: Array<{
			verdict: string;
			timestamp: string;
			actor: string;
			reason?: string;
		}>;
	} = {},
): Promise<{ id: string }> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const candidate = {
		source_url: overrides.source_url ?? 'https://example.com/skill.md',
		source_type: (overrides.source_type ?? 'github') as 'github',
		publisher: overrides.publisher ?? 'test-publisher',
		sha256: 'a'.repeat(64),
		fetched_at: '2026-01-15T12:00:00.000Z',
		skill_name: overrides.skill_name,
		skill_description: overrides.skill_description,
		skill_body: overrides.skill_body ?? 'Full skill body content.',
		risk_flags: overrides.risk_flags ?? ['prompt_injection'],
		evaluation_verdict: (overrides.evaluation_verdict ??
			'quarantined') as 'quarantined',
		evaluation_history: overrides.evaluation_history ?? [
			{
				verdict: 'quarantined',
				timestamp: '2026-01-15T12:00:00.000Z',
				actor: 'system',
				reason: 'Validation: 3 gates, 1 findings',
			},
		],
	};
	const stored = await store.add(candidate);
	return { id: stored.id };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('external_skill_inspect', () => {
	let tmpDir: string;

	// Save originals for restore
	let originalLoadConfig: typeof _internals.loadConfig;

	beforeEach(async () => {
		tmpDir = await createTempDir();
		originalLoadConfig = _internals.loadConfig;
	});

	afterEach(async () => {
		_internals.loadConfig = originalLoadConfig;
		await removeTempDir(tmpDir);
	});

	// -------------------------------------------------------------------------
	// Test 1: Returns disabled message when curation_enabled=false
	// -------------------------------------------------------------------------
	test('returns disabled message when curation_enabled is false', async () => {
		await writeTestConfig(tmpDir, { curation_enabled: false });

		const result = await callTool({ candidate_id: 'any-id' }, tmpDir);

		expect(result).toBe(
			'External skill curation is not enabled. Set external_skills.curation_enabled to true in your opencode config.',
		);
	});

	// -------------------------------------------------------------------------
	// Test 2: Returns full candidate record by ID
	// -------------------------------------------------------------------------
	test('returns full candidate record by ID', async () => {
		await writeTestConfig(tmpDir);

		const { id } = await seedCandidate(tmpDir, {
			publisher: 'alice',
			skill_name: 'review-skill',
			skill_description: 'A code review skill',
			skill_body: 'Detailed skill body content here.',
			risk_flags: ['prompt_injection', 'unsafe_instructions'],
			evaluation_verdict: 'quarantined',
			evaluation_history: [
				{
					verdict: 'quarantined',
					timestamp: '2026-01-15T12:00:00.000Z',
					actor: 'system',
					reason: 'Validation: 3 gates, 2 findings',
				},
			],
		});

		const result = JSON.parse(await callTool({ candidate_id: id }, tmpDir));

		expect(result.id).toBe(id);
		expect(result.source_url).toBe('https://example.com/skill.md');
		expect(result.source_type).toBe('github');
		expect(result.publisher).toBe('alice');
		expect(result.skill_name).toBe('review-skill');
		expect(result.skill_description).toBe('A code review skill');
		expect(result.sha256).toBe('a'.repeat(64));
		expect(result.fetched_at).toBe('2026-01-15T12:00:00.000Z');
		expect(result.evaluation_verdict).toBe('quarantined');
		expect(result.risk_flags).toEqual([
			'prompt_injection',
			'unsafe_instructions',
		]);
	});

	// -------------------------------------------------------------------------
	// Test 3: Returns error for non-existent ID
	// -------------------------------------------------------------------------
	test('returns error for non-existent candidate ID', async () => {
		await writeTestConfig(tmpDir);

		// Use a valid UUID format but one that doesn't exist in the store
		const fakeId = '00000000-0000-4000-a000-000000000099';
		const result = JSON.parse(await callTool({ candidate_id: fakeId }, tmpDir));

		expect(result.success).toBe(false);
		expect(result.error).toBe('Candidate not found');
	});

	// -------------------------------------------------------------------------
	// Test 4: Returns error for missing candidate_id
	// -------------------------------------------------------------------------
	test('returns error when candidate_id is missing', async () => {
		await writeTestConfig(tmpDir);

		const result = JSON.parse(await callTool({}, tmpDir));

		expect(result.success).toBe(false);
		expect(result.error).toContain('candidate_id');
	});

	test('returns error when candidate_id is empty string', async () => {
		await writeTestConfig(tmpDir);

		const result = JSON.parse(await callTool({ candidate_id: '' }, tmpDir));

		expect(result.success).toBe(false);
		expect(result.error).toContain('candidate_id');
	});

	// -------------------------------------------------------------------------
	// Test 5: Includes skill_body and evaluation_history in response
	// -------------------------------------------------------------------------
	test('includes skill_body and evaluation_history in response', async () => {
		await writeTestConfig(tmpDir);

		const { id } = await seedCandidate(tmpDir, {
			skill_body: 'This is the complete skill body content.',
			evaluation_history: [
				{
					verdict: 'pending',
					timestamp: '2026-01-14T10:00:00.000Z',
					actor: 'user',
					reason: 'Initial submission',
				},
				{
					verdict: 'quarantined',
					timestamp: '2026-01-15T12:00:00.000Z',
					actor: 'system',
					reason: 'Validation: prompt injection detected',
				},
			],
		});

		const result = JSON.parse(await callTool({ candidate_id: id }, tmpDir));

		expect(result.skill_body).toBe('This is the complete skill body content.');
		expect(Array.isArray(result.evaluation_history)).toBe(true);
		expect(result.evaluation_history).toHaveLength(2);
		expect(result.evaluation_history[0].verdict).toBe('pending');
		expect(result.evaluation_history[0].actor).toBe('user');
		expect(result.evaluation_history[1].verdict).toBe('quarantined');
		expect(result.evaluation_history[1].actor).toBe('system');
	});

	// -------------------------------------------------------------------------
	// Test 6: Error when config fails to load
	// -------------------------------------------------------------------------
	test('returns error when config fails to load', async () => {
		_internals.loadConfig = () => {
			throw new Error('Config load failure');
		};

		const result = JSON.parse(
			await callTool({ candidate_id: 'some-id' }, tmpDir),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Failed to load plugin configuration');
	});
});
