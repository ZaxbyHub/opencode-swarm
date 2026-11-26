/**
 * FB-106 / FB-107 — external_skill_promote hardening (PR #3942 feedback).
 *
 *   FB-106 — every field interpolated into the artifact frontmatter
 *            (publisher, source_url, source_type, candidate id, sha256, and
 *            the raw slug) is refused when it carries CR/LF or any other
 *            Unicode Cc control character, BEFORE anything is written; and
 *            the final artifact's canonical digest must equal the recorded
 *            promoted_content_hash or nothing is written.
 *   FB-107 — when the candidate-store update fails AFTER the artifact was
 *            written, promote best-effort deletes the just-written artifact
 *            ONLY when its on-disk bytes match BYTE-FOR-BYTE what promote
 *            wrote (ownership safe — a concurrent replacement, even one that
 *            differs only in the advisory content_digest value, is never
 *            deleted); the original store error stays the surfaced error.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import {
	createExternalSkillStore,
	_internals as storeInternals,
} from '../../../src/services/external-skill-store.js';
import {
	_internals,
	external_skill_promote,
} from '../../../src/tools/external-skill-promote.js';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SKILL_BODY =
	'Safe skill body with no dangerous patterns for promote hardening tests.';

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

interface SeedOverrides {
	publisher?: string;
	source_url?: string;
}

async function seedPassedCandidate(
	directory: string,
	overrides: SeedOverrides = {},
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	return store.add({
		source_url: overrides.source_url ?? 'https://example.com/skill.md',
		source_type: 'github',
		publisher: overrides.publisher ?? 'test-publisher',
		sha256: sha256(SKILL_BODY),
		fetched_at: withFrozenClock(
			() => new Date(Date.now() - 60_000).toISOString(),
			{ fixedNow: Date.now() },
		),
		skill_name: 'hardening-skill',
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

async function candidateVerdict(
	directory: string,
	id: string,
): Promise<string | undefined> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const candidate = await store.get(id);
	return candidate?.evaluation_verdict;
}

describe('external_skill_promote — FB-106 frontmatter injection refusal', () => {
	let projectDir: string;
	const originalLoadConfig = _internals.loadConfig;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-promote-hardening-');
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

	test("refuses a publisher carrying '\\ncontent_digest:' (digest-line injection) and writes nothing", async () => {
		const candidate = await seedPassedCandidate(projectDir, {
			publisher: 'evil\ncontent_digest: injected',
		});

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'injected-skill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('publisher');
		expect(parsed.error).toContain('control character');

		expect(fs.existsSync(artifactPath(projectDir, 'injected-skill'))).toBe(
			false,
		);
		expect(await candidateVerdict(projectDir, candidate.id)).toBe('passed');
	});

	test('refuses a CR-only publisher (probe-cr class: CR hides payload from the digest line)', async () => {
		const candidate = await seedPassedCandidate(projectDir, {
			publisher: 'evil\rforged',
		});

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'cr-skill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('publisher');
		expect(fs.existsSync(artifactPath(projectDir, 'cr-skill'))).toBe(false);
	});

	test('refuses a control character (DEL) in the publisher', async () => {
		const candidate = await seedPassedCandidate(projectDir, {
			publisher: 'del\u007fpublisher',
		});

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'del-skill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('publisher');
	});

	test('refuses a newline in the candidate source_url', async () => {
		const candidate = await seedPassedCandidate(projectDir, {
			source_url: 'https://example.com/\ninjected: x',
		});

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'url-skill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('source_url');
		expect(parsed.error).toContain('control character');
		expect(fs.existsSync(artifactPath(projectDir, 'url-skill'))).toBe(false);
	});

	test('refuses a control character in the raw slug (pre-sanitization)', async () => {
		const candidate = await seedPassedCandidate(projectDir);

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'my\nskill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('slug');
		expect(parsed.error).toContain('control character');
		expect(
			fs.existsSync(artifactPath(projectDir, 'my-skill')),
			'no sanitized artifact may appear either',
		).toBe(false);
	});

	test('a clean candidate still promotes (guard against overreach)', async () => {
		const candidate = await seedPassedCandidate(projectDir);

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'clean-skill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean };
		expect(parsed.success, raw).toBe(true);
		expect(fs.existsSync(artifactPath(projectDir, 'clean-skill'))).toBe(true);
	});
});

describe('external_skill_promote — FB-107 orphan-artifact cleanup on store failure', () => {
	let projectDir: string;
	const originalLoadConfig = _internals.loadConfig;
	const originalAtomicWriteFile = storeInternals.atomicWriteFile;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-promote-cleanup-');
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
		storeInternals.atomicWriteFile = originalAtomicWriteFile;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('store.update failure removes the just-written artifact and surfaces the original error', async () => {
		const candidate = await seedPassedCandidate(projectDir);
		const target = artifactPath(projectDir, 'orphan-skill');

		// Every atomic write after the seed's add() fails (the update leg).
		storeInternals.atomicWriteFile = async () => {
			throw new Error('simulated store update failure');
		};

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'orphan-skill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('simulated store update failure');

		// The artifact promote wrote must not survive as an orphan.
		expect(fs.existsSync(target)).toBe(false);
		// No record mutation: the candidate stays passed, not promoted.
		expect(await candidateVerdict(projectDir, candidate.id)).toBe('passed');
	});

	test('a concurrent REPLACEMENT at the target path is preserved (never deleted)', async () => {
		const candidate = await seedPassedCandidate(projectDir);
		const target = artifactPath(projectDir, 'replaced-skill');
		const replacement = '# replaced by someone else mid-flight\n';

		storeInternals.atomicWriteFile = async () => {
			// Simulate a concurrent writer swapping the artifact, then the
			// store update failing — cleanup must NOT delete the replacement.
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, replacement, 'utf-8');
			throw new Error('simulated store update failure');
		};

		const raw = await callPromote(
			{ candidate_id: candidate.id, slug: 'replaced-skill', approver: 'user' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('simulated store update failure');

		expect(fs.existsSync(target)).toBe(true);
		expect(fs.readFileSync(target, 'utf-8')).toBe(replacement);
		expect(await candidateVerdict(projectDir, candidate.id)).toBe('passed');
	});

	test('a replacement differing ONLY in the content_digest value is preserved (digest-identical is not byte-identical)', async () => {
		const candidate = await seedPassedCandidate(projectDir);
		const target = artifactPath(projectDir, 'digest-tweaked-skill');

		storeInternals.atomicWriteFile = async () => {
			// Replace the artifact with bytes identical to what promote wrote
			// EXCEPT the advisory content_digest value. computeArtifactDigest
			// masks that line's value on purpose, so the two files are
			// DIGEST-identical but BYTE-different — cleanup must compare the
			// exact bytes (FB-107 Stage B revision) and preserve the file.
			const written = fs.readFileSync(target, 'utf-8');
			const match = /^content_digest: ([0-9a-f]{64})$/m.exec(written);
			expect(match, written).not.toBeNull();
			const tweaked = written.replace(
				/^content_digest: [0-9a-f]{64}$/m,
				`content_digest: ${'0'.repeat(64)}`,
			);
			expect(tweaked).not.toBe(written);
			fs.writeFileSync(target, tweaked, 'utf-8');
			throw new Error('simulated store update failure');
		};

		const raw = await callPromote(
			{
				candidate_id: candidate.id,
				slug: 'digest-tweaked-skill',
				approver: 'user',
			},
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('simulated store update failure');

		// The digest-tweaked replacement must survive byte-for-byte.
		expect(fs.existsSync(target)).toBe(true);
		const preserved = fs.readFileSync(target, 'utf-8');
		expect(preserved).toContain(`content_digest: ${'0'.repeat(64)}`);
		expect(await candidateVerdict(projectDir, candidate.id)).toBe('passed');
	});
});
