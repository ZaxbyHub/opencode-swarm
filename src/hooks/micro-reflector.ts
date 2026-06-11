/**
 * Micro-reflector (Swarm Learning System, Change 6 / Task 5.1).
 *
 * The innermost reflection loop: runs when a delegated subagent returns (a
 * `tool.execute.after` hook on the `Task` tool). It reads the delegate's
 * transcript and the per-task trajectory slice
 * (`.swarm/evidence/<taskId>/trajectory.jsonl`), classifies the outcome, and —
 * ONLY on failure/partial outcomes — calls a cheap, quota-gated LLM to emit
 * 0–2 candidate insights conforming to the v3 actionability schema. Candidates
 * are appended to `.swarm/insight-candidates.jsonl`; they are NEVER written
 * directly to the knowledge store (the meso reflector consumes them at phase
 * boundary, Task 5.2).
 *
 * Budget: the prompt is capped well under ~2k input chars and the model is
 * asked for ≤512 output. Exactly one LLM call per qualifying return, gated by
 * the shared skill-improver quota. Fail-open: never throws, never blocks.
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { sanitizeTaskId } from '../evidence/manager.js';
import { reserveQuota } from '../services/skill-improver-quota.js';
import { warn } from '../utils/logger.js';
import type { CuratorLLMDelegate } from './curator.js';
import type { EnrichmentQuotaOptions } from './knowledge-curator.js';
import type { ActionableDirectiveFields } from './knowledge-types.js';
import {
	validateActionability,
	validateActionableFields,
} from './knowledge-validator.js';
import { parseDelegationArgs } from './skill-propagation-gate.js';
import type { TrajectoryEntry } from './trajectory-logger.js';
import { validateSwarmPath } from './utils.js';

export type MicroOutcome =
	| 'success'
	| 'failure_test'
	| 'failure_lint'
	| 'failure_revert'
	| 'partial';

/** Outcomes that warrant an LLM reflection (a lesson is most learnable here). */
const REFLECT_OUTCOMES: ReadonlySet<MicroOutcome> = new Set([
	'failure_test',
	'failure_lint',
	'failure_revert',
	'partial',
]);

export const MICRO_PROMPT_INPUT_CAP = 1800;
const MICRO_LLM_TIMEOUT_MS = 60_000;
const MAX_CANDIDATES = 2;

/** One v3-schema candidate insight written to the queue. */
export interface InsightCandidate extends ActionableDirectiveFields {
	lesson: string;
	category: string;
	tags: string[];
	source: {
		kind: 'micro_reflection';
		task_id?: string;
		agent: string;
		outcome: MicroOutcome;
		trajectory_steps: number;
	};
	created_at: string;
}

/** Returns `.swarm/insight-candidates.jsonl` for a project directory. */
export function resolveInsightCandidatesPath(directory: string): string {
	return validateSwarmPath(directory, 'insight-candidates.jsonl');
}

// ============================================================================
// Outcome classification
// ============================================================================

const TEST_FAIL_RE =
	/\b(\d+\s+fail(?:ed|ing|s)?|test(?:s)?\s+fail|failing\s+test|assertion\s+fail|FAIL\b|✗|✘)/i;
const LINT_FAIL_RE =
	/\b(lint\s+(?:error|fail)|biome\s+error|eslint\s+error|type\s*error|tsc\s+error|TS\d{3,})/i;
const REVERT_RE =
	/\b(revert(?:ed|ing)?|rolled?\s*back|restore[d]?\s+from\s+checkpoint|undo(?:ne)?\s+the\s+change)/i;
// Note: bare "TODO" is deliberately excluded — it appears constantly in healthy
// dev transcripts ("left a TODO comment") and would spuriously trigger reflection
// (a wasted LLM call). Only stronger, outcome-bearing phrases qualify.
const PARTIAL_RE =
	/\b(partial(?:ly)\s+complete|did\s+not\s+(?:finish|complete)|could\s+not\s+(?:finish|complete)|ran\s+out\s+of\s+(?:time|context|budget)|remaining\s+work|blocked\s+on|unable\s+to\s+complete|task\s+incomplete)/i;

/**
 * Classify the delegate outcome from its transcript + trajectory. Trajectory
 * tool results are authoritative when present; the transcript provides the
 * fallback signal. Defaults to 'success' (no reflection) when nothing matches.
 */
export function classifyOutcome(
	transcript: string,
	trajectory: TrajectoryEntry[],
): MicroOutcome {
	const text = transcript ?? '';

	// Trajectory-authoritative signals first: a failed tool call pins the kind.
	for (const e of trajectory) {
		if (e.result !== 'failure') continue;
		const tool = (e.tool ?? '').toLowerCase();
		const action = `${e.action ?? ''} ${e.verdict ?? ''}`.toLowerCase();
		if (tool.includes('test') || /test/.test(action)) return 'failure_test';
		if (
			tool.includes('lint') ||
			tool.includes('sast') ||
			/lint|typecheck|tsc/.test(action)
		)
			return 'failure_lint';
	}

	// Transcript signals.
	if (REVERT_RE.test(text)) return 'failure_revert';
	if (TEST_FAIL_RE.test(text)) return 'failure_test';
	if (LINT_FAIL_RE.test(text)) return 'failure_lint';
	if (PARTIAL_RE.test(text)) return 'partial';

	// A trajectory that ends on a non-success terminal step but no clear kind →
	// treat as partial so we still learn from it.
	const last = trajectory[trajectory.length - 1];
	if (last && last.result === 'failure') return 'partial';

	return 'success';
}

// ============================================================================
// Trajectory + candidate IO
// ============================================================================

/** Read a task's trajectory slice. Fail-open: [] when absent/corrupt. */
export async function readTaskTrajectory(
	directory: string,
	taskId: string,
): Promise<TrajectoryEntry[]> {
	try {
		const rel = path.join(
			'evidence',
			sanitizeTaskId(taskId),
			'trajectory.jsonl',
		);
		const filePath = validateSwarmPath(directory, rel);
		if (!existsSync(filePath)) return [];
		const content = await readFile(filePath, 'utf-8');
		const out: TrajectoryEntry[] = [];
		for (const line of content.split('\n')) {
			const t = line.trim();
			if (!t) continue;
			try {
				out.push(JSON.parse(t) as TrajectoryEntry);
			} catch {
				// skip corrupt line
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** Append validated candidates to the insight queue (best-effort, fail-open). */
async function appendInsightCandidates(
	directory: string,
	candidates: InsightCandidate[],
): Promise<void> {
	if (candidates.length === 0) return;
	const filePath = resolveInsightCandidatesPath(directory);
	await mkdir(path.dirname(filePath), { recursive: true });
	const lines = candidates.map((c) => JSON.stringify(c)).join('\n');
	await appendFile(filePath, `${lines}\n`, 'utf-8');
}

// ============================================================================
// Prompt + parsing
// ============================================================================

/** Compact a trajectory to a small, bounded textual summary. */
function summarizeTrajectory(trajectory: TrajectoryEntry[]): string {
	const tail = trajectory.slice(-12);
	return tail
		.map(
			(e) =>
				`${e.step}. ${e.tool}/${e.action} → ${e.result}${
					e.verdict ? ` (${e.verdict.slice(0, 40)})` : ''
				}`,
		)
		.join('\n')
		.slice(0, 800);
}

/** Build the bounded micro-reflection prompt (≤ MICRO_PROMPT_INPUT_CAP chars). */
export function buildMicroPrompt(params: {
	agent: string;
	outcome: MicroOutcome;
	transcript: string;
	trajectory: TrajectoryEntry[];
}): string {
	const trajectorySummary = summarizeTrajectory(params.trajectory);
	const transcriptTail = (params.transcript ?? '').slice(-700);
	const body = [
		`A ${params.agent} subagent just finished with outcome: ${params.outcome}.`,
		'Extract 0-2 GENERALIZABLE, ACTIONABLE lessons that would prevent this class of failure next time. Skip task-specific trivia.',
		'Output ONLY a JSON array (no prose, no fences). Each element MUST have:',
		'  "lesson": string (15-280 chars, generalizable),',
		'  at least one scope field: "applies_to_agents" (e.g. ["coder"]) or "applies_to_tools" (e.g. ["edit"]),',
		'  at least one predicate field: "forbidden_actions" | "required_actions" | "verification_checks" (arrays of short strings).',
		'Optional: "category" (process|testing|debugging|tooling|architecture|...), "directive_priority" (low|medium|high|critical).',
		'Return [] if there is no generalizable lesson.',
		'',
		`RECENT TRAJECTORY:\n${trajectorySummary}`,
		'',
		`TRANSCRIPT TAIL:\n${transcriptTail}`,
	].join('\n');
	return body.slice(0, MICRO_PROMPT_INPUT_CAP);
}

const CANDIDATE_ALLOWED_FIELDS = [
	'applies_to_agents',
	'applies_to_tools',
	'forbidden_actions',
	'required_actions',
	'verification_checks',
	'triggers',
] as const;

/** Parse the LLM response into validated v3 candidates (allowlist + actionable). */
export function parseMicroCandidates(
	response: string,
	meta: {
		agent: string;
		outcome: MicroOutcome;
		taskId?: string;
		steps: number;
	},
): InsightCandidate[] {
	let parsed: unknown;
	try {
		// Tolerate a leading/trailing prose by extracting the first JSON array.
		const start = response.indexOf('[');
		const end = response.lastIndexOf(']');
		if (start < 0 || end <= start) return [];
		parsed = JSON.parse(response.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: InsightCandidate[] = [];
	for (const item of parsed) {
		if (out.length >= MAX_CANDIDATES) break;
		if (!item || typeof item !== 'object') continue;
		const rec = item as Record<string, unknown>;
		const lesson = typeof rec.lesson === 'string' ? rec.lesson.trim() : '';
		if (lesson.length < 15 || lesson.length > 280) continue;

		// Allowlist + array-of-short-strings only (untrusted LLM output).
		const fields: ActionableDirectiveFields = {};
		for (const key of CANDIDATE_ALLOWED_FIELDS) {
			const v = rec[key];
			if (Array.isArray(v)) {
				const arr = v
					.filter((x): x is string => typeof x === 'string')
					.map((x) => x.slice(0, 200))
					.slice(0, 20);
				if (arr.length > 0) (fields as Record<string, unknown>)[key] = arr;
			}
		}
		const priority = rec.directive_priority;
		if (
			priority === 'low' ||
			priority === 'medium' ||
			priority === 'high' ||
			priority === 'critical'
		) {
			fields.directive_priority = priority;
		}

		// Shape + actionability gates (same as the curator enrichment path).
		if (!validateActionableFields(fields).valid) continue;
		if (!validateActionability(fields).actionable) continue;

		const category =
			typeof rec.category === 'string' ? rec.category : 'process';
		out.push({
			lesson,
			category,
			tags: [],
			...fields,
			source: {
				kind: 'micro_reflection',
				task_id: meta.taskId,
				agent: meta.agent,
				outcome: meta.outcome,
				trajectory_steps: meta.steps,
			},
			created_at: new Date().toISOString(),
		});
	}
	return out;
}

// ============================================================================
// Core + runtime adapter
// ============================================================================

export interface MicroReflectionResult {
	outcome: MicroOutcome;
	reflected: boolean;
	candidates: number;
}

/** Core micro-reflection. Never throws. */
export async function runMicroReflection(params: {
	directory: string;
	taskId?: string;
	agent: string;
	transcript: string;
	trajectory: TrajectoryEntry[];
	llmDelegate?: CuratorLLMDelegate;
	quota?: EnrichmentQuotaOptions;
}): Promise<MicroReflectionResult> {
	const outcome = classifyOutcome(params.transcript, params.trajectory);
	const result: MicroReflectionResult = {
		outcome,
		reflected: false,
		candidates: 0,
	};
	try {
		if (!REFLECT_OUTCOMES.has(outcome)) return result; // success → no LLM call
		if (!params.llmDelegate) return result;

		const quota = params.quota ?? { maxCalls: 10, window: 'utc' as const };
		const reservation = await reserveQuota(params.directory, {
			nCalls: 1,
			maxCalls: quota.maxCalls,
			window: quota.window,
		});
		if (!reservation.allowed) return result;

		const prompt = buildMicroPrompt({
			agent: params.agent,
			outcome,
			transcript: params.transcript,
			trajectory: params.trajectory,
		});
		const response = await params.llmDelegate(
			'',
			prompt,
			AbortSignal.timeout(MICRO_LLM_TIMEOUT_MS),
		);
		result.reflected = true;
		const candidates = parseMicroCandidates(response, {
			agent: params.agent,
			outcome,
			taskId: params.taskId,
			steps: params.trajectory.length,
		});
		await appendInsightCandidates(params.directory, candidates);
		result.candidates = candidates.length;
		return result;
	} catch (err) {
		warn(
			`[micro-reflector] reflection failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return result;
	}
}

/** Best-effort task id from a delegation prompt envelope. */
function extractTaskId(prompt: string): string | undefined {
	const m = /\btask[_-]?id\s*[:=]\s*([A-Za-z0-9._-]{1,80})/i.exec(prompt);
	return m ? m[1] : undefined;
}

export interface MicroReflectorInput {
	tool: unknown;
	args?: unknown;
	sessionID?: unknown;
}
export interface MicroReflectorOutput {
	output?: unknown;
}

function isTaskTool(tool: unknown): boolean {
	return tool === 'Task' || tool === 'task';
}

/**
 * `tool.execute.after` adapter for the `Task` tool. Resolves the delegate, the
 * transcript, the task id, and the trajectory slice, then runs micro-reflection.
 * The LLM delegate is provided by the caller (so tests can inject one); when
 * absent, classification still runs but no LLM call is made.
 */
export async function microReflectorAfter(
	directory: string,
	input: MicroReflectorInput,
	output: MicroReflectorOutput,
	llmDelegate?: CuratorLLMDelegate,
	quota?: EnrichmentQuotaOptions,
): Promise<void> {
	if (!isTaskTool(input.tool)) return;
	const transcript = typeof output.output === 'string' ? output.output : '';
	if (!transcript) return;
	const argsRecord =
		input.args && typeof input.args === 'object'
			? (input.args as Record<string, unknown>)
			: null;
	const prompt =
		argsRecord && typeof argsRecord.prompt === 'string'
			? argsRecord.prompt
			: '';
	const parsed = parseDelegationArgs(input.args);
	const agent = parsed ? stripKnownSwarmPrefix(parsed.targetAgent) : 'unknown';
	const taskId = extractTaskId(prompt);
	const trajectory = taskId ? await readTaskTrajectory(directory, taskId) : [];
	await runMicroReflection({
		directory,
		taskId,
		agent,
		transcript,
		trajectory,
		llmDelegate,
		quota,
	});
}
