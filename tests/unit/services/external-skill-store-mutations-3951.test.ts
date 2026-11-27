/**
 * Trace 3943-3951-close-residue-recoverability — #3951 AC4 supplementary:
 * the three D2 mutation paths the frozen lost-update check
 * (`external-skill-store-3951-ac4-lost-update.test.ts`, update-vs-update)
 * does not reach. Seam discipline: every wrapper forwards ALL arguments and
 * is restored in finally + afterEach; this file uses NO mock.module.
 *
 * 1. update-vs-DELETE contention — deleteCandidate()
 *    (src/services/external-skill-store.ts:450-462) takes the SAME
 *    per-candidate withEvidenceLock as update(); without it an acknowledged
 *    delete is followed by the in-flight update's stale write that
 *    RESURRECTS the record (production caller
 *    src/tools/external-skill-delete.ts). A barrier on `_internals.
 *    atomicWriteFile` holds the update's write until the delete's unlink
 *    landed — or until a quiet event-loop turn proves the unlink will not
 *    even be attempted (a serialized fix gates it behind the lock). The
 *    discriminating invariant is DISJOINTNESS of the update read→write
 *    interval from the delete unlink interval; outcomes are asserted as
 *    consequences (delete acknowledged ⇒ record absent; update null ⇒ the
 *    delete removed it), so refusing both writers cannot pass.
 * 2. Protected-verdict eviction RE-CHECK (direct public-method coverage —
 *    see the evictIfNeeded note below) plus a no-flip control.
 * 3. Revoke post-unlink partial failure (external-skill-revoke.ts:540-557):
 *    success:false + skill_file_removed:true + re-run remedy, no revoked
 *    audit entry, then a second revoke completing the record.
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
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';

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

describe('update vs delete contention — regression: an acknowledged delete resurrected by a stale in-flight update (#3951 AC4 / D2)', () => {
	test('the update read→write window and the delete unlink window never overlap, and an acknowledged delete leaves the record gone', () =>
		withFrozenClockAsync(async () => {
		const tmpDir = canonicalMkdtemp('store-mutations-contention-');
		try {
			const seeded = await seed(
				tmpDir,
				'racy',
				'pending',
				new Date(FIXED_NOW).toISOString(),
			);
			const fp = candidateFile(tmpDir, seeded.id);
			const store = createExternalSkillStore(tmpDir, { max_candidates: 500 });

			// Monotonic seam-event log: the discriminating invariant is stated
			// over these orders, not over wall-clock timing.
			let seq = 0;
			const order = new Map<string, number>();
			const log: string[] = [];
			const mark = (name: string): void => {
				order.set(name, seq++);
				log.push(`${name}@${order.get(name)}`);
			};
			let unlinkStarts = 0;
			let unlinkDones = 0;
			let writeArrivals = 0;

			storeInternals.fs.readFile = ((
				targetPath: Parameters<typeof realReadFile>[0],
				...rest: unknown[]
			) => {
				const mine = String(targetPath) === fp;
				if (mine) mark('read:start');
				const result = realReadFile(targetPath, ...rest);
				if (!mine) return result;
				return result.then((value) => {
					mark('read:done');
					return value;
				});
			}) as typeof storeInternals.fs.readFile;

			storeInternals.fs.unlink = (async (
				targetPath: Parameters<typeof realUnlink>[0],
				...rest: unknown[]
			) => {
				const mine = String(targetPath) === fp;
				if (mine) {
					unlinkStarts++;
					mark('unlink:start');
				}
				const result = await realUnlink(targetPath, ...rest);
				if (mine) {
					unlinkDones++;
					mark('unlink:done');
				}
				return result;
			}) as typeof storeInternals.fs.unlink;

			/**
			 * Hold the update's write until the delete's unlink has landed (the
			 * resurrection window this check forces). A serialized fix gates the
			 * unlink BEHIND the update's lock, so it is never even attempted: two
			 * quiet event-loop turns declare the overlap impossible and let the
			 * write proceed. A quiescence probe, not a sleep — no duration
			 * influences the verdict.
			 */
			async function awaitDeleteWindow(): Promise<void> {
				for (;;) {
					if (unlinkDones >= 1) return;
					if (unlinkStarts > unlinkDones) {
						await tick();
						continue;
					}
					const before = unlinkStarts;
					await tick();
					await tick();
					if (unlinkStarts > before) continue;
					return;
				}
			}

			storeInternals.atomicWriteFile = ((
				targetPath: string,
				content: string,
				...rest: unknown[]
			) => {
				const mine = String(targetPath) === fp;
				if (!mine) {
					return realAtomicWriteFile(targetPath, content, ...rest);
				}
				writeArrivals++;
				const gated = writeArrivals === 1;
				mark('write:start');
				return (async () => {
					if (gated) await awaitDeleteWindow();
					await realAtomicWriteFile(targetPath, content, ...rest);
					mark('write:land');
				})();
			}) as typeof storeInternals.atomicWriteFile;
			armed = true;

			const [updateAck, deleteAck] = await Promise.all([
				store.update(seeded.id, { skill_name: 'raced-name' }),
				store.delete(seeded.id),
			]);
			restoreSeams();

			// Reachability: both mutation seams really fired.
			expect(unlinkStarts, 'delete() never reached the unlink seam').toBe(1);
			expect(writeArrivals === 1).toBe(updateAck !== null);

			// Discriminating invariant: the update's locked read→write interval
			// and the delete's unlink interval are DISJOINT. On the unlocked base
			// the barrier above forces read → unlink → write (overlap = the
			// resurrection), so this assertion fails there.
			const uStart = order.get('read:start');
			const uEnd = order.get('write:land');
			const dStart = order.get('unlink:start');
			const dEnd = order.get('unlink:done');
			expect(
				dStart,
				'precondition: the unlink window was recorded',
			).toBeDefined();
			expect(dEnd, 'precondition: the unlink window was closed').toBeDefined();
			if (uStart !== undefined && uEnd !== undefined) {
				const overlap = dStart! < uEnd && dEnd! > uStart;
				expect(
					overlap,
					`update window [${uStart},${uEnd}] overlaps delete unlink window [${dStart},${dEnd}]; events: ${log.join(' ')}`,
				).toBe(false);
			}

			// Consequence contract (honest on either lock-win order).
			const after = await store.get(seeded.id);
			if (deleteAck === true) {
				expect(
					after,
					`acknowledged delete was resurrected by a stale update (skill_name=${after?.skill_name}); events: ${log.join(' ')}`,
				).toBeNull();
			}
			if (updateAck === null) {
				// The update's locked re-read found no record — only the delete
				// could have removed it, and it must have acknowledged that.
				expect(
					deleteAck,
					'update() re-read null but the delete did not acknowledge the removal',
				).toBe(true);
			} else {
				expect(updateAck.skill_name).toBe('raced-name');
				if (deleteAck === false) {
					expect(after?.skill_name).toBe('raced-name');
				}
			}
		} finally {
			restoreSeams();
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
		}, { fixedNow: FIXED_NOW }), 30_000);
});

/**
 * evictIfNeeded() has NO production caller — `add()` never invokes it, and
 * the only src references are the interface entry
 * (src/services/external-skill-store.ts:99) and the definition (500). These
 * two tests are therefore DIRECT public-method hardening coverage of the
 * under-lock verdict re-check (517-535), NOT a runtime capacity claim.
 */
describe('evictIfNeeded protected-verdict re-check (#3951 AC4 / D2)', () => {
	async function seedThree(tmpDir: string): Promise<ExternalSkillCandidate[]> {
		const base = Date.parse('2026-01-01T00:00:00.000Z');
		const out: ExternalSkillCandidate[] = [];
		for (const [i, tag] of ['oldest', 'mid', 'newest'].entries()) {
			out.push(
				await seed(
					tmpDir,
					tag,
					'pending',
					new Date(base + i * 60_000).toISOString(),
				),
			);
		}
		return out;
	}

	test('a victim that became protected between the list snapshot and the lock is SKIPPED, never deleted', () =>
		withFrozenClockAsync(async () => {
		const tmpDir = canonicalMkdtemp('store-mutations-evict-protected-');
		try {
			const [oldest] = await seedThree(tmpDir);
			const fp = candidateFile(tmpDir, oldest.id);
			const store = createExternalSkillStore(tmpDir, { max_candidates: 2 });

			// On-disk truth at snapshot time: the oldest record IS evictable
			// (pending), so the list() snapshot puts it in `toEvict` — the flip
			// below is what must save it, not a snapshot that already protected it.
			expect(
				JSON.parse(String(await realReadFile(fp, 'utf-8'))),
			).toHaveProperty('evaluation_verdict', 'pending');

			let readsOfVictim = 0;
			storeInternals.fs.readFile = ((
				targetPath: Parameters<typeof realReadFile>[0],
				...rest: unknown[]
			) => {
				const mine = String(targetPath) === fp;
				if (!mine) return realReadFile(targetPath, ...rest);
				readsOfVictim++;
				const result = realReadFile(targetPath, ...rest);
				if (readsOfVictim < 2) return result;
				// The read performed UNDER the victim's lock (read #2 — read #1 is
				// the list() snapshot) observes a concurrent promote.
				return result.then((raw) => {
					const parsed = JSON.parse(String(raw)) as ExternalSkillCandidate;
					return JSON.stringify({
						...parsed,
						evaluation_verdict: 'promoted',
					}) as Awaited<typeof realReadFile>;
				});
			}) as typeof storeInternals.fs.readFile;
			armed = true;

			const evicted = await store.evictIfNeeded();
			restoreSeams();

			// Reachability: the under-lock re-read actually happened. On the
			// unlocked base there is no re-read at all (readsOfVictim === 1),
			// which is precisely why the deletion landed there.
			expect(
				readsOfVictim,
				'the eviction victim was never re-read under its lock',
			).toBeGreaterThanOrEqual(2);
			expect(evicted).toBe(0);
			expect(await store.get(oldest.id)).not.toBeNull();
			// Siblings are untouched (nothing was evictable in the end).
			expect(await fs.stat(fp)).toBeInstanceOf(Object);
		} finally {
			restoreSeams();
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
		}, { fixedNow: FIXED_NOW }), 30_000);

	test('control: the same over-capacity fixture without the flip evicts exactly the oldest victim', () =>
		withFrozenClockAsync(async () => {
		const tmpDir = canonicalMkdtemp('store-mutations-evict-control-');
		try {
			const [oldest, mid, newest] = await seedThree(tmpDir);
			const store = createExternalSkillStore(tmpDir, { max_candidates: 2 });

			const evicted = await store.evictIfNeeded();

			// Kills the "always skip" degenerate implementation: eviction still
			// happens when the victim really is evictable at unlink time.
			expect(evicted).toBe(1);
			expect(await store.get(oldest.id)).toBeNull();
			expect(await store.get(mid.id)).not.toBeNull();
			expect(await store.get(newest.id)).not.toBeNull();
		} finally {
			restoreSeams();
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
		}, { fixedNow: FIXED_NOW }), 30_000);
});

describe('revoke post-unlink record failure — regression: a silently lost record update after the destructive unlink (#3951 AC4 / D2)', () => {
	test('success:false + skill_file_removed:true + re-run remedy, then an idempotent second revoke completes the record', () =>
		withFrozenClockAsync(async () => {
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

			expect(simulated, 'the record-write failure was never reached').toBe(1);
			// Honest partial state — never a blanket failure, never a silent loss.
			expect(first.success).toBe(false);
			expect(first.skill_file_removed, 'the unlink DID land').toBe(true);
			expect(first.error ?? '').toContain('Skill file removed');
			expect(first.error ?? '').toContain('candidate record update failed');
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
		}, { fixedNow: FIXED_NOW }), 30_000);
});
