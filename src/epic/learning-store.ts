/**
 * Epic v2 C6 — persistence of what epics learn (`learning.ts` is the math).
 *
 * Two levels:
 *   - the PROJECT PRIOR `.swarm/epic-prior/learning.json` (schema
 *     `epic-learning-v1`, paths and numbers only). It lives outside
 *     `.swarm/epic/`, so it survives `/swarm close` (not in
 *     `ACTIVE_STATE_DIRS_TO_CLEAN`); `/swarm epic prior reset`
 *     clears it;
 *   - the EPIC POSTERIOR `.swarm/epic/posterior.json` (schema
 *     `epic-posterior-v1`): at `/swarm epic start` a copy of the prior
 *     (`base`, whose digest the epic record keeps as `priorDigest`) plus the
 *     `increments` learned from this epic's closed waves. Every wave close
 *     applies the outcomes of each closed wave with a seq above
 *     `lastAppliedWaveSeq` exactly once (idempotent per wave; a crash between
 *     the close and the update is caught up by the next update or the close).
 *     At `/swarm epic close` (any outcome — also `/swarm close`'s
 *     finalization) the prior becomes
 *       bound(decay_per_epic × timeDecay(prior) ⊕ increments)
 *     once per epic instance (`mergedEpics`, the newest 50 report keys); an
 *     epic with no increments only marks itself merged (no decay).
 *
 * Planning reads the posterior of the open epic, else the prior, decayed by
 * 0.5^floor(Δdays / half_life_days) since it was written (whole half-lives:
 * full weight until a half-life has passed). An unreadable prior is
 * never overwritten (planning runs without learned signals; the remedy is
 * `/swarm epic prior reset`); an unreadable or foreign posterior
 * is rebuilt from the prior and the epic record's outcomes.
 *
 * First start migration: Epic v1 `.swarm/epic/calibration.json`
 * (`hotModuleAdditions` ⇒ α = 2) and `.swarm/epic/divergence.jsonl`
 * (declared ⇒ exposures, undeclared ⇒ incidents + co-write edges, latest
 * record per plan + task) are imported once into the prior, which records
 * `importedFrom`; a reset keeps that marker (or writes a `reset` marker),
 * so nothing is imported after an import or a reset. A `/swarm close`
 * before the first start archives the v1 files away: nothing is imported.
 *
 * All writes are atomic `.swarm/`-contained writes; every state is bounded
 * by `boundEpicLearning` (2000 files, 2000 edges).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write.js';
import * as logger from '../utils/logger.js';
import {
	boundEpicLearning,
	type EpicLearningSettings,
	type EpicLearningStats,
	emptyEpicLearning,
	epicHotFiles,
	epicLearningFromOutcomes,
	epicTimeDecayFactor,
	isEpicLearningEmpty,
	learnablePaths,
	mergeEpicLearning,
	scaleEpicLearning,
} from './learning.js';
import type { EpicRecordV1 } from './lifecycle.js';

export const EPIC_PRIOR_LEARNING_RELATIVE_PATH = path.join(
	'.swarm',
	'epic-prior',
	'learning.json',
);
/** The prior's path as shown to users (POSIX separators). */
export const EPIC_PRIOR_LEARNING_DISPLAY_PATH =
	'.swarm/epic-prior/learning.json';
export const EPIC_POSTERIOR_RELATIVE_PATH = path.join(
	'.swarm',
	'epic',
	'posterior.json',
);
const LEGACY_CALIBRATION_RELATIVE_PATH = path.join(
	'.swarm',
	'epic',
	'calibration.json',
);
const LEGACY_DIVERGENCE_RELATIVE_PATH = path.join(
	'.swarm',
	'epic',
	'divergence.jsonl',
);

/** Report keys of the epics already merged into the prior (newest kept). */
export const EPIC_PRIOR_MERGED_EPICS_KEEP = 50;
/** Largest learning / posterior / legacy calibration file read. */
const MAX_LEARNING_FILE_BYTES = 4 * 1024 * 1024;
/** Tail of the legacy divergence log replayed once. */
const MAX_LEGACY_DIVERGENCE_BYTES = 16 * 1024 * 1024;
const MAX_LEGACY_DIVERGENCE_RECORDS = 10_000;
const MAX_LEGACY_HOT_MODULES = 2000;
/** α seeded for each Epic v1 `hotModuleAdditions` entry. */
export const EPIC_LEGACY_HOT_MODULE_ALPHA = 2;
/** Directories warned about an unreadable state (bounded, invariant 8). */
const MAX_WARNED_KEYS = 64;

const fileEntrySchema = z
	.object({
		path: z.string().min(1),
		alpha: z.number().finite().min(0),
		beta: z.number().finite().min(0),
	})
	.strict();
const edgeEntrySchema = z
	.object({
		from: z.string().min(1),
		to: z.string().min(1),
		weight: z.number().finite().min(0),
	})
	.strict();
const statsSchema = z
	.object({
		files: z.array(fileEntrySchema),
		edges: z.array(edgeEntrySchema),
	})
	.strict();

const importedFromSchema = z
	.object({
		at: z.string(),
		/** `epic-v1-import`, or `reset` (a reset that suppressed any import). */
		source: z.enum(['epic-v1-import', 'reset']),
		calibrationHotModules: z.number().int().min(0),
		divergenceRecords: z.number().int().min(0),
	})
	.strict();

const priorSchema = statsSchema
	.extend({
		schema: z.literal('epic-learning-v1'),
		updatedAt: z.string(),
		importedFrom: importedFromSchema.nullable(),
		mergedEpics: z.array(z.string()),
	})
	.strict();

const posteriorSchema = z
	.object({
		schema: z.literal('epic-posterior-v1'),
		epicKey: z.string().min(1),
		token: z.string().min(1),
		priorDigest: z.string().nullable(),
		createdAt: z.string(),
		lastAppliedWaveSeq: z.number().int().min(0),
		base: statsSchema.extend({ updatedAt: z.string() }).strict(),
		increments: statsSchema,
	})
	.strict();

export type EpicPriorImport = z.infer<typeof importedFromSchema>;

/** The persisted project prior, decoded. */
export interface EpicPrior {
	updatedAt: string;
	importedFrom: EpicPriorImport | null;
	mergedEpics: string[];
	stats: EpicLearningStats;
}

export interface EpicPosterior {
	epicKey: string;
	token: string;
	priorDigest: string | null;
	createdAt: string;
	lastAppliedWaveSeq: number;
	base: { updatedAt: string; stats: EpicLearningStats };
	increments: EpicLearningStats;
}

export type EpicPriorRead =
	| { status: 'absent'; digest: null }
	| { status: 'ok'; prior: EpicPrior; digest: string }
	| { status: 'unreadable'; reason: string; digest: null };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function priorPath(directory: string): string {
	return path.join(directory, EPIC_PRIOR_LEARNING_RELATIVE_PATH);
}

function posteriorPath(directory: string): string {
	return path.join(directory, EPIC_POSTERIOR_RELATIVE_PATH);
}

function encodeStats(stats: EpicLearningStats): z.infer<typeof statsSchema> {
	const files = [...stats.files]
		.map(([file, s]) => ({ path: file, alpha: s.alpha, beta: s.beta }))
		.sort((a, b) => a.path.localeCompare(b.path));
	const edges: Array<{ from: string; to: string; weight: number }> = [];
	for (const [from, targets] of stats.edges) {
		for (const [to, weight] of targets) edges.push({ from, to, weight });
	}
	edges.sort(
		(a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
	);
	return { files, edges };
}

/** Decode + bound (a hand-edited oversized file is clamped on load). */
function decodeStats(raw: z.infer<typeof statsSchema>): EpicLearningStats {
	const stats = emptyEpicLearning();
	for (const entry of raw.files) {
		const current = stats.files.get(entry.path) ?? { alpha: 0, beta: 0 };
		stats.files.set(entry.path, {
			alpha: current.alpha + entry.alpha,
			beta: current.beta + entry.beta,
		});
	}
	for (const edge of raw.edges) {
		const targets = stats.edges.get(edge.from) ?? new Map<string, number>();
		targets.set(edge.to, (targets.get(edge.to) ?? 0) + edge.weight);
		stats.edges.set(edge.from, targets);
	}
	return boundEpicLearning(stats);
}

function readBounded(filePath: string): string | null {
	let size: number;
	try {
		size = fs.statSync(filePath).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
		throw error;
	}
	if (size > MAX_LEARNING_FILE_BYTES) {
		throw new Error(`${filePath} exceeds ${MAX_LEARNING_FILE_BYTES} bytes`);
	}
	return fs.readFileSync(filePath, 'utf-8');
}

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

/** Whether a declared entry is a directory in the project (never charged). */
function directoryProbe(directory: string): (entry: string) => boolean {
	return (entry) => {
		try {
			return fs.statSync(path.join(directory, entry)).isDirectory();
		} catch {
			return false;
		}
	};
}

/** Read the project prior (no decay applied). Never throws. */
export function readEpicPrior(directory: string): EpicPriorRead {
	let raw: string | null;
	try {
		raw = readBounded(priorPath(directory));
	} catch (error) {
		return { status: 'unreadable', reason: errorText(error), digest: null };
	}
	if (raw === null) return { status: 'absent', digest: null };
	try {
		const parsed = priorSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return {
				status: 'unreadable',
				reason: `invalid ${EPIC_PRIOR_LEARNING_RELATIVE_PATH}: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
				digest: null,
			};
		}
		return {
			status: 'ok',
			digest: sha256(raw),
			prior: {
				updatedAt: parsed.data.updatedAt,
				importedFrom: parsed.data.importedFrom,
				mergedEpics: parsed.data.mergedEpics.slice(
					-EPIC_PRIOR_MERGED_EPICS_KEEP,
				),
				stats: decodeStats(parsed.data),
			},
		};
	} catch (error) {
		return { status: 'unreadable', reason: errorText(error), digest: null };
	}
}

function writeEpicPrior(directory: string, prior: EpicPrior): void {
	const target = priorPath(directory);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const payload = {
		schema: 'epic-learning-v1' as const,
		updatedAt: prior.updatedAt,
		importedFrom: prior.importedFrom,
		mergedEpics: prior.mergedEpics.slice(-EPIC_PRIOR_MERGED_EPICS_KEEP),
		...encodeStats(boundEpicLearning(prior.stats)),
	};
	atomicWriteSwarmFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Read the epic posterior; null when absent or unreadable. Never throws. */
export function readEpicPosterior(directory: string): EpicPosterior | null {
	try {
		const raw = readBounded(posteriorPath(directory));
		if (raw === null) return null;
		const parsed = posteriorSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) return null;
		return {
			epicKey: parsed.data.epicKey,
			token: parsed.data.token,
			priorDigest: parsed.data.priorDigest,
			createdAt: parsed.data.createdAt,
			lastAppliedWaveSeq: parsed.data.lastAppliedWaveSeq,
			base: {
				updatedAt: parsed.data.base.updatedAt,
				stats: decodeStats(parsed.data.base),
			},
			increments: decodeStats(parsed.data.increments),
		};
	} catch {
		return null;
	}
}

function writeEpicPosterior(directory: string, posterior: EpicPosterior): void {
	const target = posteriorPath(directory);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const payload = {
		schema: 'epic-posterior-v1' as const,
		epicKey: posterior.epicKey,
		token: posterior.token,
		priorDigest: posterior.priorDigest,
		createdAt: posterior.createdAt,
		lastAppliedWaveSeq: posterior.lastAppliedWaveSeq,
		base: {
			updatedAt: posterior.base.updatedAt,
			...encodeStats(boundEpicLearning(posterior.base.stats)),
		},
		increments: encodeStats(boundEpicLearning(posterior.increments)),
	};
	atomicWriteSwarmFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
}

const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
	if (warnedKeys.has(key)) return;
	if (warnedKeys.size >= MAX_WARNED_KEYS) {
		const oldest = warnedKeys.values().next().value;
		if (oldest !== undefined) warnedKeys.delete(oldest);
	}
	warnedKeys.add(key);
	logger.criticalWarn(message);
}

function decayedPriorStats(
	prior: EpicPrior,
	settings: EpicLearningSettings,
	nowMs: number,
): EpicLearningStats {
	return scaleEpicLearning(
		prior.stats,
		epicTimeDecayFactor(prior.updatedAt, nowMs, settings.halfLifeDays),
	);
}

export type EpicLearningSource =
	| 'posterior'
	| 'prior'
	| 'none'
	| 'prior-unreadable';

/** Identifies one epic instance (`epicKey` repeats when a plan restarts). */
export type EpicIdentity = Pick<EpicRecordV1, 'epicKey' | 'token'>;

export interface EpicLearningView {
	source: EpicLearningSource;
	stats: EpicLearningStats;
}

/**
 * What the planner learns from right now: the posterior of the open epic
 * `epic` (time-decayed base ⊕ increments), else the time-decayed prior.
 * An unreadable prior yields no learned signal (warned once). Never throws.
 */
export function loadEpicLearningView(
	directory: string,
	epic: EpicIdentity | null,
	settings: EpicLearningSettings,
	nowMs: number,
): EpicLearningView {
	if (!settings.enabled) return { source: 'none', stats: emptyEpicLearning() };
	if (epic !== null) {
		const posterior = readEpicPosterior(directory);
		if (
			posterior &&
			posterior.epicKey === epic.epicKey &&
			posterior.token === epic.token
		) {
			const base = scaleEpicLearning(
				posterior.base.stats,
				epicTimeDecayFactor(
					posterior.base.updatedAt,
					nowMs,
					settings.halfLifeDays,
				),
			);
			return {
				source: 'posterior',
				stats: boundEpicLearning(mergeEpicLearning(base, posterior.increments)),
			};
		}
	}
	const read = readEpicPrior(directory);
	if (read.status === 'unreadable') {
		warnOnce(
			`prior\u0000${directory}`,
			`[epic/learning] the project prior is unreadable (${read.reason}); epics plan without learned signals until \`/swarm epic prior reset\` clears it.`,
		);
		return { source: 'prior-unreadable', stats: emptyEpicLearning() };
	}
	if (read.status === 'absent') {
		return { source: 'none', stats: emptyEpicLearning() };
	}
	return {
		source: 'prior',
		stats: decayedPriorStats(read.prior, settings, nowMs),
	};
}

/**
 * `/swarm epic start`, after the epic was opened: the posterior starts as a
 * copy of the prior snapshot the start read (its digest is the record's
 * `priorDigest`). Throws on a write failure (the caller warns; the first
 * wave close rebuilds it).
 */
export function initEpicPosterior(
	directory: string,
	record: Pick<EpicRecordV1, 'epicKey' | 'token' | 'priorDigest' | 'startedAt'>,
	snapshot: EpicPriorRead,
): void {
	writeEpicPosterior(directory, {
		epicKey: record.epicKey,
		token: record.token,
		priorDigest: record.priorDigest,
		createdAt: record.startedAt,
		lastAppliedWaveSeq: 0,
		base:
			snapshot.status === 'ok'
				? {
						updatedAt: snapshot.prior.updatedAt,
						stats: snapshot.prior.stats,
					}
				: { updatedAt: record.startedAt, stats: emptyEpicLearning() },
		increments: emptyEpicLearning(),
	});
}

/** The posterior of `record`, rebuilt from the prior when missing/foreign. */
function posteriorFor(directory: string, record: EpicRecordV1): EpicPosterior {
	const existing = readEpicPosterior(directory);
	if (
		existing &&
		existing.epicKey === record.epicKey &&
		existing.token === record.token
	) {
		return existing;
	}
	const prior = readEpicPrior(directory);
	return {
		epicKey: record.epicKey,
		token: record.token,
		// Stamp the prior this rebuild actually copied.
		priorDigest: prior.digest,
		createdAt: record.startedAt,
		lastAppliedWaveSeq: 0,
		base:
			prior.status === 'ok'
				? { updatedAt: prior.prior.updatedAt, stats: prior.prior.stats }
				: { updatedAt: record.startedAt, stats: emptyEpicLearning() },
		increments: emptyEpicLearning(),
	};
}

export interface EpicWaveLearningResult {
	/** Wave seqs whose outcomes this call applied (empty: nothing new). */
	appliedWaves: number[];
}

/**
 * Apply the outcomes of every CLOSED wave of `record` not applied yet
 * (seq > `lastAppliedWaveSeq`) to the posterior — exactly once per wave.
 * Throws on a write failure (the caller decides; the next call catches up).
 */
export function applyClosedWavesToPosterior(
	directory: string,
	record: EpicRecordV1,
	settings: EpicLearningSettings,
): EpicWaveLearningResult {
	if (!settings.enabled) return { appliedWaves: [] };
	const posterior = posteriorFor(directory, record);
	const pending = record.waves
		.filter(
			(wave) =>
				wave.status === 'closed' && wave.seq > posterior.lastAppliedWaveSeq,
		)
		.map((wave) => wave.seq)
		.sort((a, b) => a - b);
	if (pending.length === 0) return { appliedWaves: [] };
	const applied = new Set(pending);
	const outcomes = Object.values(record.tasks ?? {}).filter((outcome) =>
		applied.has(outcome.waveSeq),
	);
	writeEpicPosterior(directory, {
		...posterior,
		lastAppliedWaveSeq: pending[pending.length - 1],
		increments: boundEpicLearning(
			mergeEpicLearning(
				posterior.increments,
				epicLearningFromOutcomes(outcomes, {
					isDirectory: directoryProbe(directory),
					learnedThroughWaveSeq: posterior.lastAppliedWaveSeq,
				}),
			),
		),
	});
	return { appliedWaves: pending };
}

export type EpicPriorMergeStatus =
	| 'merged'
	| 'already-merged'
	| 'nothing-to-learn'
	| 'disabled'
	| 'prior-unreadable'
	| 'failed';

export interface EpicPriorMergeResult {
	status: EpicPriorMergeStatus;
	/** Files / co-write edges this epic contributed. */
	learnedFiles: number;
	learnedEdges: number;
	/** Hot files of the prior after the merge (≤ 10). */
	hotFiles: string[];
	detail: string;
}

/**
 * `/swarm epic close` (any outcome): catch the posterior up with the
 * record, then prior := bound(decay_per_epic × timeDecay(prior) ⊕
 * increments), once per epic instance (`reportKey`). The posterior is
 * removed afterwards. An epic that learned nothing leaves the statistics
 * (and their write time) untouched and is only marked merged. Never throws.
 */
export function mergeEpicPosteriorIntoPrior(
	directory: string,
	record: EpicRecordV1,
	reportKey: string,
	settings: EpicLearningSettings,
	nowMs: number,
): EpicPriorMergeResult {
	const none = { learnedFiles: 0, learnedEdges: 0, hotFiles: [] as string[] };
	if (!settings.enabled) {
		return {
			status: 'disabled',
			...none,
			detail: 'learning is disabled (epic.learning.enabled: false)',
		};
	}
	try {
		try {
			applyClosedWavesToPosterior(directory, record, settings);
		} catch (error) {
			logger.warn(
				`[epic/learning] posterior catch-up failed; merging from the epic record: ${errorText(error)}`,
			);
		}
		const posterior = readEpicPosterior(directory);
		const increments =
			posterior &&
			posterior.epicKey === record.epicKey &&
			posterior.token === record.token
				? posterior.increments
				: // Record fallback: only the latest outcome per task survives,
					// so each is charged in full (no delta).
					boundEpicLearning(
						epicLearningFromOutcomes(Object.values(record.tasks ?? {}), {
							isDirectory: directoryProbe(directory),
						}),
					);
		let learnedEdges = 0;
		for (const targets of increments.edges.values()) {
			learnedEdges += targets.size;
		}
		const learned = { learnedFiles: increments.files.size, learnedEdges };
		const read = readEpicPrior(directory);
		if (read.status === 'unreadable') {
			return {
				status: 'prior-unreadable',
				...learned,
				hotFiles: [],
				detail: `the project prior is unreadable (${read.reason}); this epic's observations were not merged — clear it with \`/swarm epic prior reset\``,
			};
		}
		const prior = read.status === 'ok' ? read.prior : null;
		if (prior?.mergedEpics.includes(reportKey)) {
			removePosterior(directory, record);
			return {
				status: 'already-merged',
				...learned,
				hotFiles: epicHotFiles(prior.stats, settings.hotExcess).slice(0, 10),
				detail: 'already merged into the project prior',
			};
		}
		if (isEpicLearningEmpty(increments)) {
			// No learning signal: the per-epic decay is skipped (an epic that
			// taught nothing must not erode the prior); the epic is still
			// marked merged so a resumed close stays idempotent.
			if (prior) {
				writeEpicPrior(directory, {
					...prior,
					mergedEpics: [...prior.mergedEpics, reportKey],
				});
			}
			removePosterior(directory, record);
			return {
				status: 'nothing-to-learn',
				...learned,
				hotFiles: prior
					? epicHotFiles(prior.stats, settings.hotExcess).slice(0, 10)
					: [],
				detail: 'no outcomes to learn from',
			};
		}
		const decayed = prior
			? scaleEpicLearning(
					decayedPriorStats(prior, settings, nowMs),
					settings.decayPerEpic,
				)
			: emptyEpicLearning();
		const stats = boundEpicLearning(mergeEpicLearning(decayed, increments));
		writeEpicPrior(directory, {
			updatedAt: new Date(nowMs).toISOString(),
			importedFrom: prior?.importedFrom ?? null,
			mergedEpics: [...(prior?.mergedEpics ?? []), reportKey],
			stats,
		});
		removePosterior(directory, record);
		return {
			status: 'merged',
			...learned,
			hotFiles: epicHotFiles(stats, settings.hotExcess).slice(0, 10),
			detail: 'merged into the project prior',
		};
	} catch (error) {
		return {
			status: 'failed',
			...none,
			detail: `merging into the project prior failed: ${errorText(error)}`,
		};
	}
}

function removePosterior(directory: string, record: EpicRecordV1): void {
	const existing = readEpicPosterior(directory);
	if (existing && existing.epicKey !== record.epicKey) return;
	try {
		fs.rmSync(posteriorPath(directory), { force: true });
	} catch {
		// best-effort: a leftover posterior of a closed epic is never read
		// (its epicKey / token no longer match an open epic)
	}
}

export type EpicPriorResetResult =
	| { status: 'reset'; hadPrior: boolean }
	| { status: 'failed'; detail: string };

/**
 * `/swarm epic prior reset`: the prior becomes empty. The
 * `importedFrom` marker survives (a v1 import is never repeated); an open
 * epic keeps its posterior and merges into the empty prior at close.
 */
export function resetEpicPrior(
	directory: string,
	nowMs: number,
): EpicPriorResetResult {
	const read = readEpicPrior(directory);
	const nowIso = new Date(nowMs).toISOString();
	try {
		writeEpicPrior(directory, {
			updatedAt: nowIso,
			// Always leave a marker: a reset also suppresses any later Epic v1
			// import (the prior was reset on purpose).
			importedFrom:
				read.status === 'ok' && read.prior.importedFrom
					? read.prior.importedFrom
					: {
							source: 'reset',
							at: nowIso,
							calibrationHotModules: 0,
							divergenceRecords: 0,
						},
			mergedEpics: read.status === 'ok' ? read.prior.mergedEpics : [],
			stats: emptyEpicLearning(),
		});
		return { status: 'reset', hadPrior: read.status !== 'absent' };
	} catch (error) {
		return { status: 'failed', detail: errorText(error) };
	}
}

// ─── Epic v1 migration ───────────────────────────────────────────────────────

export type EpicLegacyImportResult =
	| {
			status: 'imported';
			calibrationHotModules: number;
			divergenceRecords: number;
	  }
	| { status: 'already-imported' | 'nothing-to-import' | 'prior-unreadable' }
	| { status: 'failed'; detail: string };

function readLegacyHotModules(directory: string): string[] | null {
	const raw = readBounded(
		path.join(directory, LEGACY_CALIBRATION_RELATIVE_PATH),
	);
	if (raw === null) return null;
	const parsed = JSON.parse(raw) as { hotModuleAdditions?: unknown };
	if (!Array.isArray(parsed?.hotModuleAdditions)) return [];
	return parsed.hotModuleAdditions
		.filter((entry): entry is string => typeof entry === 'string')
		.slice(0, MAX_LEGACY_HOT_MODULES);
}

interface LegacyDivergenceRecord {
	planId?: unknown;
	taskId?: unknown;
	declaredScope?: unknown;
	undeclared?: unknown;
}

function readLegacyDivergence(
	directory: string,
): Array<{ declared: string[]; undeclared: string[] }> | null {
	const filePath = path.join(directory, LEGACY_DIVERGENCE_RELATIVE_PATH);
	let size: number;
	try {
		size = fs.statSync(filePath).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
		throw error;
	}
	let text: string;
	let truncated = false;
	if (size > MAX_LEGACY_DIVERGENCE_BYTES) {
		const fd = fs.openSync(filePath, 'r');
		try {
			const buffer = Buffer.alloc(MAX_LEGACY_DIVERGENCE_BYTES);
			fs.readSync(
				fd,
				buffer,
				0,
				MAX_LEGACY_DIVERGENCE_BYTES,
				size - MAX_LEGACY_DIVERGENCE_BYTES,
			);
			text = buffer.toString('utf-8');
			truncated = true;
		} finally {
			fs.closeSync(fd);
		}
	} else {
		text = fs.readFileSync(filePath, 'utf-8');
	}
	const lines = text.split('\n').filter((line) => line.trim().length > 0);
	const tail = lines
		.slice(truncated ? 1 : 0)
		.slice(-MAX_LEGACY_DIVERGENCE_RECORDS);
	const records: LegacyDivergenceRecord[] = [];
	for (const line of tail) {
		try {
			const parsed = JSON.parse(line) as LegacyDivergenceRecord;
			if (parsed && typeof parsed === 'object') records.push(parsed);
		} catch {
			// a torn line teaches nothing
		}
	}
	// Latest record per (planId, taskId); records without a plan id count once each.
	const last = new Map<string, number>();
	records.forEach((record, index) => {
		if (
			typeof record.planId === 'string' &&
			typeof record.taskId === 'string'
		) {
			last.set(`${record.planId}\u0000${record.taskId}`, index);
		}
	});
	const strings = (value: unknown): string[] =>
		Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === 'string')
			: [];
	return records
		.filter(
			(record, index) =>
				typeof record.planId !== 'string' ||
				typeof record.taskId !== 'string' ||
				last.get(`${record.planId}\u0000${record.taskId}`) === index,
		)
		.map((record) => ({
			declared: strings(record.declaredScope),
			undeclared: strings(record.undeclared),
		}));
}

/**
 * Import the Epic v1 learning files into the prior once (see the module
 * header). Runs at `/swarm epic start`; writes only when there is
 * something to import. Never throws.
 */
export function importLegacyEpicCalibrationOnce(
	directory: string,
	nowMs: number,
): EpicLegacyImportResult {
	try {
		const read = readEpicPrior(directory);
		if (read.status === 'unreadable') return { status: 'prior-unreadable' };
		if (read.status === 'ok' && read.prior.importedFrom !== null) {
			return { status: 'already-imported' };
		}
		let hotModules: string[] | null = null;
		try {
			hotModules = readLegacyHotModules(directory);
		} catch (error) {
			logger.warn(
				`[epic/learning] Epic v1 calibration.json unreadable; not imported: ${errorText(error)}`,
			);
		}
		let divergence: ReturnType<typeof readLegacyDivergence> = null;
		try {
			divergence = readLegacyDivergence(directory);
		} catch (error) {
			logger.warn(
				`[epic/learning] Epic v1 divergence.jsonl unreadable; not imported: ${errorText(error)}`,
			);
		}
		if (hotModules === null && divergence === null) {
			return { status: 'nothing-to-import' };
		}
		const increments = epicLearningFromOutcomes(
			(divergence ?? []).map((record, index) => ({
				taskId: `legacy-${index}`,
				phase: 0,
				waveSeq: 0,
				resolution: 'completed' as const,
				resolvedAt: '',
				generation: 0,
				stageAFailures: 0,
				stageBFailures: 0,
				mergeFailure: null,
				declared: record.declared,
				undeclared: record.undeclared,
				attribution: 'session' as const,
				reopened: 0,
				marker: null,
			})),
			{ isDirectory: directoryProbe(directory) },
		);
		const base = read.status === 'ok' ? read.prior.stats : emptyEpicLearning();
		const stats = mergeEpicLearning(base, increments);
		for (const file of learnablePaths(hotModules ?? [])) {
			const current = stats.files.get(file) ?? { alpha: 0, beta: 0 };
			stats.files.set(file, {
				alpha: Math.max(current.alpha, EPIC_LEGACY_HOT_MODULE_ALPHA),
				beta: current.beta,
			});
		}
		const nowIso = new Date(nowMs).toISOString();
		const importedFrom: EpicPriorImport = {
			source: 'epic-v1-import',
			at: nowIso,
			calibrationHotModules: hotModules?.length ?? 0,
			divergenceRecords: divergence?.length ?? 0,
		};
		writeEpicPrior(directory, {
			updatedAt: nowIso,
			importedFrom,
			mergedEpics: read.status === 'ok' ? read.prior.mergedEpics : [],
			stats: boundEpicLearning(stats),
		});
		return {
			status: 'imported',
			calibrationHotModules: importedFrom.calibrationHotModules,
			divergenceRecords: importedFrom.divergenceRecords,
		};
	} catch (error) {
		return { status: 'failed', detail: errorText(error) };
	}
}

/** One close-output line; always states that the project prior is kept. */
export function describeEpicPriorMerge(result: EpicPriorMergeResult): string {
	switch (result.status) {
		case 'merged':
			return `Learning: merged ${result.learnedFiles} file statistic(s) and ${result.learnedEdges} learned co-write(s) into the project prior (\`${EPIC_PRIOR_LEARNING_DISPLAY_PATH}\`)${result.hotFiles.length > 0 ? `; hot files: ${result.hotFiles.slice(0, 5).join(', ')}${result.hotFiles.length > 5 ? ', …' : ''}` : '; no hot files'}. Project prior kept (it survives /swarm close; \`/swarm epic prior reset\` clears it).`;
		case 'already-merged':
			return 'Learning: already merged into the project prior. Project prior kept.';
		case 'nothing-to-learn':
			return 'Learning: this epic recorded no outcomes to learn from. Project prior kept.';
		case 'disabled':
			return 'Learning: disabled (`epic.learning.enabled: false`). Project prior kept unchanged.';
		default:
			return `Learning: ⚠️ ${result.detail}. Project prior kept unchanged.`;
	}
}
