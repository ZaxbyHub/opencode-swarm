/**
 * Issue #2527 (F4): one-time migration of the LEGACY parent-level shared
 * worktree base (`<project-parent>/.swarm-worktrees`, shared by every
 * sibling checkout — the root of the cross-project destruction class) into
 * the project-internal default base (`<project>/.swarm-worktrees`).
 *
 * Ordering contract (plan-critic round 2, item 3): migration runs AFTER the
 * recovery lock, AFTER the live-lane-owner scan (it needs the liveness
 * answer), and AFTER the existing fail-closed uncertainty guards — mutating
 * gitdir pointers under uncertain project state is not acceptable — and
 * BEFORE enumeration-for-deletion.
 *
 * Safety contract: migration NEVER deletes anything. Owned + not-live
 * registered worktrees are MOVED with `git worktree move` (the primitive
 * that rewrites both gitdir pointers atomically; same-volume moves are an
 * internal rename — empirically verified on Windows with a git-excluded
 * target and dirty content). Foreign-owned lanes, live-owned lanes, and
 * ownership-unprovable `.git`-less remnants are LEFT AT THEIR LEGACY PATHS
 * (their owning checkouts migrate them; a bounded advisory line surfaces
 * them). The legacy base directory itself is removed only when EMPTY (plain
 * rmdir, never rm -rf). Timeout or per-lane failure ⇒ leave in place,
 * retry next start; N bounded by the lane-owner store caps and the pass's
 * withTimeout budget.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SWARM_WORKTREE_DIR_NAME } from '../config/constants';
import { resolveWorktreeRepoOwnership } from '../config/lane-context';
import type { LiveLaneOwnerEntry } from '../parallel/lane-owners';
import { type BunCompatSpawnOptions, bunSpawn } from '../utils/bun-compat';
import { canonicalRootKeyFresh } from '../utils/canonical-root';
import { resolveGitExecutable } from '../utils/git-executable.js';
import * as logger from '../utils/logger.js';
import { resolveWorktreeBaseDir } from './core';

const GIT_MOVE_TIMEOUT_MS = 10_000;
/** Cap the per-start migration batch so a huge legacy base can never blow the pass budget. */
const MAX_MIGRATIONS_PER_PASS = 16;

export interface BaseMigrationResult {
	attempted: boolean;
	legacyBaseExists: boolean;
	moved: string[];
	retained: Array<{ lanePath: string; reason: string }>;
	legacyBaseRemoved: boolean;
}

interface MigrationLane {
	lanePath: string;
	sessionId: string;
}

export const _internals = {
	resolveWorktreeRepoOwnership,
	bunSpawn,
	resolveGitExecutable,
	readdirSync: fs.readdirSync.bind(fs),
	existsSync: fs.existsSync.bind(fs),
	mkdirSync: fs.mkdirSync.bind(fs),
	rmdirSync: fs.rmdirSync.bind(fs),
	realpathSync: fs.realpathSync.bind(fs),
};

function listLegacyLanes(legacyBase: string): MigrationLane[] {
	const lanes: MigrationLane[] = [];
	let sessions: fs.Dirent[];
	try {
		sessions = _internals.readdirSync(legacyBase, { withFileTypes: true });
	} catch {
		return lanes;
	}
	for (const session of sessions) {
		if (!session.isDirectory()) continue;
		let laneEntries: fs.Dirent[];
		try {
			laneEntries = _internals.readdirSync(
				path.join(legacyBase, session.name),
				{
					withFileTypes: true,
				},
			);
		} catch {
			continue;
		}
		for (const lane of laneEntries) {
			if (!lane.isDirectory()) continue;
			lanes.push({
				lanePath: path.join(legacyBase, session.name, lane.name),
				sessionId: session.name,
			});
		}
	}
	return lanes;
}

async function gitWorktreeMove(
	projectRoot: string,
	from: string,
	to: string,
): Promise<string | undefined> {
	let proc: ReturnType<typeof bunSpawn> | undefined;
	try {
		proc = _internals.bunSpawn(
			[
				_internals.resolveGitExecutable(),
				'-C',
				projectRoot,
				'worktree',
				'move',
				from,
				to,
			],
			{
				cwd: projectRoot,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: GIT_MOVE_TIMEOUT_MS,
				killProcessTree: true,
			} satisfies BunCompatSpawnOptions,
		);
		const code = await proc.exited;
		if (code === 0) return undefined;
		const stderr = proc.stderr ? await proc.stderr.text().catch(() => '') : '';
		return stderr.trim() || `git worktree move exited ${code}`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		try {
			proc?.kill?.();
		} catch {
			// Already exited.
		}
	}
}

function isLive(
	entry: MigrationLane,
	liveOwners: LiveLaneOwnerEntry[],
): boolean {
	const canonical = canonicalRootKeyFresh(entry.lanePath);
	return liveOwners.some(
		(owner) =>
			owner.lanePath === entry.lanePath ||
			canonicalRootKeyFresh(owner.lanePath) === canonical,
	);
}

/**
 * Migrate owned, non-live lanes from the legacy parent-level base into the
 * project-internal default base. Fail-open and non-throwing by contract
 * (runs inside the bounded init-orphan-recovery pass).
 */
export async function migrateLegacyWorktreeBase(
	directory: string,
	liveOwners: LiveLaneOwnerEntry[],
): Promise<BaseMigrationResult> {
	const result: BaseMigrationResult = {
		attempted: false,
		legacyBaseExists: false,
		moved: [],
		retained: [],
		legacyBaseRemoved: false,
	};
	const legacyBase = path.resolve(
		path.dirname(directory),
		SWARM_WORKTREE_DIR_NAME,
	);
	result.legacyBaseExists = _internals.existsSync(legacyBase);
	if (!result.legacyBaseExists) return result;
	result.attempted = true;

	const newBase = resolveWorktreeBaseDir(directory);
	const lanes = listLegacyLanes(legacyBase);
	let movedCount = 0;
	for (const lane of lanes) {
		const dotGit = path.join(lane.lanePath, '.git');
		if (!_internals.existsSync(dotGit)) {
			// Ownership-unprovable remnant on the shared base — leave for its
			// owner (possibly a crashed provisioning of THIS project; the
			// enumeration-for-deletion never touches the legacy base, so it is
			// merely inert, surfaced by the retained advisory).
			result.retained.push({
				lanePath: lane.lanePath,
				reason: 'gitless legacy remnant (ownership unprovable)',
			});
			continue;
		}
		const ownership = _internals.resolveWorktreeRepoOwnership(
			lane.lanePath,
			directory,
		);
		if (!ownership.owned || ownership.uncertain) {
			result.retained.push({
				lanePath: lane.lanePath,
				reason: ownership.uncertain
					? 'ownership uncertain'
					: 'owned by a different repository',
			});
			continue;
		}
		if (isLive(lane, liveOwners)) {
			result.retained.push({
				lanePath: lane.lanePath,
				reason:
					'live lane (owner process running) — migrates after its dispatch ends',
			});
			continue;
		}
		if (movedCount >= MAX_MIGRATIONS_PER_PASS) {
			result.retained.push({
				lanePath: lane.lanePath,
				reason: 'per-pass migration cap reached — next start continues',
			});
			continue;
		}
		const target = path.join(
			newBase,
			lane.sessionId,
			path.basename(lane.lanePath),
		);
		try {
			_internals.mkdirSync(path.dirname(target), { recursive: true });
		} catch (error) {
			result.retained.push({
				lanePath: lane.lanePath,
				reason: `target mkdir failed: ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		const moveError = await gitWorktreeMove(directory, lane.lanePath, target);
		if (moveError) {
			result.retained.push({ lanePath: lane.lanePath, reason: moveError });
			continue;
		}
		// `git worktree move` leaves the emptied session-level directory
		// behind; drop the husk so the legacy base can actually reach the
		// empty state the final rmdir requires (plain rmdir only — a husk
		// still holding a sibling lane is NOT empty and must survive).
		try {
			_internals.rmdirSync(path.dirname(lane.lanePath));
		} catch {
			// Not empty (another lane remains) or already gone — either is fine.
		}
		result.moved.push(target);
		movedCount++;
	}

	// Remove the legacy base ONLY when empty (plain rmdir — never rm -rf:
	// retained foreign/live entries must survive).
	try {
		_internals.rmdirSync(legacyBase);
		result.legacyBaseRemoved = true;
	} catch {
		// Not empty (retained entries) or already gone — either is fine.
	}
	if (result.retained.length > 0) {
		logger.log(
			`[base-migration] ${result.retained.length} legacy-base entr${result.retained.length === 1 ? 'y' : 'ies'} left for their owning checkouts (${result.retained[0]?.reason})`,
		);
	}
	return result;
}
