/**
 * Trace 3943-3951-close-residue-recoverability — #3951 AC4 (P1 lost update).
 *
 * Frozen discriminating check (RED at base 18c09e03e, GREEN after the fix).
 *
 * `ExternalSkillStore.update()` (src/services/external-skill-store.ts:392-425)
 * is an UNLOCKED read-merge-write: `await get(id)` reads the record file,
 * `applyCandidatePatch` appends the caller-supplied `evaluation_history`
 * entry, and `_internals.atomicWriteFile` overwrites the whole file. Two
 * overlapping `external_skill_reject` calls on one candidate with distinct
 * reasons both acknowledge `{success:true}` while only the last writer's
 * reason survives.
 *
 * Previous code did, concretely: both updates read the SAME pre-write
 * snapshot (each merge computed from the seed record), the first write landed,
 * and the second write landed from a stale merge — silently discarding the
 * first rejection's reason while its tool call had already been acknowledged.
 *
 * Determinism (seams, NOT timing): the record reads stay REAL (un-doctored
 * `fs.readFile`); the interleave is forced as a barrier through
 * `_internals.atomicWriteFile` — the FIRST write does not land until the
 * second update's internal `get()` read has completed (tracked by counting
 * readFile start/complete events on the candidate file), then both real
 * writes proceed in arrival order (serialized). On the buggy tree the
 * barrier's wait is always satisfied (nothing gates the second read), so the
 * lost update is forced, not merely likely. If the tree is fixed by
 * serializing the read-merge-write (e.g. `withEvidenceLock`), the second
 * update's read is gated BEHIND the first write: the start/complete counters
 * go quiescent across one event-loop turn with no new read issued, the
 * barrier declares that the overlap cannot occur and lets the first write
 * land — the serialized writer then merges from committed state, or the
 * loser fails explicitly. A one-turn `setImmediate` is a quiescence probe,
 * not a sleep: no duration influences the verdict.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	createExternalSkillStore,
	_internals as storeInternals,
} from '../../../src/services/external-skill-store.js';
import { external_skill_reject } from '../../../src/tools/external-skill-reject.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Deterministic instant every clock read in this file is relative to. */
const FIXED_NOW = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// Helpers (shapes copied from tests/unit/tools/external-skill-reject.test.ts)
// ---------------------------------------------------------------------------

function callReject(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_reject as unknown as {
			execute: (a: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

async function writeTestConfig(directory: string): Promise<void> {
	const configDir = path.join(directory, '.opencode');
	await fs.mkdir(configDir, { recursive: true });
	await fs.writeFile(
		path.join(configDir, 'opencode-swarm.json'),
		JSON.stringify(
			{
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
			},
			null,
			2,
		),
		'utf-8',
	);
}

const tick = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

describe('external_skill_reject concurrent RMW — regression: lost update drops an acknowledged rejection reason (#3951 AC4)', () => {
	const realReadFile = storeInternals.fs.readFile;
	const realAtomicWriteFile = storeInternals.atomicWriteFile;
	let seamsInstalled = false;
	let tmpDir: string;

	function restoreSeams(): void {
		if (seamsInstalled) {
			storeInternals.fs.readFile = realReadFile;
			storeInternals.atomicWriteFile = realAtomicWriteFile;
			seamsInstalled = false;
		}
	}

	afterEach(async () => {
		// Defensive: restore any seam still wrapped by an aborted test body.
		restoreSeams();
		if (tmpDir) {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test(
		'two overlapping rejects with distinct reasons: each acknowledged rejection is persisted exactly once, or the conflicting call fails explicitly',
		() =>
			withFrozenClockAsync(
				async () => {
					tmpDir = canonicalMkdtemp('ac4-lost-update-');
					await writeTestConfig(tmpDir);

					const store = createExternalSkillStore(tmpDir, {
						max_candidates: 500,
					});
					const candidate = await store.add({
						source_url: 'https://example.com/ac4-skill.md',
						source_type: 'github',
						publisher: 'trace-3951',
						sha256: 'a'.repeat(64),
						fetched_at: new Date(FIXED_NOW - 60_000).toISOString(),
						skill_name: 'ac4-skill',
						skill_body: 'body',
						risk_flags: [],
						evaluation_verdict: 'pending',
						evaluation_history: [],
					});

					const candidateFilePath = path.join(
						tmpDir,
						'.swarm',
						'skills',
						'candidates',
						`${candidate.id}.json`,
					);

					// ---- barrier state -------------------------------------------------
					// Each reject performs exactly TWO reads of the candidate record on the
					// base tree (tool-level store.get at external-skill-reject.ts:103 and
					// the internal get() inside update()).
					const EXPECTED_OVERLAP_READS = 4;
					let readsStarted = 0;
					let readsCompleted = 0;
					let writeArrivals = 0;

					storeInternals.fs.readFile = ((
						targetPath: Parameters<typeof realReadFile>[0],
						...rest: unknown[]
					) => {
						const isCandidate = String(targetPath) === candidateFilePath;
						if (isCandidate) readsStarted++;
						const result = realReadFile(targetPath, ...rest);
						if (isCandidate) {
							return result.then(
								(value: Awaited<ReturnType<typeof realReadFile>>) => {
									readsCompleted++;
									return value;
								},
							);
						}
						return result;
					}) as typeof storeInternals.fs.readFile;

					/**
					 * Block until the second update's internal get() read has completed
					 * (the overlap this check forces), or until one full event-loop turn
					 * proves no further read is even going to be issued (a serialized fix
					 * gates the second read behind this write — let it land).
					 */
					async function awaitOverlap(): Promise<void> {
						for (;;) {
							if (readsCompleted >= EXPECTED_OVERLAP_READS) return;
							if (readsCompleted < readsStarted) {
								// A started read is still in flight — wait for completions.
								await tick();
								continue;
							}
							const startedBefore = readsStarted;
							await tick();
							if (readsStarted > startedBefore) continue;
							// Quiescent across a whole loop turn: the other update never
							// issues its merge read — it is gated behind this write.
							return;
						}
					}

					// Serialize the real writes in arrival order; the first arrival also
					// waits for the overlap. Full argument forwarding (seam rule).
					let chain: Promise<unknown> = Promise.resolve();
					storeInternals.atomicWriteFile = ((
						targetPath: string,
						content: string,
						...rest: unknown[]
					) => {
						writeArrivals++;
						const first = writeArrivals === 1;
						const run = async () => {
							if (first) await awaitOverlap();
							return realAtomicWriteFile(targetPath, content, ...rest);
						};
						const p = chain.then(run, run);
						chain = p.catch(() => undefined);
						return p;
					}) as typeof storeInternals.atomicWriteFile;
					seamsInstalled = true;

					// ---- the two overlapping rejects ----------------------------------
					const [rawA, rawB] = await Promise.all([
						callReject(
							{ candidate_id: candidate.id, reason: 'reason-AAA' },
							tmpDir,
						),
						callReject(
							{ candidate_id: candidate.id, reason: 'reason-BBB' },
							tmpDir,
						),
					]);
					restoreSeams();

					const ackA = JSON.parse(rawA) as {
						success?: boolean;
						error?: string;
					};
					const ackB = JSON.parse(rawB) as {
						success?: boolean;
						error?: string;
					};

					const after = await store.get(candidate.id);
					const userReasons = (after?.evaluation_history ?? [])
						.filter(
							(e: { actor: string; verdict: string }) =>
								e.actor === 'user' && e.verdict === 'rejected',
						)
						.map((e: { reason?: string }) => e.reason ?? '');

					// A rejected call that reports failure must fail EXPLICITLY (a message),
					// never as a bare ack-with-no-history.
					for (const ack of [ackA, ackB]) {
						if (ack.success !== true) {
							expect(typeof ack.error).toBe('string');
							expect((ack.error ?? '').length).toBeGreaterThan(0);
						}
					}

					// The pipeline still works: at least one acknowledged rejection must
					// survive (guards against a "fix" that refuses both updates).
					const ackedReasons = [
						ackA.success === true ? 'reason-AAA' : null,
						ackB.success === true ? 'reason-BBB' : null,
					].filter((r): r is string => r !== null);
					expect(ackedReasons.length).toBeGreaterThanOrEqual(1);

					// AC4 contract: every ACKNOWLEDGED rejection appears in the persisted
					// evaluation_history exactly once.
					for (const reason of ackedReasons) {
						const occurrences = userReasons.filter((r) => r === reason).length;
						expect(
							occurrences,
							`acknowledged rejection "${reason}" must appear exactly once in persisted user-actor history; got ${occurrences} (ackA=${JSON.stringify(ackA)} ackB=${JSON.stringify(ackB)} persisted=${JSON.stringify(userReasons)})`,
						).toBe(1);
					}
				},
				{ fixedNow: FIXED_NOW },
			),
		25_000,
	);
});
