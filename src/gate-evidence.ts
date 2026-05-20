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
import { z } from 'zod';
import { withEvidenceLock } from './evidence/lock.js';
import { telemetry } from './telemetry.js';
import { bunWrite } from './utils/bun-compat';
import { assertStrictTaskId, isStrictTaskId } from './validation/task-id';

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

const GateEvidenceSchema = z
	.object({
		sessionId: z.string(),
		timestamp: z.string(),
		agent: z.string(),
	})
	.passthrough(); // preserve council-specific extras (verdict, vetoedBy, etc.)

const TaskEvidenceSchema = z.object({
	taskId: z.string(),
	required_gates: z.array(z.string()).default([]),
	gates: z.record(z.string(), GateEvidenceSchema),
	turbo: z.boolean().optional(),
});

export const DEFAULT_REQUIRED_GATES = ['reviewer', 'test_engineer'];

/**
 * Canonical task-id validation helper.
 * Delegates to the shared strict validator (#452 item 2).
 * Re-exported for backward compatibility with existing callers.
 */
export function isValidTaskId(taskId: string): boolean {
	return isStrictTaskId(taskId);
}

function assertValidTaskId(taskId: string): void {
	assertStrictTaskId(taskId);
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
	const combined = [...new Set([...(existingGates ?? []), ...newGates])];
	return combined.sort();
}

function getEvidenceDir(directory: string): string {
	return path.join(directory, '.swarm', 'evidence');
}

function getEvidencePath(directory: string, taskId: string): string {
	assertValidTaskId(taskId);
	return path.join(getEvidenceDir(directory), `${taskId}.json`);
}

function readExisting(evidencePath: string): TaskEvidence | null {
	try {
		const raw = readFileSync(evidencePath, 'utf-8');
		return TaskEvidenceSchema.parse(JSON.parse(raw));
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
	mkdirSync(evidenceDir, { recursive: true });

	const lockRelPath = path.join('evidence', `${taskId}.json`);
	await withEvidenceLock(directory, lockRelPath, gate, taskId, async () => {
		const evidencePath = getEvidencePath(directory, taskId);
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
	});
	telemetry.gatePassed(sessionId, gate, taskId);
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
	mkdirSync(evidenceDir, { recursive: true });

	const lockRelPath = path.join('evidence', `${taskId}.json`);
	await withEvidenceLock(
		directory,
		lockRelPath,
		agentType,
		taskId,
		async () => {
			const evidencePath = getEvidencePath(directory, taskId);
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
		},
	);
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
 * Returns the TaskEvidence for a task, or null if the file does not exist (ENOENT).
 * Throws on malformed JSON, permission errors, or other non-ENOENT issues.
 * Used by checkReviewerGate for evidence-first gate checking with proper error handling.
 */
export function readTaskEvidenceRaw(
	directory: string,
	taskId: string,
): TaskEvidence | null {
	assertValidTaskId(taskId);
	const evidencePath = getEvidencePath(directory, taskId);
	try {
		const raw = readFileSync(evidencePath, 'utf-8');
		return TaskEvidenceSchema.parse(JSON.parse(raw));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
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
