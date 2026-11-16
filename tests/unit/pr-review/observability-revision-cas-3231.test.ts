/**
 * Issue #3231 defect-class guardrail (trace
 * 3231-3232-observability-append-integrity, Phase 4.2 Class B): the no-bump
 * observability append path carries its own persisted generation
 * (`observabilityRevision`). The append path CASes the incoming payload's
 * generation against the durable row's (rejecting same-state-revision stale
 * snapshots with the existing concurrent-change BLOCKED) and advances it by
 * one; every state-machine write carries the durable generation forward
 * (never reset by instance replacement or a field clear, never regressed by
 * a stale snapshot); the field guard skips it (its own CAS owns reporting).
 *
 * Legs (a)-(i) mirror the approved fix plan (07-approved-plan.md).
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	appendPrWorkflowSkillContractAdvisories,
	type PrWorkflowGateState,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	appendObservabilityStateWhileLocked,
	readPrWorkflowGateStateFromDisk,
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = '2026-11-06T00:00:00.000Z';
const AT_MS = 1_762_273_600_000;

const tempDirs: string[] = [];

function freshProject(prefix: string): string {
	const directory = canonicalMkdtemp(`sw3231cas-${prefix}-`);
	tempDirs.push(directory);
	mkdirSync(join(directory, '.git'), { recursive: true });
	return directory;
}

function stateFileOf(directory: string, session: string): string {
	return join(
		directory,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(session)}.json`,
	);
}

/** Seed a legacy gate-state JSON row (imported into SQLite on first read). */
function seedGateState(
	directory: string,
	session: string,
	extra: Record<string, unknown> = {},
): void {
	const stateFile = stateFileOf(directory, session);
	mkdirSync(dirname(stateFile), { recursive: true });
	writeFileSync(
		stateFile,
		JSON.stringify({
			schemaVersion: 1,
			revision: 0,
			sessionID: session,
			mode: 'PR_REVIEW',
			activatedAt: NOW,
			updatedAt: NOW,
			...extra,
		}),
		'utf8',
	);
}

/** The production append shape: fresh read under the lock, then append. */
async function appendFresh(directory: string, session: string): Promise<void> {
	await withSessionStateMutation(directory, session, async () => {
		const fresh: PrWorkflowGateState | null =
			await readPrWorkflowGateStateFromDisk(directory, session);
		if (!fresh) throw new Error('cas suite: durable row vanished');
		await appendObservabilityStateWhileLocked(directory, {
			...fresh,
			prReviewSubmitRejections: [
				...(fresh.prReviewSubmitRejections ?? []),
				{
					childSessionId: `child-${fresh.observabilityRevision ?? 0}`,
					at: AT_MS,
					message: 'cas suite append',
				},
			],
			updatedAt: NOW,
		});
	});
}

afterEach(() => {
	closeAllProjectDbs();
	for (const directory of tempDirs.splice(0)) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Windows: the SQLite WAL may briefly hold the temp dir; best-effort.
		}
	}
});

test('(a)+(h) appends advance the generation exactly once each and never touch the durable revision', async () => {
	const directory = freshProject('advance');
	const session = 'session-3231-advance';
	seedGateState(directory, session);
	await readPrWorkflowGateState(directory, session);

	await appendFresh(directory, session);
	let state = await readPrWorkflowGateState(directory, session);
	expect(state?.revision).toBe(0);
	expect(state?.observabilityRevision).toBe(1);

	await appendFresh(directory, session);
	state = await readPrWorkflowGateState(directory, session);
	expect(state?.revision).toBe(0);
	expect(state?.observabilityRevision).toBe(2);
	expect((state?.prReviewSubmitRejections ?? []).length).toBe(2);
});

test('(b) a stale state-machine write cannot regress the generation and a stale append is still rejected', async () => {
	const directory = freshProject('noregress');
	const session = 'session-3231-noregress';
	seedGateState(directory, session);
	await readPrWorkflowGateState(directory, session);

	// Snapshot BEFORE the append (state-machine write input).
	const stale: PrWorkflowGateState | null =
		await readPrWorkflowGateStateFromDisk(directory, session);
	expect(stale).not.toBeNull();

	await appendFresh(directory, session); // generation 0 -> 1, revision stays 0

	// State-machine write from the PRE-append snapshot: the revision CAS lets
	// it through (revision matches: appends never bump it) and the durable
	// observability fields survive — and so must the generation.
	const written = await writeStateWhileLocked(directory, {
		...stale!,
		updatedAt: NOW,
	});
	expect(written.revision).toBe(1);
	expect(written.observabilityRevision).toBe(1);

	// 3593-R3: an incoming payload that CARRIES a now-stale generation must
	// also lose to the durable value. Advance to generation 2, then write
	// from the gen-1 row produced above — a prefer-incoming carry would
	// regress 2 -> 1 here; durable-wins must persist 2.
	await appendFresh(directory, session); // generation 1 -> 2, revision stays 1
	const writtenFromStaleGeneration = await writeStateWhileLocked(directory, {
		...written,
		updatedAt: NOW,
	});
	expect(writtenFromStaleGeneration.revision).toBe(2);
	expect(writtenFromStaleGeneration.observabilityRevision).toBe(2);

	// A stale append (payload generation absent=0 vs durable 2) is still
	// rejected — the kill-net for CAS-drop/regress mutants.
	let staleAppendError: unknown = null;
	await withSessionStateMutation(directory, session, async () => {
		try {
			await appendObservabilityStateWhileLocked(directory, {
				...stale!,
				prReviewSubmitRejections: [
					{
						childSessionId: 'child-stale-b',
						at: AT_MS,
						message: 'must be rejected',
					},
				],
				updatedAt: NOW,
			});
		} catch (error) {
			staleAppendError = error;
		}
	});
	expect(staleAppendError).toBeInstanceOf(Error);
	expect((staleAppendError as Error).message.startsWith('BLOCKED')).toBe(true);

	const final = await readPrWorkflowGateState(directory, session);
	expect(final?.observabilityRevision).toBe(2);
});

test('(c) instance replacement carries the generation forward; new-instance appends are accepted', async () => {
	const directory = freshProject('replace');
	const session = 'session-3231-replace';
	seedGateState(directory, session, { workflowInstanceId: 'inst-a' });
	await readPrWorkflowGateState(directory, session);

	// Snapshot BEFORE the append: the replacement write below must carry the
	// generation DURABLE-WINS even though this stale snapshot lacks it (this
	// is the dedicated-carry pin — a carry sourced from the incoming
	// snapshot would reset the generation here).
	const stale: PrWorkflowGateState | null =
		await readPrWorkflowGateStateFromDisk(directory, session);
	expect(stale).not.toBeNull();
	expect(stale?.observabilityRevision).toBeUndefined();

	await appendFresh(directory, session); // generation 0 -> 1, revision stays 0

	// Replace the workflow instance FROM THE STALE (pre-append) snapshot —
	// the revision CAS admits it (appends never bump the revision), so only
	// the durable-wins carry keeps the generation.
	const replaced = await writeStateWhileLocked(
		directory,
		{ ...stale!, workflowInstanceId: 'inst-b' },
		{ replaceWorkflowInstanceId: 'inst-a' },
	);
	expect(replaced.revision).toBe(1);
	expect(replaced.observabilityRevision).toBe(1);

	// An append from the OLD-INSTANCE snapshot is rejected (stale revision
	// AND stale instance id).
	let oldInstanceError: unknown = null;
	await withSessionStateMutation(directory, session, async () => {
		try {
			await appendObservabilityStateWhileLocked(directory, {
				...stale!,
				prReviewSubmitRejections: [
					{
						childSessionId: 'child-old-instance',
						at: AT_MS,
						message: 'old-instance snapshot',
					},
				],
				updatedAt: NOW,
			});
		} catch (error) {
			oldInstanceError = error;
		}
	});
	expect(oldInstanceError).toBeInstanceOf(Error);
	expect((oldInstanceError as Error).message.startsWith('BLOCKED')).toBe(true);

	// A fresh-read append in the NEW instance is accepted (2, not reset).
	await appendFresh(directory, session);
	const after = await readPrWorkflowGateState(directory, session);
	expect(after?.observabilityRevision).toBe(2);

	// Legacy shape: a row with NO workflowInstanceId replaced by one WITH an
	// id also carries the generation from a stale (pre-append) snapshot.
	const directory2 = freshProject('replace-legacy');
	const session2 = 'session-3231-replace-legacy';
	seedGateState(directory2, session2);
	await readPrWorkflowGateState(directory2, session2);
	const stale2: PrWorkflowGateState | null =
		await readPrWorkflowGateStateFromDisk(directory2, session2);
	await appendFresh(directory2, session2);
	const replaced2 = await writeStateWhileLocked(directory2, {
		...stale2!,
		workflowInstanceId: 'inst-first',
	});
	expect(replaced2.observabilityRevision).toBe(1);
});

test('(d)+(f) legacy rows without the field and first appends with no durable row stamp generation 1', async () => {
	// (d) legacy durable row without the field.
	const directory = freshProject('legacy');
	const session = 'session-3231-legacy';
	seedGateState(directory, session);
	await readPrWorkflowGateState(directory, session);
	await appendFresh(directory, session);
	const state = await readPrWorkflowGateState(directory, session);
	expect(state?.observabilityRevision).toBe(1);

	// (f) no durable row at all — a first append is accepted and stamps 1.
	const directory2 = freshProject('norow');
	const session2 = 'session-3231-norow';
	let outcome: 'accepted' | 'rejected' = 'rejected';
	try {
		await withSessionStateMutation(directory2, session2, async () => {
			await appendObservabilityStateWhileLocked(directory2, {
				schemaVersion: 1,
				revision: 0,
				sessionID: session2,
				mode: 'PR_REVIEW',
				activatedAt: NOW,
				updatedAt: NOW,
				prReviewSubmitRejections: [
					{ childSessionId: 'child-first', at: AT_MS, message: 'first' },
				],
			});
		});
		outcome = 'accepted';
	} catch {
		outcome = 'rejected';
	}
	expect(outcome).toBe('accepted');
	const state2 = await readPrWorkflowGateState(directory2, session2);
	expect(state2?.observabilityRevision).toBe(1);
	expect(state2?.revision).toBe(0);
});

test('(g) clearObservabilityFields preserves the generation and older appends stay rejected', async () => {
	const directory = freshProject('clear');
	const session = 'session-3231-clear';
	seedGateState(directory, session);
	await readPrWorkflowGateState(directory, session);

	// Snapshot BEFORE the append: the clear-write below must carry the
	// generation DURABLE-WINS even though this stale snapshot lacks it (the
	// dedicated-carry pin — an incoming-snapshot carry would reset it here).
	const stale: PrWorkflowGateState | null =
		await readPrWorkflowGateStateFromDisk(directory, session);
	expect(stale?.observabilityRevision).toBeUndefined();

	await appendPrWorkflowSkillContractAdvisories(directory, session, [
		'advisory to be cleared',
	]);
	let state = await readPrWorkflowGateState(directory, session);
	expect(state?.observabilityRevision).toBe(1);
	const generationBeforeClear = state?.observabilityRevision;

	// Deliberate evidence reset (#3396 PRR-009 shape) on a state write FROM
	// THE STALE (pre-append) snapshot — the revision CAS admits it (appends
	// never bump the revision), so only the durable-wins carry keeps the
	// generation while the advisory field itself is cleared.
	await writeStateWhileLocked(
		directory,
		{ ...stale!, updatedAt: NOW },
		{ clearObservabilityFields: ['skillContractAdvisories'] },
	);
	state = await readPrWorkflowGateState(directory, session);
	expect(state?.skillContractAdvisories ?? []).toHaveLength(0);
	// The generation is NOT cleared with the evidence…
	expect(state?.observabilityRevision).toBe(generationBeforeClear);

	// …so a snapshot older than the cleared append is still rejected.
	let staleError: unknown = null;
	await withSessionStateMutation(directory, session, async () => {
		try {
			await appendObservabilityStateWhileLocked(directory, {
				...stale!,
				skillContractAdvisories: ['resurrected from a stale snapshot'],
				updatedAt: NOW,
			});
		} catch (error) {
			staleError = error;
		}
	});
	expect(staleError).toBeInstanceOf(Error);
	expect((staleError as Error).message.startsWith('BLOCKED')).toBe(true);
	expect(
		(await readPrWorkflowGateState(directory, session))
			?.skillContractAdvisories ?? [],
	).toHaveLength(0);
});

test('(e) a same-field interleave is rejected and the first append survives', async () => {
	const directory = freshProject('samefield');
	const session = 'session-3231-samefield';
	seedGateState(directory, session);
	await readPrWorkflowGateState(directory, session);

	// B snapshots BEFORE A's append; both appends touch the SAME field.
	const staleB: PrWorkflowGateState | null =
		await readPrWorkflowGateStateFromDisk(directory, session);
	expect(staleB?.skillContractAdvisories ?? []).toHaveLength(0);

	// A: a legitimate advisory append (generation 0 -> 1).
	await appendPrWorkflowSkillContractAdvisories(directory, session, [
		'A: same-field advisory that must survive',
	]);
	expect(
		(await readPrWorkflowGateState(directory, session))
			?.skillContractAdvisories ?? [],
	).toContain('A: same-field advisory that must survive');

	// B: an advisory append built from the STALE snapshot — same field, same
	// state revision, stale generation. It must be BLOCKED (not silently
	// merged and not overwriting A's entry), and A must survive. Uses the
	// public no-bump append API with the advisory field set, mirroring the
	// advisory writer's own locked call shape.
	let staleError: unknown = null;
	await withSessionStateMutation(directory, session, async () => {
		try {
			await appendObservabilityStateWhileLocked(directory, {
				...staleB!,
				skillContractAdvisories: ['B: stale same-field advisory'],
				updatedAt: NOW,
			});
		} catch (error) {
			staleError = error;
		}
	});
	expect(staleError).toBeInstanceOf(Error);
	expect((staleError as Error).message.startsWith('BLOCKED')).toBe(true);

	const final = await readPrWorkflowGateState(directory, session);
	expect(final?.skillContractAdvisories ?? []).toEqual([
		'A: same-field advisory that must survive',
	]);
	expect(final?.observabilityRevision).toBe(1);
	expect(final?.revision).toBe(0);
});

test('(i) a generation mismatch rejects with the exact concurrent-change message (the dedicated CAS owns it)', async () => {
	const directory = freshProject('message');
	const session = 'session-3231-message';
	seedGateState(directory, session);
	await readPrWorkflowGateState(directory, session);
	await appendFresh(directory, session); // generation 1

	const fresh: PrWorkflowGateState | null =
		await readPrWorkflowGateStateFromDisk(directory, session);
	expect(fresh?.observabilityRevision).toBe(1);
	let message = '';
	await withSessionStateMutation(directory, session, async () => {
		try {
			await appendObservabilityStateWhileLocked(directory, {
				...fresh!,
				observabilityRevision: 0, // stale generation, everything else current
				prReviewSubmitRejections: [
					...(fresh?.prReviewSubmitRejections ?? []),
					{
						childSessionId: 'child-stale-gen',
						at: AT_MS,
						message: 'stale generation payload',
					},
				],
				updatedAt: NOW,
			});
		} catch (error) {
			message = (error as Error).message;
		}
	});
	expect(message).toBe(
		'BLOCKED: PR workflow gate state changed concurrently; reload the active session state before retrying',
	);
	// The durable row is untouched by the rejected append.
	const after = await readPrWorkflowGateState(directory, session);
	expect(after?.observabilityRevision).toBe(1);
	expect(
		(after?.prReviewSubmitRejections ?? []).some(
			(entry) => entry.childSessionId === 'child-stale-gen',
		),
	).toBe(false);
});
