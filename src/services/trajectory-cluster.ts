/**
 * Macro-reflector trajectory clustering (Swarm Learning System, Change 6 /
 * Task 5.3, extended by #1234 Part 4).
 *
 * On the skill-improver's scheduled (quota-gated) cadence, scan the last N task
 * trajectories (`.swarm/evidence/<taskId>/trajectory.jsonl`), cluster repeated
 * FAILURE motifs by a (tool, kind) signature, and emit one skill PROPOSAL per
 * recurring motif to `.swarm/skills/proposals/`. Each proposal carries full
 * provenance: a draft SKILL.md body, the cluster of source task ids (and any
 * source knowledge ids), a verification predicate, and `applies_to_agents`.
 *
 * #1234 Part 4: also mines SUCCESS motifs — recurring multi-step tool sequences
 * that completed successfully across multiple tasks — and emits them as
 * `workflow`-type skill proposals tagged `skill_type: workflow`.
 *
 * Read-only over the knowledge store; writes only proposal markdown (never
 * active skills). Fail-open.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { listEvidenceTaskIds } from '../evidence/manager.js';
import { readTaskTrajectory } from '../hooks/micro-reflector.js';
import type { TrajectoryEntry } from '../hooks/trajectory-logger.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { warn } from '../utils/logger.js';
import {
	checkRecommendations,
	type RecommendationCandidate,
	recordEmittedRecommendations,
} from './recommendation-ledger.js';

/** Trajectories scanned per macro pass (the plan's N=200 window). */
export const MACRO_TRAJECTORY_WINDOW = 200;
/** A motif must recur across at least this many distinct tasks to propose. */
export const MOTIF_MIN_TASKS = 2;

export interface FailureMotif {
	signature: string;
	tool: string;
	kind: string;
	agent: string;
	taskIds: string[];
	sampleVerdicts: string[];
}

/** Map a failing trajectory step to a coarse failure "kind". */
function failureKind(e: TrajectoryEntry): string {
	const tool = (e.tool ?? '').toLowerCase();
	const ctx = `${e.action ?? ''} ${e.verdict ?? ''}`.toLowerCase();
	if (tool.includes('test') || /\btest\b/.test(ctx)) return 'test';
	if (
		tool.includes('lint') ||
		tool.includes('sast') ||
		/lint|typecheck|tsc|type error/.test(ctx)
	)
		return 'lint';
	if (/revert|rollback|checkpoint/.test(ctx)) return 'revert';
	if (tool === 'edit' || tool === 'write' || tool === 'patch') return 'write';
	if (tool === 'bash') return 'command';
	return 'other';
}

function slugify(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || 'motif'
	);
}

/**
 * Cluster failure motifs across the recent trajectory window. Returns motifs
 * that recur across >= MOTIF_MIN_TASKS distinct tasks, most-frequent first.
 */
export async function gatherFailureMotifs(
	directory: string,
	opts: { window?: number; minTasks?: number } = {},
): Promise<FailureMotif[]> {
	const window = opts.window ?? MACRO_TRAJECTORY_WINDOW;
	const minTasks = opts.minTasks ?? MOTIF_MIN_TASKS;
	try {
		const allTaskIds = await listEvidenceTaskIds(directory);
		const taskIds = allTaskIds.slice(-window);
		const clusters = new Map<
			string,
			{
				tool: string;
				kind: string;
				agents: Map<string, number>;
				taskIds: Set<string>;
				verdicts: string[];
			}
		>();

		for (const taskId of taskIds) {
			const trajectory = await readTaskTrajectory(directory, taskId);
			// One signature per task counts once toward that task's contribution,
			// so a single task spamming retries cannot manufacture a motif.
			const seenInTask = new Set<string>();
			for (const e of trajectory) {
				if (e.result !== 'failure') continue;
				const tool = (e.tool ?? 'unknown').toLowerCase();
				const kind = failureKind(e);
				const signature = `${tool}:${kind}`;
				let c = clusters.get(signature);
				if (!c) {
					c = {
						tool,
						kind,
						agents: new Map(),
						taskIds: new Set(),
						verdicts: [],
					};
					clusters.set(signature, c);
				}
				c.taskIds.add(taskId);
				const agent = (e.agent ?? 'unknown').toLowerCase();
				c.agents.set(agent, (c.agents.get(agent) ?? 0) + 1);
				if (!seenInTask.has(signature) && e.verdict) {
					c.verdicts.push(e.verdict.slice(0, 80));
				}
				seenInTask.add(signature);
			}
		}

		const motifs: FailureMotif[] = [];
		for (const [signature, c] of clusters) {
			if (c.taskIds.size < minTasks) continue;
			const agent =
				[...c.agents.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
				'unknown';
			motifs.push({
				signature,
				tool: c.tool,
				kind: c.kind,
				agent,
				taskIds: [...c.taskIds],
				sampleVerdicts: c.verdicts.slice(0, 3),
			});
		}
		motifs.sort((a, b) => b.taskIds.length - a.taskIds.length);
		return motifs;
	} catch (err) {
		warn(
			`[trajectory-cluster] motif scan failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return [];
	}
}

/** Suggest a verification predicate for a motif kind. */
function motifPredicate(motif: FailureMotif): string {
	switch (motif.kind) {
		case 'test':
			return 'tool:bun test';
		case 'lint':
			return 'tool:biome check';
		default:
			// A generic guard the reviewer can specialise; never auto-executed
			// without a directive author opting in.
			return `grep:TODO:src/**/*.ts`;
	}
}

/**
 * The recommendation a failure motif asserts, in cross-producer form
 * (issue #1821 AC21).
 *
 * The agent role is folded into the *statement* rather than carried as a scope
 * key so this statement can collide with an equivalent lesson proposed by the
 * curator or the consensus miner — the whole point of a shared identity. The
 * motif signature's constituents (tool, failure kind) are what actually vary
 * between motifs, so two distinct motifs never produce the same statement.
 */
function motifStatement(motif: FailureMotif): string {
	return `Avoid the recurring ${motif.kind} failure in ${motif.tool} observed for the ${motif.agent} role`;
}

/** Describe a failure motif to the cross-producer dedup ledger. */
function buildMotifCandidate(
	motif: FailureMotif,
	sessionId?: string,
): RecommendationCandidate {
	return {
		kind: 'improver',
		target: `motif-${slugify(motif.signature)}`,
		statement: motifStatement(motif),
		scopeKeys: [],
		provenance: {
			mechanism: 'skill_improver',
			sourceTaskIds: motif.taskIds,
		},
		origin: {
			agentRole: motif.agent,
			...(sessionId ? { sessionId } : {}),
		},
	};
}

/** Render a draft SKILL.md proposal body for a motif (with full provenance). */
export function buildMotifProposal(
	motif: FailureMotif,
	options: { fingerprint?: string; producedAt?: string } = {},
): string {
	const lines = [
		'---',
		`slug: motif-${slugify(motif.signature)}`,
		`title: "Avoid recurring ${motif.kind} failures (${motif.tool})"`,
		`status: proposal`,
		`applies_to_agents: [${slugify(motif.agent)}]`,
		`source_task_ids: [${motif.taskIds.map(slugify).join(', ')}]`,
		`verification_predicate: "${motifPredicate(motif)}"`,
		`generated_by: macro_reflector`,
		`generated_at: ${options.producedAt ?? new Date().toISOString()}`,
		// #1821: learning provenance, stamped only when the emission went through
		// the dedup ledger (which is what mints the fingerprint). `learning_mechanism`
		// matches `LearningMechanism` in src/learning/provenance.ts; the full
		// LearningProvenanceV1 record for this proposal lives on the ledger entry
		// carrying the same fingerprint.
		...(options.fingerprint
			? [
					`learning_mechanism: skill_improver`,
					`recommendation_fingerprint: ${options.fingerprint}`,
				]
			: []),
		'---',
		'',
		`# Recurring ${motif.kind} failure motif: \`${motif.signature}\``,
		'',
		`Observed across ${motif.taskIds.length} task(s) for the **${motif.agent}** role.`,
		'',
		'## Evidence (source trajectories)',
		...motif.taskIds.map((id) => `- ${id}`),
		'',
		'## Sample failures',
		...(motif.sampleVerdicts.length > 0
			? motif.sampleVerdicts.map((v) => `- ${v}`)
			: ['- (no verdict text recorded)']),
		'',
		'## Proposed guard',
		`Before completing work, the ${motif.agent} should verify via:`,
		'',
		'```',
		motifPredicate(motif),
		'```',
		'',
		'_Auto-generated proposal — review before activating as a skill._',
	];
	return lines.join('\n');
}

export interface MotifProposalResult {
	motifs: number;
	proposalsWritten: string[];
	/**
	 * #1821 AC21: motifs whose recommendation was already emitted — by an earlier
	 * improver run, the curator sweep, or the consensus miner — and were therefore
	 * not re-proposed.
	 */
	duplicatesSuppressed: number;
}

/**
 * Run the macro motif pass and write one proposal per recurring motif. Returns
 * the written proposal paths. Fail-open; never throws.
 */
export async function writeMotifProposals(
	directory: string,
	opts: {
		window?: number;
		minTasks?: number;
		maxProposals?: number;
		/** Recorded in the ledger entry's provenance write origin. */
		sessionId?: string;
	} = {},
): Promise<MotifProposalResult> {
	const result: MotifProposalResult = {
		motifs: 0,
		proposalsWritten: [],
		duplicatesSuppressed: 0,
	};
	try {
		const motifs = await gatherFailureMotifs(directory, opts);
		result.motifs = motifs.length;
		// Nothing to write → do not create the proposals directory (some callers
		// assert its absence when no drafts/proposals are produced).
		if (motifs.length === 0) return result;
		const max = opts.maxProposals ?? 10;
		const selected = motifs.slice(0, max);
		// #1821 AC21: read-only dedup check, then write, then record what was
		// actually written. One `producedAt` is shared by the ledger entry and the
		// proposal frontmatter so the two artifacts agree on when the
		// recommendation was emitted.
		const producedAt = _internals.now().toISOString();
		const candidates = selected.map((motif) =>
			buildMotifCandidate(motif, opts.sessionId),
		);
		const dedupCheck = await _internals.checkRecommendations(
			directory,
			candidates,
		);
		const emitted = dedupCheck.decisions.filter((decision) => decision.emit);
		result.duplicatesSuppressed = dedupCheck.decisions.length - emitted.length;
		// Everything was a duplicate → still do not create the proposals directory.
		if (emitted.length === 0) return result;
		const proposalsDir = validateSwarmPath(
			directory,
			path.join('skills', 'proposals'),
		);
		await mkdir(proposalsDir, { recursive: true });
		const written: RecommendationCandidate[] = [];
		for (const decision of emitted) {
			const motif = selected[decision.index];
			const candidate = candidates[decision.index];
			if (motif === undefined || candidate === undefined) continue;
			const slug = `motif-${slugify(motif.signature)}`;
			const filePath = path.join(proposalsDir, `${slug}.md`);
			await writeFile(
				filePath,
				buildMotifProposal(motif, {
					fingerprint: decision.fingerprint,
					producedAt,
				}),
				'utf-8',
			);
			result.proposalsWritten.push(filePath);
			written.push(candidate);
		}
		await _internals.recordEmittedRecommendations(directory, written, {
			producedAt,
		});
		return result;
	} catch (err) {
		warn(
			`[trajectory-cluster] proposal write failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return result;
	}
}

// ============================================================================
// Success motif mining (#1234 Part 4)
// ============================================================================

/** Minimum number of steps in a trajectory for it to qualify as a workflow. */
export const SUCCESS_SEQUENCE_MIN_STEPS = 3;

export interface SuccessMotif {
	signature: string;
	sequence: Array<{ tool: string; action: string }>;
	agent: string;
	taskIds: string[];
	gatesPassed: string[];
}

export interface SuccessMotifProposalResult {
	motifs: number;
	proposalsWritten: string[];
	/** #1821 AC21: see `MotifProposalResult.duplicatesSuppressed`. */
	duplicatesSuppressed: number;
}

/**
 * Extract the ordered tool sequence from a task's trajectory. Returns the
 * sequence only if the trajectory has >= SUCCESS_SEQUENCE_MIN_STEPS steps AND
 * every step's `result` is exactly `'success'`. Any non-`'success'` result
 * disqualifies the whole trajectory — that includes `'failure'` and the
 * `'pending'` bucket that trajectory-logger `mapResult` assigns to verdicts
 * like `needs_revision`/`concerns`/`blocked`. The code does not distinguish
 * among non-success values; they are all rejected, so non-successful patterns
 * never contaminate success-motif proposals.
 */
function extractSuccessSequence(
	trajectory: TrajectoryEntry[],
	minSteps: number = SUCCESS_SEQUENCE_MIN_STEPS,
): Array<{ tool: string; action: string }> | null {
	if (trajectory.length < minSteps) return null;
	if (trajectory.some((e) => e.result !== 'success')) return null;
	return trajectory.map((e) => ({
		tool: (e.tool ?? 'unknown').toLowerCase(),
		action: (e.action ?? 'run').toLowerCase(),
	}));
}

function sequenceSignature(
	seq: Array<{ tool: string; action: string }>,
): string {
	return seq.map((s) => `${s.tool}:${s.action}`).join('→');
}

function detectGatesPassed(trajectory: TrajectoryEntry[]): string[] {
	const gates = new Set<string>();
	for (const e of trajectory) {
		if (e.result !== 'success') continue;
		const tool = (e.tool ?? '').toLowerCase();
		const ctx = `${e.action ?? ''} ${e.verdict ?? ''}`.toLowerCase();
		if (tool.includes('test') || /\btest\b/.test(ctx)) gates.add('test');
		if (
			tool.includes('lint') ||
			tool.includes('sast') ||
			/lint|typecheck|tsc/.test(ctx)
		)
			gates.add('lint');
		if (/review|approve/.test(ctx)) gates.add('review');
	}
	return [...gates];
}

export async function gatherSuccessMotifs(
	directory: string,
	opts: { window?: number; minTasks?: number; minSteps?: number } = {},
): Promise<SuccessMotif[]> {
	const window = opts.window ?? MACRO_TRAJECTORY_WINDOW;
	const minTasks = opts.minTasks ?? MOTIF_MIN_TASKS;
	const minSteps = opts.minSteps ?? SUCCESS_SEQUENCE_MIN_STEPS;
	try {
		const allTaskIds = await listEvidenceTaskIds(directory);
		const taskIds = allTaskIds.slice(-window);
		const clusters = new Map<
			string,
			{
				sequence: Array<{ tool: string; action: string }>;
				agents: Map<string, number>;
				taskIds: Set<string>;
				gatesPassed: Set<string>;
			}
		>();

		for (const taskId of taskIds) {
			const trajectory = await readTaskTrajectory(directory, taskId);
			const seq = extractSuccessSequence(trajectory, minSteps);
			if (!seq) continue;
			const sig = sequenceSignature(seq);
			let c = clusters.get(sig);
			if (!c) {
				c = {
					sequence: seq,
					agents: new Map(),
					taskIds: new Set(),
					gatesPassed: new Set(),
				};
				clusters.set(sig, c);
			}
			c.taskIds.add(taskId);
			const agent = (trajectory[0]?.agent ?? 'unknown').toLowerCase();
			c.agents.set(agent, (c.agents.get(agent) ?? 0) + 1);
			for (const g of detectGatesPassed(trajectory)) {
				c.gatesPassed.add(g);
			}
		}

		const motifs: SuccessMotif[] = [];
		for (const [signature, c] of clusters) {
			if (c.taskIds.size < minTasks) continue;
			const agent =
				[...c.agents.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
				'unknown';
			motifs.push({
				signature,
				sequence: c.sequence,
				agent,
				taskIds: [...c.taskIds],
				gatesPassed: [...c.gatesPassed],
			});
		}
		motifs.sort((a, b) => b.taskIds.length - a.taskIds.length);
		return motifs;
	} catch (err) {
		warn(
			`[trajectory-cluster] success motif scan failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return [];
	}
}

/**
 * Deterministic slug for a success-motif workflow proposal. Single source of
 * truth so the proposal frontmatter and the on-disk filename always agree.
 */
function workflowSlug(signature: string): string {
	return `workflow-${slugify(signature.slice(0, 48))}`;
}

/**
 * The recommendation a success motif asserts, in cross-producer form
 * (issue #1821 AC21). Same agent-in-statement rationale as `motifStatement`.
 *
 * The rendered sequence MUST mirror `sequenceSignature` (`tool:action` per
 * step), not just the tool names: two motifs that share a tool chain but differ
 * in actions have different signatures, different slugs, and different proposal
 * files, so a tool-only statement would collapse two genuinely different
 * workflows onto one cross key and suppress the second.
 */
function workflowStatement(motif: SuccessMotif): string {
	const seqStr = motif.sequence
		.map((step) => `${step.tool}:${step.action}`)
		.join(' -> ');
	return `Follow the proven ${seqStr} workflow for the ${motif.agent} role`;
}

/** Describe a success motif to the cross-producer dedup ledger. */
function buildWorkflowCandidate(
	motif: SuccessMotif,
	sessionId?: string,
): RecommendationCandidate {
	return {
		kind: 'improver',
		target: workflowSlug(motif.signature),
		statement: workflowStatement(motif),
		scopeKeys: [],
		provenance: {
			mechanism: 'skill_improver',
			sourceTaskIds: motif.taskIds,
		},
		origin: {
			agentRole: motif.agent,
			...(sessionId ? { sessionId } : {}),
		},
	};
}

export function buildWorkflowProposal(
	motif: SuccessMotif,
	options: { fingerprint?: string; producedAt?: string } = {},
): string {
	const seqStr = motif.sequence.map((s) => s.tool).join(' → ');
	const slug = workflowSlug(motif.signature);
	const lines = [
		'---',
		`slug: ${slug}`,
		`title: "Successful workflow: ${seqStr}"`,
		`status: proposal`,
		`skill_type: workflow`,
		`applies_to_agents: [${slugify(motif.agent)}]`,
		`source_task_ids: [${motif.taskIds.map(slugify).join(', ')}]`,
		`generated_by: macro_reflector_success`,
		`generated_at: ${options.producedAt ?? new Date().toISOString()}`,
		// #1821: see the identical block in `buildMotifProposal`.
		...(options.fingerprint
			? [
					`learning_mechanism: skill_improver`,
					`recommendation_fingerprint: ${options.fingerprint}`,
				]
			: []),
		'---',
		'',
		`# Successful workflow pattern: ${seqStr}`,
		'',
		`Observed across ${motif.taskIds.length} task(s) for the **${motif.agent}** role. All steps completed successfully.`,
		'',
		'## Workflow sequence',
		...motif.sequence.map((s, i) => `${i + 1}. \`${s.tool}\` (${s.action})`),
		'',
		'## Gates passed',
		...(motif.gatesPassed.length > 0
			? motif.gatesPassed.map((g) => `- ${g}`)
			: ['- (no explicit gate steps detected)']),
		'',
		'## Evidence (source trajectories)',
		...motif.taskIds.map((id) => `- ${id}`),
		'',
		'## Recommended usage',
		`When starting a task matching this pattern, the ${motif.agent} should follow this proven sequence rather than re-deriving the approach.`,
		'',
		'_Auto-generated workflow proposal — review before activating as a skill._',
	];
	return lines.join('\n');
}

export async function writeSuccessMotifProposals(
	directory: string,
	opts: {
		window?: number;
		minTasks?: number;
		minSteps?: number;
		maxProposals?: number;
		/** Recorded in the ledger entry's provenance write origin. */
		sessionId?: string;
	} = {},
): Promise<SuccessMotifProposalResult> {
	const result: SuccessMotifProposalResult = {
		motifs: 0,
		proposalsWritten: [],
		duplicatesSuppressed: 0,
	};
	try {
		const motifs = await gatherSuccessMotifs(directory, opts);
		result.motifs = motifs.length;
		if (motifs.length === 0) return result;
		const max = opts.maxProposals ?? 10;
		const selected = motifs.slice(0, max);
		const producedAt = _internals.now().toISOString();
		const candidates = selected.map((motif) =>
			buildWorkflowCandidate(motif, opts.sessionId),
		);
		const dedupCheck = await _internals.checkRecommendations(
			directory,
			candidates,
		);
		const emitted = dedupCheck.decisions.filter((decision) => decision.emit);
		result.duplicatesSuppressed = dedupCheck.decisions.length - emitted.length;
		if (emitted.length === 0) return result;
		const proposalsDir = validateSwarmPath(
			directory,
			path.join('skills', 'proposals'),
		);
		await mkdir(proposalsDir, { recursive: true });
		const written: RecommendationCandidate[] = [];
		for (const decision of emitted) {
			const motif = selected[decision.index];
			const candidate = candidates[decision.index];
			if (motif === undefined || candidate === undefined) continue;
			const slug = workflowSlug(motif.signature);
			const filePath = path.join(proposalsDir, `${slug}.md`);
			await writeFile(
				filePath,
				buildWorkflowProposal(motif, {
					fingerprint: decision.fingerprint,
					producedAt,
				}),
				'utf-8',
			);
			result.proposalsWritten.push(filePath);
			written.push(candidate);
		}
		await _internals.recordEmittedRecommendations(directory, written, {
			producedAt,
		});
		return result;
	} catch (err) {
		warn(
			`[trajectory-cluster] success proposal write failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return result;
	}
}

/**
 * DI seam (AGENTS.md invariant 7). `now` pins the shared `producedAt` that the
 * ledger entry and the proposal frontmatter both carry; the two ledger functions
 * let a test exercise the suppressed / degraded branches without touching the
 * real ledger. Restore each entry in `afterEach`.
 */
export const _internals: {
	now: () => Date;
	checkRecommendations: typeof checkRecommendations;
	recordEmittedRecommendations: typeof recordEmittedRecommendations;
} = {
	now: () => new Date(),
	checkRecommendations,
	recordEmittedRecommendations,
};

/**
 * Pure-function seam for tests (writing-tests SKILL.md, Tier 0). The two
 * statement builders define the cross-producer identity of a motif, so a test
 * asserting cross-producer suppression must derive the competing statement from
 * them rather than hardcode a copy that can silently drift.
 */
export const _test_exports = { motifStatement, workflowStatement };
