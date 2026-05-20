/**
 * Check gate status tool - read-only tool for querying task gate status.
 * Reads .swarm/evidence/{taskId}.json and returns structured JSON describing
 * which gates have passed, which are missing, and overall task status.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { isSecretscanEvidence, loadEvidence } from '../evidence/manager.js';
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

		// Calculate passed and missing gates
		const requiredGates = evidenceData.required_gates || [];
		const gatesMap = evidenceData.gates || {};
		const passedGates: string[] = [];
		const missingGates: string[] = [];

		for (const requiredGate of requiredGates) {
			if (gatesMap[requiredGate]) {
				passedGates.push(requiredGate);
			} else {
				missingGates.push(requiredGate);
			}
		}

		// Determine overall status
		let status: 'all_passed' | 'incomplete' =
			missingGates.length === 0 ? 'all_passed' : 'incomplete';

		// Build message
		let message: string;
		if (status === 'all_passed') {
			message = `All required gates have passed for task "${taskIdInput}".`;
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
						if (
							lastSecretscan.verdict === 'fail' ||
							lastSecretscan.verdict === 'rejected'
						) {
							secretscanVerdict = 'fail';
							missingGates.push('secretscan (BLOCKED — secrets detected)');
							if (status === 'all_passed') {
								status = 'incomplete';
							}
							message = `BLOCKED: Secretscan found secrets in prior scan. ${message}`;
						} else if (
							lastSecretscan.verdict === 'pass' ||
							lastSecretscan.verdict === 'approved' ||
							lastSecretscan.verdict === 'info'
						) {
							secretscanVerdict = 'pass';
						}
					}
				} else {
					message +=
						' Advisory: No secretscan evidence found for this task. Consider running secretscan.';
				}
			}
		} catch {
			// Evidence loading failures should not break the tool
		}

		// Check for todo_scan field in evidence (advisory only)
		const todoScan = evidenceData.todo_scan as
			| { priority: string; count: number; details?: string[] }
			| undefined;

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
		};

		return JSON.stringify(result, null, 2);
	},
});
