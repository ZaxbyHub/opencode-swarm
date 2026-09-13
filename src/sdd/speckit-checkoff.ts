/**
 * Spec-Kit tasks.md check-off round trip (issue #2501, Part B).
 *
 * When Swarm completes a plan task whose requirement refs map to Spec-Kit task
 * ids (T###) captured in the check-off ledger, this module checks those tasks
 * off in the SOURCE `specs/<feature>/tasks.md` (`- [ ]` → `- [x]`).
 *
 * Safety contract (issue #1577 Part B / #2501):
 * - WRITE-BACK IS OPT-IN: gated on `speckit_checkoff.enabled` (default false);
 *   `propagateSpeckitCheckoff` with `enabled: false` performs no writes at all.
 * - No ledger (native-Swarm / OpenSpec sources) → no-op.
 * - Byte parity: only the matched task line's checkbox bytes change; line
 *   endings (LF or CRLF) and every other byte are preserved.
 * - Concurrent-edit safety: detect-and-reconcile (the edit is applied to the
 *   CURRENT bytes; a user edit elsewhere survives); if the captured task line
 *   is gone or changed shape, the write is REFUSED for that feature.
 * - User-reopen respect: a task the ledger records as Swarm-checked but that
 *   is now `[ ]` was reopened by the user — never re-checked.
 * - Stale-ledger refusal: the ledger records a digest over the task lines; a
 *   regenerated/renumbered tasks.md refuses all writes for that feature.
 * - Never corrupts the user file: refusals write nothing; successful writes are
 *   atomic (temp + rename) under a cross-process lock.
 *
 * Invariant-4 note: writing `specs/<feature>/tasks.md` (outside `.swarm/`) is a
 * deliberate, issue-mandated exception — tasks.md is a user-authored SOURCE
 * artifact being round-tripped, not runtime state. The opt-in gate, atomic
 * write, lock, digest/staleness refusal, and byte-parity checks bound the
 * surface.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPluginConfig } from '../config/loader';
import { tryAcquireLock } from '../parallel/file-locks';
import {
	atomicWriteFileAnyRoot,
	atomicWriteSwarmFileSync,
} from '../utils/atomic-write';
import { log, warn } from '../utils/logger';

export const SPECKIT_CHECKOFF_LEDGER_REL = path.join(
	'.swarm',
	'speckit-checkoff-ledger.json',
);

const TASK_LINE_REGEX = /^\s*-\s+\[[ xX]\]\s+(T\d+)/;
const FR_REF_REGEX = /(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)?FR-\d{3}/g;
const MAX_TASKS_FILE_BYTES = 512 * 1024;

/** One captured Spec-Kit task line in the ledger. */
export interface SpeckitCheckoffTaskEntry {
	taskId: string;
	/** Canonical requirement refs (namespaced in multi-feature mode, bare otherwise). */
	frRefs: string[];
	/** Trimmed snapshot of the task line at projection time (staleness + locate basis). */
	lineSnapshot: string;
	initiallyChecked: boolean;
	/** ISO timestamp when Swarm checked this task off (absent until then). */
	swarmCheckedAt?: string;
}

/** Per-feature ledger record. */
export interface SpeckitCheckoffFeatureRecord {
	featureId: string;
	/** Posix path of tasks.md relative to the project root. */
	tasksRelPath: string;
	/** sha256 over the trimmed task lines at projection time (staleness basis). */
	taskLinesDigest: string;
	tasks: SpeckitCheckoffTaskEntry[];
}

export interface SpeckitCheckoffLedger {
	version: 1;
	namespaced: boolean;
	projectedAt: string;
	features: SpeckitCheckoffFeatureRecord[];
}

/** Per-feature outcome of one propagation run. */
export interface SpeckitCheckoffFeatureResult {
	featureId: string;
	tasksRelPath: string;
	checked: string[];
	reopenedSkipped: string[];
	stale: boolean;
	refused: string[];
}

export interface SpeckitCheckoffResult {
	ran: boolean;
	reason?: string;
	features: SpeckitCheckoffFeatureResult[];
	/** True when the completed task matched no ledger task anywhere (reported, not guessed). */
	unmatched?: boolean;
}

const FR_BARE_SUFFIX = /FR-\d{3}$/;

/**
 * Tolerant ref match: exact, or one side is the bare form of the other side's
 * namespaced form (mirrors the drift basis; a bare ref covers the same-numbered
 * requirement of any feature).
 */
function refsMatch(a: string, b: string): boolean {
	if (a === b) return true;
	const aBare = !a.includes('/');
	const bBare = !b.includes('/');
	if (aBare && !bBare && FR_BARE_SUFFIX.test(b) && b.endsWith(`/${a}`))
		return true;
	if (bBare && !aBare && FR_BARE_SUFFIX.test(a) && a.endsWith(`/${b}`))
		return true;
	return false;
}

function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function readBounded(filePath: string): string | null {
	try {
		const stat = fs.lstatSync(filePath);
		if (!stat.isFile() || stat.size > MAX_TASKS_FILE_BYTES) return null;
		return fs.readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}
}

/** Parse the T### checkbox lines of a tasks.md into task entries (no writes). */
export function parseSpeckitTasksContent(
	content: string,
	namespaced: boolean,
	featureId: string,
): { tasks: SpeckitCheckoffTaskEntry[]; taskLinesDigest: string } {
	const tasks: SpeckitCheckoffTaskEntry[] = [];
	const taskLines: string[] = [];
	for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
		const match = rawLine.match(TASK_LINE_REGEX);
		if (!match) continue;
		const snapshot = rawLine.trim();
		// Staleness basis: checkbox STATE is deliberately normalized out of the
		// digest. Check-off flips (ours) and user reopens (theirs) must NOT make a
		// feature stale — otherwise the second sequential check-off on a feature
		// would be refused. Staleness means the task LINES were regenerated or
		// renumbered (ids/text changed), which the normalized digest still catches.
		taskLines.push(snapshot.replace(/\[[xX]\]/g, '[ ]'));
		const refs = [...snapshot.matchAll(FR_REF_REGEX)].map((m) => m[0]!);
		const frRefs = refs.map((ref) =>
			namespaced && !ref.includes('/') ? `${featureId}/${ref}` : ref,
		);
		tasks.push({
			taskId: match[1]!,
			frRefs,
			lineSnapshot: snapshot,
			initiallyChecked: /\[x\]/i.test(snapshot),
		});
	}
	return { tasks, taskLinesDigest: sha256(taskLines.join('\n')) };
}

/**
 * Build and atomically write the check-off ledger for a successful Spec-Kit
 * projection. Called from `writeProjectedSpecSync` (both write paths); the
 * projection write stays authoritative — a ledger failure is logged, never
 * thrown to the caller.
 *
 * Task→requirement mapping basis (#2501): Spec-Kit task lines reference user
 * STORIES (`[US n]`), not necessarily FR ids. The ledger derives each task's
 * requirement refs from (a) any explicit FR refs on the line, plus (b) the
 * story-index mapping: `[US n]` maps to the feature's n-th requirement in
 * projection order (`featureRequirementIds`, captured at projection time).
 * Out-of-range story indices map to nothing (the task reports unmatched rather
 * than guessing).
 */
export function writeSpeckitCheckoffLedger(
	root: string,
	resolution: {
		features: string[];
		namespaced: boolean;
		featureRequirementIds: string[][];
		spec: { sourcePaths: string[] };
	},
): void {
	const features: SpeckitCheckoffFeatureRecord[] = [];
	resolution.features.forEach((featureId, index) => {
		const specRel =
			resolution.spec.sourcePaths[index] ?? `specs/${featureId}/spec.md`;
		const tasksRelPath = `${path.dirname(specRel).split(path.sep).join('/')}/tasks.md`;
		const content = readBounded(path.join(root, tasksRelPath));
		if (content === null) return; // no/oversized tasks.md — feature has no check-off surface
		const parsed = parseSpeckitTasksContent(
			content,
			resolution.namespaced,
			featureId,
		);
		if (parsed.tasks.length === 0) return;
		const requirementIds = resolution.featureRequirementIds[index] ?? [];
		for (const task of parsed.tasks) {
			const refs = new Set(task.frRefs);
			for (const storyMatch of task.lineSnapshot.matchAll(/\[US(\d+)\]/gi)) {
				const storyIndex = Number(storyMatch[1]) - 1;
				const mapped = requirementIds[storyIndex];
				if (mapped) refs.add(mapped);
			}
			task.frRefs = [...refs];
		}
		features.push({
			featureId,
			tasksRelPath,
			taskLinesDigest: parsed.taskLinesDigest,
			tasks: parsed.tasks,
		});
	});

	const ledger: SpeckitCheckoffLedger = {
		version: 1,
		namespaced: resolution.namespaced,
		projectedAt: new Date().toISOString(),
		features,
	};
	atomicWriteSwarmFileSync(
		path.join(root, SPECKIT_CHECKOFF_LEDGER_REL),
		`${JSON.stringify(ledger, null, 2)}\n`,
	);
}

function readLedger(root: string): SpeckitCheckoffLedger | null {
	const raw = readBounded(path.join(root, SPECKIT_CHECKOFF_LEDGER_REL));
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw) as SpeckitCheckoffLedger;
		if (parsed?.version !== 1 || !Array.isArray(parsed.features)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function writeLedger(root: string, ledger: SpeckitCheckoffLedger): void {
	atomicWriteSwarmFileSync(
		path.join(root, SPECKIT_CHECKOFF_LEDGER_REL),
		`${JSON.stringify(ledger, null, 2)}\n`,
	);
}

export interface ApplyCheckoffEditOutcome {
	applied: boolean;
	content: string;
	reason: string;
}

/**
 * Content-level check-off edit (the C9/`_internals` seam): apply ONE task's
 * checkbox flip to `currentContent`, locating the line by its ledger snapshot.
 *
 * Pure — performs no I/O. Byte-preserving outside the flipped `- [ ]` bytes.
 * Outcomes: 'ok' (flipped), 'already-checked', 'already-checked-by-user',
 * 'task-line-not-found' (refuse), 'task-line-changed' (refuse — same id, different shape).
 */
/**
 * Checkbox-state-insensitive line comparison basis: a task line matches its
 * ledger snapshot when the text matches with `[ ]`/`[x]` normalized — our own
 * flips and user reopens change only the checkbox bytes.
 */
function normalizeCheckboxState(line: string): string {
	return line.replace(/\[[xX]\]/g, '[ ]');
}

export function applyCheckoffEdit(
	taskEntry: SpeckitCheckoffTaskEntry,
	_baselineContent: string,
	currentContent: string,
): ApplyCheckoffEditOutcome {
	const lines = currentContent.split(/(?=\r?\n)/); // keeps terminators on each line
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const lineTrimmed = line.trim();
		if (
			normalizeCheckboxState(lineTrimmed) !==
			normalizeCheckboxState(taskEntry.lineSnapshot)
		) {
			// Same T### id but different text = regenerated line → refuse.
			const idMatch = line.match(TASK_LINE_REGEX);
			if (idMatch && idMatch[1] === taskEntry.taskId) {
				return {
					applied: false,
					content: currentContent,
					reason: 'task-line-changed',
				};
			}
			continue;
		}
		if (/\[x\]/i.test(lineTrimmed)) {
			return {
				applied: false,
				content: currentContent,
				reason: 'already-checked',
			};
		}
		const boxIndex = line.indexOf('[ ]');
		if (boxIndex === -1) {
			return {
				applied: false,
				content: currentContent,
				reason: 'task-line-changed',
			};
		}
		lines[i] = `${line.slice(0, boxIndex)}[x]${line.slice(boxIndex + 3)}`;
		return { applied: true, content: lines.join(''), reason: 'ok' };
	}
	return {
		applied: false,
		content: currentContent,
		reason: 'task-line-not-found',
	};
}

function extractFrRefsFromText(text: string): string[] {
	return [...text.matchAll(FR_REF_REGEX)].map((m) => m[0]!);
}

/**
 * Propagate one completed plan task's check-off into the source tasks.md files.
 *
 * `completed.frRefs` are the task's requirement refs (plan `fr_refs`); refs are
 * also mined from `completed.text` (descriptions often carry the natural ids).
 * Never throws for expected refusal paths; structural I/O failures throw only
 * from the atomic-write core and are caught by {@link
 * maybePropagateSpeckitCheckoff}.
 */
export async function propagateSpeckitCheckoff(
	directory: string,
	completed: { taskId: string; frRefs: string[]; text: string },
	options: { enabled: boolean },
): Promise<SpeckitCheckoffResult> {
	if (!options.enabled) {
		return { ran: false, reason: 'disabled', features: [] };
	}
	const root = path.resolve(directory);
	const ledger = readLedger(root);
	if (!ledger) {
		return { ran: false, reason: 'no-ledger', features: [] };
	}

	const completedRefs = [
		...completed.frRefs,
		...extractFrRefsFromText(`${completed.text ?? ''}`),
	];
	const results: SpeckitCheckoffFeatureResult[] = [];
	let anyMatch = false;
	let ledgerDirty = false;
	const checkedAt = new Date().toISOString();

	for (const feature of ledger.features) {
		const result: SpeckitCheckoffFeatureResult = {
			featureId: feature.featureId,
			tasksRelPath: feature.tasksRelPath,
			checked: [],
			reopenedSkipped: [],
			stale: false,
			refused: [],
		};
		const matchedTasks = feature.tasks.filter((task) =>
			task.frRefs.some((taskRef) =>
				completedRefs.some((completedRef) => refsMatch(completedRef, taskRef)),
			),
		);
		const hasSwarmChecked = feature.tasks.some((t) => t.swarmCheckedAt);
		if (matchedTasks.length === 0 && !hasSwarmChecked) {
			results.push(result);
			continue;
		}
		if (matchedTasks.length > 0) anyMatch = true;

		const tasksAbs = path.join(root, feature.tasksRelPath);
		let current = readBounded(tasksAbs);
		if (current === null) {
			result.stale = true;
			result.refused.push(...matchedTasks.map((t) => t.taskId));
			results.push(result);
			continue;
		}
		// Stale-ledger detection: the T### lines must still match the captured digest.
		const currentDigest = parseSpeckitTasksContent(
			current,
			ledger.namespaced,
			feature.featureId,
		).taskLinesDigest;
		if (currentDigest !== feature.taskLinesDigest) {
			result.stale = true;
			result.refused.push(...matchedTasks.map((t) => t.taskId));
			results.push(result);
			continue;
		}

		// User-reopen scan (B5): report EVERY task the ledger records as
		// Swarm-checked whose line is back to `[ ]` — the user reopened it, and a
		// later propagation for ANY task must neither re-check it nor silently
		// ignore it. Comparison is checkbox-insensitive (our own flips change only
		// the checkbox bytes). These tasks are also excluded from flipping below.
		for (const task of feature.tasks) {
			if (!task.swarmCheckedAt) continue;
			const line = current
				.replace(/\r\n/g, '\n')
				.split('\n')
				.find(
					(l) =>
						normalizeCheckboxState(l.trim()) ===
						normalizeCheckboxState(task.lineSnapshot),
				);
			if (line !== undefined && /\[ \]/.test(line)) {
				result.reopenedSkipped.push(task.taskId);
			}
		}

		let contentChanged = false;
		for (const task of matchedTasks) {
			if (task.swarmCheckedAt && result.reopenedSkipped.includes(task.taskId)) {
				// Recorded in the reopen scan above — respect the user, never re-check.
				continue;
			}
			const outcome = applyCheckoffEdit(task, current, current);
			if (outcome.applied) {
				current = outcome.content;
				contentChanged = true;
				task.swarmCheckedAt = checkedAt;
				ledgerDirty = true;
				result.checked.push(task.taskId);
			} else if (outcome.reason === 'already-checked') {
				// Idempotent: nothing to flip.
				if (!task.swarmCheckedAt) {
					task.swarmCheckedAt = checkedAt;
					ledgerDirty = true;
				}
			} else {
				result.refused.push(task.taskId);
			}
		}

		if (contentChanged && current !== null) {
			// Concurrent-edit safety: re-read immediately before the write and
			// reconcile — a user edit elsewhere survives; a changed target line
			// refuses. Then write atomically under a cross-process lock.
			const lock = await tryAcquireLock(
				root,
				feature.tasksRelPath,
				'speckit-checkoff',
				completed.taskId,
			);
			if (!lock.acquired) {
				result.refused.push(...result.checked);
				result.checked = [];
				results.push(result);
				continue;
			}
			try {
				const latest = readBounded(tasksAbs);
				if (latest === null || latest !== current) {
					if (latest !== null) {
						// Re-run the flips on the FRESH bytes (detect-and-reconcile).
						let reconciled = latest;
						let ok = true;
						for (const taskId of [...result.checked]) {
							const task = feature.tasks.find((t) => t.taskId === taskId)!;
							const outcome = applyCheckoffEdit(task, latest, reconciled);
							if (outcome.applied) {
								reconciled = outcome.content;
							} else if (outcome.reason !== 'already-checked') {
								ok = false;
								result.checked = result.checked.filter((id) => id !== taskId);
								result.refused.push(taskId);
							}
						}
						if (ok && result.checked.length > 0) {
							await atomicWriteFileAnyRoot(tasksAbs, reconciled);
							current = reconciled;
						} else {
							current = latest;
						}
					} else {
						result.refused.push(...result.checked);
						result.checked = [];
					}
				} else {
					await atomicWriteFileAnyRoot(tasksAbs, current);
				}
			} finally {
				if (lock.lock._release) {
					await lock.lock._release().catch(() => {});
				}
			}
		}
		results.push(result);
	}

	if (ledgerDirty) {
		try {
			writeLedger(root, ledger);
		} catch (err) {
			warn(
				`[speckit-checkoff] ledger update failed after check-off: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	return {
		ran: true,
		features: results,
		unmatched: !anyMatch || undefined,
	};
}

/**
 * Fail-open wrapper for the plan-manager wiring: loads the plugin config,
 * no-ops unless `speckit_checkoff.enabled`, and never lets a check-off failure
 * propagate into the task-status update (AGENTS.md #5/#9 — bookkeeping is
 * advisory to the durable plan write).
 */
export async function maybePropagateSpeckitCheckoff(
	directory: string,
	completed: { taskId: string; frRefs: string[]; text: string },
): Promise<void> {
	try {
		const config = loadPluginConfig(directory);
		if (config?.speckit_checkoff?.enabled !== true) return;
		const result = await propagateSpeckitCheckoff(directory, completed, {
			enabled: true,
		});
		if (result.ran && result.features.some((f) => f.checked.length > 0)) {
			log(
				`[speckit-checkoff] task ${completed.taskId} checked off: ${result.features
					.map((f) => `${f.featureId}:[${f.checked.join(', ')}]`)
					.join(' ')}`,
			);
		}
	} catch (err) {
		warn(
			`[speckit-checkoff] propagation for ${completed.taskId} failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/** DI seam for tests/checks (repo convention: restore in afterEach). */
export const _internals = {
	applyCheckoffEdit,
	parseSpeckitTasksContent,
	readBounded,
	sha256,
};
