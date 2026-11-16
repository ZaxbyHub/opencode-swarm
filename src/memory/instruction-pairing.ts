/**
 * Paired cached-vs-uncached outcome evidence for instruction selection (#2672).
 *
 * Runs the REAL knowledge-injector hook (the plugin's instruction-selection and
 * instruction-cache surface) over deterministic, offline fixture tasks and
 * reports paired per-task outcomes: quality (which directive labels survive
 * selection), latency per arm, cache reads, uncached cost, and the rendered
 * prefix length at the host-renderable carrier boundary.
 *
 * Contract discipline (issue #2672):
 * - Same task/model/budget on both arms; the uncached arm is the regeneration
 *   reference and the cached arm replays byte-identical context on a warm
 *   per-instance cache.
 * - Negative results are RETAINED rows (`negative_result: true` when the
 *   cached arm did not improve the paired quality outcome). On the offline
 *   deterministic corpus both arms run the same selection algorithm over the
 *   same records, so `quality_outcome` is 'identical' by design — the honest
 *   "caching did not change instruction quality" negative result.
 * - NO percentage or savings claim exists anywhere in the report: deltas are
 *   absolute numbers and every quantity names its denominator in `measurement`.
 * - `identity.instruction_set_digest` is the evidence handle a HarnessOpt
 *   lineage record (#2503) can reference; this module never modifies the
 *   harness-optimizer — #2503 remains the broad held-out comparison owner.
 */

import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ORCHESTRATOR_NAME } from '../config/agent-names.js';
import { createKnowledgeInjectorHook } from '../hooks/knowledge-injector.js';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store.js';
import type {
	KnowledgeConfig,
	MessageWithParts,
	SwarmKnowledgeEntry,
} from '../hooks/knowledge-types.js';
import { getPrimaryOwner, swarmState } from '../state.js';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache.js';

export type InstructionPairingDirectivePriority =
	| 'critical'
	| 'high'
	| 'medium'
	| 'low';

export interface InstructionPairingRecord {
	/**
	 * Stable identifier recovered from the rendered prefix. Constrained to
	 * `[A-Za-z0-9-]` (PRR-012): other characters still reach the fixture
	 * store verbatim but can never be matched back by the sentinel pattern,
	 * silently undercounting `quality.expected_hit_count` for that record.
	 */
	label: string;
	lesson: string;
	directivePriority?: InstructionPairingDirectivePriority;
	tags?: string[];
}

export interface InstructionPairingTask {
	id: string;
	lastUserMessage: string;
	expectedLabels: string[];
	records: InstructionPairingRecord[];
}

export interface InstructionPairingOptions {
	/**
	 * Project directory context. Fixture stores live in disposable temp roots
	 * (never under the caller's `.swarm/`); when `writeReport` is set, the
	 * durable report artifact is written under this directory's
	 * `.swarm/memory/`.
	 */
	directory: string;
	/** Omitted falls back to the deterministic DEFAULT_INSTRUCTION_PAIRING_TASKS. */
	tasks?: InstructionPairingTask[];
	modelId?: string;
	injectCharBudget?: number;
	/** Explicit report destination; overrides the `writeReport` default path. */
	reportPath?: string;
	/** Write the report to `<directory>/.swarm/memory/instruction-pairing-report.json`. */
	writeReport?: boolean;
}

export interface InstructionPairingArmResult {
	latency_ms: number;
	/** Injections served from the warm context cache in the measured invocation (0 or 1). */
	cache_reads: number;
	/** How cache_reads was determined ('events-file-delta' = observed, 'protocol-assumed' = identical-context replay). */
	cache_reads_basis: string;
	rendered_prefix_chars: number;
	/** The paired uncached arm's regeneration latency, reported on both arms (paired attribution, absolute ms). */
	uncached_cost: number;
	quality: {
		expected_hit_count: number;
		expected_total: number;
		selected_labels: string[];
	};
}

export interface InstructionPairingPair {
	task: { id: string };
	arm_cached: InstructionPairingArmResult;
	arm_uncached: InstructionPairingArmResult;
	quality_outcome: 'identical' | 'improved' | 'degraded';
	negative_result: boolean;
}

export interface InstructionPairingReport {
	schema_version: 1;
	generated_at: string;
	identity: {
		task_set_id: string;
		model_id: string;
		budget_chars: number;
		instruction_set_digest: string;
	};
	pairs: InstructionPairingPair[];
	measurement: {
		latency_denominator: string;
		cost_denominator: string;
		prefix_denominator: string;
	};
	negative_results_retained: boolean;
	cache_invalidation: { verified: boolean; detail: string };
}

const FIXED_EPOCH = '2026-01-01T00:00:00.000Z';
const DEFAULT_INJECT_CHAR_BUDGET = 4000;
const SENTINEL_PATTERN = /__PAIRING_LABEL_([A-Za-z0-9-]+)__/g;

/** Deterministic offline corpus used when `options.tasks` is omitted. */
export const DEFAULT_INSTRUCTION_PAIRING_TASKS: InstructionPairingTask[] = [
	{
		id: 'pairing-default-ci-triage',
		lastUserMessage:
			'Review the CI failure on the merge queue and decide whether to batch it with the earlier gate failure.',
		expectedLabels: ['ci-failure-batching', 'gate-attribution'],
		records: [
			{
				label: 'ci-failure-batching',
				lesson:
					'Batch identical CI failures from one merge-queue run before triage.',
				directivePriority: 'high',
				tags: ['ci', 'merge-queue'],
			},
			{
				label: 'gate-attribution',
				lesson:
					'Attribute required-check failures to the exact gate, not the workflow.',
				directivePriority: 'high',
				tags: ['ci', 'attribution'],
			},
			{
				label: 'worktree-retry-cleanup',
				lesson: 'Remove retry worktrees once the flaky test is quarantined.',
				directivePriority: 'medium',
			},
		],
	},
	{
		id: 'pairing-default-instruction-budget',
		lastUserMessage:
			'The architect prompt is over budget; trim the instruction prefix before dispatching.',
		expectedLabels: ['instruction-budget'],
		records: [
			{
				label: 'instruction-budget',
				lesson:
					'Trim lowest-priority directives first when the injection budget is exceeded.',
				directivePriority: 'critical',
			},
			{
				label: 'parallel-work-check',
				lesson: 'Check for parallel work before editing shared files.',
				directivePriority: 'medium',
			},
		],
	},
	{
		id: 'pairing-default-skill-hygiene',
		lastUserMessage:
			'Validate the skill edits against the mirror contract before pushing.',
		expectedLabels: ['skill-edit-validation'],
		records: [
			{
				label: 'skill-edit-validation',
				lesson: 'Validate skill edits against the mirror contract before push.',
				directivePriority: 'high',
				tags: ['skills'],
			},
			{
				label: 'merge-queue-readiness',
				lesson:
					'Confirm merge-queue readiness gates before promoting a branch.',
				directivePriority: 'medium',
			},
		],
	},
];

function pairingConfig(injectCharBudget: number): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		dedup_threshold: 0.6,
		scope_filter: ['global'],
		// Hermetic: never read or write the shared hive store during pairing.
		hive_enabled: false,
		rejected_max_entries: 20,
		validation_enabled: true,
		evergreen_confidence: 0.9,
		evergreen_utility: 0.8,
		low_utility_threshold: 0.3,
		min_retrievals_for_utility: 3,
		schema_version: 1,
		inject_char_budget: injectCharBudget,
	} as KnowledgeConfig;
}

function makeMessages(sessionId: string): { messages: MessageWithParts[] } {
	// #2526: src/ never constructs role:'system' entries — the hook resolves
	// the agent via swarmState.activeAgent and the session from any message
	// info, so the user message alone is the complete host input here.
	// #3372: never re-stamp a session that already carries identity state —
	// a foreign or already-owned session keeps its live activeAgent entry for
	// the whole measurement. Only when the entry is absent does the harness
	// create one, resolving through the #3320 primary-owner record; ownerless
	// synthetic pairing sessions keep the ORCHESTRATOR_NAME fallback so the
	// injector still resolves a swarm context for them.
	const existing = swarmState.activeAgent.get(sessionId);
	if (existing === undefined) {
		swarmState.activeAgent.set(
			sessionId,
			getPrimaryOwner(sessionId) ?? ORCHESTRATOR_NAME,
		);
	}
	return {
		messages: [
			{
				info: { role: 'user', sessionID: sessionId },
				parts: [{ type: 'text', text: 'continue the current task' }],
			},
		],
	};
}

/**
 * Test seam (#3372): direct binding to the production composer so tests can
 * drive the exact identity lifecycle `measureInvocation` drives. Deliberately
 * the production function itself — a wrapper here would defeat the seam's
 * purpose (pinned by tests/unit/memory/instruction-pairing-identity*.test.ts).
 */
export const _internals = { makeMessages };

function injectedText(output: { messages: MessageWithParts[] }): string {
	return output.messages
		.filter((m) =>
			m.parts?.some((p) => p.text?.includes('[[KNOWLEDGE-INJECTED]]')),
		)
		.map((m) => m.parts?.map((p) => p.text ?? '').join('') ?? '')
		.join('\n');
}

function selectedLabelsFromRenderedText(text: string): string[] {
	const labels = new Set<string>();
	for (const match of text.matchAll(SENTINEL_PATTERN)) {
		labels.add(match[1]);
	}
	return [...labels].sort();
}

/** Materializes a task's records into a disposable project knowledge store. */
async function materializeTaskStore(
	projectDir: string,
	task: InstructionPairingTask,
): Promise<void> {
	mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });
	const storePath = resolveSwarmKnowledgePath(projectDir);
	for (const record of task.records) {
		// Sentinel prefix keeps label recovery deterministic from the rendered
		// block; the human-readable lesson follows (bounded to the 15-280 range).
		const lesson = `__PAIRING_LABEL_${record.label}__ ${record.lesson}`.slice(
			0,
			280,
		);
		const entry: SwarmKnowledgeEntry = {
			id: createHash('sha1').update(`${task.id}:${record.label}`).digest('hex'),
			tier: 'swarm',
			lesson,
			category: 'process',
			tags: record.tags ?? [],
			scope: 'global',
			confidence: 0.85,
			status: 'established',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: FIXED_EPOCH,
			updated_at: FIXED_EPOCH,
			project_name: 'instruction-pairing',
			...(record.directivePriority
				? { directive_priority: record.directivePriority }
				: {}),
		} as SwarmKnowledgeEntry;
		await appendKnowledge(storePath, entry);
	}
}

/** Observed size of the knowledge-events file (hit detection), or -1 when absent. */
function eventsFileSize(projectDir: string): number {
	const eventsPath = path.join(projectDir, '.swarm', 'knowledge-events.jsonl');
	try {
		return existsSync(eventsPath) ? statSync(eventsPath).size : -1;
	} catch {
		return -1;
	}
}

interface ArmMeasurement {
	latencyMs: number;
	cacheReads: number;
	cacheReadsBasis: string;
	renderedText: string;
}

async function measureInvocation(
	hook: ReturnType<typeof createKnowledgeInjectorHook>,
	sessionId: string,
	candidateHit: boolean,
): Promise<ArmMeasurement> {
	const root = sessionTempRoot.get(sessionId);
	const before = root ? eventsFileSize(root) : -1;
	const output = makeMessages(sessionId);
	const started = performance.now();
	await hook({}, output);
	const latencyMs = performance.now() - started;
	const text = injectedText(output);
	let cacheReads = 0;
	let cacheReadsBasis = 'cold-instance-by-construction';
	if (candidateHit && root) {
		const after = eventsFileSize(root);
		if (before >= 0 && after >= 0) {
			// A miss records retrieval events; a hit only reads. An unchanged
			// events file after an identical-context replay is an observed hit.
			cacheReads = after === before ? 1 : 0;
			cacheReadsBasis = 'events-file-delta';
		} else {
			cacheReads = 1;
			cacheReadsBasis = 'protocol-assumed';
		}
	}
	return { latencyMs, cacheReads, cacheReadsBasis, renderedText: text };
}

/** sessionId -> temp project root, for events-file-based hit detection. */
const sessionTempRoot = new Map<string, string>();

/**
 * Refcounted in-flight registry for the synthetic pairing sessions' identity
 * lifecycle (#3372, implementation-review rounds 1-2). Concurrent runs with
 * colliding synthetic ids cannot restore one another's temporary entries:
 * the ORIGINAL prior state is captured once by the FIRST holder, and only the
 * LAST holder to finish performs the cleanup — earlier finishers do nothing.
 * (A per-run prior capture restores another run's temporary value; a
 * stamped-value token cannot distinguish invocations that stamp the same
 * agent name — both were reviewer-executed counterexamples.)
 */
const pairingIdentityHolds = new Map<
	string,
	{ count: number; priorAgent: string | undefined }
>();

function holdPairingSessionIdentity(sessionId: string): void {
	const existing = pairingIdentityHolds.get(sessionId);
	if (existing) {
		existing.count += 1;
		return;
	}
	pairingIdentityHolds.set(sessionId, {
		count: 1,
		priorAgent: swarmState.activeAgent.get(sessionId),
	});
}

function releasePairingSessionIdentity(sessionId: string): void {
	const hold = pairingIdentityHolds.get(sessionId);
	if (!hold) return;
	hold.count -= 1;
	// Another in-flight run still owns the entry — the last one out cleans up.
	if (hold.count > 0) return;
	pairingIdentityHolds.delete(sessionId);
	if (hold.priorAgent === undefined) {
		swarmState.activeAgent.delete(sessionId);
	} else {
		swarmState.activeAgent.set(sessionId, hold.priorAgent);
	}
}

async function runTaskPairing(
	task: InstructionPairingTask,
	injectCharBudget: number,
): Promise<InstructionPairingPair> {
	const root = mkdtempSync(path.join(tmpdir(), `pairing-${task.id}-`));
	const sessionId = `pairing-${task.id}`;
	sessionTempRoot.set(sessionId, root);
	// #3372: hold the session's identity for this run — the refcounted
	// registry guarantees the ORIGINAL prior state is restored by the last
	// concurrent holder to finish (see pairingIdentityHolds).
	holdPairingSessionIdentity(sessionId);
	try {
		await materializeTaskStore(root, task);
		const config = pairingConfig(injectCharBudget);

		// Uncached arm: a fresh hook instance has a cold per-instance cache, so
		// its single invocation is a full regeneration (the paired reference).
		const uncachedHook = createKnowledgeInjectorHook(
			root,
			config,
			{},
			undefined,
		);
		const uncached = await measureInvocation(uncachedHook, sessionId, false);

		// Cached arm: prime, then replay byte-identical context on the same
		// instance; the measured invocation is the replay.
		const cachedHook = createKnowledgeInjectorHook(root, config, {}, undefined);
		await measureInvocation(cachedHook, sessionId, false);
		const cached = await measureInvocation(cachedHook, sessionId, true);

		const uncachedLabels = selectedLabelsFromRenderedText(
			uncached.renderedText,
		);
		const cachedLabels = selectedLabelsFromRenderedText(cached.renderedText);
		const expectedHits = (labels: string[]): number =>
			task.expectedLabels.filter((label) => labels.includes(label)).length;

		const cachedSet = new Set(cachedLabels);
		const uncachedSet = new Set(uncachedLabels);
		let qualityOutcome: InstructionPairingPair['quality_outcome'] = 'identical';
		if (
			cachedSet.size !== uncachedSet.size ||
			[...cachedSet].some((label) => !uncachedSet.has(label))
		) {
			qualityOutcome =
				expectedHits(cachedLabels) > expectedHits(uncachedLabels)
					? 'improved'
					: 'degraded';
		}

		return {
			task: { id: task.id },
			arm_cached: {
				latency_ms: Math.max(0, cached.latencyMs),
				cache_reads: cached.cacheReads,
				cache_reads_basis: cached.cacheReadsBasis,
				rendered_prefix_chars: cached.renderedText.length,
				uncached_cost: Math.max(0, uncached.latencyMs),
				quality: {
					expected_hit_count: expectedHits(cachedLabels),
					expected_total: task.expectedLabels.length,
					selected_labels: cachedLabels,
				},
			},
			arm_uncached: {
				latency_ms: Math.max(0, uncached.latencyMs),
				cache_reads: uncached.cacheReads,
				cache_reads_basis: uncached.cacheReadsBasis,
				rendered_prefix_chars: uncached.renderedText.length,
				uncached_cost: Math.max(0, uncached.latencyMs),
				quality: {
					expected_hit_count: expectedHits(uncachedLabels),
					expected_total: task.expectedLabels.length,
					selected_labels: uncachedLabels,
				},
			},
			quality_outcome: qualityOutcome,
			negative_result: qualityOutcome !== 'improved',
		};
	} finally {
		// Invariant-8 hygiene: never leave synthetic pairing sessions mapped.
		// The refcounted release restores the ORIGINAL prior state (last
		// holder out) — see pairingIdentityHolds.
		releasePairingSessionIdentity(sessionId);
		sessionTempRoot.delete(sessionId);
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * Verifies the instruction cache invalidates when the instruction set changes:
 * prime a hook with a briefing on disk, change the briefing, replay identical
 * context, and require the fresh instruction text (not the stale cache).
 */
async function verifyCacheInvalidation(): Promise<{
	verified: boolean;
	detail: string;
}> {
	const root = mkdtempSync(path.join(tmpdir(), 'pairing-invalidation-'));
	const sessionId = 'pairing-invalidation';
	sessionTempRoot.set(sessionId, root);
	// #3372: same refcounted identity hold for this DISTINCT synthetic
	// session ('pairing-invalidation') — last holder out restores.
	holdPairingSessionIdentity(sessionId);
	try {
		mkdirSync(path.join(root, '.swarm'), { recursive: true });
		const briefingPath = path.join(root, '.swarm', 'curator-briefing.md');
		writeFileSync(briefingPath, 'PAIRING-BRIEFING-v1 original', 'utf8');
		// G2 (#1729): curator-briefing.md is a cached artifact name — invalidate.
		invalidateCachedArtifact(briefingPath);
		const hook = createKnowledgeInjectorHook(
			root,
			pairingConfig(DEFAULT_INJECT_CHAR_BUDGET),
		);
		const first = await measureInvocation(hook, sessionId, false);
		if (!first.renderedText.includes('PAIRING-BRIEFING-v1')) {
			return {
				verified: false,
				detail: 'setup failure: prime invocation did not inject the briefing',
			};
		}
		writeFileSync(briefingPath, 'PAIRING-BRIEFING-v2 updated', 'utf8');
		// G2 (#1729): same cached-artifact name on the flip write.
		invalidateCachedArtifact(briefingPath);
		const second = await measureInvocation(hook, sessionId, true);
		const fresh =
			second.renderedText.includes('PAIRING-BRIEFING-v2') &&
			!second.renderedText.includes('PAIRING-BRIEFING-v1');
		return {
			verified: fresh,
			detail: fresh
				? 'identical-context replay after a curator-briefing change injected the fresh instruction set'
				: 'identical-context replay after a curator-briefing change re-served the stale cached instruction set',
		};
	} finally {
		// Invariant-8 hygiene: never leave synthetic pairing sessions mapped.
		// The refcounted release restores the ORIGINAL prior state (last
		// holder out) — see pairingIdentityHolds.
		releasePairingSessionIdentity(sessionId);
		sessionTempRoot.delete(sessionId);
		rmSync(root, { recursive: true, force: true });
	}
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join('')}}`;
	}
	return JSON.stringify(value);
}

/**
 * Runs the paired cached-vs-uncached control over the task set and returns the
 * report. Deterministic and offline (lexical store, hive disabled, real hook).
 */
export async function runInstructionSelectionPairing(
	options: InstructionPairingOptions,
): Promise<InstructionPairingReport> {
	const tasks = options.tasks ?? DEFAULT_INSTRUCTION_PAIRING_TASKS;
	const injectCharBudget =
		options.injectCharBudget ?? DEFAULT_INJECT_CHAR_BUDGET;
	const modelId = options.modelId ?? 'offline-deterministic';

	const pairs: InstructionPairingPair[] = [];
	for (const task of tasks) {
		pairs.push(await runTaskPairing(task, injectCharBudget));
	}
	const cacheInvalidation = await verifyCacheInvalidation();

	const taskSetId = createHash('sha256')
		.update(stableJson(tasks))
		.digest('hex');
	const instructionSetDigest = createHash('sha256')
		.update(
			stableJson({
				task_set: taskSetId,
				inject_char_budget: injectCharBudget,
				cache_invalidation_verified: cacheInvalidation.verified,
			}),
		)
		.digest('hex');

	const report: InstructionPairingReport = {
		schema_version: 1,
		generated_at: new Date().toISOString(),
		identity: {
			task_set_id: taskSetId,
			model_id: modelId,
			budget_chars: injectCharBudget,
			instruction_set_digest: instructionSetDigest,
		},
		pairs,
		measurement: {
			latency_denominator:
				'wall-clock milliseconds of the measured hook invocation (cached arm: the identical-context replay; uncached arm: the cold regeneration)',
			cost_denominator:
				'uncached arm regeneration latency in milliseconds, reported on both arms as the paired avoided-regeneration reference; absolute values only',
			prefix_denominator:
				'characters of the injected host-renderable guidance carrier for the measured invocation',
		},
		negative_results_retained: true,
		cache_invalidation: cacheInvalidation,
	};

	if (options.reportPath) {
		const dest = path.resolve(options.directory, options.reportPath);
		// Containment: an absolute or ..-traversing reportPath must not write
		// outside the caller's directory (PRR-001).
		const normalizedDir = path.resolve(options.directory) + path.sep;
		if (!dest.startsWith(normalizedDir)) {
			throw new Error(
				`reportPath must resolve inside the project directory: ${options.reportPath}`,
			);
		}
		mkdirSync(path.dirname(dest), { recursive: true });
		writeFileSync(dest, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	} else if (options.writeReport) {
		const dest = path.join(
			options.directory,
			'.swarm',
			'memory',
			'instruction-pairing-report.json',
		);
		mkdirSync(path.dirname(dest), { recursive: true });
		writeFileSync(dest, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	}

	return report;
}
