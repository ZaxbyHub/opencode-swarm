/**
 * #3822 K2 — external_skill_revoke targets the STRUCTURED promotion identity.
 *
 * The deletion target comes from the newest 'promoted' history entry carrying
 * `target_path` + `promoted_content_hash` (not the prose reason). Containment:
 * the canonical target must be strictly inside
 * `<project>/.opencode/skills/generated/` — outside absolute paths,
 * traversal, and symlink/junction escapes are refused. The recorded hash
 * gates the unlink: on mismatch the file AND the candidate verdict stay
 * unchanged. A missing file is an idempotent success. Legacy candidates
 * without structured fields keep the prose-slug fallback, containment-checked.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFrozenClock } from '../../helpers/test-clock.js';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	_internals,
	external_skill_revoke,
} from '../../../src/tools/external-skill-revoke.js';

function sha256(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

async function callRevoke(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_revoke as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

interface SeedOverrides {
	evaluation_verdict?: string;
	historyEntry?: Record<string, unknown>;
}

/** Seed a promoted candidate, optionally with a structured history entry. */
async function seedPromotedCandidate(
	directory: string,
	overrides: SeedOverrides = {},
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	return store.add({
		source_url: 'https://example.com/skill.md',
		source_type: 'github',
		publisher: 'test-publisher',
		sha256: sha256('Skill body content.'),
		fetched_at: '2026-01-15T12:00:00.000Z',
		skill_name: 'revoke-structured-skill',
		skill_body: 'Skill body content.',
		risk_flags: [],
		evaluation_verdict: (overrides.evaluation_verdict ??
			'promoted') as ExternalSkillCandidate['evaluation_verdict'],
		evaluation_history: (overrides.historyEntry
			? [
					{
						verdict: 'promoted',
						timestamp: '2026-01-15T12:00:00.000Z',
						actor: 'user',
						...overrides.historyEntry,
					},
				]
			: []) as ExternalSkillCandidate['evaluation_history'],
	});
}

function writeSkillFile(targetPath: string, content: string): string {
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	fs.writeFileSync(targetPath, content, 'utf-8');
	return targetPath;
}

function generatedPath(directory: string, slug: string): string {
	return path.join(
		directory,
		'.opencode',
		'skills',
		'generated',
		slug,
		'SKILL.md',
	);
}

describe('external_skill_revoke — structured identity (#3822 K2)', () => {
	let projectDir: string;
	const originalLoadConfig = _internals.loadConfig;

	beforeEach(async () => {
		projectDir = path.join(
			os.tmpdir(),
			`ext-skill-revoke-structured-${withFrozenClock(() => Date.now(), { fixedNow: Date.now() })}-${Math.random().toString(36).slice(2, 8)}`,
		);
		fs.mkdirSync(projectDir, { recursive: true });
		// Real config file (curation enabled) — no loadConfig stub needed.
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
				},
			}),
			'utf-8',
		);
	});

	afterEach(() => {
		_internals.loadConfig = originalLoadConfig;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test('retires the structured target, not the slug scraped from prose', async () => {
		const structuredPath = writeSkillFile(
			generatedPath(projectDir, 'real-slug'),
			'# structured target\n',
		);
		const prosePath = writeSkillFile(
			generatedPath(projectDir, 'prose-slug'),
			'# prose slug skill\n',
		);
		const candidate = await seedPromotedCandidate(projectDir, {
			historyEntry: {
				reason:
					'Promoted to .opencode/skills/generated/prose-slug/SKILL.md — re-validation passed',
				target_path: structuredPath,
				promoted_content_hash: sha256('# structured target\n'),
			},
		});

		const raw = await callRevoke(
			{ candidate_id: candidate.id, reason: 'operator requested revoke' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as {
			success: boolean;
			error?: string;
			skill_file_removed?: boolean;
		};
		expect(parsed.success, raw).toBe(true);
		expect(parsed.skill_file_removed).toBe(true);
		expect(fs.existsSync(structuredPath)).toBe(false);
		expect(fs.existsSync(prosePath)).toBe(true);

		const store = createExternalSkillStore(projectDir, {
			max_candidates: 500,
		});
		const updated = await store.get(candidate.id);
		expect(updated?.evaluation_verdict).toBe('revoked');
	});

	test('hash mismatch refuses the unlink — file kept, verdict unchanged', async () => {
		const skillPath = writeSkillFile(
			generatedPath(projectDir, 'hash-slug'),
			'# tampered after approval\n',
		);
		const candidate = await seedPromotedCandidate(projectDir, {
			historyEntry: {
				reason:
					'Promoted to .opencode/skills/generated/hash-slug/SKILL.md — re-validation passed',
				target_path: skillPath,
				promoted_content_hash: sha256('# approved content\n'),
			},
		});

		const raw = await callRevoke(
			{ candidate_id: candidate.id, reason: 'operator requested revoke' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('does not match the recorded');
		expect(fs.existsSync(skillPath)).toBe(true);

		const store = createExternalSkillStore(projectDir, {
			max_candidates: 500,
		});
		const unchanged = await store.get(candidate.id);
		expect(unchanged?.evaluation_verdict).toBe('promoted');
	});

	test('outside-project absolute target is refused', async () => {
		const outsideDir = path.join(
			path.dirname(projectDir),
			`${path.basename(projectDir)}-outside`,
		);
		fs.mkdirSync(outsideDir, { recursive: true });
		const outsidePath = writeSkillFile(
			path.join(outsideDir, 'SKILL.md'),
			'# outside the project\n',
		);
		const candidate = await seedPromotedCandidate(projectDir, {
			historyEntry: {
				reason: 'Promoted elsewhere',
				target_path: outsidePath,
				promoted_content_hash: sha256('# outside the project\n'),
			},
		});

		const raw = await callRevoke(
			{ candidate_id: candidate.id, reason: 'operator requested revoke' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('escapes the generated-skill root');
		expect(fs.existsSync(outsidePath)).toBe(true);

		const store = createExternalSkillStore(projectDir, {
			max_candidates: 500,
		});
		const unchanged = await store.get(candidate.id);
		expect(unchanged?.evaluation_verdict).toBe('promoted');
		fs.rmSync(outsideDir, { recursive: true, force: true });
	});

	test('traversal target is refused', async () => {
		const candidate = await seedPromotedCandidate(projectDir, {
			historyEntry: {
				reason: 'Promoted with traversal',
				target_path: path.join(
					projectDir,
					'.opencode',
					'skills',
					'generated',
					'..',
					'..',
					'..',
					'escaped-skill.md',
				),
				promoted_content_hash: 'a'.repeat(64),
			},
		});

		const raw = await callRevoke(
			{ candidate_id: candidate.id, reason: 'operator requested revoke' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('escapes the generated-skill root');
	});

	test('missing file is an idempotent success', async () => {
		const candidate = await seedPromotedCandidate(projectDir, {
			historyEntry: {
				reason: 'Promoted',
				target_path: generatedPath(projectDir, 'already-gone'),
				promoted_content_hash: 'b'.repeat(64),
			},
		});

		const raw = await callRevoke(
			{ candidate_id: candidate.id, reason: 'already removed manually' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as {
			success: boolean;
			error?: string;
			skill_file_removed?: boolean;
			evaluation_verdict?: string;
		};
		expect(parsed.success, raw).toBe(true);
		expect(parsed.skill_file_removed).toBe(false);
		expect(parsed.evaluation_verdict).toBe('revoked');
	});

	test('legacy record without structured fields falls back to the prose slug', async () => {
		const skillPath = writeSkillFile(
			generatedPath(projectDir, 'legacy-slug'),
			'legacy skill content',
		);
		const candidate = await seedPromotedCandidate(projectDir, {
			historyEntry: {
				reason:
					'Promoted to .opencode/skills/generated/legacy-slug/SKILL.md — re-validation passed',
			},
		});

		const raw = await callRevoke(
			{ candidate_id: candidate.id, reason: 'legacy revoke' },
			projectDir,
		);
		const parsed = JSON.parse(raw) as {
			success: boolean;
			error?: string;
			skill_file_removed?: boolean;
		};
		expect(parsed.success, raw).toBe(true);
		expect(parsed.skill_file_removed).toBe(true);
		expect(fs.existsSync(skillPath)).toBe(false);
	});

	// Junction (win32) / symlink (POSIX) escape: lexically inside the
	// generated root, resolving outside it. Skipped when the platform refuses
	// link creation.
	const linkKind =
		process.platform === 'win32' ? ('junction' as const) : ('dir' as const);
	let canCreateLink = true;
	try {
		const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lnk-'));
		const probeTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'tgt-'));
		fs.symlinkSync(probeTarget, path.join(probeRoot, 'link'), linkKind);
		fs.rmSync(probeRoot, { recursive: true, force: true });
		fs.rmSync(probeTarget, { recursive: true, force: true });
	} catch {
		canCreateLink = false;
	}

	test.if(canCreateLink)(
		'symlink/junction escape inside the generated root is refused',
		async () => {
			const outsideDir = path.join(
				path.dirname(projectDir),
				`${path.basename(projectDir)}-linkdest`,
			);
			fs.mkdirSync(outsideDir, { recursive: true });
			const escapedPath = writeSkillFile(
				path.join(outsideDir, 'SKILL.md'),
				'# escaped through a link\n',
			);
			const linkPath = path.join(
				projectDir,
				'.opencode',
				'skills',
				'generated',
				'link-slug',
			);
			fs.mkdirSync(path.dirname(linkPath), { recursive: true });
			fs.symlinkSync(outsideDir, linkPath, linkKind);

			const candidate = await seedPromotedCandidate(projectDir, {
				historyEntry: {
					reason: 'Promoted through a link',
					target_path: path.join(linkPath, 'SKILL.md'),
					promoted_content_hash: sha256('# escaped through a link\n'),
				},
			});

			const raw = await callRevoke(
				{ candidate_id: candidate.id, reason: 'operator requested revoke' },
				projectDir,
			);
			const parsed = JSON.parse(raw) as { success: boolean; error?: string };
			expect(parsed.success, raw).toBe(false);
			expect(parsed.error).toContain(
				'resolves outside the generated-skill root',
			);
			expect(fs.existsSync(escapedPath)).toBe(true);
			fs.rmSync(outsideDir, { recursive: true, force: true });
		},
	);
});
