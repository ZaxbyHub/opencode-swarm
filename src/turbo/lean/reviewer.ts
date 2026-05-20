/**
 * Lean Turbo Phase Reviewer Dispatch.
 *
 * Reads lane and phase evidence for a completed Lean Turbo phase,
 * compiles a combined review package, dispatches a read-only reviewer
 * agent via the Task tool, parses the verdict, and persists it to
 * `.swarm/evidence/{phase}/lean-turbo-reviewer.json`.
 *
 * ## Read-Only Reviewer Constraint
 *
 * The dispatched reviewer agent receives `tools: { write: false, edit: false, patch: false }`
 * to enforce that it performs only verification and never modifies the codebase.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { swarmState } from '../../state';
import {
	type LaneEvidence,
	listLaneEvidence,
	readPhaseEvidence,
} from './evidence';
import type { LeanTurboRunState } from './state';
import { readPersisted } from './state';

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Configuration options for phase reviewer dispatch.
 */
export interface LeanTurboPhaseReviewerConfig {
	/**
	 * Override the reviewer agent name.
	 * Default: derived from `generatedAgentNames` via `{swarmId}_reviewer` pattern
	 * when a swarm has multiple reviewers, or `reviewer` for the default swarm.
	 */
	reviewerAgent?: string;

	/**
	 * Timeout in milliseconds for the reviewer dispatch.
	 * Default: no timeout (reviewer is awaited indefinitely).
	 */
	timeoutMs?: number;

	/**
	 * Require a diff summary in the compiled review package.
	 * When true, the package must include an `integratedDiffSummary` field.
	 * Default: false.
	 */
	requireDiffSummary?: boolean;
}

const DEFAULT_CONFIG: Required<LeanTurboPhaseReviewerConfig> = {
	reviewerAgent: '', // empty → resolve from generatedAgentNames
	timeoutMs: 0, // 0/undefined → no timeout
	requireDiffSummary: false,
};

// ─── Result Types ─────────────────────────────────────────────────────────────

/**
 * Result of a phase reviewer dispatch.
 */
export interface PhaseReviewerResult {
	/** Reviewer verdict */
	verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
	/** Human-readable reason for the verdict */
	reason?: string;
	/** Path to the persisted reviewer evidence file */
	evidencePath: string;
}

// ─── Internal Functions ────────────────────────────────────────────────────────

/**
 * Resolves the default reviewer agent name from the generated agent names.
 *
 * Uses the `{swarmId}_reviewer` pattern for named swarms and bare `reviewer`
 * for the default swarm. Follows the same suffix-based resolution used by
 * `getCanonicalAgentRole` so that arbitrary swarm prefixes are handled correctly.
 */
function resolveDefaultReviewerAgent(generatedAgentNames: string[]): string {
	if (generatedAgentNames.length === 0) {
		return 'reviewer';
	}

	// Find the longest agent name that ends with "_reviewer" or "-reviewer"
	let best: string | null = null;
	for (const name of generatedAgentNames) {
		const lower = name.toLowerCase();
		if (
			(lower.endsWith('_reviewer') || lower.endsWith('-reviewer')) &&
			(!best || name.length > best.length)
		) {
			best = name;
		}
	}

	return (
		best ??
		(generatedAgentNames.includes('reviewer')
			? 'reviewer'
			: generatedAgentNames[0])
	);
}

/**
 * Compiles a structured review package from lane and phase evidence.
 */
interface ReviewPackage {
	phase: number;
	sessionID: string;
	laneSummaries: Array<{
		laneId: string;
		taskIds: string[];
		files: string[];
		status: LaneEvidence['status'];
		agent?: string;
	}>;
	filesChanged: string[];
	testResults: {
		totalLanes: number;
		completedLanes: number;
		failedLanes: number;
	};
	buildStatus: 'unknown' | 'passed' | 'failed';
	degradationSummary: {
		totalDegraded: number;
		resolvedDegraded: number;
		pendingDegraded: number;
	};
	integratedDiffSummary?: string;
}

async function compileReviewPackage(
	directory: string,
	phase: number,
	sessionID: string,
	requireDiffSummary: boolean,
): Promise<ReviewPackage> {
	// Read all lane evidence
	const lanes = await listLaneEvidence(directory, phase);

	// Validate lane evidence completeness against durable state
	const persisted = _internals.readPersisted?.(directory) ?? null;
	if (persisted) {
		let matchingRunState: LeanTurboRunState | null = null;
		for (const sessionState of Object.values(persisted.sessions)) {
			if (
				typeof sessionState === 'object' &&
				sessionState !== null &&
				(sessionState as LeanTurboRunState).status === 'running' &&
				(sessionState as LeanTurboRunState).phase === phase &&
				(sessionState as LeanTurboRunState).strategy === 'lean' &&
				(sessionState as LeanTurboRunState).sessionID === sessionID
			) {
				matchingRunState = sessionState as LeanTurboRunState;
				break;
			}
		}
		if (!matchingRunState && sessionID === undefined) {
			for (const sessionState of Object.values(persisted.sessions)) {
				if (
					typeof sessionState === 'object' &&
					sessionState !== null &&
					(sessionState as LeanTurboRunState).status === 'running' &&
					(sessionState as LeanTurboRunState).phase === phase &&
					(sessionState as LeanTurboRunState).strategy === 'lean'
				) {
					matchingRunState = sessionState as LeanTurboRunState;
					break;
				}
			}
		}
		if (matchingRunState?.lanes && matchingRunState.lanes.length > 0) {
			const evidenceLaneIds = new Set(lanes.map((l) => l.laneId));
			const missingLanes = matchingRunState.lanes.filter(
				(l) =>
					(l.status === 'completed' || l.status === 'failed') &&
					!evidenceLaneIds.has(l.laneId),
			);
			if (missingLanes.length > 0) {
				throw new Error(
					`Lane evidence missing for ${missingLanes.length} lane(s): ${missingLanes.map((l) => l.laneId).join(', ')}. ` +
						`Run lane execution before review.`,
				);
			}
		}
	}

	// Read phase evidence
	const phaseEvidence = await readPhaseEvidence(directory, phase);

	// Collect unique files changed across all lanes
	const filesChangedSet = new Set<string>();
	for (const lane of lanes) {
		for (const file of lane.files) {
			filesChangedSet.add(file);
		}
	}

	// Compute lane status counts
	const completedLanes = lanes.filter((l) => l.status === 'completed').length;
	const failedLanes = lanes.filter((l) => l.status === 'failed').length;

	// Build lane summaries
	const laneSummaries = lanes.map((lane) => ({
		laneId: lane.laneId,
		taskIds: lane.taskIds,
		files: lane.files,
		status: lane.status,
		agent: lane.agent,
	}));

	// Degradation summary
	const degradedTasks = phaseEvidence?.degradedTasks ?? [];
	const pendingDegraded = degradedTasks.filter(
		(dt) =>
			!lanes.some(
				(l) => l.taskIds.includes(dt.taskId) && l.status === 'completed',
			),
	).length;

	// Build status (best-effort from phase evidence)
	let buildStatus: ReviewPackage['buildStatus'] = 'unknown';
	if (phaseEvidence?.status === 'completed') {
		buildStatus = failedLanes === 0 ? 'passed' : 'failed';
	} else if (phaseEvidence?.status === 'failed') {
		buildStatus = 'failed';
	}

	const pkg: ReviewPackage = {
		phase,
		sessionID,
		laneSummaries,
		filesChanged: [...filesChangedSet],
		testResults: {
			totalLanes: lanes.length,
			completedLanes,
			failedLanes,
		},
		buildStatus,
		degradationSummary: {
			totalDegraded: degradedTasks.length,
			resolvedDegraded: degradedTasks.length - pendingDegraded,
			pendingDegraded,
		},
	};

	if (requireDiffSummary) {
		if (!phaseEvidence?.integratedDiffSummary) {
			throw new Error(
				`Integrated diff summary is required for phase ${phaseEvidence?.phase ?? 'unknown'} but missing. ` +
					`Run the review step with diff evidence generation enabled.`,
			);
		}
		pkg.integratedDiffSummary = phaseEvidence.integratedDiffSummary;
	}

	return pkg;
}

/**
 * Parses a reviewer verdict from the agent's text response.
 *
 * Looks for a verdict marker line: `VERDICT: APPROVED`, `VERDICT: NEEDS_REVISION`,
 * or `VERDICT: REJECTED` (case-insensitive). Returns null if no marker is found.
 *
 * The optional reason is extracted from a `REASON:` marker line that follows
 * the verdict marker on a subsequent line.
 */
function parseReviewerVerdict(responseText: string): {
	verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
	reason?: string;
} | null {
	const upperText = responseText.toUpperCase();

	const verdictMatch = upperText.match(
		/VERDICT\s*:\s*(APPROVED|NEEDS_REVISION|REJECTED)/,
	);
	if (!verdictMatch) {
		return null;
	}

	const verdict = verdictMatch[1] as 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';

	// Look for a REASON: line after the verdict
	const lines = responseText.split('\n');
	const verdictIndex = lines.findIndex((l) =>
		l.toUpperCase().match(/VERDICT\s*:\s*(APPROVED|NEEDS_REVISION|REJECTED)/i),
	);

	let reason: string | undefined;
	if (verdictIndex >= 0 && verdictIndex + 1 < lines.length) {
		const reasonMatch = lines[verdictIndex + 1].match(/^REASON\s*:\s*(.+)/i);
		if (reasonMatch) {
			reason = reasonMatch[1].trim();
		}
	}

	return { verdict, reason };
}

/**
 * Writes the reviewer verdict to the evidence file.
 * Uses atomic write (temp file + rename) to prevent partial-file artifacts.
 */
async function writeReviewerEvidence(
	directory: string,
	phase: number,
	verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED',
	reason?: string,
): Promise<string> {
	const evidenceDir = path.join(directory, '.swarm', 'evidence', String(phase));
	await fs.mkdir(evidenceDir, { recursive: true });

	const evidencePath = path.join(evidenceDir, 'lean-turbo-reviewer.json');
	const content = JSON.stringify(
		{
			phase,
			verdict,
			reason: reason ?? null,
			timestamp: new Date().toISOString(),
		},
		null,
		2,
	);

	// Atomic write: temp file in same directory, then rename
	const tempPath = `${evidencePath}.tmp.${process.pid}.${Date.now()}`;
	try {
		await fs.writeFile(tempPath, content, 'utf-8');
		await fs.rename(tempPath, evidencePath);
	} catch (error) {
		// Clean up temp file on failure
		try {
			await fs.unlink(tempPath);
		} catch {
			// ignore cleanup failure
		}
		throw error;
	}

	return evidencePath;
}

/**
 * Default implementation: uses the OpencodeClient session API to dispatch a
 * read-only reviewer agent and await its response.
 *
 * Returns the raw response text from the agent.
 * Throws if the dispatch fails or times out.
 */
async function defaultDispatchReviewerAgent(
	directory: string,
	reviewPackage: ReviewPackage,
	agentName: string,
	timeoutMs: number,
): Promise<string> {
	const client = swarmState.opencodeClient;
	if (!client) {
		throw new Error('OpencodeClient not available');
	}

	// Create an ephemeral session for the reviewer
	const sessionResult = await client.session.create({
		query: { directory },
	});

	if (!sessionResult.data?.id) {
		throw new Error('Failed to create reviewer session');
	}

	const sessionId = sessionResult.data.id;

	try {
		const promptText = `You are a read-only phase reviewer for Lean Turbo execution.

## Phase Review Package

\`\`\`json
${JSON.stringify(reviewPackage, null, 2)}
\`\`\`

## Your Task

Review the above phase execution evidence and produce a verdict on whether the phase is ready to advance.

Evaluate:
1. Were all lanes completed successfully (or gracefully failed)?
2. Are there degraded tasks that remain unresolved?
3. Does the file change set look correct and complete?
4. Is the build status acceptable?

## Output Format

Provide your analysis and conclude with:

VERDICT: APPROVED
REASON: [brief explanation of why the phase is approved]

OR

VERDICT: NEEDS_REVISION
REASON: [what must be fixed before the phase can advance]

OR

VERDICT: REJECTED
REASON: [critical issues that block phase advancement]

Be specific and evidence-based. Do not approve a phase with unresolved degraded tasks or incomplete lane execution.`;

		// When timeoutMs > 0: race prompt against a rejecting timeout promise
		// When timeoutMs <= 0 or undefined: await prompt directly (no race)
		const response =
			timeoutMs > 0
				? await Promise.race([
						client.session.prompt({
							path: { id: sessionId },
							body: {
								agent: agentName,
								tools: { write: false, edit: false, patch: false },
								parts: [{ type: 'text', text: promptText }],
							},
						}),
						new Promise<never>((_, reject) =>
							setTimeout(
								() =>
									reject(
										new Error(
											`Reviewer dispatch timed out after ${timeoutMs}ms`,
										),
									),
								timeoutMs,
							),
						),
					])
				: await client.session.prompt({
						path: { id: sessionId },
						body: {
							agent: agentName,
							tools: { write: false, edit: false, patch: false },
							parts: [{ type: 'text', text: promptText }],
						},
					});

		if (!response.data) {
			throw new Error('Reviewer session returned no data');
		}

		// Extract text from response parts
		const textParts = response.data.parts
			.filter((p) => p.type === 'text')
			.map((p) => p.text ?? '')
			.join('\n');

		return textParts;
	} finally {
		// Clean up the ephemeral session
		client.session.delete({ path: { id: sessionId } }).catch(() => {});
	}
}

// ─── _internals Seam ───────────────────────────────────────────────────────────

/**
 * Test-only dependency-injection seam.
 * Allows tests to intercept reviewer dispatch without mock.module leakage.
 */
export const _internals: {
	compileReviewPackage: typeof compileReviewPackage;
	parseReviewerVerdict: typeof parseReviewerVerdict;
	writeReviewerEvidence: typeof writeReviewerEvidence;
	dispatchReviewerAgent: (
		directory: string,
		pkg: ReviewPackage,
		agentName: string,
		timeoutMs: number,
	) => Promise<string>;
	resolveDefaultReviewerAgent: typeof resolveDefaultReviewerAgent;
	listLaneEvidence: typeof listLaneEvidence;
	readPhaseEvidence: typeof readPhaseEvidence;
	readPersisted: typeof readPersisted | null;
} = {
	compileReviewPackage,
	parseReviewerVerdict,
	writeReviewerEvidence,
	dispatchReviewerAgent: defaultDispatchReviewerAgent,
	resolveDefaultReviewerAgent,
	listLaneEvidence,
	readPhaseEvidence,
	readPersisted,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Dispatch a read-only reviewer agent to evaluate a completed Lean Turbo phase.
 *
 * Steps:
 *  1. Read all lane evidence from `.swarm/evidence/{phase}/lean-turbo/`
 *  2. Read phase evidence from `.swarm/evidence/{phase}/lean-turbo/lean-turbo-phase.json`
 *  3. Compile a combined review package
 *  4. Dispatch a read-only reviewer agent (tools: write=false, edit=false, patch=false)
 *  5. Parse the verdict from the agent's response
 *  6. Write the verdict to `.swarm/evidence/{phase}/lean-turbo-reviewer.json`
 *  7. Return the result
 *
 * @param directory - Project root directory
 * @param phase - Phase number being reviewed
 * @param sessionID - Lean Turbo session ID
 * @param config - Optional configuration overrides
 * @returns PhaseReviewerResult with verdict, optional reason, and evidence path
 * @throws Error if dispatch fails or response cannot be parsed (fail-closed)
 */
export async function dispatchPhaseReviewer(
	directory: string,
	phase: number,
	sessionID: string,
	config?: LeanTurboPhaseReviewerConfig,
): Promise<PhaseReviewerResult> {
	const mergedConfig: Required<LeanTurboPhaseReviewerConfig> = {
		...DEFAULT_CONFIG,
		...config,
	};

	// Resolve reviewer agent
	const generatedAgentNames = swarmState.generatedAgentNames;
	const agentName =
		mergedConfig.reviewerAgent ||
		resolveDefaultReviewerAgent(generatedAgentNames);

	// Compile the review package
	const pkg = await _internals.compileReviewPackage(
		directory,
		phase,
		sessionID,
		mergedConfig.requireDiffSummary,
	);

	// Dispatch the reviewer agent and await its response
	let responseText: string;
	try {
		responseText = await _internals.dispatchReviewerAgent(
			directory,
			pkg,
			agentName,
			mergedConfig.timeoutMs,
		);
	} catch (error) {
		// Fail-closed: dispatch failure → write REJECTED verdict
		const evidencePath = await _internals.writeReviewerEvidence(
			directory,
			phase,
			'REJECTED',
			error instanceof Error ? error.message : String(error),
		);
		return {
			verdict: 'REJECTED',
			reason: `Reviewer dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
			evidencePath,
		};
	}

	// Parse the verdict from the response
	const parsed = _internals.parseReviewerVerdict(responseText);

	// Fail-closed: unparseable response → REJECTED
	if (!parsed) {
		const evidencePath = await _internals.writeReviewerEvidence(
			directory,
			phase,
			'REJECTED',
			'Reviewer response could not be parsed',
		);
		return {
			verdict: 'REJECTED',
			reason: 'Reviewer response could not be parsed',
			evidencePath,
		};
	}

	// Write the verdict to the evidence file
	const evidencePath = await _internals.writeReviewerEvidence(
		directory,
		phase,
		parsed.verdict,
		parsed.reason,
	);

	return {
		verdict: parsed.verdict,
		reason: parsed.reason,
		evidencePath,
	};
}
