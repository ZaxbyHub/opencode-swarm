/**
 * Lean Turbo Rule-3 upstream-commit predicate (issue #2962).
 *
 * `planLeanTurboLanes` reserves an optional `isUpstreamCommitted` predicate
 * (greenfield-smart Rule 3): when supplied, a cross-batch `depends:` upstream
 * (a dep not present in this planning call's task set — typically completed in
 * a prior phase) counts as satisfied only when the predicate proves the
 * upstream's work landed in git. Before this module existed, neither
 * production caller supplied it, so `makeDependencySatisfactionChecker`
 * (`partition-common.ts`) treated every cross-batch dep as implicitly
 * satisfied — a dependent task was dispatched in a parallel lane against work
 * that never reached HEAD.
 *
 * The predicate is EPIC-GATED: `swarm(task <id>):` landing commits exist only
 * under Epic Mode (`src/epic/plan-key.ts` → `task-landing.ts`/`residue-commit.ts`;
 * `src/plan/manager.ts` performs no git writes). In pure Lean Turbo no such
 * commits ever exist, so this helper returns `undefined` (the planner's
 * byte-identical legacy branch) unless an Epic is open for the project.
 *
 * Evidence reuses the CURRENT Epic marker machinery — never a re-implemented
 * subject scanner: coder landings are `git merge --no-ff` MERGE commits (the
 * log read is merge-inclusive), task ids repeat across plans (the
 * `Swarm-Plan:` trailer filters by planKey), and ids are scrubbed in subjects
 * (`scrubTaskIdForGitSubject` mapping handled inside `findTaskCommits`).
 *
 * Failure taxonomy:
 * - Unreadable Epic state           → Epic reads as OFF (same direction as
 *   `isEpicOpenForProject`): `undefined` + operator-visible warn.
 * - Epic closed between the reads   → `undefined`, no warn (not an error).
 * - Unborn HEAD (positively
 *   classified)                     → defined predicate, EMPTY committed set
 *                                     (nothing has landed yet).
 * - Genuine git failure (log read
 *   fails with HEAD resolvable, or
 *   the probe itself fails)         → disclosed permissive fallback
 *                                     (`() => true`): legacy degradation,
 *                                     NOT continued Rule-3 enforcement — wave
 *                                     ordering never covers cross-batch deps.
 *
 * This module is the Lean-owned side of a documented Lean→Epic seam (see
 * `src/epic/README.md`, upstream consumers): `src/epic/lifecycle.ts` and
 * `src/epic/markers.ts` import nothing from `src/turbo/lean/`, so the edge is
 * acyclic, and Epic-off costs exactly the sentinel `existsSync` inside
 * `isEpicOpenForProject` (Epic rule zero).
 */

import type { EpicRecordV1 } from '../../epic/lifecycle.js';
import { getOpenEpic, isEpicOpenForProject } from '../../epic/lifecycle.js';
import { epicCommitRange, findTaskCommits } from '../../epic/markers.js';
import { _internals as gitBranchInternals } from '../../git/branch.js';
import * as logger from '../../utils/logger.js';

/** Bounds for the HEAD probe (same values as `gitExec`). */
const HEAD_PROBE_TIMEOUT_MS = 30_000;
const HEAD_PROBE_MAX_BUFFER_BYTES = 1024 * 1024;

/** Max directories tracked by the warn-once set (mirrors lifecycle.ts). */
const MAX_WARNED_DIRECTORIES = 64;

/** Three-way HEAD probe outcome. */
export type HeadCommitState = 'exists' | 'unborn' | 'unknown';

/**
 * Bounded HEAD classification. `'exists'` when `git rev-parse --verify HEAD`
 * resolves (exit 0). `'unborn'` ONLY when positively classified: rev-parse
 * fails AND `git symbolic-ref -q HEAD` still resolves the branch (we are on a
 * branch that simply has no commits yet — the structural unborn shape; stderr
 * text varies by git version, so the ref probe is the classifier). Every other
 * outcome — spawn error, timeout, other exit, detached/corrupt HEAD — yields
 * `'unknown'` so a probe failure can never masquerade as "nothing committed".
 */
function headCommitExistsReal(directory: string): HeadCommitState {
	const probe = (args: string[]) =>
		gitBranchInternals.spawnSync(
			gitBranchInternals.resolveGitExecutable(),
			args,
			{
				cwd: directory,
				encoding: 'utf-8',
				timeout: HEAD_PROBE_TIMEOUT_MS,
				windowsHide: true,
				maxBuffer: HEAD_PROBE_MAX_BUFFER_BYTES,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			},
		);
	let result: ReturnType<typeof gitBranchInternals.spawnSync>;
	try {
		result = probe(['rev-parse', '--verify', 'HEAD']);
	} catch {
		return 'unknown';
	}
	if (result.status === 0) return 'exists';
	if (result.status !== 128 && result.status !== 1 && result.status !== 2) {
		return 'unknown';
	}
	try {
		const symbolic = probe(['symbolic-ref', '-q', 'HEAD']);
		return symbolic.status === 0 ? 'unborn' : 'unknown';
	} catch {
		return 'unknown';
	}
}

/** Bounded warn-once registry so one flapping directory cannot spam. */
const warnedDirectories = new Set<string>();

function warnOnceReal(directory: string, message: string): void {
	const key = directory;
	if (warnedDirectories.has(key)) return;
	if (warnedDirectories.size >= MAX_WARNED_DIRECTORIES) {
		const oldest = warnedDirectories.values().next().value;
		if (oldest !== undefined) warnedDirectories.delete(oldest);
	}
	warnedDirectories.add(key);
	_internals.criticalWarn(`[lean-turbo] ${message} (${directory})`);
}

/**
 * Resolve the Rule-3 predicate for a Lean Turbo planning call.
 *
 * @param directory - Project root directory.
 * @param taskIds - The plan's full task-id set (all phases) — the candidate
 *        cross-batch upstreams the marker read scans for. One bounded git
 *        call per planning pass; never on the plugin-init path.
 * @returns `undefined` when no Epic is open for the project (pure-lean
 *        legacy semantics, byte-identical placement), otherwise a predicate
 *        answering "does this task id have a `swarm(task <id>):` landing in
 *        the open Epic's commit range for the current plan?".
 */
export function resolveLeanRule3Predicate(
	directory: string,
	taskIds: readonly string[],
): ((taskId: string) => boolean) | undefined {
	// Gate through isEpicOpenForProject FIRST: it owns the operator-visible
	// criticalWarn + per-directory dedup for unreadable Epic state and fails
	// OFF (Epic treated as closed).
	if (!_internals.isEpicOpenForProject(directory)) return undefined;

	let record: EpicRecordV1 | null;
	try {
		record = _internals.getOpenEpic(directory);
	} catch {
		_internals.warnOnce(
			directory,
			'Epic state became unreadable mid-read; Lean Rule-3 wiring stays legacy until repaired',
		);
		return undefined;
	}
	// Close/config race: the Epic closed (or the config gate flipped) between
	// the two reads. Not an error — plain pure-lean semantics, no warning.
	if (record === null) return undefined;

	let committed: Map<string, string>;
	try {
		committed = _internals.findTaskCommits(
			directory,
			_internals.epicCommitRange(record),
			record.planKey,
			taskIds,
		);
	} catch {
		let head: HeadCommitState;
		try {
			head = _internals.headCommitExists(directory);
		} catch {
			head = 'unknown';
		}
		if (head === 'unborn') {
			// No commits exist — nothing has landed, so nothing is committed.
			return () => false;
		}
		_internals.warnOnce(
			directory,
			'git log read failed for Lean Rule-3; cross-batch dependency proof unavailable (legacy degradation)',
		);
		return () => true;
	}
	return (taskId: string) => committed.has(taskId);
}

/** DI seam (AGENTS.md invariant 7). Restore in `afterEach`. */
export const _internals = {
	isEpicOpenForProject,
	getOpenEpic,
	epicCommitRange,
	findTaskCommits,
	headCommitExists: headCommitExistsReal,
	warnOnce: warnOnceReal,
	criticalWarn: logger.criticalWarn,
};
