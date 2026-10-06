/**
 * Epic v2 lifecycle (C1a): one open epic per project, bound to one plan.
 *
 * Authority: the coordination row in namespace {@link EPIC_LIFECYCLE_NAMESPACE}
 * (entity key = epicKey). The sentinel `.swarm/epic/epic.json` is a JSON
 * projection of that row whose only job is to make "Epic is off" cost exactly
 * ONE `existsSync` on every hot-path seam: a project that never opened an
 * epic has no sentinel, so no probe ever opens swarm.db, reads config, or
 * reads the plan.
 *
 * Probe order (`getOpenEpic`): sentinel → row → config → identity. No memo,
 * no migration, no writes. A row whose plan identity no longer matches the
 * current plan (plan renamed or replaced — a new ledger root) is ORPHANED:
 * the probe answers "no open epic"; `/swarm epic status` explains and
 * `/swarm epic close --abandon` repairs.
 *
 * Lifecycle lock (M-d): every sentinel mutation runs INSIDE the coordination
 * store's `BEGIN IMMEDIATE` transaction (`withCoordinationTransaction`), so
 * the row write and the sentinel write/delete are serialized against every
 * other lifecycle writer in every process:
 *   - start: only the CAS winner (row created with expectedRevision null)
 *     writes the sentinel; a sentinel-write failure rolls the row back.
 *   - close/repair: the row is deleted (revision CAS) and the sentinel is
 *     removed only when it still names the same epicKey + token
 *     (compare-and-delete), so a late close can never delete a newer epic's
 *     sentinel.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
	deleteCoordinationStateWithinTransaction,
	getCoordinationStateRaw,
	listCoordinationStateKeys,
	listCoordinationStates,
	transitionCoordinationState,
	transitionCoordinationStateWithinTransaction,
	withCoordinationTransaction,
} from '../db/coordination-store.js';
import { projectDbExists } from '../db/project-db.js';
import { derivePlanId, derivePlanIdentityHash } from '../plan/utils.js';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write.js';
import * as logger from '../utils/logger.js';
import type { EpicWaveComponents } from './components.js';
import { isEpicModeConfigEnabledForDirectory } from './config-gate.js';
import type { EpicSizingVerdict } from './sizing.js';

/** Coordination namespace of the authoritative epic row. */
export const EPIC_LIFECYCLE_NAMESPACE = 'turbo.epic.lifecycle';

/** Project-relative path of the sentinel projection. */
export const EPIC_SENTINEL_RELATIVE_PATH = path.join(
	'.swarm',
	'epic',
	'epic.json',
);

/** Project-relative path of the plan ledger (identity proxy for the epoch). */
const PLAN_LEDGER_RELATIVE_PATH = path.join('.swarm', 'plan-ledger.jsonl');
const PLAN_JSON_RELATIVE_PATH = path.join('.swarm', 'plan.json');

/** Bounded reads on the probe path (only reached when an epic is open). */
const MAX_PLAN_JSON_BYTES = 8 * 1024 * 1024;
const MAX_LEDGER_ROOT_LINE_BYTES = 1024 * 1024;
const MAX_SENTINEL_BYTES = 64 * 1024;
/** Rows read per lifecycle listing; >1 open row is itself corruption. */
const LIFECYCLE_ROW_LIST_LIMIT = 8;

export type EpicLifecycleStatus = 'open' | 'closing';

/** One co-change pair recorded with a wave (threshold-passing, in-wave). */
export interface EpicCochangePair {
	fileA: string;
	fileB: string;
	npmi: number;
	coChangeCount: number;
}

/** Snapshot of a worktree merge-back failure observed for a wave task. */
export interface EpicMergeFailureSnapshot {
	outcome: string;
	stage: string;
	message: string;
	at: number | null;
}

/**
 * One wave issued by `epic_next_wave` (Epic v2 C2). `files` are the FROZEN
 * declared scopes of the wave's tasks at issue time; later commits compare
 * against them (divergence now, the dispatch gate in C4).
 */
export interface EpicWaveRecord {
	seq: number;
	phase: number;
	/**
	 * `parallel` (tasks of conflict-free components), `exclusive` (a task
	 * that runs alone), or `serial-component` (one task of a densely coupled
	 * component; no other ready task could join it). See `components.ts`.
	 */
	kind: 'parallel' | 'exclusive' | 'serial-component';
	taskIds: string[];
	files: Record<string, string[]>;
	/** ≤ 256 threshold-passing pairs within the wave's files; null = co-change off. */
	cochange: {
		pairs: EpicCochangePair[];
		threshold: { npmi: number; minCoChanges: number };
	} | null;
	/**
	 * Epic v2 C5: the phase's components when the wave was issued (pending
	 * task → component, component modes/densities). Absent on waves issued
	 * before C5.
	 */
	components?: EpicWaveComponents;
	/** HEAD when the wave was issued (null: non-git / unborn). */
	baseHead: string | null;
	issuedAt: string;
	closedAt?: string;
	closeHead?: string | null;
	status: 'issued' | 'closed' | 'aborted';
	abortReason?: string;
	/** Merge-back failures observed while the wave was blocked (snapshots). */
	mergeFailures?: Record<string, EpicMergeFailureSnapshot>;
	/**
	 * Wave-level undeclared files from the git fallback (changed since
	 * `baseHead`, not declared by any wave task, not attributed to a task).
	 */
	undeclared?: string[];
}

/** How one wave task was resolved, recorded when its wave closes. */
export interface EpicTaskOutcome {
	taskId: string;
	phase: number;
	waveSeq: number;
	resolution: 'completed' | 'closed' | 'removed';
	resolvedAt: string;
	/** Evidence workflow generation (uncapped; 0 = no evidence). */
	generation: number;
	/**
	 * LOWER BOUNDS: `stage_a_failed` / `stage_b_failed` entries in the
	 * evidence workflow `retryHistory`, which keeps only the last 3 entries.
	 */
	stageAFailures: number;
	stageBFailures: number;
	/** Merge-back failure snapshot observed while the wave was blocked. */
	mergeFailure: {
		outcome: string;
		stage: string;
	} | null;
	declared: string[];
	undeclared: string[];
	/** Where `undeclared` came from. */
	attribution: 'session' | 'git-single-task' | 'unavailable' | 'no-git';
	/** Ledger transitions out of `completed` for this task since the epic started. */
	reopened: number;
	/**
	 * Epic v2 C6: the counters of this task's earlier outcome when it ran
	 * again (reopened) — learning charges only the delta.
	 */
	previous?: {
		waveSeq: number;
		generation: number;
		stageBFailures: number;
		reopened: number;
	};
	/**
	 * The commit proving the task's work is on the epic branch (Epic v2 C3),
	 * mirrored to `ref` (`refs/swarm/epics/<epicKey>/tasks/<id>`, see
	 * `markers.ts`): the task's newest `swarm(task <id>):` commit for this
	 * plan inside the wave (`landing-commit` — its coder's landing merge or a
	 * residue commit), else HEAD at wave close (`wave-close-head`), or a
	 * commit re-adopted by `/swarm epic status --repair-refs` (`repaired`).
	 * Completed tasks only; `no-git` epics record no commit.
	 */
	marker: {
		ref: string | null;
		sha: string | null;
		provenance: EpicTaskMarkerProvenance;
	} | null;
}

export type EpicTaskMarkerProvenance =
	| 'landing-commit'
	| 'wave-close-head'
	| 'repaired'
	| 'no-git';

/** Per-phase lifecycle as seen by `epic_next_wave` / `epic_phase_review`. */
export interface EpicPhaseRecord {
	status: 'active' | 'review' | 'complete';
	/** True when the phase was already finished when the epic started. */
	completeAtStart?: boolean;
	reviewRuns: number;
	/** Newest last; at most {@link EPIC_PHASE_VERDICTS_KEEP}. */
	verdicts: string[];
}

/** Phase-review verdict strings kept per phase in the record. */
export const EPIC_PHASE_VERDICTS_KEEP = 20;

/**
 * Where an epic's commits go (`epic.commit_policy`, default
 * `epic-branch`): a dedicated `swarm/epic/<epicKey>` branch checked out at
 * start and landed at close, or the branch that was current at start.
 */
export type EpicCommitPolicy = 'epic-branch' | 'current-branch';

/** How `/swarm epic close` lands the epic branch (default `squash`). */
export type EpicLandMode = 'squash' | 'merge' | 'none';

export interface EpicRecordConfig {
	/** Non-git epics always record 'current-branch' (nothing to branch). */
	commitPolicy: EpicCommitPolicy;
	isolation: 'worktree' | 'main-tree-nogit';
	/** Wave width cap honoured by `epic_next_wave` (1 for non-git, M-i). */
	maxParallel: number;
}

export interface EpicRecordGit {
	isRepo: boolean;
	baseCommit: string | null;
	originalBranch: string | null;
	/**
	 * `swarm/epic/<epicKey>` — written ONLY after `git checkout -b` succeeded
	 * (M-e); null for current-branch / non-git epics.
	 */
	epicBranch: string | null;
}

/** A landing attempt that did not land (close stays resumable). */
export interface EpicLandingAttempt {
	mode: EpicLandMode;
	status: 'conflict' | 'failed';
	at: string;
	conflictFiles: string[];
	detail: string;
}

export interface EpicClosingInfo {
	requestedAt: string;
	outcome: EpicCloseOutcome;
	/** Landing mode of the latest close request (null: abandon / no branch). */
	land: EpicLandMode | null;
	/** Last landing attempt that failed; null until one fails. */
	lastLandingAttempt: EpicLandingAttempt | null;
}

export type EpicCloseOutcome =
	| 'completed'
	| 'abandoned'
	| 'abandoned-by-swarm-close';

export interface EpicRecordV1 {
	schema: 'epic-record-v1';
	epicKey: string;
	/** Per-start nonce; the sentinel compare-and-delete matches it too. */
	token: string;
	planId: string;
	planIdentityHash: string;
	planEpoch: string | null;
	planKey: string;
	/** sha256 of the plan ledger's root line (sync epoch proxy); null = no ledger. */
	ledgerRootDigest: string | null;
	status: EpicLifecycleStatus;
	startedAt: string;
	startedBySession: string;
	forced: boolean;
	structureHashAtStart: string;
	config: EpicRecordConfig;
	git: EpicRecordGit;
	sizing: EpicSizingVerdict;
	/**
	 * Epic v2 C6: sha256 of the project prior (`.swarm/epic-prior/
	 * learning.json`) the epic's posterior was copied from at start; null
	 * when there was no readable prior or learning is disabled.
	 */
	priorDigest: string | null;
	closing: EpicClosingInfo | null;
	/** Waves issued by `epic_next_wave`, in issue order (Epic v2 C2). */
	waves: EpicWaveRecord[];
	/** Seq of the wave currently issued and not yet closed. */
	activeWaveSeq: number | null;
	/** Outcome of every task resolved through a closed wave, by task id. */
	tasks: Record<string, EpicTaskOutcome>;
	/** Phase lifecycle keyed by phase id (string). */
	phases: Record<string, EpicPhaseRecord>;
}

/** Sentinel projection: enough to identify the row it mirrors. */
export interface EpicSentinel {
	schema: 'epic-sentinel-v1';
	epicKey: string;
	token: string;
	planId: string;
	startedAt: string;
}

/** Raised when the lifecycle row exists but cannot be trusted. */
export class EpicStateUnreadableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EpicStateUnreadableError';
	}
}

const sizingSchema = z
	.object({
		epicSized: z.boolean(),
		reasons: z.array(z.string()),
	})
	.passthrough();

const waveSchema = z
	.object({
		seq: z.number().int().min(1),
		phase: z.number().int(),
		kind: z.enum(['parallel', 'exclusive', 'serial-component']),
		taskIds: z.array(z.string()),
		files: z.record(z.string(), z.array(z.string())),
		cochange: z
			.object({
				pairs: z.array(
					z
						.object({
							fileA: z.string(),
							fileB: z.string(),
							npmi: z.number(),
							coChangeCount: z.number(),
						})
						.passthrough(),
				),
				threshold: z.object({ npmi: z.number(), minCoChanges: z.number() }),
			})
			.nullable(),
		components: z
			.object({
				byTask: z.record(z.string(), z.string()),
				modes: z.record(
					z.string(),
					z.enum(['exclusive', 'serial-component', 'parallel']),
				),
				density: z.record(z.string(), z.number()),
				exclusive: z.record(
					z.string(),
					z
						// Pre-C6 records named the learned reason `hot-module`.
						.enum([
							'global-file',
							'protected-path',
							'no-scope',
							'hot-file',
							'hot-module',
						])
						.transform((reason) =>
							reason === 'hot-module' ? ('hot-file' as const) : reason,
						),
				),
				threshold: z.number(),
				truncated: z.boolean(),
			})
			.passthrough()
			.optional(),
		baseHead: z.string().nullable(),
		issuedAt: z.string(),
		closedAt: z.string().optional(),
		closeHead: z.string().nullable().optional(),
		status: z.enum(['issued', 'closed', 'aborted']),
		abortReason: z.string().optional(),
		mergeFailures: z
			.record(
				z.string(),
				z
					.object({
						outcome: z.string(),
						stage: z.string(),
						message: z.string(),
						at: z.number().nullable(),
					})
					.passthrough(),
			)
			.optional(),
		undeclared: z.array(z.string()).optional(),
	})
	.passthrough();

const taskOutcomeSchema = z
	.object({
		taskId: z.string(),
		phase: z.number().int(),
		waveSeq: z.number().int(),
		resolution: z.enum(['completed', 'closed', 'removed']),
		resolvedAt: z.string(),
		generation: z.number(),
		stageAFailures: z.number(),
		stageBFailures: z.number(),
		mergeFailure: z
			.object({
				outcome: z.string(),
				stage: z.string(),
			})
			// Records written before C6 carry an always-empty `conflictFiles`.
			.passthrough()
			.nullable(),
		declared: z.array(z.string()),
		undeclared: z.array(z.string()),
		attribution: z.enum([
			'session',
			'git-single-task',
			'unavailable',
			'no-git',
		]),
		reopened: z.number(),
		previous: z
			.object({
				waveSeq: z.number(),
				generation: z.number(),
				stageBFailures: z.number(),
				reopened: z.number(),
			})
			.optional(),
		marker: z
			.object({
				ref: z.string().nullable(),
				sha: z.string().nullable(),
				provenance: z.enum([
					'landing-commit',
					'wave-close-head',
					'repaired',
					'no-git',
				]),
			})
			.nullable(),
	})
	.passthrough();

const phaseRecordSchema = z
	.object({
		status: z.enum(['active', 'review', 'complete']),
		completeAtStart: z.boolean().optional(),
		reviewRuns: z.number().int().min(0),
		verdicts: z.array(z.string()),
	})
	.passthrough();

const recordSchema = z
	.object({
		schema: z.literal('epic-record-v1'),
		epicKey: z.string().min(1),
		token: z.string().min(1),
		planId: z.string().min(1),
		planIdentityHash: z.string().min(1),
		planEpoch: z.string().nullable(),
		planKey: z.string().min(1),
		ledgerRootDigest: z.string().nullable(),
		status: z.enum(['open', 'closing']),
		startedAt: z.string().min(1),
		startedBySession: z.string(),
		forced: z.boolean(),
		structureHashAtStart: z.string(),
		config: z
			.object({
				commitPolicy: z.enum(['epic-branch', 'current-branch']),
				isolation: z.enum(['worktree', 'main-tree-nogit']),
				maxParallel: z.number().int().min(1),
			})
			.passthrough(),
		git: z
			.object({
				isRepo: z.boolean(),
				baseCommit: z.string().nullable(),
				originalBranch: z.string().nullable(),
				epicBranch: z.string().nullable().default(null),
			})
			.passthrough(),
		sizing: sizingSchema,
		priorDigest: z.string().nullable().default(null),
		closing: z
			.object({
				requestedAt: z.string(),
				outcome: z.enum(['completed', 'abandoned', 'abandoned-by-swarm-close']),
				land: z.enum(['squash', 'merge', 'none']).nullable().default(null),
				lastLandingAttempt: z
					.object({
						mode: z.enum(['squash', 'merge', 'none']),
						status: z.enum(['conflict', 'failed']),
						at: z.string(),
						conflictFiles: z.array(z.string()),
						detail: z.string(),
					})
					.nullable()
					.default(null),
			})
			.nullable(),
		waves: z.array(waveSchema).default([]),
		activeWaveSeq: z.number().int().nullable().default(null),
		tasks: z.record(z.string(), taskOutcomeSchema).default({}),
		phases: z.record(z.string(), phaseRecordSchema).default({}),
	})
	.passthrough();

const sentinelSchema = z
	.object({
		schema: z.literal('epic-sentinel-v1'),
		epicKey: z.string().min(1),
		token: z.string().min(1),
		planId: z.string(),
		startedAt: z.string(),
	})
	.passthrough();

/**
 * DI seam (AGENTS.md invariant 7). Restore in `afterEach`.
 */
export const _internals = {
	isEpicModeConfigEnabledForDirectory,
	now: (): number => Date.now(),
	/** Bounded warn-once set so a corrupt row does not spam every probe. */
	warnedDirectories: new Set<string>(),
};

const MAX_WARNED_DIRECTORIES = 64;

function hasTraversalSegment(directory: string): boolean {
	return directory.split(/[\\/]/).includes('..');
}

export function epicSentinelPath(directory: string): string {
	return path.join(directory, EPIC_SENTINEL_RELATIVE_PATH);
}

/**
 * The one hot-path check: does the sentinel exist? Exactly one `existsSync`.
 * Never follows raw `..` segments into an ancestor's `.swarm/`.
 */
export function epicSentinelExists(directory: string): boolean {
	// Hook callers may hand a non-string directory (adversarial inputs): no
	// epic, never a throw.
	if (typeof directory !== 'string' || !directory) return false;
	if (hasTraversalSegment(directory)) return false;
	return fs.existsSync(epicSentinelPath(directory));
}

/** Ref-safe, filename-safe epic key: `<planId≤40>-<planKey≤12>`. */
export function computeEpicKey(planId: string, planKey: string): string {
	const safeId = planId
		.replace(/[^A-Za-z0-9_-]/g, '_')
		.replace(/^[-_.]+/, '')
		.slice(0, 40);
	return `${safeId.length > 0 ? safeId : 'plan'}-${planKey.slice(0, 12)}`;
}

/** Identity fields of the current plan used for the orphan check. */
export interface EpicPlanIdentity {
	planId: string;
	planIdentityHash: string;
}

export function planIdentityOf(plan: {
	swarm: string;
	title: string;
}): EpicPlanIdentity {
	return {
		planId: derivePlanId(plan),
		planIdentityHash: derivePlanIdentityHash(plan),
	};
}

function readBoundedUtf8(filePath: string, maxBytes: number): string | null {
	let fd: number | null = null;
	try {
		fd = fs.openSync(filePath, 'r');
		const buffer = Buffer.alloc(maxBytes);
		const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.subarray(0, read).toString('utf-8');
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				// best-effort
			}
		}
	}
}

/**
 * sha256 of the plan ledger's first line. The ledger is append-only and a
 * new plan (save_plan of a different plan, reset, recovery re-root) starts a
 * new root line, so the digest is a synchronous proxy for the plan epoch.
 * Returns null when there is no ledger.
 */
export function readLedgerRootDigest(directory: string): string | null {
	const ledgerPath = path.join(directory, PLAN_LEDGER_RELATIVE_PATH);
	if (!fs.existsSync(ledgerPath)) return null;
	const head = readBoundedUtf8(ledgerPath, MAX_LEDGER_ROOT_LINE_BYTES);
	if (head === null) return 'unreadable';
	const newline = head.indexOf('\n');
	const rootLine = (newline >= 0 ? head.slice(0, newline) : head).replace(
		/\r$/,
		'',
	);
	if (rootLine.trim().length === 0) return null;
	return createHash('sha256').update(rootLine, 'utf8').digest('hex');
}

/** Synchronous, bounded read of the current plan identity from plan.json. */
export function readCurrentPlanIdentity(
	directory: string,
): EpicPlanIdentity | null {
	const planPath = path.join(directory, PLAN_JSON_RELATIVE_PATH);
	try {
		const stat = fs.statSync(planPath);
		if (!stat.isFile() || stat.size > MAX_PLAN_JSON_BYTES) return null;
		const parsed = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as unknown;
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			typeof (parsed as { swarm?: unknown }).swarm !== 'string' ||
			typeof (parsed as { title?: unknown }).title !== 'string'
		) {
			return null;
		}
		return planIdentityOf(parsed as { swarm: string; title: string });
	} catch {
		return null;
	}
}

export function parseEpicRecord(payload: string): EpicRecordV1 {
	let raw: unknown;
	try {
		raw = JSON.parse(payload);
	} catch (error) {
		throw new EpicStateUnreadableError(
			`Epic lifecycle row is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const parsed = recordSchema.safeParse(raw);
	if (!parsed.success) {
		throw new EpicStateUnreadableError(
			`Epic lifecycle row has an unexpected shape: ${parsed.error.issues
				.slice(0, 3)
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		);
	}
	// Pre-C2 rows carried `lastDecision` (the removed epic_decide_phase
	// verdict); drop it so a later update does not carry it forward.
	const { lastDecision: _retired, ...record } = parsed.data as Record<
		string,
		unknown
	>;
	return record as unknown as EpicRecordV1;
}

/** Read and validate the sentinel; null when absent, invalid, or oversized. */
export function readEpicSentinel(directory: string): EpicSentinel | null {
	const text = readBoundedUtf8(epicSentinelPath(directory), MAX_SENTINEL_BYTES);
	if (text === null) return null;
	try {
		const parsed = sentinelSchema.safeParse(JSON.parse(text));
		return parsed.success ? (parsed.data as unknown as EpicSentinel) : null;
	} catch {
		return null;
	}
}

interface LifecycleRow {
	entityKey: string;
	revision: number;
	generation: number;
	status: string;
	payload: string;
	updatedAt: string;
}

function listLifecycleRows(directory: string): LifecycleRow[] {
	try {
		return listCoordinationStates(
			directory,
			EPIC_LIFECYCLE_NAMESPACE,
			LIFECYCLE_ROW_LIST_LIMIT,
		);
	} catch (error) {
		throw new EpicStateUnreadableError(
			`Epic lifecycle rows could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Why a row-backed epic is not usable for the current plan. */
export type EpicOrphanReason =
	| 'plan-missing'
	| 'plan-renamed-or-replaced'
	| 'plan-ledger-replaced';

/** Pure identity comparison (exported for tests and status). */
export function evaluateEpicIdentity(
	record: EpicRecordV1,
	current: EpicPlanIdentity | null,
	ledgerRootDigest: string | null,
): EpicOrphanReason | null {
	if (current === null) return 'plan-missing';
	if (current.planIdentityHash !== record.planIdentityHash) {
		return 'plan-renamed-or-replaced';
	}
	if (ledgerRootDigest !== record.ledgerRootDigest) {
		return 'plan-ledger-replaced';
	}
	return null;
}

/** Full diagnostic view used by `/swarm epic status` / close / repair. */
export interface EpicInspection {
	sentinelPresent: boolean;
	sentinel: EpicSentinel | null;
	/** Validated record (null when no row, or when `unreadable` is set). */
	record: EpicRecordV1 | null;
	/** Row entity keys present (even when unparseable). */
	rowKeys: string[];
	unreadable: string | null;
	orphanReason: EpicOrphanReason | null;
	configEnabled: boolean;
}

/**
 * Inspect every piece of lifecycle state without writing. Unlike the probe
 * it reads rows even when the sentinel is absent (repair needs that), so it
 * is only for `/swarm epic *` and `/swarm close` finalization. Opens the DB
 * only when swarm.db already exists.
 */
export function inspectEpic(
	directory: string,
	plan?: { swarm: string; title: string } | null,
): EpicInspection {
	const sentinelPresent = epicSentinelExists(directory);
	const sentinel = sentinelPresent ? readEpicSentinel(directory) : null;
	const inspection: EpicInspection = {
		sentinelPresent,
		sentinel,
		record: null,
		rowKeys: [],
		unreadable: null,
		orphanReason: null,
		configEnabled: _internals.isEpicModeConfigEnabledForDirectory(directory),
	};
	if (hasTraversalSegment(directory) || !projectDbExists(directory)) {
		return inspection;
	}
	let rows: LifecycleRow[];
	try {
		rows = listLifecycleRows(directory);
	} catch (error) {
		inspection.unreadable =
			error instanceof Error ? error.message : String(error);
		try {
			inspection.rowKeys = listLifecycleRowsRawKeys(directory);
		} catch {
			// keys stay unknown; the unreadable message already says why
		}
		return inspection;
	}
	inspection.rowKeys = rows.map((row) => row.entityKey);
	if (rows.length === 0) return inspection;
	if (rows.length > 1) {
		inspection.unreadable = `multiple Epic lifecycle rows present (${inspection.rowKeys.join(', ')})`;
		return inspection;
	}
	try {
		const record = parseEpicRecord(rows[0].payload);
		if (record.epicKey !== rows[0].entityKey) {
			throw new EpicStateUnreadableError(
				`Epic lifecycle row key ${rows[0].entityKey} does not match its payload epicKey ${record.epicKey}`,
			);
		}
		inspection.record = record;
		inspection.orphanReason = evaluateEpicIdentity(
			record,
			plan ? planIdentityOf(plan) : readCurrentPlanIdentity(directory),
			readLedgerRootDigest(directory),
		);
	} catch (error) {
		inspection.unreadable =
			error instanceof Error ? error.message : String(error);
	}
	return inspection;
}

/**
 * The open epic for the current plan, or null. Probe order: sentinel → row →
 * config → identity; no memo, no writes. Throws {@link EpicStateUnreadableError}
 * when the sentinel exists and the row is present but untrustworthy.
 *
 * @param plan - when supplied, its identity is used instead of reading
 *        `.swarm/plan.json`.
 */
export function getOpenEpic(
	directory: string,
	plan?: { swarm: string; title: string } | null,
): EpicRecordV1 | null {
	// (1) sentinel — the ONLY I/O when Epic is off.
	if (!epicSentinelExists(directory)) return null;
	// (2) row.
	if (!projectDbExists(directory)) return null;
	const rows = listLifecycleRows(directory);
	if (rows.length === 0) return null;
	if (rows.length > 1) {
		throw new EpicStateUnreadableError(
			`multiple Epic lifecycle rows present (${rows.map((row) => row.entityKey).join(', ')})`,
		);
	}
	const record = parseEpicRecord(rows[0].payload);
	if (record.epicKey !== rows[0].entityKey) {
		throw new EpicStateUnreadableError(
			`Epic lifecycle row key ${rows[0].entityKey} does not match its payload epicKey ${record.epicKey}`,
		);
	}
	if (record.status !== 'open') return null;
	// (3) config master gate.
	if (!_internals.isEpicModeConfigEnabledForDirectory(directory)) return null;
	// (4) identity — orphaned epics are not open.
	const orphan = evaluateEpicIdentity(
		record,
		plan ? planIdentityOf(plan) : readCurrentPlanIdentity(directory),
		readLedgerRootDigest(directory),
	);
	return orphan === null ? record : null;
}

function warnUnreadableOnce(directory: string, message: string): void {
	const key = path.resolve(directory);
	if (_internals.warnedDirectories.has(key)) return;
	if (_internals.warnedDirectories.size >= MAX_WARNED_DIRECTORIES) {
		const oldest = _internals.warnedDirectories.values().next().value;
		if (oldest !== undefined) _internals.warnedDirectories.delete(oldest);
	}
	_internals.warnedDirectories.add(key);
	logger.criticalWarn(
		`[epic] Epic lifecycle state is unreadable for ${directory}: ${message}. Epic behaviour is OFF until repaired — run \`/swarm epic status\` (diagnose) or \`/swarm epic close --abandon\` (repair).`,
	);
}

/**
 * Boolean probe for hot-path seams. Sentinel-first (one `existsSync` when
 * Epic is off); corrupt state ⇒ false + one critical warning per directory.
 */
export function isEpicOpenForProject(directory: string): boolean {
	try {
		return getOpenEpic(directory) !== null;
	} catch (error) {
		warnUnreadableOnce(
			directory,
			error instanceof Error ? error.message : String(error),
		);
		return false;
	}
}

function writeSentinelFile(directory: string, sentinel: EpicSentinel): void {
	const target = epicSentinelPath(directory);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	atomicWriteSwarmFileSync(target, `${JSON.stringify(sentinel, null, 2)}\n`);
}

function sentinelFor(record: EpicRecordV1): EpicSentinel {
	return {
		schema: 'epic-sentinel-v1',
		epicKey: record.epicKey,
		token: record.token,
		planId: record.planId,
		startedAt: record.startedAt,
	};
}

/** Unlink the sentinel; an already-missing file is not an error. */
function unlinkSentinel(directory: string): void {
	try {
		fs.unlinkSync(epicSentinelPath(directory));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}

/** Compare-and-delete: unlink only when the sentinel names this epic. */
function deleteSentinelIfMatches(
	directory: string,
	epicKey: string,
	token: string | null,
): boolean {
	const current = readEpicSentinel(directory);
	const present = epicSentinelExists(directory);
	if (!present) return false;
	if (current !== null) {
		if (current.epicKey !== epicKey) return false;
		if (token !== null && current.token !== token) return false;
	}
	// An unparseable sentinel cannot name another epic: remove it.
	unlinkSentinel(directory);
	return true;
}

export type EpicCreateOutcome =
	| { outcome: 'created'; record: EpicRecordV1 }
	| { outcome: 'exists'; existingKeys: string[] };

/**
 * CAS-create the epic row and (as the winner only) write the sentinel, both
 * under the lifecycle lock. A sentinel-write failure rolls the row back.
 */
export function createEpicRecord(
	directory: string,
	record: EpicRecordV1,
): EpicCreateOutcome {
	return withCoordinationTransaction(directory, () => {
		const existing = listLifecycleRowsRawKeys(directory);
		if (existing.length > 0) {
			return { outcome: 'exists', existingKeys: existing } as const;
		}
		const result = transitionCoordinationStateWithinTransaction(directory, {
			namespace: EPIC_LIFECYCLE_NAMESPACE,
			entityKey: record.epicKey,
			expectedRevision: null,
			generation: 1,
			status: record.status,
			payload: JSON.stringify(record),
		});
		if (result.outcome !== 'applied') {
			return { outcome: 'exists', existingKeys: [record.epicKey] } as const;
		}
		writeSentinelFile(directory, sentinelFor(record));
		return { outcome: 'created', record } as const;
	});
}

/** Row keys without payload validation (repair must see corrupt rows). */
function listLifecycleRowsRawKeys(directory: string): string[] {
	return listCoordinationStateKeys(
		directory,
		EPIC_LIFECYCLE_NAMESPACE,
		LIFECYCLE_ROW_LIST_LIMIT,
	);
}

/** Bounded CAS retries for record mutations. */
const MAX_RECORD_UPDATE_ATTEMPTS = 5;

/**
 * The epic row would outgrow the store payload cap. Distinct from a generic
 * store failure so callers can surface the remedy instead of the raw
 * `payload must contain 1..1048576 characters`.
 */
export class EpicRecordTooLargeError extends Error {
	constructor(epicKey: string) {
		super(
			`Epic \`${epicKey}\`'s lifecycle row is near its size limit (over ${MAX_EPIC_RECORD_PAYLOAD_CHARS} serialized characters), so no further wave can be recorded. Close the epic (\`/swarm epic close\`) to land or abandon it, then start a new epic for the remaining work.`,
		);
		this.name = 'EpicRecordTooLargeError';
	}
}

/**
 * Soft ceiling for the serialized epic row, checked before the store write.
 *
 * The record grows per wave (frozen file scopes, cochange pairs, a per-wave
 * component snapshot, merge failures) and the store rejects any payload over
 * `MAX_PAYLOAD_CHARS` (1 MiB) with a bare `payload must contain 1..1048576
 * characters`. On a long epic that surfaces as a raw store exception with no
 * remedy, and every later transition — including both close variants — throws
 * the same way. Refusing here, with a threshold below the hard cap, keeps a
 * headroom band so the failure is actionable while transitions are still
 * possible.
 */
const MAX_EPIC_RECORD_PAYLOAD_CHARS = 786_432;

/** True when `record` would serialize past {@link MAX_EPIC_RECORD_PAYLOAD_CHARS}. */
export function epicRecordPayloadTooLarge(record: EpicRecordV1): boolean {
	return JSON.stringify(record).length > MAX_EPIC_RECORD_PAYLOAD_CHARS;
}

/**
 * Revision-checked read-modify-write of the epic row. Returns the updated
 * record, or null when the row vanished or (with `expectedToken`) belongs to
 * a different start of the same epicKey. Throws on contention/corruption, and
 * throws {@link EpicRecordTooLargeError} when the row would outgrow the store
 * payload cap.
 */
export function updateEpicRecord(
	directory: string,
	epicKey: string,
	mutate: (record: EpicRecordV1) => EpicRecordV1,
	expectedToken: string | null = null,
): EpicRecordV1 | null {
	for (let attempt = 0; attempt < MAX_RECORD_UPDATE_ATTEMPTS; attempt += 1) {
		const current = getCoordinationStateRaw(
			directory,
			EPIC_LIFECYCLE_NAMESPACE,
			epicKey,
		);
		if (!current) return null;
		const record = parseEpicRecord(current.payload);
		// Same epicKey, different start (closed and re-opened): never touch
		// the newer epic on behalf of a stale caller. The revision CAS below
		// pins the row this check saw.
		if (expectedToken !== null && record.token !== expectedToken) return null;
		const next = mutate(record);
		if (epicRecordPayloadTooLarge(next)) {
			throw new EpicRecordTooLargeError(epicKey);
		}
		const result = transitionCoordinationState(directory, {
			namespace: EPIC_LIFECYCLE_NAMESPACE,
			entityKey: epicKey,
			expectedRevision: current.revision,
			generation: current.generation + 1,
			status: next.status,
			payload: JSON.stringify(next),
		});
		if (result.outcome === 'applied') return next;
		if (
			result.outcome !== 'revision_conflict' &&
			result.outcome !== 'stale_generation'
		) {
			throw new Error(`Epic record update failed: ${result.outcome}`);
		}
	}
	throw new Error(`Epic record update failed: contention on ${epicKey}`);
}

/** A phase as the Epic phase order sees it (id + plan status). */
export interface EpicPhaseRef {
	id: number;
	status?: string;
}

/**
 * Whether `phase` is done for Epic: recorded complete on the epic (by
 * `phase_complete`, or finished before the epic started), or closed in the
 * plan. The plan's own `complete` status is NOT used: it turns `complete`
 * as soon as every task completes, before the phase review ran.
 */
export function isEpicPhaseDone(
	record: Pick<EpicRecordV1, 'phases'>,
	phase: EpicPhaseRef,
): boolean {
	return (
		record.phases[String(phase.id)]?.status === 'complete' ||
		phase.status === 'closed'
	);
}

/** The epic's current phase: the first phase (plan order) not done. */
export function epicCurrentPhase(
	record: Pick<EpicRecordV1, 'phases'>,
	phases: readonly EpicPhaseRef[],
): number | null {
	return phases.find((phase) => !isEpicPhaseDone(record, phase))?.id ?? null;
}

/** Bounded read of the plan's phase order from `.swarm/plan.json`. */
export function readPlanPhaseRefs(directory: string): EpicPhaseRef[] | null {
	const planPath = path.join(directory, PLAN_JSON_RELATIVE_PATH);
	try {
		const stat = fs.statSync(planPath);
		if (!stat.isFile() || stat.size > MAX_PLAN_JSON_BYTES) return null;
		const parsed = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as {
			phases?: unknown;
		};
		if (!Array.isArray(parsed?.phases)) return null;
		return parsed.phases
			.filter(
				(phase): phase is { id: number; status?: unknown } =>
					typeof phase === 'object' &&
					phase !== null &&
					typeof (phase as { id?: unknown }).id === 'number',
			)
			.map((phase) => ({
				id: phase.id,
				status: typeof phase.status === 'string' ? phase.status : undefined,
			}));
	} catch {
		return null;
	}
}

/** A plan task as Epic's hot-path seams see it. */
export interface EpicPlanTaskRef {
	id: string;
	phase: number;
	description: string | undefined;
	files: string[];
}

/**
 * Bounded synchronous lookup of one task in `.swarm/plan.json` (the derived
 * projection — enough for membership and the commit subject). Null when the
 * plan is unreadable or the task is not in it.
 */
export function readPlanTaskRef(
	directory: string,
	taskId: string,
): EpicPlanTaskRef | null {
	const planPath = path.join(directory, PLAN_JSON_RELATIVE_PATH);
	try {
		const stat = fs.statSync(planPath);
		if (!stat.isFile() || stat.size > MAX_PLAN_JSON_BYTES) return null;
		const parsed = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as {
			phases?: unknown;
		};
		if (!Array.isArray(parsed?.phases)) return null;
		for (const phase of parsed.phases as Array<{
			id?: unknown;
			tasks?: unknown;
		}>) {
			if (!phase || !Array.isArray(phase.tasks)) continue;
			for (const task of phase.tasks as Array<Record<string, unknown>>) {
				if (task?.id !== taskId) continue;
				return {
					id: taskId,
					phase: typeof phase.id === 'number' ? phase.id : 0,
					description:
						typeof task.description === 'string' ? task.description : undefined,
					files: Array.isArray(task.files_touched)
						? task.files_touched.filter(
								(f): f is string => typeof f === 'string',
							)
						: [],
				};
			}
		}
		return null;
	} catch {
		return null;
	}
}

export type EpicPhaseCompleteOutcome =
	| { outcome: 'recorded' | 'already-complete'; record: EpicRecordV1 }
	| { outcome: 'no-open-epic' }
	| { outcome: 'not-current-phase'; currentPhase: number | null };

/**
 * Record `phase` complete on the open epic (Epic v2 C2; called by
 * `phase_complete` on success while an epic is open). Phases are
 * iterations: only the epic's CURRENT phase can be completed — completing
 * another phase out of order is refused (`not-current-phase`) so it cannot
 * skip the current phase's waves. Idempotent for an already-complete phase.
 * Throws on unreadable state / contention.
 */
export function markEpicPhaseComplete(
	directory: string,
	phase: number,
	planPhases?: readonly EpicPhaseRef[],
): EpicPhaseCompleteOutcome {
	const epic = getOpenEpic(directory);
	if (!epic) return { outcome: 'no-open-epic' };
	if (epic.phases[String(phase)]?.status === 'complete') {
		return { outcome: 'already-complete', record: epic };
	}
	const phases = planPhases ?? readPlanPhaseRefs(directory);
	const current = phases ? epicCurrentPhase(epic, phases) : null;
	if (current !== phase) {
		return { outcome: 'not-current-phase', currentPhase: current };
	}
	let changed = false;
	const updated = updateEpicRecord(
		directory,
		epic.epicKey,
		(record) => {
			const key = String(phase);
			const prior = record.phases[key];
			changed = false;
			if (prior?.status === 'complete') return record;
			changed = true;
			return {
				...record,
				phases: {
					...record.phases,
					[key]: {
						status: 'complete',
						reviewRuns: prior?.reviewRuns ?? 0,
						verdicts: prior?.verdicts ?? [],
					},
				},
			};
		},
		epic.token,
	);
	if (!updated) return { outcome: 'no-open-epic' };
	return {
		outcome: changed ? 'recorded' : 'already-complete',
		record: updated,
	};
}

/**
 * CAS the row to `closing` (first close step; idempotent). A resumed close
 * keeps the original request time and outcome — except that an explicit
 * abandon upgrades a `completed` close whose landing never finished — and
 * records the landing mode of the latest request.
 */
export function markEpicClosing(
	directory: string,
	epicKey: string,
	outcome: EpicCloseOutcome,
	expectedToken: string | null = null,
	land: EpicLandMode | null = null,
): EpicRecordV1 | null {
	return updateEpicRecord(
		directory,
		epicKey,
		(record) =>
			record.status === 'closing' && record.closing
				? resumeClosing(record, record.closing, outcome, land)
				: {
						...record,
						status: 'closing',
						closing: {
							requestedAt: new Date(_internals.now()).toISOString(),
							outcome,
							land,
							lastLandingAttempt: null,
						},
					},
		expectedToken,
	);
}

function resumeClosing(
	record: EpicRecordV1,
	closing: EpicClosingInfo,
	outcome: EpicCloseOutcome,
	land: EpicLandMode | null,
): EpicRecordV1 {
	const nextOutcome =
		closing.outcome === 'completed' && outcome !== 'completed'
			? outcome
			: closing.outcome;
	if (closing.land === land && closing.outcome === nextOutcome) return record;
	return { ...record, closing: { ...closing, land, outcome: nextOutcome } };
}

/**
 * Record the epic branch once `git checkout -b` succeeded (M-e). Returns the
 * updated record, or null when the row vanished / belongs to another start.
 */
export function recordEpicBranch(
	directory: string,
	epicKey: string,
	expectedToken: string,
	epicBranch: string,
): EpicRecordV1 | null {
	return updateEpicRecord(
		directory,
		epicKey,
		(record) => ({ ...record, git: { ...record.git, epicBranch } }),
		expectedToken,
	);
}

/** Record a failed landing attempt on a `closing` row (close stays resumable). */
export function recordEpicLandingAttempt(
	directory: string,
	epicKey: string,
	expectedToken: string,
	attempt: EpicLandingAttempt,
): EpicRecordV1 | null {
	return updateEpicRecord(
		directory,
		epicKey,
		(record) =>
			record.closing
				? {
						...record,
						closing: { ...record.closing, lastLandingAttempt: attempt },
					}
				: record,
		expectedToken,
	);
}

/** The `token` of a raw row payload, or null when unparseable. */
function payloadToken(payload: string): string | null {
	try {
		const parsed = JSON.parse(payload) as { token?: unknown };
		return typeof parsed?.token === 'string' ? parsed.token : null;
	} catch {
		return null;
	}
}

export interface EpicDeleteResult {
	rowsDeleted: string[];
	sentinelDeleted: boolean;
}

/**
 * Delete the epic row(s) then the sentinel (compare-and-delete), under the
 * lifecycle lock. `epicKey` null deletes every lifecycle row WITHOUT parsing
 * payloads (corrupt-state repair for `close --abandon`).
 */
export function deleteEpicState(
	directory: string,
	epicKey: string | null,
	token: string | null,
): EpicDeleteResult {
	const result: EpicDeleteResult = { rowsDeleted: [], sentinelDeleted: false };
	if (!projectDbExists(directory)) {
		// No database ⇒ no row can exist: only the projection may linger.
		const sentinel = readEpicSentinel(directory);
		result.sentinelDeleted = deleteSentinelIfMatches(
			directory,
			epicKey ?? sentinel?.epicKey ?? '',
			epicKey === null ? null : token,
		);
		return result;
	}
	return withCoordinationTransaction(directory, () => {
		const keys =
			epicKey === null ? listLifecycleRowsRawKeys(directory) : [epicKey];
		for (const key of keys) {
			const raw = getCoordinationStateRaw(
				directory,
				EPIC_LIFECYCLE_NAMESPACE,
				key,
			);
			if (!raw) continue;
			// Compare-and-delete on the token too: a stale close of epic A
			// must not delete a re-opened epic B with the same epicKey.
			if (
				epicKey !== null &&
				token !== null &&
				payloadToken(raw.payload) !== token
			) {
				continue;
			}
			if (
				deleteCoordinationStateWithinTransaction(
					directory,
					EPIC_LIFECYCLE_NAMESPACE,
					key,
					raw.revision,
				)
			) {
				result.rowsDeleted.push(key);
			}
		}
		const sentinel = readEpicSentinel(directory);
		if (epicKey === null) {
			// Corrupt-state repair: the sentinel can only name a row we just
			// removed (or none) — remove it whatever it names.
			result.sentinelDeleted = deleteSentinelIfMatches(
				directory,
				sentinel?.epicKey ?? '',
				null,
			);
		} else {
			result.sentinelDeleted = deleteSentinelIfMatches(
				directory,
				epicKey,
				token,
			);
		}
		return result;
	});
}

export type EpicSentinelRepair =
	| 'none'
	| 'removed-stale-sentinel'
	| 'restored-sentinel'
	| 'rewrote-mismatched-sentinel';

/**
 * Reconcile the sentinel with the authoritative row under the lifecycle lock:
 *  - sentinel without any row  → remove the sentinel (row confirmed absent);
 *  - open row without sentinel → restore the sentinel from the row;
 *  - sentinel naming another epic than the row → rewrite it from the row.
 * Corrupt rows are left alone (repair is `close --abandon`).
 */
export function repairEpicSentinel(directory: string): EpicSentinelRepair {
	if (!projectDbExists(directory)) {
		if (epicSentinelExists(directory)) {
			unlinkSentinel(directory);
			return 'removed-stale-sentinel';
		}
		return 'none';
	}
	return withCoordinationTransaction(directory, () => {
		let rows: LifecycleRow[];
		try {
			rows = listLifecycleRows(directory);
		} catch {
			return 'none' as const;
		}
		const present = epicSentinelExists(directory);
		if (rows.length === 0) {
			if (!present) return 'none' as const;
			unlinkSentinel(directory);
			return 'removed-stale-sentinel' as const;
		}
		if (rows.length > 1) return 'none' as const;
		let record: EpicRecordV1;
		try {
			record = parseEpicRecord(rows[0].payload);
		} catch {
			return 'none' as const;
		}
		const sentinel = present ? readEpicSentinel(directory) : null;
		if (!present) {
			if (record.status !== 'open') return 'none' as const;
			writeSentinelFile(directory, sentinelFor(record));
			return 'restored-sentinel' as const;
		}
		if (
			sentinel === null ||
			sentinel.epicKey !== record.epicKey ||
			sentinel.token !== record.token
		) {
			writeSentinelFile(directory, sentinelFor(record));
			return 'rewrote-mismatched-sentinel' as const;
		}
		return 'none' as const;
	});
}
