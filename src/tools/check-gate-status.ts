/**
 * Check gate status tool - read-only tool for querying task gate status.
 * Reads .swarm/evidence/{taskId}.json and returns structured JSON describing
 * which gates have passed, which are missing, and overall task status.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config/index.js';
import { isSecretscanEvidence, loadEvidence } from '../evidence/manager.js';
import type { TaskEvidence } from '../gate-evidence.js';
import {
	deriveApplicableGateSet,
	externalProofCurrent,
	readCurrentTaskDeclaredFiles,
	resolveCurrentPlanIdentitySync,
	TASK_WORKFLOW_SCHEMA_MARKER,
} from '../gate-evidence.js';
import type { TodoGateConfigBlock } from '../todo/todo-gate.js';
import { evaluateTodoGate } from '../todo/todo-gate.js';
import * as logger from '../utils/logger.js';
import { isStrictTaskId } from '../validation/task-id';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

// ============ Constants ============
const EVIDENCE_DIR = '.swarm/evidence';

// ============ Types ============
interface GateInfo {
	sessionId: string;
	timestamp: string;
	agent: string;
}

interface EvidenceData {
	taskId: string;
	required_gates: string[];
	gates: Record<string, GateInfo>;
	todo_scan?: { priority: string; count: number; details?: string[] };
	workflow?: {
		state?: string;
		generation?: number;
		schema?: string;
	};
}

interface GateStatusResult {
	taskId: string;
	status: 'all_passed' | 'incomplete' | 'no_evidence';
	required_gates: string[];
	passed_gates: string[];
	missing_gates: string[];
	gates: Record<string, GateInfo> | Record<string, never>;
	message: string;
	todo_scan: { priority: string; count: number; details?: string[] } | null;
	secretscan_verdict?: 'pass' | 'fail' | 'not_run';
	/** Durable workflow lifecycle snapshot (gate-evidence exact-task-v1). */
	workflow?: { state: string; generation: number } | null;
	/**
	 * Present only when the durable store looks wedged at coder_delegated with
	 * no pre_check gate — the TASK_WORKFLOW_STAGE_A_REQUIRED signature (e.g.
	 * after /swarm reset-session destroyed the in-memory attribution chain).
	 */
	workflow_attribution_hint?: string;
	prior_campaign_evidence?: string;
}

// Task ID validation delegated to shared module (#452 item 2)
function isValidTaskId(taskId: string): boolean {
	return isStrictTaskId(taskId);
}

// ============ Path Security ============
function isPathWithinSwarm(filePath: string, workspaceRoot: string): boolean {
	// Validate against the actual workspace root, not user-provided working_directory
	// This prevents callers from pointing the tool at arbitrary directories
	const normalizedWorkspace = path.resolve(workspaceRoot);
	const swarmPath = path.join(normalizedWorkspace, '.swarm', 'evidence');
	const normalizedPath = path.resolve(filePath);
	return normalizedPath.startsWith(swarmPath);
}

// ============ Evidence Reading ============
function readEvidenceFile(evidencePath: string): EvidenceData | null {
	// Check if file exists
	if (!fs.existsSync(evidencePath)) {
		return null;
	}

	// Read and parse JSON
	let content: string;
	try {
		content = fs.readFileSync(evidencePath, 'utf-8');
	} catch {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}

	// Validate structure
	if (
		parsed &&
		typeof parsed === 'object' &&
		Array.isArray((parsed as Record<string, unknown>).required_gates) &&
		typeof (parsed as Record<string, unknown>).gates === 'object' &&
		(parsed as Record<string, unknown>).gates !== null
	) {
		return parsed as EvidenceData;
	}

	return null;
}

// ============ Tool Definition ============
export const check_gate_status: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Read-only tool to check the gate status of a specific task. Reads .swarm/evidence/{taskId}.json and returns structured JSON describing required, passed, and missing gates.',
	args: {
		task_id: z
			.string()
			.min(1)
			.regex(
				/^\d+\.\d+(\.\d+)*$/,
				'Task ID must be in N.M or N.M.P format (e.g., "1.1", "1.2.3", "1.2.3.4")',
			)
			.describe('The task ID to check gate status for (e.g., "1.1", "2.3.1")'),
		working_directory: z
			.string()
			.optional()
			.describe(
				'Explicit project root directory. When provided, .swarm/evidence/ is resolved relative to this path instead of the plugin context directory. Use this when CWD differs from the actual project root.',
			),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		// Safe args extraction
		let taskIdInput: string | undefined;
		let workingDirInput: string | undefined;

		try {
			if (args && typeof args === 'object') {
				const obj = args as Record<string, unknown>;
				taskIdInput = typeof obj.task_id === 'string' ? obj.task_id : undefined;
				workingDirInput =
					typeof obj.working_directory === 'string'
						? obj.working_directory
						: undefined;
			}
		} catch {
			// Malicious getter threw
		}

		// Resolve effective directory: explicit working_directory > injected directory
		const dirResult = resolveWorkingDirectory(workingDirInput, directory);
		if (!dirResult.success) {
			const errorResult: GateStatusResult = {
				taskId: taskIdInput ?? '',
				status: 'no_evidence',
				required_gates: [],
				passed_gates: [],
				missing_gates: [],
				gates: {},
				message: dirResult.message,
				todo_scan: null,
			};
			return JSON.stringify(errorResult, null, 2);
		}
		directory = dirResult.directory;

		// TODO-gate config (issue #2581). The config loader recovers a
		// malformed config file to schema defaults, so a broken config
		// evaluates the TODO gate with DEFAULT settings (advisory, max 0)
		// rather than skipping it; only an unexpected loader throw skips
		// evaluation (defensive — debug-logged). This read-only tool must
		// not fabricate verdicts. (phase_complete parses the same config
		// fail-closed — the asymmetry is intentional and documented in
		// docs/configuration.md.)
		let todoGateConfig: TodoGateConfigBlock | undefined;
		try {
			todoGateConfig = loadPluginConfigWithMeta(directory).config.todo_gate;
		} catch (configError) {
			logger.log(
				'check_gate_status: todo_gate config load threw; TODO gate evaluation skipped',
				configError,
			);
		}

		// Validate task_id
		if (!taskIdInput) {
			const errorResult: GateStatusResult = {
				taskId: '',
				status: 'no_evidence',
				required_gates: [],
				passed_gates: [],
				missing_gates: [],
				gates: {},
				message: 'Invalid task_id: task_id is required',
				todo_scan: null,
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Validate task_id format (canonical N.M or N.M.P or N.M.P.Q pattern with security checks)
		if (!isValidTaskId(taskIdInput)) {
			const errorResult: GateStatusResult = {
				taskId: taskIdInput,
				status: 'no_evidence',
				required_gates: [],
				passed_gates: [],
				missing_gates: [],
				gates: {},
				message: `Invalid task_id format: "${taskIdInput}". Must match N.M or N.M.P (e.g. "1.1", "1.2.3", "1.2.3.4")`,
				todo_scan: null,
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Resolve evidence path from effective directory (may be caller-provided via working_directory)
		const evidencePath = path.join(
			directory,
			EVIDENCE_DIR,
			`${taskIdInput}.json`,
		);

		// Validate path is within workspace (defense in depth)
		if (!isPathWithinSwarm(evidencePath, directory)) {
			const errorResult: GateStatusResult = {
				taskId: taskIdInput,
				status: 'no_evidence',
				required_gates: [],
				passed_gates: [],
				missing_gates: [],
				gates: {},
				message: 'Invalid path: evidence path validation failed',
				todo_scan: null,
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Read evidence file
		const evidenceData = readEvidenceFile(evidencePath);

		// Handle missing or invalid evidence
		if (!evidenceData) {
			const errorResult: GateStatusResult = {
				taskId: taskIdInput,
				status: 'no_evidence',
				required_gates: [],
				passed_gates: [],
				missing_gates: [],
				gates: {},
				message: `No evidence file found for task "${taskIdInput}" at ${evidencePath}. Evidence file may be missing or invalid.`,
				todo_scan: null,
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Calculate passed and missing gates from the shared applicability
		// derivation. Legacy records without an authoritative workflow marker
		// still retain the ordinary pre_check obligation; only a trusted
		// generation-zero empty-scope settlement may omit it.
		const gatesMap = evidenceData.gates || {};
		const authoritativeWorkflow =
			evidenceData.workflow?.schema === TASK_WORKFLOW_SCHEMA_MARKER;
		const derivedGates = deriveApplicableGateSet(
			evidenceData as TaskEvidence,
			authoritativeWorkflow
				? {
						currentDeclaredFiles: readCurrentTaskDeclaredFiles(
							directory,
							taskIdInput,
						),
					}
				: undefined,
		);
		const requiredGates = derivedGates.requiredGates;
		const passedGates = derivedGates.satisfiedGates;
		const missingGates = derivedGates.missingGates;
		const readOnlyNoMutation = derivedGates.readOnlyNoMutation;

		// External-evidence declarations (issue #3422): a task that declares
		// external_git reports its attestation state instead of the Stage B
		// derivation above. Undeclared tasks keep that derivation untouched.
		try {
			const externalPlanPath = path.join(directory, '.swarm', 'plan.json');
			const externalPlanRaw = fs.readFileSync(externalPlanPath, 'utf-8');
			const externalPlan = JSON.parse(externalPlanRaw) as {
				title?: unknown;
				swarm?: unknown;
				phases?: Array<{
					tasks?: Array<{
						id: string;
						evidence_class?: string;
						evidence_anchors?: Array<{
							command: string;
							expect?: string;
							expect_prefix?: string;
						}>;
					}>;
				}>;
			};
			const declaredTask = (externalPlan.phases ?? [])
				.flatMap((phase) => phase.tasks ?? [])
				.find((task) => task.id === taskIdInput);
			if (
				declaredTask &&
				declaredTask.evidence_class === 'external_git' &&
				typeof externalPlan.title === 'string' &&
				typeof externalPlan.swarm === 'string'
			) {
				const proofCurrent = externalProofCurrent(
					{ title: externalPlan.title, swarm: externalPlan.swarm },
					declaredTask,
					evidenceData as TaskEvidence,
				);
				const externalWorkflowMeta =
					evidenceData.workflow &&
					typeof evidenceData.workflow === 'object' &&
					typeof evidenceData.workflow.state === 'string'
						? {
								state: evidenceData.workflow.state,
								generation:
									typeof evidenceData.workflow.generation === 'number'
										? evidenceData.workflow.generation
										: 0,
							}
						: null;
				const externalResult: GateStatusResult = proofCurrent
					? {
							taskId: taskIdInput,
							status: 'all_passed',
							required_gates: ['external_attest'],
							passed_gates: ['external_attest'],
							missing_gates: [],
							gates: gatesMap,
							message: `External evidence attested: task "${taskIdInput}" is satisfied by its pinned external_git anchors (issue #3422).`,
							todo_scan:
								(evidenceData.todo_scan as
									| {
											priority: string;
											count: number;
											details?: string[];
									  }
									| undefined) ?? null,
							workflow: externalWorkflowMeta,
						}
					: {
							taskId: taskIdInput,
							status: 'incomplete',
							required_gates: ['external_attest'],
							passed_gates: [],
							missing_gates: ['external_attest'],
							gates: gatesMap,
							message: `Task "${taskIdInput}" declares external_git evidence but no matched attestation exists yet. Run /swarm attest ${taskIdInput} (or re-plan it as a thin coder dispatch).`,
							todo_scan:
								(evidenceData.todo_scan as
									| {
											priority: string;
											count: number;
											details?: string[];
									  }
									| undefined) ?? null,
							workflow: externalWorkflowMeta,
						};
				return JSON.stringify(externalResult, null, 2);
			}
		} catch {
			// plan.json missing or unreadable — keep today's derivation below.
		}

		// Determine overall status
		let status: 'all_passed' | 'incomplete' =
			missingGates.length === 0 &&
			(readOnlyNoMutation ||
				evidenceData.workflow?.state === 'tests_run' ||
				evidenceData.workflow?.state === 'complete')
				? 'all_passed'
				: 'incomplete';

		// Build message
		let message: string;
		if (status === 'all_passed') {
			message = `All required gates have passed for task "${taskIdInput}".`;
		} else if (requiredGates.length === 0) {
			message = `Task "${taskIdInput}" is incomplete. No required gates are configured for this task generation.`;
		} else {
			message = `Task "${taskIdInput}" is incomplete. Missing gates: ${missingGates.join(', ')}.`;
		}

		// Check for secretscan evidence in EvidenceBundle format (supplementary to gate-evidence)
		let secretscanVerdict: 'pass' | 'fail' | 'not_run' = 'not_run';
		try {
			const evidenceResult = await loadEvidence(directory, taskIdInput);
			if (evidenceResult.status === 'found') {
				const secretscanEntries = evidenceResult.bundle.entries.filter(
					(entry) => entry.type === 'secretscan',
				);
				if (secretscanEntries.length > 0) {
					const lastSecretscan =
						secretscanEntries[secretscanEntries.length - 1];
					if (isSecretscanEvidence(lastSecretscan)) {
						const incompleteFiles = lastSecretscan.incomplete_files;
						const incompletePaths = lastSecretscan.incomplete_paths;
						const findingsCount = lastSecretscan.findings_count ?? 0;
						const hasIncompleteCoverage =
							incompleteFiles > 0 || incompletePaths.length > 0;
						// #3092 diff-scope parity: gate on NEW findings when the
						// evidence carries the counter; legacy evidence without
						// it falls back to the TOTAL (previous behavior). The
						// predicate must preserve 0 — a truthiness fallback
						// would re-wedge the exact zero-new pass this exists
						// to unblock.
						const newFindingsRaw: unknown = lastSecretscan.new_findings_count;
						const preexistingRaw: unknown =
							lastSecretscan.preexisting_findings_count;
						const newFindingsValid =
							typeof newFindingsRaw === 'number' &&
							Number.isSafeInteger(newFindingsRaw) &&
							newFindingsRaw >= 0;
						const preexistingValid =
							typeof preexistingRaw === 'number' &&
							Number.isSafeInteger(preexistingRaw) &&
							preexistingRaw >= 0;
						let newFindingsBasis = newFindingsValid
							? newFindingsRaw
							: findingsCount;
						// #3128 review PRR-010: internally inconsistent counters
						// (new + preexisting ≠ total) cannot prove the zero-new
						// claim — fall back to the TOTAL, fail-closed.
						if (
							newFindingsValid &&
							preexistingValid &&
							newFindingsRaw + preexistingRaw !== findingsCount
						) {
							newFindingsBasis = findingsCount;
						}
						const hasNewFindings = newFindingsBasis > 0;
						// #2918 vacuous coverage — same normative predicate as the
						// pre_check gate and the decoder, evaluated over the persisted
						// evidence fields (optional; missing ⇒ non-vacuous ⇒ strict).
						// Deliberately keyed on the TOTAL findings_count, NOT the
						// new-findings basis: a pre-existing-only pass scanned files.
						const policySkipped: unknown = lastSecretscan.policy_skipped_files;
						const requestedFilesCount: unknown = lastSecretscan.requested_files;
						const vacuousCoverage =
							lastSecretscan.files_scanned === 0 &&
							typeof policySkipped === 'number' &&
							Number.isSafeInteger(policySkipped) &&
							policySkipped >= 0 &&
							typeof requestedFilesCount === 'number' &&
							Number.isSafeInteger(requestedFilesCount) &&
							requestedFilesCount > 0 &&
							policySkipped >= requestedFilesCount &&
							findingsCount === 0 &&
							incompleteFiles === 0 &&
							incompletePaths.length === 0;
						const hasZeroCoverage =
							lastSecretscan.files_scanned === 0 && !vacuousCoverage;
						if (
							hasIncompleteCoverage ||
							hasNewFindings ||
							hasZeroCoverage ||
							lastSecretscan.verdict === 'fail' ||
							lastSecretscan.verdict === 'rejected'
						) {
							secretscanVerdict = 'fail';
							if (hasIncompleteCoverage && !hasNewFindings) {
								missingGates.push('secretscan (BLOCKED — incomplete coverage)');
								if (status === 'all_passed') {
									status = 'incomplete';
								}
								message = `BLOCKED: Secretscan incomplete coverage in prior scan. ${message}`;
							} else if (hasNewFindings && hasIncompleteCoverage) {
								missingGates.push(
									'secretscan (BLOCKED — secrets detected; incomplete coverage)',
								);
								if (status === 'all_passed') {
									status = 'incomplete';
								}
								message = `BLOCKED: Secretscan found secrets and incomplete coverage in prior scan (${newFindingsBasis} new on changed lines). ${message}`;
							} else if (hasNewFindings) {
								missingGates.push('secretscan (BLOCKED — secrets detected)');
								if (status === 'all_passed') {
									status = 'incomplete';
								}
								message = `BLOCKED: Secretscan found secrets in prior scan (${newFindingsBasis} new on changed lines${findingsCount > newFindingsBasis ? `, ${findingsCount} total` : ''}). ${message}`;
							} else if (hasZeroCoverage) {
								missingGates.push('secretscan (BLOCKED — zero coverage)');
								if (status === 'all_passed') {
									status = 'incomplete';
								}
								message = `BLOCKED: Secretscan scanned zero files in prior scan. ${message}`;
							} else {
								// Failed/rejected verdict with complete coverage and
								// no new findings — a producer contradiction (e.g.
								// truncation or tampering), not a zero-coverage scan.
								missingGates.push('secretscan (BLOCKED — zero coverage)');
								if (status === 'all_passed') {
									status = 'incomplete';
								}
								message = `BLOCKED: Secretscan verdict failed without new findings or coverage gaps (possible truncation or tampering). ${message}`;
							}
						} else if (
							lastSecretscan.verdict === 'pass' ||
							lastSecretscan.verdict === 'approved' ||
							lastSecretscan.verdict === 'info'
						) {
							secretscanVerdict = 'pass';
							if (vacuousCoverage) {
								// Satisfied, with a note: the pass rests on provable
								// extension-policy exclusion, not on scanned files.
								message += ` Advisory: Secretscan coverage was vacuous (${lastSecretscan.policy_skipped_files} of ${lastSecretscan.requested_files} requested file(s) skipped by scan policy).`;
							} else if (findingsCount > 0) {
								// #3092: green with visible pre-existing debt —
								// secretscan green means zero NEW secrets on changed
								// lines; pre-existing findings stay reported.
								message += ` Advisory: ${findingsCount} pre-existing secret finding(s) remain visible (non-gating; secretscan green = zero new secrets on changed lines).`;
							}
						}
					}
				} else {
					message +=
						' Advisory: No secretscan evidence found for this task. Consider running secretscan.';
				}
			} else if (evidenceResult.status === 'invalid_schema') {
				secretscanVerdict = 'fail';
				missingGates.push('secretscan (BLOCKED — invalid evidence)');
				status = 'incomplete';
				message = `BLOCKED: Secretscan evidence is invalid and cannot prove complete coverage. ${message}`;
			}
		} catch {
			// Evidence loading failures should not break the tool
		}

		// Apply the configured TODO gate to the recorded todo_scan evidence
		// (issue #2581). Advisory when block_on_threshold is false; a
		// todo_gate (BLOCKED — ...) missing-gate entry + incomplete status
		// when true — the same shape the secretscan path above uses.
		const todoScan = evidenceData.todo_scan as
			| { priority: string; count: number; details?: string[] }
			| undefined;
		const todoVerdict = evaluateTodoGate(todoScan, todoGateConfig);
		if (todoVerdict.status === 'exceeded') {
			if (todoVerdict.blocked) {
				missingGates.push(
					`todo_gate (BLOCKED — ${todoVerdict.count} high-priority TODOs exceed max ${todoVerdict.max})`,
				);
				if (status === 'all_passed') {
					status = 'incomplete';
				}
				message = `BLOCKED: TODO gate threshold exceeded. ${todoVerdict.message} ${message}`;
			} else {
				message += ` Advisory: todo_gate threshold exceeded — ${todoVerdict.count} high-priority TODOs (FIXME/HACK/XXX) exceed max_high_priority=${todoVerdict.max}.`;
			}
		}

		// Durable workflow lifecycle diagnostics. A task whose workflow store
		// sits at coder_delegated with no pre_check gate proof is wedged: every
		// Stage B dispatch will be denied with TASK_WORKFLOW_STAGE_A_REQUIRED.
		// Surfacing it here makes the wedge visible from the read-only tool
		// instead of only via the (previously swallowed) write-path error.
		const workflowMeta =
			evidenceData.workflow &&
			typeof evidenceData.workflow === 'object' &&
			typeof evidenceData.workflow.state === 'string'
				? {
						state: evidenceData.workflow.state,
						generation:
							typeof evidenceData.workflow.generation === 'number'
								? evidenceData.workflow.generation
								: 0,
					}
				: null;
		// Stage B wedge fix (Class E): flag evidence that predates the current
	// plan campaign (no plan-identity stamp, or a stamp for a different plan).
	const currentPlanIdentity = resolveCurrentPlanIdentitySync(dirResult);
	const evidencePlanIdentityHash = (evidenceData as { planIdentityHash?: string } | null)?.planIdentityHash;
	let priorCampaignEvidence: string | undefined;
	if (
		currentPlanIdentity != null &&
		evidenceData != null &&
		(evidencePlanIdentityHash === undefined ||
			evidencePlanIdentityHash !== currentPlanIdentity.planIdentityHash)
	) {
		priorCampaignEvidence = 'Evidence for this task predates the current plan campaign (plan-identity stamp absent or mismatched). Its gates do not satisfy the current campaign receipts; run repair_gate_evidence for this task to rebuild current-campaign evidence.';
		message += ` ${priorCampaignEvidence}`;
	}
	let workflowAttributionHint: string | undefined;
		if (
			status === 'incomplete' &&
			workflowMeta?.state === 'coder_delegated' &&
			!gatesMap.pre_check
		) {
			workflowAttributionHint =
				`Task is settled at coder_delegated but Stage A (pre_check_batch) was never attributed — ` +
				`reviewer/test_engineer dispatches will be denied with TASK_WORKFLOW_STAGE_A_REQUIRED. ` +
				`Run pre_check_batch on the task's changed files; if it passes without advancing this task, run /swarm recover ${taskIdInput}.`;
			message += ` ${workflowAttributionHint}`;
		}

		const result: GateStatusResult = {
			taskId: taskIdInput,
			status,
			required_gates: requiredGates,
			passed_gates: passedGates,
			missing_gates: missingGates,
			gates: gatesMap,
			message,
			todo_scan: todoScan ?? null,
			secretscan_verdict: secretscanVerdict,
			workflow: workflowMeta,
			...(workflowAttributionHint
				? { workflow_attribution_hint: workflowAttributionHint }
				: {}),
			...(priorCampaignEvidence ? { prior_campaign_evidence: priorCampaignEvidence } : {}),
		};

		return JSON.stringify(result, null, 2);
	},
});
