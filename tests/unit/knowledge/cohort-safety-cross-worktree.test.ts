/**
 * #1848 §2 criterion #2: cross-worktree curation safety integration test.
 *
 * Verifies the headline safety property: worktree A cannot archive/quarantine/
 * rewrite/retract/remove worktree B's entry solely because A lacks local
 * application events for it. The policy must convert the destructive intent
 * into a non-destructive proposal (no-op), protecting B's entry.
 *
 * Also verifies the owner path: A CAN perform permitted actions on A's own
 * entries (criterion #3).
 *
 * This exercises the real quarantineEntry + authorizeCuration path with a
 * real temp-directory store (not just the policy unit in isolation).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import {
	computeContentHash,
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import { quarantineEntry } from '../../../src/hooks/knowledge-validator.js';
import {
	_internals,
	authorizeCuration,
} from '../../../src/knowledge/curation-policy.js';

// Track created temp dirs so they can be removed (avoid leaking into tmpdir).
const createdTmpDirs: string[] = [];

// IR-5 fix: restore _internals after each test.
const _internalsSnapshot = { ..._internals };
afterEach(() => {
	Object.assign(_internals, _internalsSnapshot);
	while (createdTmpDirs.length > 0) {
		const dir = createdTmpDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeTmpDir(): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'swarm-xsafe-')));
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	createdTmpDirs.push(dir);
	return dir;
}

function makeEntry(
	id: string,
	ownerWorktree: string,
	lesson = 'always run tests before pushing code',
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'established',
		confirmed_by: [],
		project_name: 'test',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 3,
		producer: { cohort_id: 'shared-cohort', worktree_id: ownerWorktree },
		revision: 1,
		content_hash: computeContentHash(lesson),
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
	};
}

function writeEntries(dir: string, entries: SwarmKnowledgeEntry[]): void {
	writeFileSync(
		resolveSwarmKnowledgePath(dir),
		entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
	);
}

const config = (): unknown => KnowledgeConfigSchema.parse({});

describe('cross-worktree curation safety (criterion #2)', () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTmpDir();
		// Policy: simulate a cohort-linked worktree so the ownership protections
		// apply. Inject a no-op config-fingerprint reader so the config guard
		// passes (no stored fingerprint = first member = permissive on config).
		_internals.isLinked = () => true;
		_internals.readCohortConfigFingerprint = async () => null;
	});

	it('worktree B CANNOT quarantine worktree A entry via local-only evidence', async () => {
		writeEntries(dir, [makeEntry('A-entry', 'wt-A')]);

		const beforeEntries = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(dir),
		);
		const target = beforeEntries.find((e) => e.id === 'A-entry')!;

		await quarantineEntry(dir, 'A-entry', 'B says unused', 'architect', {
			input: {
				directory: dir,
				action: 'quarantine',
				entryId: 'A-entry',
				reason: 'B says unused',
				evidenceScope: 'local-session',
				actorWorktreeId: 'wt-B',
			},
			context: { config: config() as never, entry: target } as never,
		});

		// The entry must STILL be in the active store (quarantine was blocked).
		const afterEntries = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(dir),
		);
		expect(afterEntries.length).toBe(1);
		expect(afterEntries[0].id).toBe('A-entry');
		expect(afterEntries[0].status).toBe('established');
	});

	it('worktree A CAN quarantine its own entry (owner path, criterion #3)', async () => {
		writeEntries(dir, [makeEntry('A-entry', 'wt-A')]);

		const beforeEntries = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(dir),
		);
		const target = beforeEntries.find((e) => e.id === 'A-entry')!;

		await quarantineEntry(dir, 'A-entry', 'A retracts own entry', 'architect', {
			input: {
				directory: dir,
				action: 'quarantine',
				entryId: 'A-entry',
				reason: 'A retracts own entry',
				evidenceScope: 'local-session',
				actorWorktreeId: 'wt-A',
			},
			context: { config: config() as never, entry: target } as never,
		});

		// The entry must be REMOVED from the active store (quarantine succeeded).
		const afterEntries = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(dir),
		);
		expect(afterEntries.length).toBe(0);
	});

	it('worktree B CANNOT archive worktree A entry via local-only evidence (policy blocks)', async () => {
		const entry = makeEntry('A-entry', 'wt-A');
		const decision = await authorizeCuration(
			{
				directory: dir,
				action: 'archive',
				entryId: 'A-entry',
				evidenceScope: 'local-session',
				actorWorktreeId: 'wt-B',
			},
			{ config: config() as never, entry } as never,
		);
		expect(decision.authorized).toBe(false);
		if (!decision.authorized) {
			expect(decision.basis).toBe('not-owner-local-evidence');
		}
	});

	it('unknown-owner legacy entry is protected from any non-override destructive action', async () => {
		const legacy: SwarmKnowledgeEntry = {
			...makeEntry('legacy-1', 'wt-A'),
			producer: null, // legacy — unknown owner
		};
		const decision = await authorizeCuration(
			{
				directory: dir,
				action: 'archive',
				entryId: 'legacy-1',
				evidenceScope: 'local-session',
				actorWorktreeId: 'wt-A',
			},
			{ config: config() as never, entry: legacy } as never,
		);
		expect(decision.authorized).toBe(false);
		if (!decision.authorized) {
			expect(decision.basis).toBe('protected-unknown-owner');
		}
	});
});
