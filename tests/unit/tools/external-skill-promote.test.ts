/**
 * Tests for external-skill-promote tool.
 *
 * Uses _internals DI seam for config injection and file I/O — no mock.module leakage.
 * Uses real temp directories for store I/O via createExternalSkillStore.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	_internals,
	external_skill_promote,
} from '../../../src/tools/external-skill-promote.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call the tool's execute function with a directory context.
 */
async function callTool(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_promote as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

/** Create a temp directory for test store state. */
async function createTempDir(): Promise<string> {
	const tmpBase = os.tmpdir();
	const tmpDir = path.join(
		tmpBase,
		`ext-skill-promote-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

/** Seed the store with a candidate and return the created record. */
async function seedCandidate(
	directory: string,
	overrides: {
		evaluation_verdict?: string;
		evaluation_history?: Array<{
			verdict: string;
			timestamp: string;
			actor: string;
			reason?: string;
			gate_results?: Array<{ gate: string; verdict: string }>;
			risk_assessment?: {
				total_flags: number;
				findings: Array<{ severity: string; category: string }>;
			};
		}>;
		skill_body?: string;
		sha256?: string;
		fetched_at?: string;
	},
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const skillBody =
		overrides.skill_body ??
		'This is a safe skill body with no dangerous patterns.';

	// Compute correct SHA-256 if not overridden, so provenance_integrity gate passes
	let sha256 = overrides.sha256;
	if (sha256 === undefined) {
		const { createHash } = await import('node:crypto');
		sha256 = createHash('sha256').update(skillBody).digest('hex');
	}

	// Use a recent fetched_at so TTL gate passes
	const fetchedAt = overrides.fetched_at ?? '2026-06-08T12:00:00.000Z';

	return store.add({
		source_url: 'https://example.com/skill.md',
		source_type: 'github',
		publisher: 'test-publisher',
		sha256,
		fetched_at: fetchedAt,
		skill_name: 'test-skill',
		skill_body: skillBody,
		risk_flags: [],
		evaluation_verdict: (overrides.evaluation_verdict ??
			'passed') as ExternalSkillCandidate['evaluation_verdict'],
		evaluation_history: overrides.evaluation_history ?? [],
	});
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('external_skill_promote', () => {
	let tmpDir: string;
	let originalLoadConfig: typeof _internals.loadConfig;
	let originalWriteSkillFile: typeof _internals.writeSkillFile;
	let originalGetTimestamp: typeof _internals.getTimestamp;
	let originalFileExists: typeof _internals.fileExists;
	let writtenFilePath: string | null;
	let writtenFileContent: string | null;

	beforeEach(async () => {
		tmpDir = await createTempDir();
		originalLoadConfig = _internals.loadConfig;
		originalWriteSkillFile = _internals.writeSkillFile;
		originalGetTimestamp = _internals.getTimestamp;
		originalFileExists = _internals.fileExists;
		writtenFilePath = null;
		writtenFileContent = null;

		// Capture writes instead of hitting the real filesystem
		_internals.writeSkillFile = async (
			filePath: string,
			content: string,
		): Promise<void> => {
			writtenFilePath = filePath;
			writtenFileContent = content;
		};

		// Default: target path does not exist (so promotion proceeds)
		_internals.fileExists = async (_filePath: string): Promise<boolean> =>
			false;

		// Fixed timestamp for deterministic assertions
		_internals.getTimestamp = () => '2026-06-09T12:00:00.000Z';
	});

	afterEach(async () => {
		_internals.loadConfig = originalLoadConfig;
		_internals.writeSkillFile = originalWriteSkillFile;
		_internals.getTimestamp = originalGetTimestamp;
		_internals.fileExists = originalFileExists;
		await removeTempDir(tmpDir);
	});

	// -------------------------------------------------------------------------
	// Test 1: Returns disabled message when curation_enabled=false
	// -------------------------------------------------------------------------
	test('returns disabled message when curation_enabled is false', async () => {
		await writeTestConfig(tmpDir, { curation_enabled: false });

		const result = await callTool(
			{ candidate_id: 'some-id', slug: 'my-skill', approver: 'user' },
			tmpDir,
		);

		expect(result).toBe(
			'External skill curation is not enabled. Set external_skills.curation_enabled to true in your opencode config.',
		);
	});

	// -------------------------------------------------------------------------
	// Test 2: Successfully promotes a passed candidate
	// -------------------------------------------------------------------------
	test('successfully promotes a passed candidate and writes SKILL.md', async () => {
		await writeTestConfig(tmpDir);

		const candidate = await seedCandidate(tmpDir, {
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

		const result = JSON.parse(
			await callTool(
				{ candidate_id: candidate.id, slug: 'my-skill', approver: 'user' },
				tmpDir,
			),
		);

		expect(result.success).toBe(true);
		expect(result.candidate_id).toBe(candidate.id);
		expect(result.slug).toBe('my-skill');
		expect(result.evaluation_verdict).toBe('promoted');
		expect(result.target_path).toContain('my-skill');
		expect(result.target_path).toContain('SKILL.md');

		// Verify the file was "written" with the right content
		expect(writtenFilePath).toBe(result.target_path);
		expect(writtenFileContent).toContain(
			'promoted_from: external-skill-candidate',
		);
		expect(writtenFileContent).toContain(`candidate_id: ${candidate.id}`);

		// Verify the candidate was updated in the store
		const store = createExternalSkillStore(tmpDir, { max_candidates: 500 });
		const updated = await store.get(candidate.id);
		expect(updated).not.toBeNull();
		expect(updated!.evaluation_verdict).toBe('promoted');
	});

	// -------------------------------------------------------------------------
	// Test 3: TOCTOU — rejects if re-validation fails
	// -------------------------------------------------------------------------
	test('re-validates and rejects if candidate no longer passes gates', async () => {
		await writeTestConfig(tmpDir);

		// Seed with a candidate that was previously "passed" but whose sha256
		// does NOT match the current skill_body — the provenance_integrity gate
		// will catch this as content_hash_mismatch.
		const candidate = await seedCandidate(tmpDir, {
			evaluation_verdict: 'passed',
			evaluation_history: [
				{
					verdict: 'passed',
					timestamp: '2026-01-15T12:00:00.000Z',
					actor: 'system',
					reason: 'All gates passed',
				},
			],
			sha256: 'b'.repeat(64), // intentionally wrong hash
		});

		const result = JSON.parse(
			await callTool(
				{ candidate_id: candidate.id, slug: 'my-skill', approver: 'user' },
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe(
			'Re-validation failed — candidate no longer passes gates',
		);
	});

	// -------------------------------------------------------------------------
	// Test 4: Rejects if approver !== 'user'
	// -------------------------------------------------------------------------
	test('rejects if approver is not user', async () => {
		await writeTestConfig(tmpDir);

		const result = JSON.parse(
			await callTool(
				{ candidate_id: 'some-id', slug: 'my-skill', approver: 'agent' },
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Only user approval is allowed');
	});

	// -------------------------------------------------------------------------
	// Test 5: Returns error when candidate_id not found
	// -------------------------------------------------------------------------
	test('returns error when candidate is not found', async () => {
		await writeTestConfig(tmpDir);

		const result = JSON.parse(
			await callTool(
				{
					candidate_id: '00000000-0000-4000-a000-000000000000',
					slug: 'my-skill',
					approver: 'user',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Candidate not found');
	});

	// -------------------------------------------------------------------------
	// Test 6: Rejects if candidate is 'pending' (not yet evaluated)
	// -------------------------------------------------------------------------
	test('rejects if candidate is pending (not yet evaluated)', async () => {
		await writeTestConfig(tmpDir);

		const candidate = await seedCandidate(tmpDir, {
			evaluation_verdict: 'pending',
		});

		const result = JSON.parse(
			await callTool(
				{ candidate_id: candidate.id, slug: 'my-skill', approver: 'user' },
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Candidate must be evaluated before promotion');
	});

	// -------------------------------------------------------------------------
	// Test 7: Slug sanitization
	// -------------------------------------------------------------------------
	test('sanitizes slug: special chars to dashes, uppercase to lowercase', async () => {
		await writeTestConfig(tmpDir);

		const candidate = await seedCandidate(tmpDir, {
			evaluation_verdict: 'passed',
		});

		const result = JSON.parse(
			await callTool(
				{
					candidate_id: candidate.id,
					slug: 'My Cool Skill!!@@#',
					approver: 'user',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(true);
		expect(result.slug).toBe('my-cool-skill');
	});

	test('rejects slug that is empty after sanitization', async () => {
		await writeTestConfig(tmpDir);

		const result = JSON.parse(
			await callTool(
				{ candidate_id: 'some-id', slug: '!!!@@@###', approver: 'user' },
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('empty after sanitization');
	});

	// -------------------------------------------------------------------------
	// Test 8: Audit record added to evaluation_history
	// -------------------------------------------------------------------------
	test('adds audit record to evaluation_history on promotion', async () => {
		await writeTestConfig(tmpDir);

		const candidate = await seedCandidate(tmpDir, {
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

		await callTool(
			{
				candidate_id: candidate.id,
				slug: 'audit-test-skill',
				approver: 'user',
			},
			tmpDir,
		);

		// Verify the store was updated with audit entry
		const store = createExternalSkillStore(tmpDir, { max_candidates: 500 });
		const updated = await store.get(candidate.id);
		expect(updated).not.toBeNull();
		expect(updated!.evaluation_verdict).toBe('promoted');

		// Find the user-actor promoted entry
		const promotedEntry = updated!.evaluation_history.find(
			(e) => e.verdict === 'promoted' && e.actor === 'user',
		);
		expect(promotedEntry).toBeDefined();
		expect(promotedEntry!.timestamp).toBe('2026-06-09T12:00:00.000Z');
		expect(promotedEntry!.reason).toContain('audit-test-skill');
		expect(promotedEntry!.reason).toContain('re-validation passed');
	});

	// -------------------------------------------------------------------------
	// Test 9: SKILL.md contains provenance frontmatter fields
	// -------------------------------------------------------------------------
	test('SKILL.md contains all provenance frontmatter fields', async () => {
		await writeTestConfig(tmpDir);

		const candidate = await seedCandidate(tmpDir, {
			evaluation_verdict: 'passed',
		});

		await callTool(
			{
				candidate_id: candidate.id,
				slug: 'provenance-skill',
				approver: 'user',
			},
			tmpDir,
		);

		expect(writtenFileContent).not.toBeNull();

		// Verify all frontmatter fields
		expect(writtenFileContent).toContain(
			'promoted_from: external-skill-candidate',
		);
		expect(writtenFileContent).toContain(`candidate_id: ${candidate.id}`);
		expect(writtenFileContent).toContain(`source_url: ${candidate.source_url}`);
		expect(writtenFileContent).toContain(
			`source_type: ${candidate.source_type}`,
		);
		expect(writtenFileContent).toContain(`publisher: ${candidate.publisher}`);
		expect(writtenFileContent).toContain(`sha256: ${candidate.sha256}`);
		expect(writtenFileContent).toContain(
			'promoted_at: 2026-06-09T12:00:00.000Z',
		);
		expect(writtenFileContent).toContain('promoted_by: user');
		expect(writtenFileContent).toContain('slug: provenance-skill');

		// Verify frontmatter delimiters
		expect(writtenFileContent).toContain('---');

		// Verify skill body is present after frontmatter
		expect(writtenFileContent).toContain(candidate.skill_body);
	});

	// -------------------------------------------------------------------------
	// Test 10: Returns error when config fails to load
	// -------------------------------------------------------------------------
	test('returns error when config fails to load', async () => {
		_internals.loadConfig = () => {
			throw new Error('Config load failure');
		};

		const result = JSON.parse(
			await callTool(
				{ candidate_id: 'some-id', slug: 'my-skill', approver: 'user' },
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Failed to load plugin configuration');
	});

	// -------------------------------------------------------------------------
	// Test 11: Rejects promotion when SKILL.md already exists (slug collision)
	// -------------------------------------------------------------------------
	test('rejects promotion when SKILL.md already exists at target path', async () => {
		await writeTestConfig(tmpDir);

		const candidate = await seedCandidate(tmpDir, {
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

		// Simulate an existing skill at the target path
		_internals.fileExists = async (filePath: string): Promise<boolean> => {
			return filePath.includes('collision-skill');
		};

		const result = JSON.parse(
			await callTool(
				{
					candidate_id: candidate.id,
					slug: 'collision-skill',
					approver: 'user',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("Skill 'collision-skill' already exists");
		expect(result.error).toContain(
			'Use a different slug or retire the existing skill first',
		);

		// Verify no file was written
		expect(writtenFilePath).toBeNull();
		expect(writtenFileContent).toBeNull();
	});

	// -------------------------------------------------------------------------
	// Test 12: TOCTOU race — fileExists returns false but write throws EEXIST
	// -------------------------------------------------------------------------
	test('handles TOCTOU race: fileExists returns false but exclusive write throws EEXIST', async () => {
		await writeTestConfig(tmpDir);

		const candidate = await seedCandidate(tmpDir, {
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

		// fileExists says "no" (fast path passes), but exclusive write fails with EEXIST
		_internals.fileExists = async (_filePath: string): Promise<boolean> =>
			false;
		_internals.writeSkillFile = async (
			_filePath: string,
			_content: string,
		): Promise<void> => {
			const err = new Error('EEXIST: file already exists');
			(err as NodeJS.ErrnoException).code = 'EEXIST';
			throw err;
		};

		const result = JSON.parse(
			await callTool(
				{ candidate_id: candidate.id, slug: 'race-skill', approver: 'user' },
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("Skill 'race-skill' already exists");

		// Candidate must NOT be marked as promoted — the write never succeeded
		const store = createExternalSkillStore(tmpDir, { max_candidates: 500 });
		const unchanged = await store.get(candidate.id);
		expect(unchanged).not.toBeNull();
		expect(unchanged!.evaluation_verdict).toBe('passed');
	});

	// -------------------------------------------------------------------------
	// Test 13: Audit record includes gate_results, risk_assessment,
	//           provenance_snapshot (with fetched_at), candidate_id,
	//           original_verdict, target_path, promoted_content_hash,
	//           and original_evaluation (FR-006)
	// -------------------------------------------------------------------------
	test('audit record includes gate results, risk assessment, candidate_id, original verdict, provenance snapshot with fetched_at, target path, promoted content hash, and original evaluation', async () => {
		await writeTestConfig(tmpDir);

		const candidate = await seedCandidate(tmpDir, {
			evaluation_verdict: 'passed',
			evaluation_history: [
				{
					verdict: 'passed',
					timestamp: '2026-01-15T12:00:00.000Z',
					actor: 'system',
					reason: 'Validation: 3 gates, 0 findings',
					gate_results: [
						{ gate: 'prompt_injection', verdict: 'pass' },
						{ gate: 'unsafe_instructions', verdict: 'pass' },
						{ gate: 'provenance_integrity', verdict: 'pass' },
					],
					risk_assessment: {
						total_flags: 0,
						findings: [],
					},
				},
			],
		});

		await callTool(
			{
				candidate_id: candidate.id,
				slug: 'audit-rich-skill',
				approver: 'user',
			},
			tmpDir,
		);

		const store = createExternalSkillStore(tmpDir, { max_candidates: 500 });
		const updated = await store.get(candidate.id);
		expect(updated).not.toBeNull();

		const promotedEntry = updated!.evaluation_history.find(
			(e) => e.verdict === 'promoted' && e.actor === 'user',
		);
		expect(promotedEntry).toBeDefined();

		// candidate_id — the promoted candidate's ID
		expect(promotedEntry!.candidate_id).toBeDefined();
		expect(promotedEntry!.candidate_id).toBe(candidate.id);

		// original_verdict — what the original evaluation said before promotion
		expect(promotedEntry!.original_verdict).toBeDefined();
		expect(promotedEntry!.original_verdict).toBe('passed');

		// gate_results: array of { gate, verdict } from all three gates
		expect(Array.isArray(promotedEntry!.gate_results)).toBe(true);
		expect(promotedEntry!.gate_results!.length).toBe(3);
		const gateNames = promotedEntry!.gate_results!.map((gr) => gr.gate);
		expect(gateNames).toContain('prompt_injection');
		expect(gateNames).toContain('unsafe_instructions');
		expect(gateNames).toContain('provenance_integrity');
		for (const gr of promotedEntry!.gate_results!) {
			expect(gr.verdict).toBe('pass');
		}

		// risk_assessment — structured object with total_flags and findings
		expect(promotedEntry!.risk_assessment).toBeDefined();
		expect(
			typeof (promotedEntry!.risk_assessment as { total_flags: number })
				.total_flags,
		).toBe('number');
		expect(
			(promotedEntry!.risk_assessment as { total_flags: number }).total_flags,
		).toBeGreaterThanOrEqual(0);
		expect(
			Array.isArray(
				(promotedEntry!.risk_assessment as { findings: unknown[] }).findings,
			),
		).toBe(true);
		for (const finding of (
			promotedEntry!.risk_assessment as {
				findings: Array<{ severity: string; category: string }>;
			}
		).findings) {
			expect(['error', 'warning']).toContain(finding.severity);
			expect(typeof finding.category).toBe('string');
		}

		// provenance_snapshot — includes fetched_at
		expect(promotedEntry!.provenance_snapshot).toBeDefined();
		expect(promotedEntry!.provenance_snapshot!.sha256).toBe(candidate.sha256);
		expect(promotedEntry!.provenance_snapshot!.source_url).toBe(
			candidate.source_url,
		);
		expect(promotedEntry!.provenance_snapshot!.publisher).toBe(
			candidate.publisher,
		);
		expect(promotedEntry!.provenance_snapshot!.fetched_at).toBeDefined();
		expect(promotedEntry!.provenance_snapshot!.fetched_at).toBe(
			candidate.fetched_at,
		);

		// target_path
		expect(promotedEntry!.target_path).toBeDefined();
		expect(promotedEntry!.target_path).toContain('audit-rich-skill');
		expect(promotedEntry!.target_path).toContain('SKILL.md');

		// promoted_content_hash — SHA-256 of the actual skillMarkdown written
		expect(promotedEntry!.promoted_content_hash).toBeDefined();
		expect(typeof promotedEntry!.promoted_content_hash).toBe('string');
		expect(promotedEntry!.promoted_content_hash).toMatch(/^[a-f0-9]{64}$/);
		// Verify the hash matches the actual written content
		const { createHash } = await import('node:crypto');
		const expectedHash = createHash('sha256')
			.update(writtenFileContent!)
			.digest('hex');
		expect(promotedEntry!.promoted_content_hash).toBe(expectedHash);

		// original_evaluation — the pre-promotion evaluation context
		expect(promotedEntry!.original_evaluation).toBeDefined();
		const origEval = promotedEntry!.original_evaluation as Record<
			string,
			unknown
		>;
		expect(origEval.verdict).toBe('passed');
		expect(origEval.timestamp).toBe('2026-01-15T12:00:00.000Z');
		expect(origEval.actor).toBe('system');

		// original_evaluation.gate_results — persisted from the pre-promotion history entry
		expect(origEval.gate_results).toBeDefined();
		expect(Array.isArray(origEval.gate_results)).toBe(true);
		const origGateResults = origEval.gate_results as Array<{
			gate: string;
			verdict: string;
		}>;
		expect(origGateResults.length).toBe(3);
		expect(origGateResults.map((gr) => gr.gate)).toContain('prompt_injection');
		expect(origGateResults.map((gr) => gr.gate)).toContain(
			'unsafe_instructions',
		);
		expect(origGateResults.map((gr) => gr.gate)).toContain(
			'provenance_integrity',
		);
		for (const gr of origGateResults) {
			expect(gr.verdict).toBe('pass');
		}

		// original_evaluation.risk_assessment — persisted from the pre-promotion history entry
		expect(origEval.risk_assessment).toBeDefined();
		const origRisk = origEval.risk_assessment as {
			total_flags: number;
			findings: unknown[];
		};
		expect(origRisk.total_flags).toBe(0);
		expect(Array.isArray(origRisk.findings)).toBe(true);
	});
});
