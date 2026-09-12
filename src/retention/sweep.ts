/**
 * One bounded, fail-open retention sweep over the residual keyspace families
 * under `<projectRoot>/.swarm/` (issue #2483 §3).
 *
 * Production triggers: the wrapper-owned post-resolution task registered in
 * `src/index.ts` (withTimeout-bounded, off the `server()`-resolution path —
 * AGENTS.md invariant 1) and one pass before the `/swarm close` clean stage.
 *
 * Safety properties (tested in tests/unit/retention/sweep-2483.test.ts and
 * edge-cases-2483.test.ts):
 *  - only ever touches paths under `<projectRoot>/.swarm/`; nothing outside
 *    survives-or-dies by accident (containment asserted by test);
 *  - fail-open per family — one family's error never aborts the others and
 *    never throws to the caller;
 *  - future-mtime entries are never pruned; symlinked entries are never
 *    traversed (dir-prune guards);
 *  - `dryRun` reports what WOULD be pruned without deleting (the blast-
 *    radius rehearsal mode; also the `retention.dry_run` config surface);
 *  - the summaries family honors `summaries.retention_days` (default 7) by
 *    delegating to `cleanupSummaries` (content-timestamp with mtime
 *    fallback), which this sweep is the first production caller of — the
 *    previously-dead `retention_days` setting becomes live.
 *  - authoritative streams (plan ledger, knowledge store, council, evidence,
 *    scopes, swarm.db, telemetry) are NOT in any family and are never
 *    touched (negative test).
 *  - checkout-preparation receipts remain recovery material: the checkout
 *    family only removes old, strictly validated applied+verified receipts
 *    (and abandoned atomic-write temporary files), never a pending receipt or
 *    its stash.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pruneDanglingReceiptIndexEntries } from '../hooks/review-receipt';
import { prWorkflowSessionFileStem } from '../pr-review/persistence.js';
import { isTerminal } from '../services/skill-optimizer/lifecycle';
import type { SkillOptState } from '../services/skill-optimizer/store';
import { cleanupSummaries, listStaleSummaryIds } from '../summaries/manager';
import { log } from '../utils/logger';
import { containsControlChars } from '../utils/path-security';
import type { PruneEntryFilter } from './dir-prune';
import {
	pruneDirectory,
	SUBTREE_SCAN_CAP,
	subtreeNewestFileMtime,
} from './dir-prune';
import { readTailJsonlDetailed } from './jsonl-cap';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default age horizon for keyspace families (30 days). */
export const DEFAULT_FAMILY_AGE_DAYS = 30;
/** Summaries horizon comes from summaries.retention_days (default 7). */
export const DEFAULT_SUMMARIES_RETENTION_DAYS = 7;
/** Age-only backstop for evolution candidates whose state is unreadable. */
export const EVOLUTION_BACKSTOP_AGE_DAYS = 90;
/** Keep-newest caps layered on top of age for high-churn run/batch dirs. */
export const PR_REVIEW_KEEP_NEWEST_RUNS = 50;
export const LANE_RESULTS_KEEP_NEWEST_BATCHES = 100;
export const REVIEW_RECEIPTS_KEEP_NEWEST = 1000;
/** Legacy plan-ledger imports are forensic only; keep a bounded recent window. */
export const LEGACY_LEDGER_ARCHIVES_KEEP_NEWEST = 16;

export interface RetentionSweepOptions {
	/** Clock injection point for tests/checks. */
	now?: number;
	/** Count-and-report without deleting (blast-radius rehearsal / config). */
	dryRun?: boolean;
	/** Honored from `retention.enabled`; when false the sweep is a no-op. */
	enabled?: boolean;
	/** Honored from `summaries.retention_days`. */
	summariesRetentionDays?: number;
	/**
	 * Cooperative stop token, polled between families/passes (review FB-10).
	 * The post-init scheduler flips it when the outer `withTimeout` budget
	 * expires so an in-flight sweep abandons the remaining families instead
	 * of finishing its full pass after the awaiter already moved on.
	 */
	shouldContinue?: () => boolean;
}

export interface RetentionSweepResult {
	pruned: Record<string, number>;
	disabled?: boolean;
	dryRun?: boolean;
	errors: Record<string, string>;
}

interface Family {
	label: string;
	/** Absolute directory this family prunes. */
	dir: string;
	maxAgeMs?: number;
	maxEntries?: number;
	includeEntry?: PruneEntryFilter;
}

// Keep the canonical JSON family and its sidecars separate: locks and
// atomic-write temps are intentionally retained, including after a timed-out
// checkout action. The sidecar suffix is deliberately narrow so an arbitrary
// sibling cannot become age-prunable by sharing the workflow-state stem.
const PR_WORKFLOW_GATE_STATE_STEM = '[A-Za-z0-9_.-]+-[0-9a-f]{12}';
const PR_WORKFLOW_GATE_STATE_NAME = new RegExp(
	`^${PR_WORKFLOW_GATE_STATE_STEM}\\.json$`,
);
const PR_WORKFLOW_GATE_SIDECAR_NAME = new RegExp(
	`^${PR_WORKFLOW_GATE_STATE_STEM}\\.json(?:\\.imported(?:\\.[0-9]+)?|\\.sqlite-projection)$`,
);
const PR_WORKFLOW_CHECKOUT_SESSION_NAME = /^[A-Za-z0-9_.-]+-[0-9a-f]{12}$/;
const PR_WORKFLOW_CHECKOUT_TEMP_NAME =
	/^[0-9a-f]{40,64}\.json\.tmp\.[0-9]+\.[0-9a-f-]{36}$/i;
const PR_WORKFLOW_CHECKOUT_RECEIPT_NAME = /^[0-9a-f]{40,64}\.json$/i;
const PR_WORKFLOW_CHECKOUT_SESSION_SCAN_CAP = 256;
const PR_WORKFLOW_CHECKOUT_ENTRY_SCAN_CAP = 64;
const PR_WORKFLOW_CHECKOUT_RECEIPT_BYTES = 64 * 1024;
const isPrWorkflowGateStateProjection: PruneEntryFilter = (name, stat) =>
	stat.isFile() && PR_WORKFLOW_GATE_STATE_NAME.test(name);
const isPrWorkflowGateSidecar: PruneEntryFilter = (name, stat) =>
	stat.isFile() && PR_WORKFLOW_GATE_SIDECAR_NAME.test(name);

// Route receipts live beside run directories but have an independent
// per-session/task keyspace. Keep the parent run-artifact family from treating
// the whole receipts directory as one entry; each receipt must age out on its
// own even when another project's receipt is still fresh.
const isPrReviewRunArtifact: PruneEntryFilter = (_name, stat) =>
	stat.isDirectory();
const isPrReviewRouteReceipt: PruneEntryFilter = (name, stat) =>
	// Include the pre-encoding sanitized grammar's hyphens so stale receipts
	// from an older plugin are reclaimed too; the directory is already a
	// dedicated containment boundary and only JSON key-shaped files qualify.
	stat.isFile() &&
	(/^[A-Za-z0-9_.~=-]+--[A-Za-z0-9_.~=-]+\.json$/.test(name) ||
		/^sha256_[a-f0-9]{64}\.json$/.test(name));

function familiesFor(swarmRoot: string, now: number): Family[] {
	const age = (days: number) => days * DAY_MS;
	const f = (
		label: string,
		rel: string,
		opts: {
			maxAgeDays?: number;
			maxEntries?: number;
			includeEntry?: PruneEntryFilter;
		},
	): Family => ({
		label,
		dir: path.join(swarmRoot, rel),
		maxAgeMs: opts.maxAgeDays !== undefined ? age(opts.maxAgeDays) : undefined,
		maxEntries: opts.maxEntries,
		includeEntry: opts.includeEntry,
	});
	void now;
	return [
		f('pr-feedback-events', 'pr-feedback-events', { maxAgeDays: 30 }),
		f('pr-workflow-gates', 'pr-workflow-gates', {
			maxAgeDays: 30,
			includeEntry: isPrWorkflowGateStateProjection,
		}),
		f('pr-workflow-gate-sidecars', 'pr-workflow-gates', {
			maxAgeDays: 30,
			includeEntry: isPrWorkflowGateSidecar,
		}),
		f(
			'pr-review-reentry-shadows',
			path.join('pr-review', 'reentry-authorizations'),
			{
				maxAgeDays: 30,
			},
		),
		f('pr-review-run-artifacts', 'pr-review', {
			maxAgeDays: 30,
			maxEntries: PR_REVIEW_KEEP_NEWEST_RUNS,
			includeEntry: (name, stat) =>
				name !== 'route-receipts' && isPrReviewRunArtifact(name, stat),
		}),
		f('pr-review-route-receipts', path.join('pr-review', 'route-receipts'), {
			maxAgeDays: 30,
			includeEntry: isPrReviewRouteReceipt,
		}),
		f('review-receipts', 'review-receipts', {
			maxAgeDays: 30,
			maxEntries: REVIEW_RECEIPTS_KEEP_NEWEST,
		}),
		f('lane-results', 'lane-results', {
			maxAgeDays: 30,
			maxEntries: LANE_RESULTS_KEEP_NEWEST_BATCHES,
		}),
		f('capsules', 'capsules', { maxAgeDays: 30 }),
		f('runs', 'runs', { maxAgeDays: 30 }),
		f('skills-proposals', path.join('skills', 'proposals'), { maxAgeDays: 14 }),
		f('skill-improver-proposals', path.join('skill-improver', 'proposals'), {
			maxAgeDays: 30,
		}),
		f('recovery', 'recovery', { maxAgeDays: 30 }),
	];
}

/**
 * Prune stale keyspace families under `.swarm/`, age-delete the rebuildable
 * epic diagnostics, expire legacy `.imported` doc-drift cold archives, run
 * the summaries retention pass, and prune evolution candidates that reached
 * a terminal lifecycle state (with an age-only backstop). Every family is
 * individually fail-open; the function itself never throws.
 */
export async function runRetentionSweep(
	projectRoot: string,
	options: RetentionSweepOptions = {},
): Promise<RetentionSweepResult> {
	const enabled = options.enabled !== false;
	if (!enabled) {
		return { pruned: {}, disabled: true, errors: {} };
	}
	const now = options.now ?? Date.now();
	const dryRun = options.dryRun === true;
	const swarmRoot = path.join(projectRoot, '.swarm');
	const result: RetentionSweepResult = { pruned: {}, dryRun, errors: {} };

	// Containment guard: the resolved swarm root must sit inside the project
	// root. A symlinked `.swarm` (or a root trick) refuses the whole sweep
	// rather than deleting through the link.
	try {
		const resolvedRoot = fs.realpathSync(projectRoot);
		const resolvedSwarm = fs.realpathSync(swarmRoot);
		if (
			!resolvedSwarm.startsWith(resolvedRoot + path.sep) &&
			resolvedSwarm !== resolvedRoot
		) {
			result.errors.containment = `.swarm resolves outside the project root; refusing sweep`;
			return result;
		}
	} catch (error) {
		// Missing .swarm entirely: nothing to sweep, not an error.
		const code =
			typeof error === 'object' && error !== null && 'code' in error
				? String((error as { code?: unknown }).code)
				: '';
		if (code !== 'ENOENT') {
			result.errors.containment =
				error instanceof Error ? error.message : String(error);
		}
		return result;
	}

	// 1. Directory families (fail-open each). Directory entries are aged by
	// their CONTENT (newest file mtime in the subtree — see dir-prune), so a
	// run/batch/candidate directory whose files are all past the horizon is
	// pruned even when the directory node's own mtime was refreshed by
	// unrelated metadata churn. The optional `shouldContinue` token (review
	// FB-10) is polled before every family AND before every later pass so an
	// externally-cancelled sweep stops promptly instead of finishing its
	// remaining work.
	const cancelled = (label: string): boolean => {
		if (options.shouldContinue && !options.shouldContinue()) {
			result.errors.sweep_cancelled = `sweep cancelled by shouldContinue token before ${label}`;
			return true;
		}
		return false;
	};
	for (const family of familiesFor(swarmRoot, now)) {
		if (cancelled(family.label)) return result;
		try {
			const pruned = await pruneDirectory(family.dir, {
				maxAgeMs: family.maxAgeMs,
				maxEntries: family.maxEntries,
				now,
				dryRun,
				includeEntry: family.includeEntry,
			});
			if (pruned > 0) result.pruned[family.label] = pruned;
		} catch (error) {
			result.errors[family.label] =
				error instanceof Error ? error.message : String(error);
		}
	}

	// 1c. Checkout-preparation receipts and atomic-write residue. Pending or
	// otherwise incomplete receipts remain recovery material. An old receipt is
	// eligible only after its durable state proves that restoration was applied
	// and verified; the safety stash is never inspected or deleted by retention.
	// A bounded directory read fails open when either the session or per-session
	// entry cap is exceeded.
	if (cancelled('pr-workflow-checkout-temps')) return result;
	try {
		const pruned = await prunePrWorkflowCheckoutArtifacts(
			path.join(swarmRoot, 'pr-workflow-checkouts'),
			now,
			dryRun,
		);
		if (pruned.temps > 0)
			result.pruned['pr-workflow-checkout-temps'] = pruned.temps;
		if (pruned.receipts > 0)
			result.pruned['pr-workflow-checkout-receipts'] = pruned.receipts;
	} catch (error) {
		result.errors['pr-workflow-checkout-temps'] =
			error instanceof Error ? error.message : String(error);
	}

	// 1b. Review-receipts index coherence: receipt files pruned above (or by
	// any other actor) must not leave dangling index entries — the manifest
	// is rewritten atomically (temp+rename, same as the append side).
	if (cancelled('review-receipts-index')) return result;
	try {
		const dropped = await pruneDanglingReceiptIndexEntries(projectRoot, {
			dryRun,
		});
		if (dropped > 0) result.pruned['review-receipts-index'] = dropped;
	} catch (error) {
		result.errors['review-receipts-index'] =
			error instanceof Error ? error.message : String(error);
	}

	// 2. Whole-file age deletion for the rebuildable epic diagnostics
	// (divergence re-accumulates on new observations; calibration re-learns;
	// writer-side caps bound them between sweeps).
	if (cancelled('epic-diagnostics')) return result;
	for (const [label, rel] of [
		['epic-divergence', path.join('epic', 'divergence.jsonl')],
		['epic-calibration', path.join('epic', 'calibration.json')],
	] as const) {
		try {
			const filePath = path.join(swarmRoot, rel);
			const stat = await fs.promises.stat(filePath).catch(() => null);
			if (
				stat &&
				stat.mtimeMs <= now &&
				stat.mtimeMs < now - DEFAULT_FAMILY_AGE_DAYS * DAY_MS
			) {
				if (!dryRun) {
					await fs.promises.unlink(filePath).catch(() => undefined);
				}
				result.pruned[label] = 1;
			}
		} catch (error) {
			result.errors[label] =
				error instanceof Error ? error.message : String(error);
		}
	}

	// 3. Legacy `.imported` doc-drift cold archives (post-SQLite-migration).
	if (cancelled('doc-drift-imported')) return result;
	try {
		const legacy = await fs.promises
			.readdir(swarmRoot)
			.then((names) =>
				names.filter((n) => /^doc-drift-phase-\d+\.json\.imported$/.test(n)),
			)
			.catch(() => [] as string[]);
		let legacyPruned = 0;
		for (const name of legacy) {
			const filePath = path.join(swarmRoot, name);
			const stat = await fs.promises.stat(filePath).catch(() => null);
			if (
				stat &&
				stat.mtimeMs <= now &&
				stat.mtimeMs < now - DEFAULT_FAMILY_AGE_DAYS * DAY_MS
			) {
				if (!dryRun) await fs.promises.unlink(filePath).catch(() => undefined);
				legacyPruned += 1;
			}
		}
		if (legacyPruned > 0) result.pruned['doc-drift-imported'] = legacyPruned;
	} catch (error) {
		result.errors['doc-drift-imported'] =
			error instanceof Error ? error.message : String(error);
	}

	// 3b. Legacy plan-ledger archives are immutable recovery inputs, but an
	// import on every old project can otherwise grow without bound. Keep the
	// newest bounded window and age out older entries. Never follow links.
	if (cancelled('legacy-ledger-archives')) return result;
	try {
		const names = (await fs.promises.readdir(swarmRoot)).filter((name) =>
			/^plan-ledger\.legacy-archive\.[0-9a-f]{64}\.jsonl$/.test(name),
		);
		const entries = (
			await Promise.all(
				names.map(async (name) => {
					const filePath = path.join(swarmRoot, name);
					const stat = await fs.promises.lstat(filePath).catch(() => null);
					return stat?.isFile() && !stat.isSymbolicLink()
						? { name, filePath, mtimeMs: stat.mtimeMs }
						: null;
				}),
			)
		)
			.filter(
				(entry): entry is { name: string; filePath: string; mtimeMs: number } =>
					entry !== null,
			)
			.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
		let removed = 0;
		for (const [index, entry] of entries.entries()) {
			if (index < LEGACY_LEDGER_ARCHIVES_KEEP_NEWEST) continue;
			if (
				entry.mtimeMs > now ||
				entry.mtimeMs >= now - DEFAULT_FAMILY_AGE_DAYS * DAY_MS
			)
				continue;
			if (!dryRun)
				await fs.promises.unlink(entry.filePath).catch(() => undefined);
			removed++;
		}
		if (removed > 0) result.pruned['legacy-ledger-archives'] = removed;
	} catch (error) {
		result.errors['legacy-ledger-archives'] =
			error instanceof Error ? error.message : String(error);
	}

	// 4. Evolution candidates: prune a candidate directory when its lifecycle
	// is terminal AND it is older than the family horizon; an age-only
	// backstop (90d) keeps the keyspace finite when state is unreadable.
	if (cancelled('evolution-terminal-candidates')) return result;
	try {
		const evolutionRoot = path.join(swarmRoot, 'evolution', 'skills');
		const pruned = await pruneEvolutionCandidates(evolutionRoot, now, dryRun);
		if (pruned > 0) result.pruned['evolution-terminal-candidates'] = pruned;
	} catch (error) {
		result.errors['evolution-terminal-candidates'] =
			error instanceof Error ? error.message : String(error);
	}

	// 5. `_eval-input` scratch (7d) and quarantine sidecars (30d) under
	// evolution/skills/**.
	if (cancelled('evolution-scratch')) return result;
	try {
		let evalPruned = 0;
		await walkEvolution(
			path.join(swarmRoot, 'evolution', 'skills'),
			async (entryPath, stat) => {
				const base = path.basename(entryPath);
				const isEvalInput = base === '_eval-input' && stat.isDirectory();
				const isQuarantine = base.startsWith('lifecycle-quarantine.');
				if (!isEvalInput && !isQuarantine) return;
				const horizon = isEvalInput
					? 7 * DAY_MS
					: DEFAULT_FAMILY_AGE_DAYS * DAY_MS;
				if (stat.mtimeMs <= now && stat.mtimeMs < now - horizon) {
					if (!dryRun) fs.rmSync(entryPath, { recursive: true, force: true });
					evalPruned += 1;
				}
			},
		);
		if (evalPruned > 0) result.pruned['evolution-scratch'] = evalPruned;
	} catch (error) {
		result.errors['evolution-scratch'] =
			error instanceof Error ? error.message : String(error);
	}

	// 6. Summaries retention (the previously-dead `summaries.retention_days`
	// becomes live through this production call site).
	if (cancelled('summaries-retention')) return result;
	try {
		const retentionDays =
			options.summariesRetentionDays ?? DEFAULT_SUMMARIES_RETENTION_DAYS;
		const before = dryRun
			? await countStaleSummaries(projectRoot, retentionDays, now)
			: 0;
		if (dryRun) {
			if (before > 0) result.pruned['summaries-retention'] = before;
		} else {
			const deleted = await cleanupSummaries(projectRoot, retentionDays, {
				now,
			});
			if (deleted.length > 0)
				result.pruned['summaries-retention'] = deleted.length;
		}
	} catch (error) {
		result.errors['summaries-retention'] =
			error instanceof Error ? error.message : String(error);
	}

	if (Object.keys(result.errors).length > 0) {
		log('retention sweep: per-family failures (non-fatal)', result.errors);
	}
	return result;
}

/**
 * Terminal-state detection from lifecycle.jsonl tail (toState) or state.json.
 * Reads the tail through the DETAILED reader (review FB-11): a torn
 * (unterminated) trailing line makes the ledger tail state UNCERTAIN, so the
 * candidate is not declared terminal from it — the state.json fallback (and
 * ultimately the 90d age-only backstop) owns that decision instead.
 */
async function candidateIsTerminal(candidateDir: string): Promise<boolean> {
	const ledger = await readTailJsonlDetailed<{
		toState?: string;
		type?: string;
	}>(path.join(candidateDir, 'lifecycle.jsonl'), {
		maxEntries: 1,
		maxBytes: 64 * 1024,
	});
	if (!ledger.tailTruncated) {
		const last = ledger.records[ledger.records.length - 1];
		if (last) {
			const state = (last.toState ?? last.type ?? '') as SkillOptState;
			if (isTerminal(state)) return true;
		}
	}
	try {
		const stateJson = JSON.parse(
			await fs.promises.readFile(
				path.join(candidateDir, 'state.json'),
				'utf-8',
			),
		) as { state?: SkillOptState };
		if (isTerminal(stateJson.state ?? null)) return true;
	} catch {
		/* no/unreadable state.json */
	}
	return false;
}

async function pruneEvolutionCandidates(
	evolutionRoot: string,
	now: number,
	dryRun: boolean,
): Promise<number> {
	let pruned = 0;
	const skillDirs = await fs.promises
		.readdir(evolutionRoot)
		.catch(() => [] as string[]);
	for (const skillSlug of skillDirs) {
		const skillDir = path.join(evolutionRoot, skillSlug);
		if (!(await isRealDirectory(skillDir))) continue;
		const candidates = await fs.promises
			.readdir(skillDir)
			.catch(() => [] as string[]);
		for (const candidateId of candidates) {
			const candidateDir = path.join(skillDir, candidateId);
			const stat = await fs.promises.stat(candidateDir).catch(() => null);
			if (!stat || !stat.isDirectory()) continue;
			// Age by CONTENT (newest file in the candidate subtree — the
			// lifecycle.jsonl/state.json writes), not by the directory node's
			// own mtime, which unrelated metadata churn can refresh. Empty
			// candidates fall back to the node mtime; unverifiable ones are kept.
			const newest = subtreeNewestFileMtime(candidateDir, SUBTREE_SCAN_CAP);
			const effectiveMtime = newest === null ? stat.mtimeMs : newest;
			if (effectiveMtime > now) continue; // clock-skew guard
			const ageMs = now - effectiveMtime;
			const terminal = await candidateIsTerminal(candidateDir);
			const eligible =
				(terminal && ageMs > DEFAULT_FAMILY_AGE_DAYS * DAY_MS) ||
				ageMs > EVOLUTION_BACKSTOP_AGE_DAYS * DAY_MS;
			if (!eligible) continue;
			if (!dryRun) fs.rmSync(candidateDir, { recursive: true, force: true });
			pruned += 1;
		}
	}
	return pruned;
}

async function walkEvolution(
	root: string,
	visit: (entryPath: string, stat: fs.Stats) => Promise<void>,
): Promise<void> {
	const entries = await fs.promises.readdir(root).catch(() => [] as string[]);
	for (const name of entries) {
		const entryPath = path.join(root, name);
		// lstat, not stat (review FB-14): a symlinked entry inside evolution/
		// is neither traversed nor visited — the same refusal policy
		// pruneDirectory applies, so the sweep can never age-delete through a
		// link pointing outside `.swarm/`.
		const stat = await fs.promises.lstat(entryPath).catch(() => null);
		if (!stat || stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			await walkEvolution(entryPath, visit);
		}
		await visit(entryPath, stat);
	}
}

/** Read at most `cap` directory names; an over-cap or unreadable directory is unprunable. */
async function readDirectoryNamesBounded(
	directory: string,
	cap: number,
): Promise<string[] | null> {
	let handle: fs.Dir;
	try {
		handle = await fs.promises.opendir(directory);
	} catch {
		return null;
	}
	const names: string[] = [];
	try {
		for (;;) {
			const entry = await handle.read();
			if (!entry) return names;
			if (names.length >= cap) return null;
			names.push(entry.name);
		}
	} catch {
		return null;
	} finally {
		try {
			await handle.close();
		} catch {
			// An unreadable/closed directory is fail-open for retention.
		}
	}
}

/**
 * Remove only stale atomic-write temps below the checkout receipt root.
 * Receipt JSON and all stash-bearing state are intentionally out of scope.
 */
async function prunePrWorkflowCheckoutTemps(
	root: string,
	now: number,
	dryRun: boolean,
): Promise<number> {
	const sessionNames = await readDirectoryNamesBounded(
		root,
		PR_WORKFLOW_CHECKOUT_SESSION_SCAN_CAP,
	);
	if (!sessionNames) return 0;
	const cutoff = now - DEFAULT_FAMILY_AGE_DAYS * DAY_MS;
	let pruned = 0;
	for (const sessionName of sessionNames) {
		if (!PR_WORKFLOW_CHECKOUT_SESSION_NAME.test(sessionName)) continue;
		const sessionPath = path.join(root, sessionName);
		const sessionStat = await fs.promises.lstat(sessionPath).catch(() => null);
		if (
			!sessionStat ||
			sessionStat.isSymbolicLink() ||
			!sessionStat.isDirectory()
		) {
			continue;
		}
		const entryNames = await readDirectoryNamesBounded(
			sessionPath,
			PR_WORKFLOW_CHECKOUT_ENTRY_SCAN_CAP,
		);
		if (!entryNames) continue;
		for (const entryName of entryNames) {
			if (!PR_WORKFLOW_CHECKOUT_TEMP_NAME.test(entryName)) continue;
			const entryPath = path.join(sessionPath, entryName);
			const stat = await fs.promises.lstat(entryPath).catch(() => null);
			if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue;
			if (stat.mtimeMs > now || stat.mtimeMs >= cutoff) continue;
			if (dryRun) {
				pruned += 1;
				continue;
			}
			try {
				await fs.promises.unlink(entryPath);
				pruned += 1;
			} catch {
				// A concurrent writer or cleanup pass owns the race; fail open.
			}
		}
	}
	return pruned;
}

/** Read one checkout receipt with a hard byte bound; malformed receipts are retained. */
async function readBoundedCheckoutReceipt(
	receiptPath: string,
): Promise<{ value: Record<string, unknown>; mtimeMs: number } | null> {
	const stat = await fs.promises.lstat(receiptPath).catch(() => null);
	if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(receiptPath, 'r');
	} catch {
		return null;
	}
	try {
		const buffer = new Uint8Array(PR_WORKFLOW_CHECKOUT_RECEIPT_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > PR_WORKFLOW_CHECKOUT_RECEIPT_BYTES) return null;
		let value: unknown;
		try {
			value = JSON.parse(
				new TextDecoder().decode(buffer.subarray(0, bytesRead)),
			);
		} catch {
			return null;
		}
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return null;
		return { value: value as Record<string, unknown>, mtimeMs: stat.mtimeMs };
	} finally {
		try {
			await handle.close();
		} catch {
			// Retention remains fail-open when a receipt handle cannot be closed.
		}
	}
}

function isStrictlyValidatedAppliedCheckoutReceipt(
	value: Record<string, unknown>,
	stashOid: string,
	sessionStem: string,
): boolean {
	if (
		value.schemaVersion !== 1 ||
		typeof value.sessionID !== 'string' ||
		value.sessionID.length === 0 ||
		prWorkflowSessionFileStem(value.sessionID) !== sessionStem ||
		typeof value.stashOid !== 'string' ||
		value.stashOid.toLowerCase() !== stashOid.toLowerCase() ||
		!Array.isArray(value.paths) ||
		value.paths.length > 64 ||
		value.paths.some(
			(entry) =>
				typeof entry !== 'string' || entry.length === 0 || entry.length > 4096,
		) ||
		typeof value.preparedAt !== 'string' ||
		value.preparedAt.length === 0 ||
		value.preparedAt.length > 64 ||
		(value.mode !== 'PR_REVIEW' && value.mode !== 'PR_FEEDBACK') ||
		!Number.isInteger(value.gateRevision) ||
		(value.gateRevision as number) < 0 ||
		typeof value.gateActivatedAt !== 'string' ||
		value.gateActivatedAt.length === 0 ||
		value.gateActivatedAt.length > 64 ||
		typeof value.originalHead !== 'string' ||
		!/^[0-9a-f]{40,64}$/i.test(value.originalHead) ||
		(value.originalBranch !== null &&
			(typeof value.originalBranch !== 'string' ||
				value.originalBranch.length === 0 ||
				value.originalBranch.length > 240 ||
				value.originalBranch.startsWith('-') ||
				value.originalBranch.startsWith('/') ||
				value.originalBranch.endsWith('/') ||
				value.originalBranch.endsWith('.') ||
				value.originalBranch.endsWith('.lock') ||
				value.originalBranch.includes('..') ||
				value.originalBranch.includes('@{') ||
				value.originalBranch.includes('//') ||
				/[\s~^:?*[\]\\]/.test(value.originalBranch) ||
				containsControlChars(value.originalBranch))) ||
		value.restoreState !== 'applied' ||
		typeof value.restoreAppliedAt !== 'string' ||
		value.restoreAppliedAt.length === 0 ||
		value.restoreAppliedAt.length > 64 ||
		typeof value.restoreVerifiedAt !== 'string' ||
		value.restoreVerifiedAt.length === 0 ||
		value.restoreVerifiedAt.length > 64 ||
		typeof value.restoredHead !== 'string' ||
		!/^[0-9a-f]{40,64}$/i.test(value.restoredHead) ||
		(value.restoredBranch !== null &&
			(typeof value.restoredBranch !== 'string' ||
				value.restoredBranch.length === 0 ||
				value.restoredBranch.length > 240 ||
				value.restoredBranch.startsWith('-') ||
				value.restoredBranch.startsWith('/') ||
				value.restoredBranch.endsWith('/') ||
				value.restoredBranch.endsWith('.') ||
				value.restoredBranch.endsWith('.lock') ||
				value.restoredBranch.includes('..') ||
				value.restoredBranch.includes('@{') ||
				value.restoredBranch.includes('//') ||
				/[\s~^:?*[\]\\]/.test(value.restoredBranch) ||
				containsControlChars(value.restoredBranch)))
	) {
		return false;
	}
	return true;
}

/**
 * Age-prune only receipts that prove a completed, verified restoration. Pending,
 * incomplete, malformed, oversized, future-dated, and concurrently changed
 * receipts remain available for explicit recovery. Stashes are never touched.
 */
async function prunePrWorkflowCheckoutReceipts(
	root: string,
	now: number,
	dryRun: boolean,
): Promise<number> {
	const sessionNames = await readDirectoryNamesBounded(
		root,
		PR_WORKFLOW_CHECKOUT_SESSION_SCAN_CAP,
	);
	if (!sessionNames) return 0;
	const cutoff = now - DEFAULT_FAMILY_AGE_DAYS * DAY_MS;
	let pruned = 0;
	for (const sessionName of sessionNames) {
		if (!PR_WORKFLOW_CHECKOUT_SESSION_NAME.test(sessionName)) continue;
		const sessionPath = path.join(root, sessionName);
		const sessionStat = await fs.promises.lstat(sessionPath).catch(() => null);
		if (
			!sessionStat ||
			sessionStat.isSymbolicLink() ||
			!sessionStat.isDirectory()
		) {
			continue;
		}
		const entryNames = await readDirectoryNamesBounded(
			sessionPath,
			PR_WORKFLOW_CHECKOUT_ENTRY_SCAN_CAP,
		);
		if (!entryNames) continue;
		for (const entryName of entryNames) {
			if (!PR_WORKFLOW_CHECKOUT_RECEIPT_NAME.test(entryName)) continue;
			const receiptPath = path.join(sessionPath, entryName);
			const receipt = await readBoundedCheckoutReceipt(receiptPath);
			if (
				!receipt ||
				!isStrictlyValidatedAppliedCheckoutReceipt(
					receipt.value,
					entryName.slice(0, -'.json'.length),
					sessionName,
				)
			) {
				continue;
			}
			const verifiedAt = Date.parse(receipt.value.restoreVerifiedAt as string);
			if (
				!Number.isFinite(verifiedAt) ||
				verifiedAt > now ||
				verifiedAt >= cutoff
			) {
				continue;
			}
			if (dryRun) {
				pruned += 1;
				continue;
			}
			const beforeDelete = await fs.promises
				.lstat(receiptPath)
				.catch(() => null);
			if (
				!beforeDelete ||
				beforeDelete.isSymbolicLink() ||
				!beforeDelete.isFile() ||
				beforeDelete.mtimeMs !== receipt.mtimeMs
			) {
				continue;
			}
			try {
				await fs.promises.unlink(receiptPath);
				pruned += 1;
			} catch {
				// A concurrent writer or recovery pass owns the race; fail open.
			}
		}
	}
	return pruned;
}

async function prunePrWorkflowCheckoutArtifacts(
	root: string,
	now: number,
	dryRun: boolean,
): Promise<{ temps: number; receipts: number }> {
	return {
		temps: await prunePrWorkflowCheckoutTemps(root, now, dryRun),
		receipts: await prunePrWorkflowCheckoutReceipts(root, now, dryRun),
	};
}

async function isRealDirectory(dir: string): Promise<boolean> {
	try {
		const stat = fs.lstatSync(dir);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Dry-run helper: count summaries past the horizon without deleting.
 * Delegates to the manager's shared `listStaleSummaryIds` predicate (review
 * FB-9) so the rehearsal counter and `cleanupSummaries` can never diverge —
 * the previous mtime-only duplicate here mispredicted staleness for any
 * summary whose content carries a numeric timestamp (content wins there).
 */
async function countStaleSummaries(
	projectRoot: string,
	retentionDays: number,
	now: number,
): Promise<number> {
	const staleIds = await listStaleSummaryIds(projectRoot, retentionDays, {
		now,
	});
	return staleIds.length;
}
