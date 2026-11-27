/**
 * #3951 round-4 review pins (R4-3/R4-4 + honest-reporting branches):
 * - terminal absence: a missing observation under the digest guard must NOT
 *   unlink a later occupant (seam-patched lstatTarget discriminates);
 * - drain retention: a fully-drained rollback with foreign files in the batch
 *   reports batchDirRetained and preserves them;
 * - the revoke partial-failure 'not removed' wording and the null-record
 *   (concurrently deleted) branch.
 *
 * Sibling of external-skill-revoke-guard-3951.test.ts (FR-006 500-line cap).
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import { rollbackResidueQuarantine } from '../../../src/services/swarm-residue.js';
import {
	external_skill_revoke,
	_internals as revokeInternals,
} from '../../../src/tools/external-skill-revoke.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const FIXED_NOW = 1_800_000_000_000;

async function callRevoke(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_revoke as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

function makeProject(prefix: string): string {
	const tmp = canonicalMkdtemp(prefix);
	fs.mkdirSync(path.join(tmp, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
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
			},
		}),
		'utf-8',
	);
	return tmp;
}

async function seedPromoted(tmp: string, slug: string): Promise<string> {
	const body = 'This is a safe skill body with no dangerous patterns.';
	const store = createExternalSkillStore(tmp, { max_candidates: 500 });
	const c = await store.add({
		source_url: `https://example.com/${slug}.md`,
		source_type: 'github',
		publisher: 'probe',
		sha256: crypto.createHash('sha256').update(body).digest('hex'),
		fetched_at: new Date(FIXED_NOW - 60_000).toISOString(),
		skill_name: slug,
		skill_body: body,
		risk_flags: [],
		evaluation_verdict: 'passed',
		evaluation_history: [
			{
				verdict: 'passed',
				timestamp: new Date(FIXED_NOW - 60_000).toISOString(),
				actor: 'system',
				reason: 'gates',
			},
		],
	});
	// Validator seam pin (same trap as the sibling suites): promote's TOCTOU
	// re-validation reads a bare new Date() the freeze spy cannot intercept,
	// so FIXED_NOW-seeded fetched_at looks future-dated under the wall clock.
	const { _internals: validatorInternals } = await import(
		'../../../src/services/external-skill-validator.js'
	);
	const realGetTimestamp = validatorInternals.getTimestamp;
	validatorInternals.getTimestamp = () => new Date(FIXED_NOW).toISOString();
	try {
		const { external_skill_promote } = await import(
			'../../../src/tools/external-skill-promote.js'
		);
		const promoted = JSON.parse(
			await (
				external_skill_promote as unknown as {
					execute: (a: unknown, ctx: { directory: string }) => Promise<string>;
				}
			).execute(
				{ candidate_id: c.id, slug, approver: 'user' },
				{ directory: tmp },
			),
		);
		expect(promoted.success).toBe(true);
	} finally {
		validatorInternals.getTimestamp = realGetTimestamp;
	}
	return c.id;
}

test('terminal absence: a missing observation never unlinks (seam-patched)', async () => {
	await withFrozenClockAsync(
		async () => {
			const tmp = makeProject('ac5-termabs-');
			const id = await seedPromoted(tmp, 'termabs');
			const skillPath = path.join(
				tmp,
				'.opencode',
				'skills',
				'generated',
				'termabs',
				'SKILL.md',
			);
			expect(fs.existsSync(skillPath)).toBe(true);

			const realLstat = revokeInternals.lstatTarget;
			revokeInternals.lstatTarget = async () => ({ kind: 'missing' });
			try {
				const res = JSON.parse(
					await callRevoke({ candidate_id: id, reason: 'probe' }, tmp),
				) as {
					success?: boolean;
					skill_file_removed?: boolean;
					evaluation_verdict?: string;
				};
				expect(res.success).toBe(true);
				expect(res.skill_file_removed).toBe(false);
				expect(res.evaluation_verdict).toBe('revoked');
				// THE pin (R4-4): the file is PRESENT on disk, yet the missing
				// observation refused to unlink it — an absent sighting must not
				// authorize deleting a later occupant.
				expect(fs.existsSync(skillPath)).toBe(true);
			} finally {
				revokeInternals.lstatTarget = realLstat;
			}
			fs.rmSync(tmp, { recursive: true, force: true });
		},
		{ fixedNow: FIXED_NOW },
	);
}, 30_000);

test('drain retention: foreign files in a drained batch survive and are reported (R4-3)', async () => {
	await withFrozenClockAsync(
		async () => {
			const tmp = canonicalMkdtemp('ac5-drainret-');
			const swarmRoot = path.join(tmp, '.swarm');
			fs.mkdirSync(swarmRoot, { recursive: true });
			const git = spawnSync('git', ['init', '--quiet'], {
				cwd: tmp,
				stdin: 'ignore',
				timeout: 30_000,
			});
			expect(git.status).toBe(0);

			// One eligible entry -> a real quarantine batch with a real manifest.
			fs.writeFileSync(path.join(swarmRoot, 'plan.json'), '{}', 'utf-8');
			const tempRel = `plan.json.${'4'.repeat(32)}.tmp`;
			fs.writeFileSync(path.join(swarmRoot, tempRel), 'payload', 'utf-8');
			const old = new Date(FIXED_NOW - 2 * 60 * 60_000);
			fs.utimesSync(path.join(swarmRoot, tempRel), old, old);
			const { quarantineSwarmResidue } = await import(
				'../../../src/services/swarm-residue.js'
			);
			const q = await quarantineSwarmResidue(tmp, { trigger: 'close' });
			expect(q.quarantined).toBe(1);
			expect(q.batchRelDir).toBeDefined();
			const batchAbs = path.join(tmp, '.swarm', q.batchRelDir as string);

			// A FOREIGN file lands in the drained batch dir.
			fs.writeFileSync(
				path.join(batchAbs, 'foreign-notes.txt'),
				'foreign',
				'utf-8',
			);

			const res = await rollbackResidueQuarantine(tmp);
			expect(res.drained).toBe(true);
			expect(res.batchDirRetained).toBe(true); // reported, not silently removed
			expect(fs.existsSync(path.join(batchAbs, 'foreign-notes.txt'))).toBe(
				true,
			); // preserved
			expect(fs.existsSync(path.join(swarmRoot, tempRel))).toBe(true); // payload restored
			fs.rmSync(tmp, { recursive: true, force: true });
		},
		{ fixedNow: FIXED_NOW },
	);
}, 30_000);

test('null-record branch: a vanished record reports honestly after removal', async () => {
	await withFrozenClockAsync(
		async () => {
			const tmp = makeProject('ac5-nullrec-');
			const id = await seedPromoted(tmp, 'nullrec');
			// The tool reads the record FIRST, so deleting it up front only
			// yields a not-found refusal. Vanish the record INSIDE the removal
			// seam — after the unlink lands, before update() re-reads — which
			// is the exact interleaving the null branch exists for.
			const recordPath = path.join(
				tmp,
				'.swarm',
				'skills',
				'candidates',
				`${id}.json`,
			);
			const realRetire = revokeInternals.retireSkillFile;
			let vanished = false;
			revokeInternals.retireSkillFile = async (
				filePath: string,
				...rest: unknown[]
			) => {
				const out = await realRetire(filePath, ...(rest as [never]));
				if (!vanished) {
					vanished = true;
					fs.rmSync(recordPath);
				}
				return out;
			};
			try {
				const res = JSON.parse(
					await callRevoke({ candidate_id: id, reason: 'probe' }, tmp),
				) as {
					success?: boolean;
					skill_file_removed?: boolean;
					error?: string;
				};
				expect(res.success).toBe(false);
				expect(res.skill_file_removed).toBe(true);
				expect(res.error ?? '').toContain('no longer exists');
				expect(res.error ?? '').toContain(
					'Skill file removal outcome: removed',
				);
			} finally {
				revokeInternals.retireSkillFile = realRetire;
			}
			fs.rmSync(tmp, { recursive: true, force: true });
		},
		{ fixedNow: FIXED_NOW },
	);
}, 30_000);
