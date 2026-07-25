/**
 * Read-only corpus assembly for the consensus miner (issue #1821, Workstream C).
 *
 * This module owns exactly one job: turn every already-existing evidence store
 * in `.swarm/` into a single flat stream of `CorpusObservation` records. It
 * introduces **no new store**. Every reader below is an existing exported
 * function; the two enumerators added here are `listTrajectorySessions` (a
 * `readdir` over `.swarm/trajectories`) and `listEvaluationRunIds` (a `readdir`
 * over `.swarm/evolution/runs`), because both underlying stores read one
 * artifact at a time and never needed a listing of their own. An enumerator is
 * not a store: it writes nothing, caches nothing, and owns no schema.
 *
 * Hard rules this module upholds (AGENTS.md invariants 4 and 8):
 * - Every reader receives an injected `directory`. There is no `process.cwd()`
 *   fallback anywhere in this file, and none may be added: a consensus report
 *   mined against the wrong root would silently attribute one project's
 *   evidence to another.
 * - Nothing here writes to disk: no artifact, no lock, no cache file, no marker.
 *   That is not a property of *reading* — it has to be chosen. `loadEvidence`
 *   performs a lazy in-place upgrade of a legacy flat retrospective by default
 *   (rewriting the bundle under an `evidence-loader` lock and creating a lock
 *   sentinel under `.swarm/locks/`), so `defaultReaders` binds it with
 *   `{ migrate: false }`. A mining run must never mutate the evidence it is
 *   merely counting. Note that `migrate: false` skips only the PERSISTENCE: the
 *   returned bundle is still the wrapped, normalized view — including the
 *   `task_complexity` remap, which happens in `wrapFlatRetrospective` before the
 *   write branch — so the corpus reads normalized values while the file on disk
 *   keeps its legacy ones.
 *   Three upstream readers do populate PROCESS-LOCAL caches, which is worth
 *   stating rather than hiding behind the word "read-only": `readTrajectory`
 *   fills the PRM in-memory trajectory cache (`src/prm/trajectory-store.ts`),
 *   while `readKnowledge` and `loadEvidence` fill the two SEPARATE maps in
 *   `src/utils/swarm-artifact-cache.ts` — the parsed-artifact cache and the text
 *   cache, each independently bounded at `MAX_CACHE_ENTRIES` = 128 entries. All
 *   are bounded and FIFO-evicting, so mining a large `.swarm/` tree CAN evict
 *   another subsystem's cached entries and change what that subsystem sees next.
 *   The PRM one goes further: it is a plain `Map` with no revalidation, and
 *   `readTrajectory` REPLACES the entry for the session it read, re-bounded by
 *   its own `maxLines` default rather than by whatever bound the live writer was
 *   using — a session whose list exceeds 1000 entries is cut to the newest
 *   `floor(maxLines / 2)` = 500 ENTRIES. That 500 is unrelated to
 *   `MAX_TRACKED_TRAJECTORY_SESSIONS` = 500, which bounds how many SESSIONS the
 *   cache holds at once; the two constants merely happen to share a value.
 *   None of these caches is on disk: nothing about them writes a file, and none
 *   survives the process. (The readers themselves obviously do read files — the
 *   claim above is that nothing here WRITES, not that nothing here touches the
 *   filesystem. The artifact cache in particular `stat`s the file on every
 *   lookup to check freshness, and on a miss invokes the caller's own read
 *   function and `stat`s again before storing.)
 * - Every free-text fragment that survives into a signal, a statement, or an
 *   evidence reference passes through `redactSecrets` and a hard length bound
 *   before it is retained. Prompts and reasoning traces are never read into an
 *   observation at all — only outcomes, verdicts, categories, and the bounded
 *   excerpts below.
 * - The whole corpus is capped at `maxEvidenceItems` observations. The cap is
 *   applied against a deterministic source order and a deterministic per-source
 *   sort, so the same `.swarm/` tree always yields the same truncated corpus.
 *   Within a source the cut is *balanced between failing and succeeding
 *   observations* rather than lexicographic, because a lexicographic cut
 *   systematically drops whichever class sorts late and would let truncation
 *   erase counterexamples while confidence rose. That removes the systematic
 *   bias; it does not make truncation lossless. The balance is struck PER
 *   SOURCE, so one signal can still lose every counterexample it had, and once
 *   the budget is spent every later source is dropped WHOLE. `report.truncation`
 *   exists so a reader can tell a partial view from a complete one — see
 *   `docs/consensus-mining.md`.
 */

import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { EvaluationRunV1 } from '../evaluation/contracts.js';
import { readGateGroundTruth } from '../evaluation/gate-ground-truth.js';
import { canonicalHash } from '../evaluation/hashing.js';
import {
	type GateAuditReadSummary,
	listGateAuditResults,
	readEvaluationRun,
} from '../evaluation/store.js';
import {
	type LoadEvidenceResult,
	listEvidenceTaskIds,
	loadEvidence,
} from '../evidence/manager.js';
import {
	computeOutcomeSignal,
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store.js';
import type { RetrievalOutcome } from '../hooks/knowledge-types.js';
import { readTaskTrajectory } from '../hooks/micro-reflector.js';
import { readSkillUsageEntries } from '../hooks/skill-usage-log.js';
import { redactSecrets } from '../memory/redaction.js';
import { readTrajectory } from '../prm/trajectory-store.js';
import type { TrajectoryEntry } from '../prm/types.js';
import type { ConsensusCorpusHash, ConsensusSourceKind } from './contracts.js';

/**
 * One normalized evidence record.
 *
 * `runId` is the *support unit*: the miner counts distinct `runId` values, so
 * whatever a source uses as its independent-trial identity belongs here. For
 * evaluation and gate-audit evidence that is the literal run id; for per-task
 * evidence it is the task's own identity, and for session trajectories the
 * session id. Each is namespaced so two sources can never collide.
 */
export interface CorpusObservation {
	runId: string;
	taskId?: string;
	taskCategory?: string;
	agentRole?: string;
	modelId?: string;
	seed?: string;
	success: boolean;
	signals: string[];
	evidenceRef: string;
}

export interface ConsensusCorpus {
	observations: CorpusObservation[];
	hashes: ConsensusCorpusHash[];
	/** True when `maxEvidenceItems` truncated the stream. */
	truncated: boolean;
	/** Sources that threw while being read. Never fatal — the corpus degrades. */
	unreadableSources: ConsensusSourceKind[];
}

/**
 * Injectable readers. Dependency injection rather than `mock.module` (AGENTS.md
 * invariant 7): the corpus pulls from eight subsystems, and mocking those module
 * paths would leak across Bun's shared test-runner process.
 */
export interface CorpusReaders {
	listEvaluationRunIds: (directory: string) => Promise<string[]>;
	readEvaluationRun: (
		directory: string,
		runId: string,
	) => Promise<EvaluationRunV1 | undefined>;
	listGateAuditResults: (directory: string) => Promise<GateAuditReadSummary>;
	readGateGroundTruth: typeof readGateGroundTruth;
	listEvidenceTaskIds: (directory: string) => Promise<string[]>;
	readTaskTrajectory: (
		directory: string,
		taskId: string,
	) => Promise<TrajectoryEntry[]>;
	listTrajectorySessions: (directory: string) => Promise<string[]>;
	readTrajectory: (
		sessionId: string,
		directory: string,
	) => Promise<TrajectoryEntry[]>;
	readSkillUsageEntries: typeof readSkillUsageEntries;
	readKnowledgeEntries: (directory: string) => Promise<KnowledgeLike[]>;
	loadEvidence: (
		directory: string,
		taskId: string,
	) => Promise<LoadEvidenceResult>;
}

/**
 * Structural view of a knowledge entry. Deliberately minimal: the consensus
 * miner reads four fields, and depending on the full `KnowledgeEntry` union
 * would couple this module to a schema another lane actively edits.
 */
export interface KnowledgeLike {
	id?: unknown;
	lesson?: unknown;
	category?: unknown;
	retrieval_outcomes?: RetrievalOutcome;
}

export interface LoadCorpusOptions {
	/** Hard cap on retained observations. Required — there is no default. */
	maxEvidenceItems: number;
	/** Hard cap on any single retained free-text fragment. */
	maxExcerptChars: number;
	/**
	 * Caller-supplied retention predicate, applied per source AFTER that source's
	 * hash and observation count are recorded and BEFORE the `maxEvidenceItems`
	 * budget is spent.
	 *
	 * That position is the whole point. The consensus miner's request filters used
	 * to run only on the already-truncated stream, so narrowing a request to the
	 * one task category that mattered removed observations from a corpus the cap
	 * had already shaped — 50 observations in, 0 out. Applying the predicate here
	 * spends the budget on observations that can survive the request instead, so
	 * narrowing genuinely widens what is available to it.
	 *
	 * Applied after the per-source hash so `corpusHashes` keeps meaning "what this
	 * source contained", independent of any one request; `truncation.observations`
	 * on the report is what declares how many were actually tallied.
	 *
	 * Omitted \u21D2 every observation is retained, which is the pre-existing behaviour.
	 */
	filter?: (observation: CorpusObservation) => boolean;
	/** Reader overrides for tests. Unspecified readers use the real store. */
	readers?: Partial<CorpusReaders>;
}

/** Fixed source order. Truncation is deterministic only because this is. */
const SOURCE_ORDER: readonly ConsensusSourceKind[] = [
	'evaluation-run',
	'gate-audit',
	'gate-ground-truth',
	'task-trajectory',
	'prm-session',
	'skill-usage',
	'knowledge',
	'evidence-bundle',
] as const;

/** Bounds a single enumeration so a pathological `.swarm/` cannot stall mining. */
const MAX_ENUMERATED_ENTRIES = 2000;

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

/**
 * Total, locale-INDEPENDENT string order.
 *
 * `String.prototype.localeCompare` without an explicit locale is ICU- and
 * environment-sensitive: it orders `a-b, a:b, ab, aB` differently from code-unit
 * order, and the collation can differ between hosts. That is fine for display
 * and fatal here — this ordering decides which observations survive truncation
 * and the order of the attribute array, both of which are hashed into
 * `integrityHash`. A report whose id depends on the host's collation is not
 * reproducible. Code-unit comparison is the same everywhere.
 */
export function compareRefs(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Redact, collapse, and bound a free-text fragment before it is retained.
 *
 * Order matters: redaction runs BEFORE truncation, so a secret that straddles
 * the length bound is still replaced rather than half-copied into the report.
 * Newlines and control characters collapse to single spaces because signals are
 * compared for equality — a fragment that differs only by line wrapping must
 * not split one consensus attribute into two.
 *
 * Format characters (`\p{Cf}`) are collapsed alongside control characters — to a
 * SPACE, like everything else here, not deleted — and that is a correctness rule
 * rather than tidiness. U+202E (RIGHT-TO-LEFT OVERRIDE), U+2066–U+2069 (the
 * isolates) and U+200E/U+200F reorder how the text RENDERS without changing the
 * bytes stored, so a persisted signal, statement, evidence ref, or `llmSummary`
 * could read as something other than the bytes the report actually holds.
 * U+200B–U+200D and U+FEFF are the same class of invisible, and they also hide
 * INSIDE a token: `[REDACTED\u200B:x]` is not the placeholder it renders as, and
 * `sk\u200B-…` is not the secret shape `redactSecrets` matches.
 *
 * Replacing rather than deleting is a real choice, in both directions. What it
 * BUYS: deletion would let `[REDACTED\u200B:x]` close up into a well-formed
 * `[REDACTED:x]` after the forged-marker check in `extractRestatement` has
 * already run on the raw text — manufacturing exactly the forged redaction
 * marker that check exists to reject. A space breaks the token instead, and
 * `MARKUP_RE` then rejects it on the bare `[`. What it does NOT buy: `a\u200Db`
 * becomes `a b`, not `ab`, so a fragment differing from another only by a
 * zero-width joiner still differs afterwards. Equality is canonicalized (every
 * such fragment collapses the same way), not made to agree with the joiner-free
 * spelling.
 */
export function sanitizeExcerpt(value: string, maxChars: number): string {
	const normalized = redactSecrets(value)
		// Unicode control AND format characters first: a pasted terminal dump
		// carries NUL/BEL/ESC and a hostile one carries bidi overrides, neither of
		// which the `\s` class matches. Whitespace runs second, so every fragment
		// collapses to one canonical spacing.
		.replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return normalized.length > maxChars
		? normalized.slice(0, maxChars)
		: normalized;
}

/**
 * READ-ONLY enumerator over `.swarm/trajectories`.
 *
 * `src/prm/trajectory-store.ts` reads exactly one session at a time and has no
 * bulk enumerator, so the consensus corpus needs this to discover which sessions
 * exist. It lives here rather than in the PRM store because it is the consensus
 * miner's need, not the PRM subsystem's, and because adding it there would put a
 * second writer-adjacent surface in a module another lane owns. It performs a
 * single `readdir`, filters to `<sessionId>.jsonl` names that match the shared
 * identifier shape, sorts, bounds, and returns. Missing directory \u21D2 `[]`.
 */
export async function listTrajectorySessions(
	directory: string,
): Promise<string[]> {
	const root = path.join(directory, '.swarm', 'trajectories');
	let entries: import('node:fs').Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
		.map((entry) => entry.name.slice(0, -'.jsonl'.length))
		.filter((name) => IDENTIFIER_RE.test(name))
		.sort()
		.slice(0, MAX_ENUMERATED_ENTRIES);
}

/**
 * READ-ONLY enumerator over `.swarm/evolution/runs`.
 *
 * `src/evaluation/store.ts` exposes `readEvaluationRun(directory, runId)` but no
 * listing (its own callers always know the run id). Mirrors the directory
 * discipline of `listGateAuditResults`: validated names only, sorted, bounded.
 */
export async function listEvaluationRunIds(
	directory: string,
): Promise<string[]> {
	const root = path.join(directory, '.swarm', 'evolution', 'runs');
	let entries: import('node:fs').Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
		.map((entry) => entry.name.slice(0, -'.json'.length))
		.filter((name) => IDENTIFIER_RE.test(name))
		.sort()
		.slice(0, MAX_ENUMERATED_ENTRIES);
}

function defaultReaders(): CorpusReaders {
	return {
		listEvaluationRunIds,
		readEvaluationRun,
		listGateAuditResults,
		readGateGroundTruth,
		listEvidenceTaskIds,
		readTaskTrajectory,
		listTrajectorySessions,
		readTrajectory,
		readSkillUsageEntries,
		readKnowledgeEntries: (directory) =>
			readKnowledge<KnowledgeLike>(resolveSwarmKnowledgePath(directory)),
		// `{ migrate: false }` is load-bearing, not defensive. The default
		// `loadEvidence` lazily rewrites a legacy flat retrospective in place —
		// taking an `evidence-loader` lock, creating a lock sentinel under
		// `.swarm/locks/`, renaming a temp file over `evidence.json`, and remapping
		// legacy `task_complexity` values (`medium` \u2192 `moderate`). Mining is a read.
		loadEvidence: (directory, taskId) =>
			loadEvidence(directory, taskId, { migrate: false }),
	};
}

/**
 * Build one namespaced signal.
 *
 * `domain` is load-bearing: the miner maps it directly onto
 * `ConsensusAttributeV1.proposedTarget`, so a signal's namespace decides where a
 * qualifying attribute would be actioned. Parts are sanitized individually so a
 * secret embedded in any one of them cannot survive by hiding behind a
 * delimiter.
 */
function signal(
	domain: 'skill' | 'prompt' | 'tooling' | 'orchestration',
	parts: readonly string[],
	maxExcerptChars: number,
): string {
	const cleaned = parts
		.map((part) => sanitizeExcerpt(String(part), maxExcerptChars))
		.filter((part) => part.length > 0);
	return [domain, ...cleaned].join(':');
}

// ---------------------------------------------------------------------------
// Per-source loaders
// ---------------------------------------------------------------------------

/**
 * Evaluation runs — the only source carrying task category, model id, and seed
 * together. Each result row becomes one observation attributed to the model that
 * produced it (baseline vs candidate resolved through the run's own declaration).
 */
async function loadEvaluationRuns(
	directory: string,
	readers: CorpusReaders,
	maxExcerptChars: number,
): Promise<CorpusObservation[]> {
	const observations: CorpusObservation[] = [];
	for (const runId of await readers.listEvaluationRunIds(directory)) {
		const run = await readers.readEvaluationRun(directory, runId);
		if (!run) continue;
		const modelById = new Map<string, string>([
			[run.baseline.id, run.baseline.model],
			[run.candidate.id, run.candidate.model],
		]);
		const agentById = new Map<string, string | undefined>([
			[run.baseline.id, run.baseline.agent],
			[run.candidate.id, run.candidate.agent],
		]);
		for (const [index, result] of run.results.entries()) {
			const signals = [
				signal(
					'tooling',
					['evaluation-outcome', result.outcome],
					maxExcerptChars,
				),
			];
			if (result.failureCode) {
				signals.push(
					signal(
						'tooling',
						['evaluation-failure', result.failureCode],
						maxExcerptChars,
					),
				);
			}
			observations.push({
				runId: `evaluation-run:${run.runId}`,
				taskId: result.taskId,
				taskCategory: result.category,
				agentRole: agentById.get(result.candidateId),
				modelId: modelById.get(result.candidateId),
				seed: result.seed,
				success: result.outcome === 'scored',
				signals,
				evidenceRef: sanitizeExcerpt(
					`evaluation-run:${run.runId}:${result.taskId}:${index}`,
					maxExcerptChars,
				),
			});
		}
	}
	return observations;
}

/** Gate-audit cells. Carries a model id but no task category or seed. */
async function loadGateAudit(
	directory: string,
	readers: CorpusReaders,
	maxExcerptChars: number,
): Promise<CorpusObservation[]> {
	const observations: CorpusObservation[] = [];
	const summary = await readers.listGateAuditResults(directory);
	for (const result of summary.results) {
		for (const [index, cell] of result.cells.entries()) {
			const signals = [
				signal('tooling', ['gate', cell.gate, cell.outcome], maxExcerptChars),
			];
			if (cell.failureClassification) {
				signals.push(
					signal(
						'tooling',
						['gate-failure', cell.gate, cell.failureClassification],
						maxExcerptChars,
					),
				);
			}
			observations.push({
				runId: `gate-audit:${result.runId}`,
				taskId: cell.taskId,
				agentRole: cell.gate,
				modelId: cell.model,
				success: cell.outcome === 'caught',
				signals,
				evidenceRef: sanitizeExcerpt(
					`gate-audit:${result.runId}:${cell.taskId}:${index}`,
					maxExcerptChars,
				),
			});
		}
	}
	return observations;
}

/** Gate ground-truth sidecars, joined by run id to the audit above. */
async function loadGateGroundTruth(
	directory: string,
	readers: CorpusReaders,
	maxExcerptChars: number,
): Promise<CorpusObservation[]> {
	const observations: CorpusObservation[] = [];
	const summary = await readers.listGateAuditResults(directory);
	for (const result of summary.results) {
		const truth = await readers.readGateGroundTruth(directory, result.runId);
		for (const [index, event] of truth.events.entries()) {
			observations.push({
				runId: `gate-audit:${event.runId}`,
				taskId: event.taskId,
				agentRole: event.gate,
				modelId: event.model,
				success: event.classification === 'clean',
				signals: [
					signal(
						'tooling',
						['gate-truth', event.gate, event.source, event.classification],
						maxExcerptChars,
					),
				],
				evidenceRef: sanitizeExcerpt(
					`gate-ground-truth:${event.runId}:${event.taskId}:${index}`,
					maxExcerptChars,
				),
			});
		}
	}
	return observations;
}

/**
 * Per-task trajectories under `.swarm/evidence/<taskId>/trajectory.jsonl`.
 *
 * The task itself is the support unit: two entries from one task's trajectory
 * are one trial, not two, so support cannot be inflated by a chatty run.
 */
async function loadTaskTrajectories(
	directory: string,
	readers: CorpusReaders,
	maxExcerptChars: number,
): Promise<CorpusObservation[]> {
	const observations: CorpusObservation[] = [];
	for (const taskId of await readers.listEvidenceTaskIds(directory)) {
		const entries = await readers.readTaskTrajectory(directory, taskId);
		for (const [index, entry] of entries.entries()) {
			observations.push({
				runId: `task:${taskId}`,
				taskId,
				agentRole: entry.agent
					? sanitizeExcerpt(entry.agent, maxExcerptChars)
					: undefined,
				success: entry.result === 'success',
				signals: [
					signal(
						'orchestration',
						['task-action', entry.action, entry.result],
						maxExcerptChars,
					),
				],
				evidenceRef: sanitizeExcerpt(
					`task-trajectory:${taskId}:${index}`,
					maxExcerptChars,
				),
			});
		}
	}
	return observations;
}

/**
 * PRM session trajectories under `.swarm/trajectories/<sessionId>.jsonl`.
 *
 * `TrajectoryEntry.target` is documented as "File or task being targeted", so it
 * is the only task attribution this source has; it is sanitized and used as
 * `taskId` so session evidence can contribute real task diversity rather than
 * being permanently stranded below the anecdote gate.
 */
async function loadPrmSessions(
	directory: string,
	readers: CorpusReaders,
	maxExcerptChars: number,
): Promise<CorpusObservation[]> {
	const observations: CorpusObservation[] = [];
	for (const sessionId of await readers.listTrajectorySessions(directory)) {
		const entries = await readers.readTrajectory(sessionId, directory);
		for (const [index, entry] of entries.entries()) {
			const target = entry.target
				? sanitizeExcerpt(entry.target, maxExcerptChars)
				: '';
			observations.push({
				runId: `prm-session:${sessionId}`,
				taskId: target.length > 0 ? target : undefined,
				agentRole: entry.agent
					? sanitizeExcerpt(entry.agent, maxExcerptChars)
					: undefined,
				success: entry.result === 'success',
				signals: [
					signal(
						'orchestration',
						['session-action', entry.action, entry.result],
						maxExcerptChars,
					),
				],
				evidenceRef: sanitizeExcerpt(
					`prm-session:${sessionId}:${index}`,
					maxExcerptChars,
				),
			});
		}
	}
	return observations;
}

/** Skill usage / compliance log. The session is the support unit. */
function loadSkillUsage(
	directory: string,
	readers: CorpusReaders,
	maxExcerptChars: number,
): CorpusObservation[] {
	return readers.readSkillUsageEntries(directory).map((entry) => ({
		runId: `skill-usage:${entry.sessionID}`,
		taskId: entry.taskID,
		agentRole: sanitizeExcerpt(entry.agentName, maxExcerptChars),
		success: entry.complianceVerdict === 'compliant',
		signals: [
			signal(
				'skill',
				['usage', entry.skillPath, entry.complianceVerdict],
				maxExcerptChars,
			),
		],
		evidenceRef: sanitizeExcerpt(
			`skill-usage:${entry.sessionID}:${entry.id}`,
			maxExcerptChars,
		),
	}));
}

/**
 * Knowledge entries with accumulated retrieval outcomes.
 *
 * The lesson text itself is the signal — that is what makes two independent
 * entries "the same claim" — which also makes this the corpus's largest
 * free-text surface and the reason `sanitizeExcerpt` is applied here rather than
 * only at report-render time. Knowledge carries no task attribution, so
 * knowledge-only attributes stay below the task-diversity gate by construction.
 */
async function loadKnowledge(
	directory: string,
	readers: CorpusReaders,
	maxExcerptChars: number,
): Promise<CorpusObservation[]> {
	const entries = await readers.readKnowledgeEntries(directory);
	const observations: CorpusObservation[] = [];
	for (const [index, entry] of entries.entries()) {
		if (typeof entry.lesson !== 'string' || entry.lesson.trim().length === 0) {
			continue;
		}
		const id = typeof entry.id === 'string' ? entry.id : String(index);
		const category =
			typeof entry.category === 'string' ? entry.category : 'other';
		const outcome = computeOutcomeSignal(entry.retrieval_outcomes);
		observations.push({
			runId: `knowledge:${sanitizeExcerpt(id, maxExcerptChars)}`,
			success: outcome >= 0,
			signals: [
				signal('skill', ['knowledge', category, entry.lesson], maxExcerptChars),
			],
			evidenceRef: sanitizeExcerpt(`knowledge:${id}`, maxExcerptChars),
		});
	}
	return observations;
}

/**
 * Evidence bundles / retrospectives. Shares the `task:<id>` support unit with
 * task trajectories on purpose: they are two views of the same trial, and
 * counting them as two independent runs would double the apparent support.
 */
async function loadEvidenceBundles(
	directory: string,
	readers: CorpusReaders,
	maxExcerptChars: number,
): Promise<CorpusObservation[]> {
	const observations: CorpusObservation[] = [];
	for (const taskId of await readers.listEvidenceTaskIds(directory)) {
		const result = await readers.loadEvidence(directory, taskId);
		if (result.status !== 'found') continue;
		for (const [index, entry] of result.bundle.entries.entries()) {
			observations.push({
				runId: `task:${taskId}`,
				taskId,
				agentRole: entry.agent
					? sanitizeExcerpt(entry.agent, maxExcerptChars)
					: undefined,
				success: entry.verdict === 'pass',
				signals: [
					signal(
						'prompt',
						['evidence', entry.type, entry.verdict ?? 'unknown'],
						maxExcerptChars,
					),
				],
				evidenceRef: sanitizeExcerpt(
					`evidence-bundle:${taskId}:${index}`,
					maxExcerptChars,
				),
			});
		}
	}
	return observations;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Retain `limit` observations from a deterministically-sorted source without
 * systematically dropping either outcome class.
 *
 * A plain `slice(0, limit)` cuts lexicographically by `evidenceRef`. Those refs
 * are structured (`gate-audit:<runId>:<taskId>:<index>`), so the cut correlates
 * with run and task identity — and therefore, whenever failures cluster in one
 * run or one task, with OUTCOME. The effect of that is exactly backwards:
 * failing observations vanish while succeeding ones survive, so `failureSupport`
 * and `counterexampleRefs` fall to zero and `confidence` *rises* as evidence is
 * discarded. Truncation must never be able to launder a contested finding into a
 * clean one (issue #1821 AC17).
 *
 * The cut therefore alternates between the failing and the succeeding sublist,
 * each kept in its own deterministic order, until the budget is spent; whichever
 * list runs out first yields its remaining share to the other, so a source with
 * no failures still fills the budget. The retained subset is re-sorted on the way
 * out, so the returned stream still obeys the documented per-source ordering and
 * the result is a pure function of the input.
 */
function balancedSlice(
	sorted: readonly CorpusObservation[],
	limit: number,
): CorpusObservation[] {
	if (limit >= sorted.length) return [...sorted];
	const failures = sorted.filter((observation) => !observation.success);
	const successes = sorted.filter((observation) => observation.success);
	const retained: CorpusObservation[] = [];
	let failureIndex = 0;
	let successIndex = 0;
	// Failures are taken first within each pair, so an odd budget rounds toward
	// negative evidence: under-reporting a counterexample is the costlier error.
	while (retained.length < limit) {
		if (failureIndex < failures.length) {
			retained.push(failures[failureIndex] as CorpusObservation);
			failureIndex += 1;
			if (retained.length >= limit) break;
		}
		if (successIndex < successes.length) {
			retained.push(successes[successIndex] as CorpusObservation);
			successIndex += 1;
		} else if (failureIndex >= failures.length) {
			break;
		}
	}
	return retained.sort((left, right) =>
		compareRefs(left.evidenceRef, right.evidenceRef),
	);
}

/**
 * Load and normalize every corpus source.
 *
 * Failure of any single source is non-fatal and recorded in `unreadableSources`:
 * a corrupt trajectory file must not make the whole mining run unavailable, and
 * a silently-empty corpus would be worse than a declared partial one. The
 * returned observations are stable-sorted, reduced by the optional
 * `options.filter`, and then truncated to `maxEvidenceItems` — filter first, so
 * the budget is spent on observations the caller can actually use.
 */
export async function loadConsensusCorpus(
	directory: string,
	options: LoadCorpusOptions,
): Promise<ConsensusCorpus> {
	const readers: CorpusReaders = { ...defaultReaders(), ...options.readers };
	const maxExcerptChars = Math.max(1, options.maxExcerptChars);
	const loaders: Record<
		ConsensusSourceKind,
		() => Promise<CorpusObservation[]>
	> = {
		'evaluation-run': () =>
			loadEvaluationRuns(directory, readers, maxExcerptChars),
		'gate-audit': () => loadGateAudit(directory, readers, maxExcerptChars),
		'gate-ground-truth': () =>
			loadGateGroundTruth(directory, readers, maxExcerptChars),
		'task-trajectory': () =>
			loadTaskTrajectories(directory, readers, maxExcerptChars),
		'prm-session': () => loadPrmSessions(directory, readers, maxExcerptChars),
		'skill-usage': async () =>
			loadSkillUsage(directory, readers, maxExcerptChars),
		knowledge: () => loadKnowledge(directory, readers, maxExcerptChars),
		'evidence-bundle': () =>
			loadEvidenceBundles(directory, readers, maxExcerptChars),
	};

	const observations: CorpusObservation[] = [];
	const hashes: ConsensusCorpusHash[] = [];
	const unreadableSources: ConsensusSourceKind[] = [];
	let truncated = false;

	for (const source of SOURCE_ORDER) {
		let loaded: CorpusObservation[];
		try {
			loaded = await loaders[source]();
		} catch {
			unreadableSources.push(source);
			continue;
		}
		// Deterministic per-source order so truncation never depends on
		// filesystem enumeration order.
		loaded.sort((left, right) =>
			compareRefs(left.evidenceRef, right.evidenceRef),
		);
		// Hashed and counted BEFORE the caller's predicate: `corpusHashes` declares
		// what the source contained, which must not depend on one request's filters.
		hashes.push({
			source,
			hash: canonicalHash(loaded),
			observations: loaded.length,
		});
		const eligible = options.filter ? loaded.filter(options.filter) : loaded;
		const remaining = options.maxEvidenceItems - observations.length;
		if (remaining <= 0) {
			if (eligible.length > 0) truncated = true;
			continue;
		}
		if (eligible.length > remaining) {
			truncated = true;
			observations.push(...balancedSlice(eligible, remaining));
		} else {
			observations.push(...eligible);
		}
	}

	return { observations, hashes, truncated, unreadableSources };
}
