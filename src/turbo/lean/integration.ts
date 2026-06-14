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
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { swarmState } from '../../state';
import {
	type LaneEvidence,
	listLaneEvidence,
	readPhaseEvidence,
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
}

const DEFAULT_CONFIG: Required<LeanTurboPhaseCriticConfig> = {
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
function resolveDefaultCriticAgent(generatedAgentNames: string[]): string {
	if (generatedAgentNames.length === 0) {
		return 'critic';
	}

	// Find the longest agent name that ends with "_critic" or "-critic"
	let best: string | null = null;
	for (const name of generatedAgentNames) {
		const lower = name.toLowerCase();
		if (
			(lower.endsWith('_critic') || lower.endsWith('-critic')) &&
			(!best || name.length > best.length)
		) {
			best = name;
		}
	}

	return (
		best ??
		(generatedAgentNames.includes('critic') ? 'critic' : generatedAgentNames[0])
	);
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
 * read-only critic agent and await its response.
 *
 * Returns the raw response text from the agent.
 * Throws if the dispatch fails or times out.
 *
 * @param directory - Project root directory for the critic session
 * @param criticPackage - Compiled boundary review package
 * @param agentName - Name of the critic agent to dispatch
 * @param timeoutMs - Timeout in milliseconds (0 for no timeout)
 * @param parentSessionId - Parent session ID to attach as child session
 */
async function defaultDispatchCriticAgent(
	directory: string,
	criticPackage: CriticPackage,
	agentName: string,
	timeoutMs: number,
	parentSessionId?: string,
): Promise<string> {
	const client = swarmState.opencodeClient;
	if (!client) {
		throw new Error('OpencodeClient not available');
	}

	// Create an ephemeral session for the critic, scoped to the project directory
	const sessionResult = await client.session.create({
		...(parentSessionId
			? { body: { parentID: parentSessionId, title: 'lean_turbo_critic background' } }
			: {}),
		query: { directory },
	});

	if (!sessionResult.data?.id) {
		throw new Error('Failed to create critic session');
	}

	const sessionId = sessionResult.data.id;

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
										new Error(`Critic dispatch timed out after ${timeoutMs}ms`),
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
			throw new Error('Critic session returned no data');
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
	const mergedConfig: Required<LeanTurboPhaseCriticConfig> = {
		...DEFAULT_CONFIG,
		...config,
	};

	// Resolve critic agent
	const generatedAgentNames = swarmState.generatedAgentNames;
	const agentName =
		mergedConfig.criticAgent || resolveDefaultCriticAgent(generatedAgentNames);

	// Compile the boundary review package
	const pkg = await _internals.compileCriticPackage(
		directory,
		phase,
		sessionID,
	);

	// Dispatch the critic agent and await its response
	let responseText: string;
	try {
		responseText = await _internals.dispatchCriticAgent(
			directory,
			pkg,
			agentName,
			mergedConfig.timeoutMs,
			sessionID,
		);
	} catch (error) {
		// Fail-closed: dispatch failure → write REJECTED verdict
		const evidencePath = await _internals.writeCriticEvidence(
			directory,
			phase,
			'REJECTED',
			error instanceof Error ? error.message : String(error),
		);
		return {
			verdict: 'REJECTED',
			reason: `Critic dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
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
