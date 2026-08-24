/**
 * Lean Turbo Phase Critic Boundary Review Dispatch.
 *
 * Reads reviewer and phase evidence for a completed Lean Turbo phase,
 * compiles a combined boundary review package, dispatches a read-only critic
 * agent via the Task tool, parses the verdict, and persists it to
 * `.swarm/evidence/{phase}/lean-turbo-critic.json`.
 *
 * ## Read-Only Critic Constraint
 *
 * The dispatched critic agent receives `tools: { write: false, edit: false, patch: false }`
 * to enforce that it performs only verification and never modifies the codebase.
 *
 * #1896 / #1905: on a transient/quota dispatch error the critic fails over to a
 * configured `fallback_models` entry via the shared `dispatchWithModelFallback`
 * helper, instead of immediately writing a REJECTED verdict (a quota blip
 * previously cascaded into a false phase rejection). The SDK error envelope is
 * preserved in the thrown message so the classifier sees the quota token on the
 * dominant SDK error shape.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getSwarmAgents, resolveFallbackModel } from '../../agents/index';
import { peekModelFallbackIndex } from '../../agents/model-override.js';
import { stripKnownSwarmPrefix } from '../../config/schema';
import type { ReviewModelDispatcher } from '../../review/contracts';
import {
	type ReviewAgentModelRegistry,
	resolveAgentForActiveSwarm,
	reviewFallbackModelStrings,
	reviewPrimaryModel,
} from '../../review/runtime';
import { getAgentSession, swarmState } from '../../state';
import { telemetry } from '../../telemetry';
import { pushAdvisory } from '../../utils/advisory-queue';
import { teardownEphemeralSession } from '../../utils/ephemeral-session-teardown';
import {
	dispatchWithModelFallback,
	type ModelOverride,
} from '../../utils/model-dispatch-fallback';
import {
	isQuotaError,
	isTransientProviderError,
} from '../../utils/provider-error-classification';
import { invalidateCachedArtifact } from '../../utils/swarm-artifact-cache';
import {
	type LaneEvidence,
	listLaneEvidence,
	readPhaseEvidence,
	type ValidationArtifact,
} from './evidence';

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Configuration options for phase critic dispatch.
 */
export interface LeanTurboPhaseCriticConfig {
	/**
	 * Override the critic agent name.
	 * Default: derived from `generatedAgentNames` via `{swarmId}_critic` pattern
	 * when a swarm has multiple critics, or `critic` for the default swarm.
	 */
	criticAgent?: string;

	/**
	 * Timeout in milliseconds for the critic dispatch.
	 * Default: no timeout (critic is awaited indefinitely).
	 */
	timeoutMs?: number;

	/**
	 * Instance-local dispatcher bound to the active plugin client.
	 * New runtime call paths inject this instead of reading global client state.
	 */
	dispatcher?: ReviewModelDispatcher;

	/**
	 * Immutable agent-name registry captured by the plugin instance.
	 * Direct callers may omit this only when a single/default critic suffices.
	 */
	generatedAgentNames?: readonly string[];

	/** Exact active agent identity used to select this session's swarm. */
	activeAgentName?: string;

	/** Immutable plugin-instance model configuration for fallback ownership. */
	agentModelRegistry?: ReviewAgentModelRegistry;
}

const DEFAULT_CONFIG: Required<
	Omit<
		LeanTurboPhaseCriticConfig,
		| 'dispatcher'
		| 'generatedAgentNames'
		| 'activeAgentName'
		| 'agentModelRegistry'
	>
> = {
	criticAgent: '', // empty → resolve from generatedAgentNames
	timeoutMs: 0, // 0/undefined → no timeout
};

// ─── Result Types ─────────────────────────────────────────────────────────────

/**
 * Result of a phase critic dispatch.
 */
export interface PhaseCriticResult {
	/** Critic verdict */
	verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | 'ESCALATE_TO_HUMAN';
	/** Human-readable reason for the verdict */
	reason?: string;
	/** Path to the persisted critic evidence file */
	evidencePath: string;
}

// ─── Internal Types ───────────────────────────────────────────────────────────

/**
 * Reviewer evidence record (lean-turbo-reviewer.json).
 */
interface ReviewerEvidence {
	phase: number;
	verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
	reason?: string | null;
	timestamp: string;
}

// ─── Internal Functions ────────────────────────────────────────────────────────

/**
 * Resolves the default critic agent name from the generated agent names.
 *
 * Uses the `{swarmId}_critic` pattern for named swarms and bare `critic`
 * for the default swarm. Follows the same suffix-based resolution used by
 * `getCanonicalAgentRole` so that arbitrary swarm prefixes are handled correctly.
 */
function resolveDefaultCriticAgent(
	generatedAgentNames: readonly string[],
	activeAgentName?: string,
): string {
	return resolveAgentForActiveSwarm(
		generatedAgentNames,
		'critic',
		activeAgentName,
	);
}

function resolveLegacyCriticModelConfig(
	agentName: string,
	config: LeanTurboPhaseCriticConfig | undefined,
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
 * Reads the reviewer evidence from .swarm/evidence/{phase}/lean-turbo-reviewer.json.
 *
 * @returns Parsed reviewer evidence, or null if file does not exist or is invalid
 */
async function readReviewerEvidence(
	directory: string,
	phase: number,
): Promise<ReviewerEvidence | null> {
	const evidencePath = path.join(
		directory,
		'.swarm',
		'evidence',
		String(phase),
		'lean-turbo-reviewer.json',
	);

	let content: string;
	try {
		content = await fs.readFile(evidencePath, 'utf-8');
	} catch (error) {
		// ENOENT / ENOTDIR means file doesn't exist — not an error
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return null;
		}
		throw error;
	}

	try {
		return JSON.parse(content) as ReviewerEvidence;
	} catch {
		// Invalid JSON — treat as missing
		return null;
	}
}

/**
 * Compiles a structured boundary review package from reviewer and phase evidence.
 */
interface CriticPackage {
	phase: number;
	sessionID: string;
	/** Reviewer verdict if available */
	reviewerVerdict?: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
	/** Whether reviewer evidence was missing or invalid */
	reviewerMissing: boolean;
	/** Safety concerns noted during compilation */
	safetyConcerns: string[];
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
}

async function compileCriticPackage(
	directory: string,
	phase: number,
	sessionID: string,
): Promise<CriticPackage> {
	// Read all lane evidence
	const lanes = await listLaneEvidence(directory, phase);

	// Read phase evidence
	const phaseEvidence = await readPhaseEvidence(directory, phase);

	// Read reviewer evidence
	const reviewerEvidence = await readReviewerEvidence(directory, phase);

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

	// Safety concerns
	const safetyConcerns: string[] = [];

	// Note missing reviewer evidence as a safety concern
	if (!reviewerEvidence) {
		safetyConcerns.push(
			'Reviewer evidence is missing — critic cannot verify reviewer assessment',
		);
	} else if (reviewerEvidence.verdict === 'REJECTED') {
		safetyConcerns.push(
			`Reviewer verdict is REJECTED: ${reviewerEvidence.reason ?? 'no reason provided'}`,
		);
	} else if (reviewerEvidence.verdict === 'NEEDS_REVISION') {
		safetyConcerns.push(
			`Reviewer verdict is NEEDS_REVISION: ${reviewerEvidence.reason ?? 'no reason provided'}`,
		);
	}

	// Note pending degraded tasks as a safety concern
	if (pendingDegraded > 0) {
		safetyConcerns.push(
			`${pendingDegraded} degraded task(s) remain unresolved`,
		);
	}

	// Note failed lanes as a safety concern
	if (failedLanes > 0) {
		safetyConcerns.push(`${failedLanes} lane(s) failed`);
	}

	const pkg: CriticPackage = {
		phase,
		sessionID,
		reviewerVerdict: reviewerEvidence?.verdict,
		reviewerMissing: !reviewerEvidence,
		safetyConcerns,
		laneSummaries,
		filesChanged: [...filesChangedSet],
		testResults: {
			totalLanes: lanes.length,
			completedLanes,
			failedLanes,
		},
		degradationSummary: {
			totalDegraded: degradedTasks.length,
			resolvedDegraded: degradedTasks.length - pendingDegraded,
			pendingDegraded,
		},
	};

	if (phaseEvidence?.validationArtifacts) {
		pkg.validationArtifacts = phaseEvidence.validationArtifacts;
	}

	return pkg;
}

/**
 * Parses a critic verdict from the agent's text response.
 *
 * Looks for a verdict marker line: `VERDICT: APPROVED`, `VERDICT: NEEDS_REVISION`,
 * `VERDICT: REJECTED`, or `VERDICT: ESCALATE_TO_HUMAN` (case-insensitive).
 * Returns null if no marker is found.
 *
 * The optional reason is extracted from a `REASON:` marker line that follows
 * the verdict marker on a subsequent line.
 */
function parseCriticVerdict(responseText: string): {
	verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | 'ESCALATE_TO_HUMAN';
	reason?: string;
} | null {
	const upperText = responseText.toUpperCase();

	const verdictMatch = upperText.match(
		/VERDICT\s*:\s*(APPROVED|NEEDS_REVISION|REJECTED|ESCALATE_TO_HUMAN)/,
	);
	if (!verdictMatch) {
		return null;
	}

	const verdict = verdictMatch[1] as
		| 'APPROVED'
		| 'NEEDS_REVISION'
		| 'REJECTED'
		| 'ESCALATE_TO_HUMAN';

	// Look for a REASON: line after the verdict
	const lines = responseText.split('\n');
	const verdictIndex = lines.findIndex((l) =>
		l
			.toUpperCase()
			.match(
				/VERDICT\s*:\s*(APPROVED|NEEDS_REVISION|REJECTED|ESCALATE_TO_HUMAN)/i,
			),
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
 * Writes the critic verdict to the evidence file.
 * Uses atomic write (temp file + rename) to prevent partial-file artifacts.
 */
async function writeCriticEvidence(
	directory: string,
	phase: number,
	verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | 'ESCALATE_TO_HUMAN',
	reason?: string,
): Promise<string> {
	const evidenceDir = path.join(directory, '.swarm', 'evidence', String(phase));
	await fs.mkdir(evidenceDir, { recursive: true });

	const evidencePath = path.join(evidenceDir, 'lean-turbo-critic.json');
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
		invalidateCachedArtifact(evidencePath);
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

async function dispatchCriticWithReviewDispatcher(
	dispatcher: ReviewModelDispatcher,
	directory: string,
	criticPackage: CriticPackage,
	agentName: string,
	timeoutMs: number,
	parentSessionId?: string,
	model?: ModelOverride,
): Promise<string> {
	const result = await dispatcher.dispatch({
		directory,
		parentSessionId,
		agentName,
		model,
		system:
			'You are a read-only phase critic for Lean Turbo execution. Evaluate phase-boundary safety, lane integrity, degraded tasks, and the reviewer verdict. Conclude with exactly one verdict marker and a REASON line.',
		prompt: `Review this boundary evidence and conclude with VERDICT: APPROVED, NEEDS_REVISION, REJECTED, or ESCALATE_TO_HUMAN plus a REASON line.\n\n${JSON.stringify(criticPackage, null, 2)}`,
		title: parentSessionId ? 'lean_turbo_critic background' : undefined,
		timeoutMs,
	});
	if (result.status === 'completed') return result.text;
	if (result.status === 'timeout') {
		const timeoutDescription =
			timeoutMs > 0 ? `${timeoutMs}ms` : 'the bounded default';
		throw new Error(`Critic dispatch timed out after ${timeoutDescription}`);
	}
	throw new Error(
		result.error ??
			`Critic dispatch ${result.status === 'cancelled' ? 'cancelled' : 'failed'}`,
	);
}

/**
 * Default implementation uses the injected shared dispatcher for plugin
 * runtime calls. The direct-client branch remains as a compatibility fence for
 * older integrations and direct tests.
 */
async function defaultDispatchCriticAgent(
	directory: string,
	criticPackage: CriticPackage,
	agentName: string,
	timeoutMs: number,
	parentSessionId?: string,
	// #1905: per-call model override on a fallback attempt; omitted (undefined)
	// means the registered critic agent model.
	model?: ModelOverride,
	dispatcher?: ReviewModelDispatcher,
): Promise<string> {
	if (dispatcher) {
		return dispatchCriticWithReviewDispatcher(
			dispatcher,
			directory,
			criticPackage,
			agentName,
			timeoutMs,
			parentSessionId,
			model,
		);
	}
	const client = swarmState.opencodeClient;
	if (!client) {
		throw new Error('OpencodeClient not available');
	}

	// Create an ephemeral session for the critic, scoped to the project directory
	const sessionResult = await client.session.create({
		...(parentSessionId
			? {
					body: {
						parentID: parentSessionId,
						title: 'lean_turbo_critic background',
					},
				}
			: {}),
		query: { directory },
	});

	if (!sessionResult.data?.id) {
		throw new Error('Failed to create critic session');
	}

	const sessionId = sessionResult.data.id;
	const promptController = new AbortController();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	try {
		const promptText = `You are a read-only phase critic performing boundary review for Lean Turbo execution.

## Boundary Review Package

\`\`\`json
${JSON.stringify(criticPackage, null, 2)}
\`\`\`

## Your Task

Review the above phase execution boundary conditions and produce a verdict on whether the phase is safe to advance.

Evaluate:
1. Are all safety concerns resolved or acceptable?
2. Does the boundary between lanes maintain integrity?
3. Are there unresolved degraded tasks that threaten phase boundaries?
4. Does the reviewer verdict (if available) support advancement?

## Output Format

Provide your analysis and conclude with:

VERDICT: APPROVED
REASON: [brief explanation of why the phase boundary is acceptable]

OR

VERDICT: NEEDS_REVISION
REASON: [what must be addressed before the phase can safely advance]

OR

VERDICT: REJECTED
REASON: [critical boundary issues that block phase advancement]

OR

VERDICT: ESCALATE_TO_HUMAN
REASON: [the decision requires human judgment]

Be specific and evidence-based. When safety concerns are present, err on the side of rejection.`;

		// When timeoutMs > 0: race prompt against a rejecting timeout promise
		// When timeoutMs <= 0 or undefined: await prompt directly (no race)
		// #1905: per-call model override on a fallback attempt; omitted
		// (undefined) means the registered critic agent model.
		const response =
			timeoutMs > 0
				? await Promise.race([
						client.session.prompt({
							path: { id: sessionId },
							body: {
								agent: agentName,
								...(model ? { model } : {}),
								tools: { write: false, edit: false, patch: false },
								parts: [{ type: 'text', text: promptText }],
							},
							signal: promptController.signal,
						}),
						new Promise<never>((_, reject) => {
							timeoutHandle = setTimeout(() => {
								promptController.abort();
								reject(
									new Error(`Critic dispatch timed out after ${timeoutMs}ms`),
								);
							}, timeoutMs);
						}),
					])
				: await client.session.prompt({
						path: { id: sessionId },
						body: {
							agent: agentName,
							...(model ? { model } : {}),
							tools: { write: false, edit: false, patch: false },
							parts: [{ type: 'text', text: promptText }],
						},
						signal: promptController.signal,
					});

		if (!response.data) {
			// #1905: preserve the SDK error body so the transient/quota
			// classifier can read the real provider message — without this,
			// envelope-shaped 429/402 errors classify as permanent and the
			// failover never fires.
			throw new Error(
				`Critic session returned no data: ${JSON.stringify(response.error)}`,
			);
		}

		// Extract text from response parts
		const textParts = response.data.parts
			.filter((p) => p.type === 'text')
			.map((p) => p.text ?? '')
			.join('\n');

		return textParts;
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		promptController.abort();
		// #2123: await a graceful abort (flush) before the cascade-delete.
		await teardownEphemeralSession(client.session, sessionId);
	}
}

// ─── _internals Seam ───────────────────────────────────────────────────────────

/**
 * Test-only dependency-injection seam.
 * Allows tests to intercept critic dispatch without mock.module leakage.
 */
export const _internals: {
	compileCriticPackage: typeof compileCriticPackage;
	parseCriticVerdict: typeof parseCriticVerdict;
	writeCriticEvidence: typeof writeCriticEvidence;
	dispatchCriticAgent: (
		directory: string,
		pkg: CriticPackage,
		agentName: string,
		timeoutMs: number,
		parentSessionId?: string,
		model?: ModelOverride,
		dispatcher?: ReviewModelDispatcher,
	) => Promise<string>;
	resolveDefaultCriticAgent: typeof resolveDefaultCriticAgent;
	readReviewerEvidence: typeof readReviewerEvidence;
	listLaneEvidence: typeof listLaneEvidence;
	readPhaseEvidence: typeof readPhaseEvidence;
} = {
	compileCriticPackage,
	parseCriticVerdict,
	writeCriticEvidence,
	dispatchCriticAgent: defaultDispatchCriticAgent,
	resolveDefaultCriticAgent,
	readReviewerEvidence,
	listLaneEvidence,
	readPhaseEvidence,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Dispatch a read-only critic agent to evaluate boundary conditions for a completed Lean Turbo phase.
 *
 * Steps:
 *  1. Read reviewer evidence from `.swarm/evidence/{phase}/lean-turbo-reviewer.json`
 *  2. Read lane and phase evidence from `.swarm/evidence/{phase}/lean-turbo/`
 *  3. Compile a boundary review package with safety concerns noted
 *  4. Dispatch a read-only critic agent (tools: write=false, edit=false, patch=false)
 *  5. Parse the verdict from the agent's response
 *  6. Write the verdict to `.swarm/evidence/{phase}/lean-turbo-critic.json`
 *  7. Return the result
 *
 * @param directory - Project root directory
 * @param phase - Phase number being reviewed
 * @param sessionID - Lean Turbo session ID
 * @param config - Optional configuration overrides
 * @returns PhaseCriticResult with verdict, optional reason, and evidence path
 * @throws Error if dispatch fails or response cannot be parsed (fail-closed)
 */
export async function dispatchPhaseCritic(
	directory: string,
	phase: number,
	sessionID: string,
	config?: LeanTurboPhaseCriticConfig,
): Promise<PhaseCriticResult> {
	const mergedConfig: Required<
		Omit<
			LeanTurboPhaseCriticConfig,
			| 'dispatcher'
			| 'generatedAgentNames'
			| 'activeAgentName'
			| 'agentModelRegistry'
		>
	> = {
		...DEFAULT_CONFIG,
		...config,
	};

	// Resolve critic agent
	const generatedAgentNames =
		config?.generatedAgentNames ?? swarmState.generatedAgentNames;
	const agentName =
		mergedConfig.criticAgent ||
		resolveDefaultCriticAgent(generatedAgentNames, config?.activeAgentName);

	// Compile the boundary review package
	const pkg = await _internals.compileCriticPackage(
		directory,
		phase,
		sessionID,
	);

	// Dispatch the critic agent and await its response.
	// #1896 / #1905: on a transient/quota dispatch error, fail over to a
	// configured critic fallback_model instead of immediately writing a REJECTED
	// verdict (a quota blip previously cascaded into a false phase rejection).
	// Only after the primary + all fallbacks are exhausted does the fail-closed
	// REJECTED path run.
	const fallbackModels = reviewFallbackModelStrings(
		agentName,
		config?.agentModelRegistry,
	);
	const legacyModelConfig = resolveLegacyCriticModelConfig(agentName, config);
	let responseText: string;
	try {
		// Issue #2103 workstream E: role identity for the per-session override store.
		const overrideBaseRole = stripKnownSwarmPrefix(agentName);
		const overrideStoreSwarmId =
			overrideBaseRole !== agentName
				? agentName.slice(0, agentName.length - overrideBaseRole.length - 1)
				: 'default';
		const overrideStoreBaseRole = overrideBaseRole;
		const dispatched = await dispatchWithModelFallback<string>({
			// Issue #2103 workstream E: honor a per-session override recorded by
			// guardrails so it reaches the actual per-call model argument.
			startFallbackIndex: peekModelFallbackIndex(
				sessionID,
				overrideStoreSwarmId,
				overrideStoreBaseRole,
			),
			dispatch: (model) =>
				_internals.dispatchCriticAgent(
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
				// A critic dispatch TIMEOUT is not a provider transient — keep
				// the existing fail-closed-then-REJECTED behavior instead of
				// failing over (a slow call on one model does not predict quota
				// exhaustion on the next). Mirrors the reviewer/runner carve-out.
				if (/Critic dispatch timed out/i.test(msg)) return 'permanent';
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
				// Site 3 (lean-turbo integration) has no injected advisory
				// channel (unlike auto-review.ts), so the advisory lands via the
				// shared session-state path — same as the sibling reviewer.ts.
				const session = getAgentSession(sessionID);
				if (session) {
					pushAdvisory(
						session,
						`MODEL FALLBACK: lean-turbo critic failed over to "${toModel}" (fallback ${fallbackIndex}) after a transient/quota dispatch error.`,
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
		const evidencePath = await _internals.writeCriticEvidence(
			directory,
			phase,
			'REJECTED',
			error instanceof Error ? error.message : String(error),
		);
		return {
			verdict: 'REJECTED',
			reason: `Critic dispatch failed${isQuota ? ' (model quota/usage limit exhausted across all configured fallbacks)' : ''}: ${error instanceof Error ? error.message : String(error)}`,
			evidencePath,
		};
	}

	// Parse the verdict from the response
	const parsed = _internals.parseCriticVerdict(responseText);

	// Fail-closed: unparseable response → REJECTED
	if (!parsed) {
		const evidencePath = await _internals.writeCriticEvidence(
			directory,
			phase,
			'REJECTED',
			'Critic response could not be parsed',
		);
		return {
			verdict: 'REJECTED',
			reason: 'Critic response could not be parsed',
			evidencePath,
		};
	}

	// Write the verdict to the evidence file
	const evidencePath = await _internals.writeCriticEvidence(
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
