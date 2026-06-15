/**
 * Auto-review hook (auto-review machinery, piece B) — opt-in.
 *
 * When `auto_review.enabled` is true, completing a task
 * (`update_task_status` → status 'completed') and/or a phase
 * (`phase_complete`) automatically dispatches the registered reviewer agent
 * over a fresh ephemeral session to review the current execution diff —
 * the same "second model reviews the work in a clean context" pattern used
 * by Claude Code's auto-review and Codex's review model. The reviewer agent
 * carries its own configured model (`agents.reviewer.model`), so the review
 * model is independently configurable from the coder/architect models.
 *
 * The pass is ADVISORY and fully fail-open:
 *   - fire-and-forget from `tool.execute.after` (never blocks the tool)
 *   - verdicts are persisted as durable review receipts
 *     (`.swarm/review-receipts/`, scope-fingerprinted over the diff) and an
 *     `auto_review` event is appended to `.swarm/events.jsonl`
 *   - a REJECTED or unparseable verdict injects a `[AUTO-REVIEW]` advisory
 *     into the architect's next prompt; APPROVED stays silent
 *
 * Bounds (AGENTS.md invariants 3 and 8): the diff subprocess uses execFile
 * with cwd/timeout/maxBuffer and ignored stdin; dispatches are guarded by a
 * per-session in-flight set plus a 60s cooldown in a bounded FIFO map.
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import { ORCHESTRATOR_NAME } from '../config/constants.js';
import {
	type AutoReviewConfig,
	stripKnownSwarmPrefix,
} from '../config/schema.js';
import { swarmState } from '../state.js';
import { resolveDefaultReviewerAgent } from '../turbo/lean/reviewer.js';
import * as logger from '../utils/logger.js';
import { normalizeToolName } from './normalize-tool-name.js';
import {
	buildApprovedReceipt,
	buildRejectedReceipt,
	persistReviewReceipt,
} from './review-receipt.js';
import { parseReviewerOutput } from './review-receipt-collector.js';
import { validateSwarmPath } from './utils.js';

// ============================================================================
// Bounded session tracking (invariant 8)
// ============================================================================

const MAX_TRACKED_SESSIONS = 256;
const COOLDOWN_MS = 60_000;

const inFlightSessions = new Set<string>();
const lastDispatchBySession = new Map<string, number>();

function evictCooldownMap(): void {
	while (lastDispatchBySession.size > MAX_TRACKED_SESSIONS) {
		const firstKey = lastDispatchBySession.keys().next().value;
		if (firstKey === undefined) break;
		lastDispatchBySession.delete(firstKey);
	}
}

/** Test-only: clear module-level dispatch tracking. */
export function resetAutoReviewTracking(): void {
	inFlightSessions.clear();
	lastDispatchBySession.clear();
}

// ============================================================================
// Diff collection
// ============================================================================

function execGit(
	directory: string,
	args: string[],
	opts: { timeoutMs: number; maxBuffer: number },
): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = child_process.execFile(
			'git',
			args,
			{
				encoding: 'utf-8',
				cwd: directory,
				timeout: opts.timeoutMs,
				maxBuffer: opts.maxBuffer,
				// stdin ignored — a never-closed stdin pipe can block the child
				stdio: ['ignore', 'pipe', 'pipe'],
			} as child_process.ExecFileOptionsWithStringEncoding,
			(error, stdout) => {
				// Best-effort cleanup: kill the child once the callback fires so
				// it cannot outlive the caller after success, error, or timeout.
				proc.kill();
				if (error) {
					reject(error);
					return;
				}
				resolve(stdout ?? '');
			},
		);
	});
}

export type ExecutionDiffResult =
	| { status: 'ok'; diff: string }
	| { status: 'clean' }
	| { status: 'error'; reason: string };

/**
 * Collect the execution diff for review: `git diff HEAD` (tracked changes)
 * plus a porcelain summary of untracked files. Distinguishes a clean working
 * tree from collection failures (git missing, timeout, diff exceeding the
 * 2× maxBuffer cap) so events report honestly. Output is truncated to
 * `maxBytes`.
 */
async function computeExecutionDiff(
	directory: string,
	maxBytes: number,
): Promise<ExecutionDiffResult> {
	try {
		const [diff, status] = await Promise.all([
			execGit(directory, ['diff', 'HEAD'], {
				timeoutMs: 15_000,
				maxBuffer: Math.max(maxBytes * 2, 1024 * 1024),
			}),
			execGit(directory, ['status', '--porcelain'], {
				timeoutMs: 10_000,
				maxBuffer: 256 * 1024,
			}),
		]);
		const untracked = status
			.split('\n')
			.filter((l) => l.startsWith('??'))
			.map((l) => l.slice(3).trim())
			.filter(Boolean);
		if (!diff.trim() && untracked.length === 0) return { status: 'clean' };

		let combined = diff;
		if (untracked.length > 0) {
			combined += `\n\n## UNTRACKED FILES (not in diff above)\n${untracked
				.slice(0, 100)
				.map((f) => `- ${f}`)
				.join('\n')}`;
		}
		if (combined.length > maxBytes) {
			combined = `${combined.slice(0, maxBytes)}\n... [diff truncated at ${maxBytes} bytes]`;
		}
		return { status: 'ok', diff: combined };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.warn(`[auto-review] diff collection failed: ${reason}`);
		return { status: 'error', reason };
	}
}

// ============================================================================
// Reviewer dispatch (ephemeral session — curator/oversight pattern)
// ============================================================================

function buildReviewPrompt(
	trigger: string,
	diff: string,
	taskId?: string,
	phase?: number,
): string {
	return [
		`TASK: Review the execution diff below (automatic ${trigger} review pass).`,
		taskId ? `Plan task under review: ${taskId}.` : '',
		phase !== undefined ? `Phase under review: ${phase}.` : '',
		'FILE: see DIFF',
		'DIFF:',
		'```diff',
		diff,
		'```',
		'AFFECTS: infer from diff',
		'CHECK: correctness, security, regressions',
		'GATES: none',
		'SKILLS: none',
		'SKILLS_USED_BY_CODER: none',
		'',
		'This diff is the cumulative working-tree change — review the CHANGE, not pre-existing code.',
		'Respond in your mandated OUTPUT FORMAT, beginning directly with VERDICT.',
	]
		.filter(Boolean)
		.join('\n');
}

async function dispatchReviewer(
	directory: string,
	prompt: string,
	agentName: string,
	timeoutMs: number,
): Promise<string> {
	const client = swarmState.opencodeClient;
	if (!client) {
		throw new Error('OpencodeClient not available');
	}
	const createResult = await client.session.create({ query: { directory } });
	if (!createResult.data?.id) {
		throw new Error('Failed to create auto-review session');
	}
	const sessionId = createResult.data.id;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		const promptCall = client.session.prompt({
			path: { id: sessionId },
			body: {
				agent: agentName,
				// Read-only reviewer: verification only, never modification.
				tools: { write: false, edit: false, patch: false },
				parts: [{ type: 'text', text: prompt }],
			},
		});
		const response = await Promise.race([
			promptCall,
			new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(
					() => reject(new Error(`auto-review timed out after ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
		if (!response.data) {
			throw new Error('auto-review session returned no data');
		}
		return response.data.parts
			.filter((p): p is typeof p & { text: string } => p.type === 'text')
			.map((p) => p.text)
			.join('\n');
	} finally {
		// Clear the race timer so successful dispatches do not leave a pending
		// timeout (up to 30min) keeping the event loop alive.
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		client.session.delete({ path: { id: sessionId } }).catch(() => {});
	}
}

// ============================================================================
// Event persistence
// ============================================================================

interface AutoReviewEvent {
	type: 'auto_review';
	timestamp: string;
	session_id: string;
	trigger: string;
	task_id?: string;
	phase?: number;
	verdict: 'approved' | 'rejected' | 'unparseable' | 'error' | 'skipped';
	detail: string;
	receipt_path?: string;
}

// In-process serialization of events.jsonl appends: prevents two concurrent
// writeAutoReviewEvent calls from racing on the read-N + write-N+1 + rename
// pattern, where the second rename silently drops the first caller's new line.
// Serializing through a promise chain also eliminates the O(n) read/write cost
// — each append becomes O(1) via appendFileSync regardless of file size.
// Cross-process races are extremely rare (two distinct OpenCode instances
// writing events simultaneously) and are accepted as best-effort.
// NOTE: writeAutoReviewEvent is synchronous (: void) so we cannot `await prev`
// here. The serialization guarantee comes from appendFileSync being blocking:
// each call completes before the next event-loop callback runs, so writes are
// naturally ordered. The promise chain preserves the structural pattern from
// review-receipt.ts withIndexLock for consistency and future async migration.
let _eventWriteLockChain: Promise<void> = Promise.resolve();

function withEventWriteLock<T>(fn: () => T): T {
	let release!: () => void;
	_eventWriteLockChain = new Promise<void>((r) => {
		release = r;
	});
	try {
		return fn();
	} finally {
		release();
	}
}

function writeAutoReviewEvent(directory: string, event: AutoReviewEvent): void {
	try {
		const eventsPath = validateSwarmPath(directory, 'events.jsonl');
		const line = `${JSON.stringify(event)}\n`;
		withEventWriteLock(() => {
			fs.appendFileSync(eventsPath, line, 'utf-8');
		});
	} catch (err) {
		logger.warn(
			`[auto-review] event write failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ============================================================================
// Run
// ============================================================================

export interface AutoReviewRunInput {
	directory: string;
	sessionID: string;
	trigger: 'task_completion' | 'phase_boundary';
	taskId?: string;
	phase?: number;
	config: Required<Pick<AutoReviewConfig, 'timeout_ms' | 'max_diff_kb'>>;
	injectAdvisory: (sessionId: string, message: string) => void;
}

/**
 * Execute one auto-review pass: collect diff → dispatch reviewer over an
 * ephemeral session → persist receipt + event → advisory on REJECTED or
 * unparseable output. Fully fail-open; never throws.
 */
export async function runAutoReview(input: AutoReviewRunInput): Promise<void> {
	const { directory, sessionID, trigger, taskId, phase, config } = input;
	const base = {
		type: 'auto_review' as const,
		timestamp: new Date().toISOString(),
		session_id: sessionID,
		trigger,
		task_id: taskId,
		phase,
	};
	try {
		const diffResult = await _internals.computeExecutionDiff(
			directory,
			config.max_diff_kb * 1024,
		);
		if (diffResult.status === 'clean') {
			writeAutoReviewEvent(directory, {
				...base,
				verdict: 'skipped',
				detail: 'clean working tree — nothing to review',
			});
			return;
		}
		if (diffResult.status === 'error') {
			writeAutoReviewEvent(directory, {
				...base,
				verdict: 'error',
				detail: `diff collection failed: ${diffResult.reason}`,
			});
			return;
		}
		const diff = diffResult.diff;

		const agentName = resolveDefaultReviewerAgent(
			swarmState.generatedAgentNames,
		);
		const prompt = buildReviewPrompt(trigger, diff, taskId, phase);

		let transcript: string;
		try {
			transcript = await _internals.dispatchReviewer(
				directory,
				prompt,
				agentName,
				config.timeout_ms,
			);
		} catch (err) {
			writeAutoReviewEvent(directory, {
				...base,
				verdict: 'error',
				detail: `dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}

		const parsed = parseReviewerOutput(transcript);
		if (!parsed) {
			writeAutoReviewEvent(directory, {
				...base,
				verdict: 'unparseable',
				detail: 'reviewer response had no VERDICT line',
			});
			input.injectAdvisory(
				sessionID,
				`[AUTO-REVIEW] Automatic ${trigger} review returned no machine-readable verdict. Treat as UNVERIFIED — inspect the diff or re-dispatch @reviewer before proceeding.`,
			);
			return;
		}

		const receipt =
			parsed.verdict === 'approved'
				? buildApprovedReceipt({
						agent: 'reviewer',
						sessionId: sessionID,
						scopeContent: diff,
						scopeDescription: `auto-review-${trigger}-diff`,
						checkedAspects: ['correctness', 'security', 'regressions'],
						validatedClaims: [
							`AUTO-REVIEW VERDICT: APPROVED${parsed.risk ? ` (risk ${parsed.risk})` : ''}`,
						],
						caveats: parsed.issues.map((i) => i.text),
					})
				: buildRejectedReceipt({
						agent: 'reviewer',
						sessionId: sessionID,
						scopeContent: diff,
						scopeDescription: `auto-review-${trigger}-diff`,
						blockingFindings: parsed.issues.map((i) => ({
							location: i.location ?? 'unknown',
							summary: i.text,
							severity: i.severity,
						})),
						evidenceReferences: parsed.issues
							.map((i) => i.location)
							.filter((loc): loc is string => Boolean(loc)),
						passConditions: parsed.fixes,
						summary: `Auto-review REJECTED${parsed.risk ? ` (risk ${parsed.risk})` : ''}`,
					});

		let receiptPath: string | undefined;
		try {
			receiptPath = await persistReviewReceipt(directory, receipt);
		} catch (err) {
			logger.warn(
				`[auto-review] receipt persistence failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		writeAutoReviewEvent(directory, {
			...base,
			verdict: parsed.verdict,
			detail:
				parsed.verdict === 'approved'
					? `approved${parsed.risk ? ` (risk ${parsed.risk})` : ''}`
					: `rejected with ${parsed.issues.length} issue(s)`,
			receipt_path: receiptPath,
		});

		if (parsed.verdict === 'rejected') {
			const topIssues = parsed.issues
				.slice(0, 3)
				.map((i) => `  • ${i.text}`)
				.join('\n');
			input.injectAdvisory(
				sessionID,
				[
					`[AUTO-REVIEW] Automatic ${trigger} review REJECTED the current diff${parsed.risk ? ` (risk ${parsed.risk})` : ''}.`,
					topIssues,
					parsed.fixes.length > 0
						? `Required fixes: ${parsed.fixes.slice(0, 3).join('; ')}`
						: '',
					'Address the findings (delegate to coder, then re-review) before continuing.',
				]
					.filter(Boolean)
					.join('\n'),
			);
		}
	} catch (err) {
		logger.warn(
			`[auto-review] run failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ============================================================================
// Hook factory
// ============================================================================

export interface AutoReviewHookOptions {
	config: AutoReviewConfig;
	directory: string;
	injectAdvisory: (sessionId: string, message: string) => void;
}

export function createAutoReviewHook(options: AutoReviewHookOptions): {
	toolAfter: (
		input: { tool: string; sessionID: string; callID?: string },
		output: { args?: unknown; output?: unknown },
	) => Promise<void>;
} {
	const { config, directory, injectAdvisory } = options;
	if (!config.enabled) {
		return { toolAfter: async () => {} };
	}
	const wantsTask =
		config.trigger === 'task_completion' || config.trigger === 'both';
	const wantsPhase =
		config.trigger === 'phase_boundary' || config.trigger === 'both';

	return {
		toolAfter: async (input, output) => {
			try {
				const tool = (
					normalizeToolName(input.tool) ??
					input.tool ??
					''
				).toLowerCase();
				const sessionID = input.sessionID;
				if (!sessionID) return;

				// Only the orchestrator's session triggers a review pass (same
				// guard as self-review.ts) — defense in depth on top of the
				// architect-only tool map for update_task_status/phase_complete.
				const agentName =
					swarmState.activeAgent.get(sessionID) ??
					swarmState.agentSessions.get(sessionID)?.agentName ??
					'';
				if (
					agentName &&
					stripKnownSwarmPrefix(agentName) !== ORCHESTRATOR_NAME
				) {
					return;
				}

				const args =
					(output.args as Record<string, unknown> | undefined) ?? undefined;

				let trigger: 'task_completion' | 'phase_boundary' | null = null;
				let taskId: string | undefined;
				let phase: number | undefined;
				if (
					wantsTask &&
					tool === 'update_task_status' &&
					args?.status === 'completed'
				) {
					trigger = 'task_completion';
					taskId = typeof args.task_id === 'string' ? args.task_id : undefined;
				} else if (wantsPhase && tool === 'phase_complete') {
					trigger = 'phase_boundary';
					phase =
						typeof args?.phase === 'number' && Number.isInteger(args.phase)
							? args.phase
							: undefined;
				}
				if (!trigger) return;

				// Re-entrancy + cooldown: one dispatch at a time per session, and
				// at most one per 60s (repeated phase_complete retries while gates
				// fail must not spam review sessions).
				if (inFlightSessions.has(sessionID)) return;
				const last = lastDispatchBySession.get(sessionID) ?? 0;
				if (_internals.now() - last < COOLDOWN_MS) return;

				inFlightSessions.add(sessionID);
				lastDispatchBySession.delete(sessionID);
				lastDispatchBySession.set(sessionID, _internals.now());
				evictCooldownMap();

				// Fire-and-forget: the advisory/receipt lands asynchronously; the
				// tool call itself is never delayed by the review model.
				void _internals
					.runAutoReview({
						directory,
						sessionID,
						trigger,
						taskId,
						phase,
						config: {
							timeout_ms: config.timeout_ms,
							max_diff_kb: config.max_diff_kb,
						},
						injectAdvisory,
					})
					.finally(() => {
						inFlightSessions.delete(sessionID);
					});
			} catch (err) {
				logger.warn(
					`[auto-review] hook error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	};
}

// ============================================================================
// _internals seam (writing-tests skill: DI over mock.module)
// ============================================================================

export const _internals: {
	computeExecutionDiff: typeof computeExecutionDiff;
	dispatchReviewer: typeof dispatchReviewer;
	runAutoReview: typeof runAutoReview;
	now: () => number;
} = {
	computeExecutionDiff,
	dispatchReviewer,
	runAutoReview,
	now: () => Date.now(),
};
