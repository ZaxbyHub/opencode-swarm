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
import { getSwarmAgents, resolveFallbackModel } from '../../agents/index';
import { stripKnownSwarmPrefix } from '../../config/schema';
import { DEFAULT_EPHEMERAL_TIMEOUT_MS } from '../../evaluation/ephemeral-agent-dispatcher';
import {
	createReviewModelDispatcher,
	type ReviewModelDispatcher,
} from '../../review/contracts';
import {
	type ReviewAgentModelRegistry,
	resolveAgentForActiveSwarm,
	reviewFallbackModelStrings,
	reviewPrimaryModel,
} from '../../review/runtime';
import { getAgentSession, swarmState } from '../../state';
import { telemetry } from '../../telemetry';
import { pushAdvisory } from '../../utils/advisory-queue';
import {
	dispatchWithModelFallback,
	type ModelOverride,
} from '../../utils/model-dispatch-fallback';
import {
	isQuotaError,
	isTransientProviderError,
} from '../../utils/provider-error-classification';
import {
	type LaneEvidence,
	listLaneEvidence,
	readPhaseEvidence,
	type ValidationArtifact,
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
	 * Default: the shared bounded dispatcher timeout.
	 */
	timeoutMs?: number;

	/**
	 * Require a diff summary in the compiled review package.
	 * When true, the package must include an `integratedDiffSummary` field.
	 * Default: false.
	 */
	requireDiffSummary?: boolean;

	/**
	 * Instance-local dispatcher bound to the active plugin client.
	 * New runtime call paths inject this instead of reading global client state.
	 */
	dispatcher?: ReviewModelDispatcher;

	/**
	 * Immutable agent-name registry captured by the plugin instance.
	 * Direct callers may omit this only when a single/default reviewer suffices.
	 */
	generatedAgentNames?: readonly string[];

	/** Exact active agent identity used to select this session's swarm. */
	activeAgentName?: string;

	/** Immutable plugin-instance model configuration for fallback ownership. */
	agentModelRegistry?: ReviewAgentModelRegistry;
}

const DEFAULT_CONFIG: Required<
	Omit<
		LeanTurboPhaseReviewerConfig,
		| 'dispatcher'
		| 'generatedAgentNames'
		| 'activeAgentName'
		| 'agentModelRegistry'
	>
> = {
	reviewerAgent: '', // empty → resolve from generatedAgentNames
	timeoutMs: DEFAULT_EPHEMERAL_TIMEOUT_MS,
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
 *
 * Exported for reuse by the auto-review hook (src/hooks/auto-review.ts).
 */
export function resolveDefaultReviewerAgent(
	generatedAgentNames: readonly string[],
	activeAgentName?: string,
): string {
	return resolveAgentForActiveSwarm(
		generatedAgentNames,
		'reviewer',
		activeAgentName,
	);
}

function resolveLegacyReviewerModelConfig(
	agentName: string,
	config: LeanTurboPhaseReviewerConfig | undefined,
):
	| {
			agentBaseName: string;
			swarmAgents: ReturnType<typeof getSwarmAgents>;
	  }
	| undefined {
	// Plugin-owned paths inject both the dispatcher and immutable registry.
	// Never consult process-global agent state for an injected runtime: doing so
	// would reintroduce cross-instance fallback leakage. This compatibility
	// fence exists only for older direct callers that still rely on getAgentConfigs.
	if (config?.dispatcher || config?.agentModelRegistry) return undefined;

	const agentBaseName = stripKnownSwarmPrefix(agentName);
	const swarmId =
		agentBaseName !== agentName
			? agentName.slice(0, agentName.length - agentBaseName.length - 1)
			: undefined;
	return {
		agentBaseName,
		swarmAgents: getSwarmAgents(swarmId),
	};
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
	validationArtifacts?: {
		build?: ValidationArtifact;
		test?: ValidationArtifact;
		lint?: ValidationArtifact;
	};
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

	if (phaseEvidence?.validationArtifacts) {
		pkg.validationArtifacts = phaseEvidence.validationArtifacts;
	}

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
 * Default implementation delegates to the shared bounded ephemeral-session
 * primitive through an instance-local ReviewModelDispatcher.
 */
async function defaultDispatchReviewerAgent(
	directory: string,
	reviewPackage: ReviewPackage,
	agentName: string,
	timeoutMs: number,
	parentSessionId?: string,
	model?: ModelOverride,
	dispatcher?: ReviewModelDispatcher,
): Promise<string> {
	let activeDispatcher = dispatcher;
	if (!activeDispatcher) {
		/**
		 * Backward-compatibility fence for direct callers and older integrations.
		 * Plugin/tool call paths inject a client-bound dispatcher and never take
		 * this branch. Remove this fallback after the public API deprecation window.
		 */
		const legacyClient = swarmState.opencodeClient;
		if (!legacyClient) throw new Error('ReviewModelDispatcher not available');
		activeDispatcher = createReviewModelDispatcher(legacyClient);
	}

	const system = `You are a read-only phase reviewer for Lean Turbo execution.
Review the supplied phase execution evidence and decide whether the phase is ready to advance.
Evaluate lane completion, unresolved degraded tasks, the file change set, and build status.
Conclude with exactly one verdict marker (APPROVED, NEEDS_REVISION, or REJECTED) and a REASON line.
Be specific and evidence-based. Never approve unresolved degraded tasks or incomplete lane execution.`;
	const prompt = `## Phase Review Package

\`\`\`json
${JSON.stringify(reviewPackage, null, 2)}
\`\`\`

Provide your analysis and conclude with:

VERDICT: APPROVED
REASON: [brief explanation]

OR

VERDICT: NEEDS_REVISION
REASON: [what must be fixed]

OR

VERDICT: REJECTED
REASON: [critical blocking issues]`;

	const result = await activeDispatcher.dispatch({
		directory,
		parentSessionId,
		agentName,
		model,
		system,
		prompt,
		title: parentSessionId ? 'lean_turbo_reviewer background' : undefined,
		timeoutMs,
	});
	if (result.status === 'completed') return result.text;
	if (result.status === 'timeout') {
		const timeoutDescription =
			timeoutMs > 0 ? `${timeoutMs}ms` : 'the bounded default';
		throw new Error(`Reviewer dispatch timed out after ${timeoutDescription}`);
	}
	throw new Error(
		result.error ??
			`Reviewer dispatch ${result.status === 'cancelled' ? 'cancelled' : 'failed'}`,
	);
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
		parentSessionId?: string,
		model?: ModelOverride,
		dispatcher?: ReviewModelDispatcher,
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
	const mergedConfig: Required<
		Omit<
			LeanTurboPhaseReviewerConfig,
			| 'dispatcher'
			| 'generatedAgentNames'
			| 'activeAgentName'
			| 'agentModelRegistry'
		>
	> = {
		...DEFAULT_CONFIG,
		...config,
	};

	// Resolve reviewer agent
	const generatedAgentNames =
		config?.generatedAgentNames ?? swarmState.generatedAgentNames;
	const agentName =
		mergedConfig.reviewerAgent ||
		resolveDefaultReviewerAgent(generatedAgentNames, config?.activeAgentName);

	// Compile the review package
	const pkg = await _internals.compileReviewPackage(
		directory,
		phase,
		sessionID,
		mergedConfig.requireDiffSummary,
	);

	// Dispatch the reviewer agent and await its response.
	// #1896: on a transient/quota dispatch error, fail over to a configured
	// reviewer fallback_model instead of immediately writing a REJECTED verdict
	// (a quota blip previously cascaded into a false phase rejection). Only after
	// the primary + all fallbacks are exhausted does the fail-closed path run.
	const fallbackModels = reviewFallbackModelStrings(
		agentName,
		config?.agentModelRegistry,
	);
	const legacyModelConfig = resolveLegacyReviewerModelConfig(agentName, config);
	let responseText: string;
	try {
		const dispatched = await dispatchWithModelFallback<string>({
			dispatch: (model) =>
				_internals.dispatchReviewerAgent(
					directory,
					pkg,
					agentName,
					mergedConfig.timeoutMs,
					sessionID,
					model,
					config?.dispatcher,
				),
			resolveFallback: (index) =>
				config?.agentModelRegistry
					? (fallbackModels[index - 1] ?? null)
					: legacyModelConfig
						? resolveFallbackModel(
								legacyModelConfig.agentBaseName,
								index,
								legacyModelConfig.swarmAgents,
							)
						: null,
			// Advance to the next model immediately on a transient/quota error — an
			// instant same-model retry cannot clear an exhausted quota.
			maxTransientRetriesPerModel: 0,
			classify: (err) => {
				const msg = err instanceof Error ? err.message : String(err);
				// A reviewer dispatch TIMEOUT is not a provider transient — keep
				// the existing fail-closed-then-REJECTED behavior instead of
				// failing over (a slow call on one model does not predict quota
				// exhaustion on the next). Mirrors the runner lane-timeout carve-out.
				if (/Reviewer dispatch timed out/i.test(msg)) return 'permanent';
				return isTransientProviderError(msg) ? 'transient' : 'permanent';
			},
			onFallback: ({ toModel, fallbackIndex }) => {
				telemetry.modelFallback(
					sessionID,
					agentName,
					reviewPrimaryModel(agentName, config?.agentModelRegistry) ??
						legacyModelConfig?.swarmAgents?.[legacyModelConfig.agentBaseName]
							?.model ??
						'default',
					toModel,
					'transient_model_error',
				);
				const session = getAgentSession(sessionID);
				if (session) {
					pushAdvisory(
						session,
						`MODEL FALLBACK: reviewer failed over to "${toModel}" (fallback ${fallbackIndex}) after a transient/quota dispatch error.`,
					);
				}
			},
		});
		responseText = dispatched.result;
	} catch (error) {
		// Fail-closed: dispatch failure (after fallbacks exhausted) → REJECTED verdict
		const isQuota = isQuotaError(
			error instanceof Error ? error.message : String(error),
		);
		const evidencePath = await _internals.writeReviewerEvidence(
			directory,
			phase,
			'REJECTED',
			error instanceof Error ? error.message : String(error),
		);
		return {
			verdict: 'REJECTED',
			reason: `Reviewer dispatch failed${isQuota ? ' (model quota/usage limit exhausted across all configured fallbacks)' : ''}: ${error instanceof Error ? error.message : String(error)}`,
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
