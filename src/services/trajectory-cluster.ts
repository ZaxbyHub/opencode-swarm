/**
 * Macro-reflector trajectory clustering (Swarm Learning System, Change 6 /
 * Task 5.3).
 *
 * On the skill-improver's scheduled (quota-gated) cadence, scan the last N task
 * trajectories (`.swarm/evidence/<taskId>/trajectory.jsonl`), cluster repeated
 * FAILURE motifs by a (tool, kind) signature, and emit one skill PROPOSAL per
 * recurring motif to `.swarm/skills/proposals/`. Each proposal carries full
 * provenance: a draft SKILL.md body, the cluster of source task ids (and any
 * source knowledge ids), a verification predicate, and `applies_to_agents`.
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

/** Render a draft SKILL.md proposal body for a motif (with full provenance). */
export function buildMotifProposal(motif: FailureMotif): string {
	const lines = [
		'---',
		`slug: motif-${slugify(motif.signature)}`,
		`title: "Avoid recurring ${motif.kind} failures (${motif.tool})"`,
		`status: proposal`,
		`applies_to_agents: [${motif.agent}]`,
		`source_task_ids: [${motif.taskIds.join(', ')}]`,
		`verification_predicate: "${motifPredicate(motif)}"`,
		`generated_by: macro_reflector`,
		`generated_at: ${new Date().toISOString()}`,
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
}

/**
 * Run the macro motif pass and write one proposal per recurring motif. Returns
 * the written proposal paths. Fail-open; never throws.
 */
export async function writeMotifProposals(
	directory: string,
	opts: { window?: number; minTasks?: number; maxProposals?: number } = {},
): Promise<MotifProposalResult> {
	const result: MotifProposalResult = { motifs: 0, proposalsWritten: [] };
	try {
		const motifs = await gatherFailureMotifs(directory, opts);
		result.motifs = motifs.length;
		// Nothing to write → do not create the proposals directory (some callers
		// assert its absence when no drafts/proposals are produced).
		if (motifs.length === 0) return result;
		const max = opts.maxProposals ?? 10;
		const proposalsDir = validateSwarmPath(
			directory,
			path.join('skills', 'proposals'),
		);
		await mkdir(proposalsDir, { recursive: true });
		for (const motif of motifs.slice(0, max)) {
			const slug = `motif-${slugify(motif.signature)}`;
			const filePath = path.join(proposalsDir, `${slug}.md`);
			await writeFile(filePath, buildMotifProposal(motif), 'utf-8');
			result.proposalsWritten.push(filePath);
		}
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
