/**
 * Swarm-tier archive tests for knowledge_archive tool.
 * Part 1 of 3 for knowledge-archive.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchivedEvent } from '../../../src/hooks/knowledge-events';
import { readKnowledgeEvents } from '../../../src/hooks/knowledge-events';
import {
	appendKnowledge,
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { _internals as policyInternals } from '../../../src/knowledge/curation-policy';
import { knowledge_archive } from '../../../src/tools/knowledge-archive';
import { makeCtx, makeSwarmEntry } from './_knowledge-archive-helpers';

describe('knowledge_archive — swarm-tier', () => {
	let dir: string;
	let swarmPath: string;
	let previousHome: string | undefined;
	let previousXdgDataHome: string | undefined;
	let previousLocalAppData: string | undefined;

	beforeEach(async () => {
		previousHome = process.env.HOME;
		previousXdgDataHome = process.env.XDG_DATA_HOME;
		previousLocalAppData = process.env.LOCALAPPDATA;
		dir = join(
			tmpdir(),
			`swarm-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		process.env.HOME = dir;
		process.env.XDG_DATA_HOME = join(dir, 'xdg-data');
		process.env.LOCALAPPDATA = join(dir, 'localappdata');
		swarmPath = resolveSwarmKnowledgePath(dir);
		await appendKnowledge(swarmPath, makeSwarmEntry('k1'));
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previousXdgDataHome;
		if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = previousLocalAppData;
		rmSync(dir, { recursive: true, force: true });
	});

	it('archives by default: sets status archived and keeps the entry', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'stale' },
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(true);
		expect(parsed.mode).toBe('archive');
		expect(parsed.tier).toBe('swarm');
		expect(parsed.previous_status).toBe('candidate');
		expect(parsed.status).toBe('archived');

		const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBe('archived');
		// PRR-002: producer-side archived_from assertion
		expect(entries[0].archived_from).toBe('candidate');
		expect(entries[0].archived_at).toBeTruthy();

		const tomb = (await readKnowledgeEvents(dir)).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb).toHaveLength(1);
		expect(tomb[0].entry_id).toBe('k1');
		expect(tomb[0].actor).toBe('architect');
		expect(tomb[0].reason).toBe('stale');
		expect(tomb[0].previous_status).toBe('candidate');
		expect(tomb[0].mode).toBe('archive');
		expect(tomb[0].tier).toBe('swarm');
	});

	it('quarantines when mode=quarantine (routes through quarantineEntry — G5 #1716)', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'suspect', mode: 'quarantine', evidence: 'flaky' },
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('quarantined');
		expect(parsed.tier).toBe('swarm');

		const swarmEntries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
		expect(swarmEntries).toHaveLength(0);

		const quarantinePath = join(
			resolveSwarmKnowledgePath(dir).replace(/knowledge\.jsonl$/, ''),
			'knowledge-quarantined.jsonl',
		);
		const quarantined = await readKnowledge<
			SwarmKnowledgeEntry & {
				original_status: string;
				quarantine_reason: string;
			}
		>(quarantinePath);
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0].id).toBe('k1');
		expect(quarantined[0].status).toBe('quarantined');
		expect(quarantined[0].original_status).toBe('candidate');
		expect(quarantined[0].quarantine_reason).toBe('suspect');

		const tomb = (await readKnowledgeEvents(dir)).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb).toHaveLength(0);

		await new Promise((resolve) => queueMicrotask(resolve));
		const skillEvents = (await readKnowledgeEvents(dir)).filter(
			(e) => (e as { type?: string }).type === 'skill-stale-batch',
		);
		expect(skillEvents).toHaveLength(0);
	});

	it('refuses to purge without the admin flag', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'gone', mode: 'purge' },
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('allow_purge');

		const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBe('candidate');
	});

	it('PRR-003: quarantine returns not-found (not false-success) for a missing id', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'missing', reason: 'suspect', mode: 'quarantine' },
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('entry not found');
	});

	// F-03: purge no longer auto-synthesizes a `manual-override` from
	// `allow_purge:true`. In a LINKED cohort, a purge of an entry owned by a
	// DIFFERENT worktree must now route through the cohort-safety policy and be
	// BLOCKED (cohort-wide evidence scope with no quorum) — returning
	// {success:false} with a cohort-safety policy detail — instead of silently
	// hard-deleting a sibling worktree's entry.
	//
	// Falsification: before the fix, purge synthesized an operator override, so
	// `authorizeCuration` short-circuited to `basis:'override' → authorized` and
	// the cross-owner entry was PURGED (success:true, store empty). After the fix
	// no override is synthesized, so the linked cross-owner ladder blocks it.
	//
	// Cohort-linkedness is simulated via the SANCTIONED curation-policy
	// `_internals` DI seam (mutable module object) — NOT `mock.module` of the
	// knowledge-store (which leaks across Bun's shared runner). isLinked→true
	// activates the ownership ladder; resolveWorktreeId pins the actor to a
	// worktree that is NOT the entry's producer; readCohortConfigFingerprint→null
	// keeps the config guard permissive (first cohort member).
	it('F-03: blocks a purge of a cross-owned entry in a linked cohort (no override synthesis)', async () => {
		const snapshot = { ...policyInternals };
		policyInternals.isLinked = () => true;
		policyInternals.readCohortConfigFingerprint = async () => null;
		policyInternals.resolveWorktreeId = async () => 'wt-actor';
		try {
			// An entry owned by a DIFFERENT worktree; only local (no cohort-wide
			// negative) evidence exists, so the quorum cannot authorize it.
			const owned = {
				...makeSwarmEntry('owned-by-other'),
				producer: { cohort_id: 'shared-cohort', worktree_id: 'wt-other' },
				revision: 1,
			} as SwarmKnowledgeEntry;
			await appendKnowledge(swarmPath, owned);

			const raw = await knowledge_archive.execute(
				{
					id: 'owned-by-other',
					reason: 'not mine',
					mode: 'purge',
					allow_purge: true,
				},
				makeCtx(dir),
			);
			const parsed = JSON.parse(raw);
			// Blocked by the cohort-safety policy — not a silent hard-delete.
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Cohort-safety policy blocked');
			expect(parsed.basis).toBe('quorum-insufficient');

			// The cross-owned entry SURVIVES the blocked purge.
			const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
			expect(entries.some((e) => e.id === 'owned-by-other')).toBe(true);

			// No purge tombstone was written for the blocked entry.
			const tomb = (await readKnowledgeEvents(dir)).filter(
				(e): e is ArchivedEvent =>
					e.type === 'archived' && e.entry_id === 'owned-by-other',
			);
			expect(tomb).toHaveLength(0);
		} finally {
			Object.assign(policyInternals, snapshot);
		}
	});

	it('purges (hard-deletes) with allow_purge:true and still writes a tombstone', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'gone', mode: 'purge', allow_purge: true },
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('purged');
		expect(parsed.tier).toBe('swarm');

		const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
		expect(entries).toHaveLength(0);

		const tomb = (await readKnowledgeEvents(dir)).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb).toHaveLength(1);
		expect(tomb[0].mode).toBe('purge');
		expect(tomb[0].tier).toBe('swarm');
	});

	it('returns not found for an unknown id and writes no tombstone', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'missing', reason: 'x' },
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('entry not found');
		expect(await readKnowledgeEvents(dir)).toHaveLength(0);
	});

	it('requires id and reason', async () => {
		const noId = JSON.parse(
			await knowledge_archive.execute({ reason: 'x' } as never, makeCtx(dir)),
		);
		expect(noId.success).toBe(false);
		const noReason = JSON.parse(
			await knowledge_archive.execute({ id: 'k1' } as never, makeCtx(dir)),
		);
		expect(noReason.success).toBe(false);
	});

	it('PRR-015: re-archive is a no-op that preserves original archived_from', async () => {
		// First archive: k1 (candidate) → archived, archived_from: 'candidate'
		const first = JSON.parse(
			await knowledge_archive.execute(
				{ id: 'k1', reason: 'first' },
				makeCtx(dir),
			),
		);
		expect(first.success).toBe(true);
		expect(first.status).toBe('archived');

		const after1 = (await readKnowledge<SwarmKnowledgeEntry>(swarmPath)).find(
			(e) => e.id === 'k1',
		)!;
		expect(after1.status).toBe('archived');
		expect(after1.archived_from).toBe('candidate');
		const archivedAt1 = after1.archived_at;

		// Second archive (re-archive): should be a no-op
		const second = JSON.parse(
			await knowledge_archive.execute(
				{ id: 'k1', reason: 'duplicate' },
				makeCtx(dir),
			),
		);
		expect(second.success).toBe(true);

		const after2 = (await readKnowledge<SwarmKnowledgeEntry>(swarmPath)).find(
			(e) => e.id === 'k1',
		)!;
		// CRITICAL: archived_from must NOT be corrupted to 'archived'
		expect(after2.archived_from).toBe('candidate');
		expect(after2.status).toBe('archived');
		// archived_at may be unchanged (prefer equality, not deep equality)
		expect(after2.archived_at).toBe(archivedAt1);
	});

	// PRR-002: the swarm archive mutation now flows through
	// `transactKnowledgeWithCas`, closing the authorize→mutate TOCTOU. A stale
	// archive plan (the entry changed since the authorization snapshot) must be
	// REJECTED with `{success:false}` rather than silently clobbering the newer
	// entry.
	//
	// Falsification via REAL concurrency (no mocking — mock.module'ing
	// knowledge-store leaks across Bun's shared runner, see hive-promoter note
	// #1847): two simultaneous archives of the SAME revisioned entry both capture
	// `revision: 1` at their (unlocked) pre-authorization read. The directory lock
	// then serializes the two CAS transactions: the first commits (bumping the
	// revision to 2), and the second observes the drift (2 !== 1) and CAS-fails.
	//
	// Before the fix (plain single `transactKnowledge`, no CAS) BOTH archives
	// succeed — the loser hits the re-archive no-op guard and returns
	// `{success:true, status:'archived'}` — so `succeeded===2, failed===0` and this
	// test fails. With the CAS wiring exactly one succeeds and one is rejected.
	it('PRR-002: rejects a stale archive plan when the entry drifted since authorization', async () => {
		// A revisioned entry (revision 1). makeSwarmEntry leaves `revision`
		// undefined, which would SKIP the revision CAS check; set it explicitly so
		// the drift is observable via the revision token.
		const seed = makeSwarmEntry('cas-drift');
		(seed as SwarmKnowledgeEntry & { revision: number }).revision = 1;
		await appendKnowledge(swarmPath, seed);

		// Two concurrent archives. Promise.all initiates both execute() calls
		// before either resolves its pre-authorization read, so both capture the
		// same authorized revision (1); the directory lock inside
		// transactKnowledgeWithCas then serializes the mutations.
		const [rawA, rawB] = await Promise.all([
			knowledge_archive.execute(
				{ id: 'cas-drift', reason: 'plan-A' },
				makeCtx(dir),
			),
			knowledge_archive.execute(
				{ id: 'cas-drift', reason: 'plan-B' },
				makeCtx(dir),
			),
		]);
		const results = [JSON.parse(rawA), JSON.parse(rawB)];

		const succeeded = results.filter((r) => r.success === true);
		const rejected = results.filter((r) => r.success === false);
		// Exactly one archive commits; the other is CAS-rejected as a stale plan.
		expect(succeeded).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(succeeded[0].status).toBe('archived');
		// The rejection surfaces the stale-plan contract, not a false success.
		expect(rejected[0].error).toContain('stale archive plan rejected');

		// The winning mutation committed exactly once: the entry is archived and
		// its revision was bumped a single time (1 → 2).
		const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
		const after = entries.find((e) => e.id === 'cas-drift');
		expect(after?.status).toBe('archived');
		expect(after?.revision).toBe(2);
	});
});
