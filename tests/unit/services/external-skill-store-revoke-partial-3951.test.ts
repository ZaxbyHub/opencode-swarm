/**
 * Trace 3943-3951-close-residue-recoverability — #3951 AC4 supplementary,
 * sibling of external-skill-store-mutations-3951.test.ts (FR-006 split):
 * the revoke post-unlink partial-failure path (external-skill-revoke.ts).
 * Seam discipline: the wrapper forwards ALL arguments and is restored in
 * finally + afterEach; this file uses NO mock.module.
 *
 * A simulated candidate-record write failure AFTER the destructive unlink
 * must report the honest partial state (success:false, skill_file_removed
 * true, the actual 'Skill file removal outcome: removed' wording, re-run
 * remedy, no revoked audit entry), and a second revoke must complete the
 * record idempotently.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import { computeArtifactDigest } from '../../../src/services/external-skill-identity.js';
import {
	createExternalSkillStore,
	_internals as storeInternals,
} from '../../../src/services/external-skill-store.js';
import { external_skill_revoke } from '../../../src/tools/external-skill-revoke.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Deterministic instant every clock read in this file is relative to. */
const FIXED_NOW = 1_800_000_000_000;

const realReadFile = storeInternals.fs.readFile;
const realUnlink = storeInternals.fs.unlink;
const realAtomicWriteFile = storeInternals.atomicWriteFile;
let armed = false;

function restoreSeams(): void {
	if (armed) {
		storeInternals.fs.readFile = realReadFile;
		storeInternals.fs.unlink = realUnlink;
		storeInternals.atomicWriteFile = realAtomicWriteFile;
		armed = false;
	}
}

afterEach(() => {
	restoreSeams();
});

async function callRevoke(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_revoke as unknown as {
			execute: (a: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

async function writeTestConfig(directory: string): Promise<void> {
	const configDir = path.join(directory, '.opencode');
	await fs.mkdir(configDir, { recursive: true });
	await fs.writeFile(
		path.join(configDir, 'opencode-swarm.json'),
		JSON.stringify({ external_skills: { curation_enabled: true } }),
		'utf-8',
	);
}

function sha256(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

/** Seed one candidate with a caller-controlled verdict and fetched_at. */
async function seed(
	directory: string,
	tag: string,
	verdict: ExternalSkillCandidate['evaluation_verdict'],
	fetchedAt: string,
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	return store.add({
		source_url: `https://example.com/${tag}.md`,
		source_type: 'github',
		publisher: 'trace-3951',
		sha256: sha256(`body-${tag}`),
		fetched_at: fetchedAt,
		skill_name: tag,
		skill_body: `body-${tag}`,
		risk_flags: [],
		evaluation_verdict: verdict,
		evaluation_history: [],
	});
}

const candidateFile = (directory: string, id: string): string =>
	path.join(directory, '.swarm', 'skills', 'candidates', `${id}.json`);

const tick = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));
describe('revoke post-unlink record failure — regression: a silently lost record update after the destructive unlink (#3951 AC4 / D2)', () => {
	test(
		'success:false + skill_file_removed:true + re-run remedy, then an idempotent second revoke completes the record',
		() =>
			withFrozenClockAsync(
				async () => {
					const tmpDir = canonicalMkdtemp('store-mutations-revoke-partial-');
					try {
						await writeTestConfig(tmpDir);
						const slug = 'revoke-partial';
						const skillPath = path.join(
							tmpDir,
							'.opencode',
							'skills',
							'generated',
							slug,
							'SKILL.md',
						);
						const body = '# revoke partial\n';
						await fs.mkdir(path.dirname(skillPath), { recursive: true });
						await fs.writeFile(skillPath, body, 'utf-8');
						const record = await seed(
							tmpDir,
							slug,
							'promoted',
							new Date(FIXED_NOW).toISOString(),
						);
						const fp = candidateFile(tmpDir, record.id);
						await storeInternals.atomicWriteFile(
							fp,
							JSON.stringify({
								...record,
								evaluation_history: [
									{
										verdict: 'promoted',
										timestamp: new Date(FIXED_NOW).toISOString(),
										actor: 'user',
										reason: 'Promoted',
										target_path: skillPath,
										promoted_content_hash: computeArtifactDigest(body),
									},
								],
							}),
						);

						// The store write that fails is EXACTLY the revoke's post-unlink
						// record update (the seeding write above already landed).
						let simulated = 0;
						storeInternals.atomicWriteFile = ((
							targetPath: string,
							content: string,
							...rest: unknown[]
						) => {
							if (simulated === 0 && String(targetPath) === fp) {
								simulated++;
								return Promise.reject(
									new Error('EPERM: simulated candidate record write failure'),
								);
							}
							return realAtomicWriteFile(targetPath, content, ...rest);
						}) as typeof storeInternals.atomicWriteFile;
						armed = true;

						const first = JSON.parse(
							await callRevoke(
								{ candidate_id: record.id, reason: 'ac4 partial' },
								tmpDir,
							),
						) as {
							success?: boolean;
							skill_file_removed?: boolean;
							error?: string;
						};
						restoreSeams();

						expect(
							simulated,
							'the record-write failure was never reached',
						).toBe(1);
						// Honest partial state — never a blanket failure, never a silent loss.
						// (Round-4 review: pin the ACTUAL wording — 'Skill file removal
						// outcome: removed; … the candidate record update failed: …' —
						// the old prefix 'Skill file removed, but …' was reworded in the
						// honest-reporting fix.)
						expect(first.success).toBe(false);
						expect(first.skill_file_removed, 'the unlink DID land').toBe(true);
						expect(first.error ?? '').toContain(
							'Skill file removal outcome: removed',
						);
						expect(first.error ?? '').toContain(
							'candidate record update failed',
						);
						expect(first.error ?? '').toContain('Re-run revoke');
						expect(
							await fs.stat(skillPath).then(
								() => true,
								() => false,
							),
						).toBe(false);
						const mid = await createExternalSkillStore(tmpDir, {
							max_candidates: 500,
						}).get(record.id);
						expect(mid?.evaluation_verdict).toBe('promoted');
						expect(
							(mid?.evaluation_history ?? []).filter(
								(e) => e.actor === 'user' && e.verdict === 'revoked',
							),
							'a failed revoke must not write a revoked audit entry',
						).toHaveLength(0);

						// Re-run completes it: the file is already gone (idempotent removal)
						// and the record reaches 'revoked' with exactly one audit entry.
						const second = JSON.parse(
							await callRevoke(
								{ candidate_id: record.id, reason: 'ac4 partial' },
								tmpDir,
							),
						) as {
							success?: boolean;
							skill_file_removed?: boolean;
							evaluation_verdict?: string;
						};
						expect(second.success).toBe(true);
						expect(second.skill_file_removed, 'already removed').toBe(false);
						const done = await createExternalSkillStore(tmpDir, {
							max_candidates: 500,
						}).get(record.id);
						expect(done?.evaluation_verdict).toBe('revoked');
						expect(
							(done?.evaluation_history ?? []).filter(
								(e) => e.actor === 'user' && e.verdict === 'revoked',
							),
						).toHaveLength(1);
					} finally {
						restoreSeams();
						await fs.rm(tmpDir, { recursive: true, force: true });
					}
				},
				{ fixedNow: FIXED_NOW },
			),
		30_000,
	);
});
