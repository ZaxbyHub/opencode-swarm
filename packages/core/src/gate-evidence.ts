/**
 * Gate Evidence Store
 *
 * Durable, task-scoped evidence for QA gate completion.
 * Evidence is recorded on disk (.swarm/evidence/{taskId}.json) by the
 * delegation-gate toolAfter hook and read by checkReviewerGate at
 * update_task_status(completed) time.
 *
 * Evidence files survive session restarts (unlike in-memory state).
 * Agents never write these files directly — only the hook does.
 * Gates are append-only: required_gates can only grow, never shrink.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { bunWrite } from './utils/bun-compat';

export interface GateEvidence {
	sessionId: string;
	timestamp: string;
	agent: string;
}

export interface TaskEvidence {
	taskId: string;
	required_gates: string[];
	gates: Record<string, GateEvidence>;
	turbo?: boolean;
}

export const DEFAULT_REQUIRED_GATES = ['reviewer', 'test_engineer'];

/** Strict N.M or N.M.P pattern — same as validateTaskId in update-task-status.ts */
const TASK_ID_PATTERN = /^\d+\.\d+(\.\d+)*$/;

/**
 * Canonical task-id validation helper.
 * Returns true if the taskId is a valid numeric format (N.M or N.M.P),
 * false otherwise.
 *
 * Validates:
 * - Non-empty string
 * - Matches N.M or N.M.P numeric pattern (e.g., "1.1", "1.2.3")
 * - No path traversal (..)
 * - No path separators (/, \)
 * - No null bytes
 */
export function isValidTaskId(taskId: string): boolean {
	if (!taskId) return false;
	if (taskId.includes('..')) return false;
	if (taskId.includes('/')) return false;
	if (taskId.includes('\\')) return false;
	if (taskId.includes('\0')) return false;
	return TASK_ID_PATTERN.test(taskId);
}

function assertValidTaskId(taskId: string): void {
	if (!isValidTaskId(taskId)) {
		throw new Error(
			`Invalid taskId: "${taskId}". Must match N.M or N.M.P (e.g. "1.1", "1.2.3").`,
		);
	}
}

/**
 * Maps the first-dispatched agent type to the initial required_gates array.
 * Unknown agent types fall back to the safe default ["reviewer", "test_engineer"].
 */
export function deriveRequiredGates(agentType: string): string[] {
	switch (agentType) {
		case 'coder':
			return ['reviewer', 'test_engineer'];
		case 'docs':
			return ['docs'];
		case 'designer':
			return ['designer', 'reviewer', 'test_engineer'];
		case 'explorer':
			return ['explorer'];
		case 'sme':
			return ['sme'];
		case 'reviewer':
			return ['reviewer'];
		case 'test_engineer':
			return ['test_engineer'];
		case 'critic':
			return ['critic'];
		default:
			return ['reviewer', 'test_engineer'];
	}
}

/**
 * Returns the union of existingGates and deriveRequiredGates(newAgentType).
 * Sorted, deduplicated. Gates can only grow, never shrink.
 */
export function expandRequiredGates(
	existingGates: string[],
	newAgentType: string,
): string[] {
	const newGates = deriveRequiredGates(newAgentType);
	const combined = [...new Set([...existingGates, ...newGates])];
	return combined.sort();
}

function getEvidenceDir(directory: string): string {
	return path.join(directory, '.swarm', 'evidence');
}

function getEvidencePath(directory: string, taskId: string): string {
	return path.join(getEvidenceDir(directory), `${taskId}.json`);
}

function readExisting(evidencePath: string): TaskEvidence | null {
	try {
		const raw = readFileSync(evidencePath, 'utf-8');
		return JSON.parse(raw) as TaskEvidence;
	} catch {
		return null;
	}
}

async function atomicWrite(targetPath: string, content: string): Promise<void> {
	const tempPath = `${targetPath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
	try {
		await bunWrite(tempPath, content);
		renameSync(tempPath, targetPath);
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			/* already renamed or never created */
		}
	}
}

/**
 * Creates or updates .swarm/evidence/{taskId}.json with a gate pass entry.
 * If file doesn't exist: creates with required_gates from deriveRequiredGates(gate).
 * If file exists: merges gate entry, expands required_gates via expandRequiredGates.
 * Atomic write: temp file + rename.
 */
export async function recordGateEvidence(
	directory: string,
	taskId: string,
	gate: string,
	sessionId: string,
	turbo?: boolean,
): Promise<void> {
	assertValidTaskId(taskId);
	const evidenceDir = getEvidenceDir(directory);
	const evidencePath = getEvidencePath(directory, taskId);

	mkdirSync(evidenceDir, { recursive: true });

	const existing = readExisting(evidencePath);
	const requiredGates = existing
		? expandRequiredGates(existing.required_gates, gate)
		: deriveRequiredGates(gate);

	const updated: TaskEvidence = {
		taskId,
		required_gates: requiredGates,
		turbo: turbo === true ? true : existing?.turbo,
		gates: {
			...(existing?.gates ?? {}),
			[gate]: {
				sessionId,
				timestamp: new Date().toISOString(),
				agent: gate,
			},
		},
	};

	await atomicWrite(evidencePath, JSON.stringify(updated, null, 2));
}

/**
 * Sets or expands required_gates WITHOUT recording a gate pass.
 * Used when non-gate agents are dispatched (coder, explorer, sme, etc.).
 * Creates evidence file if it doesn't exist yet.
 */
export async function recordAgentDispatch(
	directory: string,
	taskId: string,
	agentType: string,
	turbo?: boolean,
): Promise<void> {
	assertValidTaskId(taskId);
	const evidenceDir = getEvidenceDir(directory);
	const evidencePath = getEvidencePath(directory, taskId);

	mkdirSync(evidenceDir, { recursive: true });

	const existing = readExisting(evidencePath);
	const requiredGates = existing
		? expandRequiredGates(existing.required_gates, agentType)
		: deriveRequiredGates(agentType);

	const updated: TaskEvidence = {
		taskId,
		required_gates: requiredGates,
		turbo: turbo === true ? true : existing?.turbo,
		gates: existing?.gates ?? {},
	};

	await atomicWrite(evidencePath, JSON.stringify(updated, null, 2));
}

/**
 * Returns the TaskEvidence for a task, or null if file missing or parse error.
 * Never throws.
 */
export async function readTaskEvidence(
	directory: string,
	taskId: string,
): Promise<TaskEvidence | null> {
	try {
		assertValidTaskId(taskId);
		return readExisting(getEvidencePath(directory, taskId));
	} catch {
		return null;
	}
}

/**
 * Returns true only when every required_gate has a matching gates entry.
 * Returns false if no evidence file exists.
 */
export async function hasPassedAllGates(
	directory: string,
	taskId: string,
): Promise<boolean> {
	const evidence = await readTaskEvidence(directory, taskId);
	if (!evidence) return false;
	if (
		!Array.isArray(evidence.required_gates) ||
		evidence.required_gates.length === 0
	)
		return false;
	return evidence.required_gates.every((gate) => evidence.gates[gate] != null);
}
