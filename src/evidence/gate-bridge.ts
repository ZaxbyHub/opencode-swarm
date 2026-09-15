import type { Evidence } from '../config/evidence-schema';
import {
	deriveApplicableGateSet,
	isValidTaskId,
	readCurrentTaskDeclaredFiles,
	readTaskEvidence,
	readTaskEvidenceRaw,
	TASK_WORKFLOW_SCHEMA_MARKER,
	type TaskEvidence,
} from '../gate-evidence.js';

type SyntheticGateEvidenceType = 'review' | 'test' | 'approval';

const GATE_EVIDENCE_TYPE_BY_GATE: Record<string, SyntheticGateEvidenceType> = {
	reviewer: 'review',
	test_engineer: 'test',
};

export interface DurableGateEvidenceStatus {
	isComplete: boolean;
	missingGates: string[];
	evidenceExists: boolean;
	invalid: boolean;
}

export async function readDurableGateEvidence(
	directory: string,
	taskId: string,
): Promise<TaskEvidence | null> {
	try {
		return await readTaskEvidence(directory, taskId);
	} catch {
		return null;
	}
}

export function hasCompleteDurableGateEvidence(
	evidence: TaskEvidence | null | undefined,
): boolean {
	return getDurableGateEvidenceStatus(evidence).isComplete;
}

export function getDurableGateEvidenceStatus(
	evidence: TaskEvidence | null | undefined,
): DurableGateEvidenceStatus {
	if (!evidence?.gates || typeof evidence.gates !== 'object') {
		return {
			isComplete: false,
			missingGates: [],
			evidenceExists: evidence != null,
			invalid: false,
		};
	}

	if (!Array.isArray(evidence.required_gates)) {
		return {
			isComplete: false,
			missingGates: ['required_gates'],
			evidenceExists: true,
			invalid: false,
		};
	}

	const derivedGates = deriveApplicableGateSet(evidence);
	return {
		isComplete: derivedGates.missingGates.length === 0,
		missingGates: derivedGates.missingGates,
		evidenceExists: true,
		invalid: false,
	};
}

export async function getDurableGateEvidenceStatusForTask(
	directory: string,
	taskId: string,
): Promise<DurableGateEvidenceStatus> {
	if (!isValidTaskId(taskId)) {
		return {
			isComplete: false,
			missingGates: [],
			evidenceExists: false,
			invalid: false,
		};
	}

	try {
		return getDurableGateEvidenceStatusWithCurrentScope(
			readTaskEvidenceRaw(directory, taskId),
			directory,
			taskId,
		);
	} catch {
		return {
			isComplete: false,
			missingGates: ['invalid_gate_evidence'],
			evidenceExists: true,
			invalid: true,
		};
	}
}

function getDurableGateEvidenceStatusWithCurrentScope(
	evidence: TaskEvidence | null,
	directory: string,
	taskId: string,
): DurableGateEvidenceStatus {
	if (!evidence?.gates || typeof evidence.gates !== 'object') {
		return getDurableGateEvidenceStatus(evidence);
	}
	if (!Array.isArray(evidence.required_gates)) {
		return getDurableGateEvidenceStatus(evidence);
	}
	if (
		!evidence.workflow ||
		evidence.workflow.schema !== TASK_WORKFLOW_SCHEMA_MARKER
	) {
		// Task-specific legacy callers historically evaluated the persisted list
		// directly. Keep that behavior separate from the public pure helper above,
		// whose derived set intentionally reports the modern pre_check obligation.
		if (evidence.required_gates.length === 0) {
			return {
				isComplete: false,
				missingGates: ['required_gates'],
				evidenceExists: true,
				invalid: false,
			};
		}
		const missingGates = evidence.required_gates.filter(
			(gate) => evidence.gates[gate] == null,
		);
		return {
			isComplete: missingGates.length === 0,
			missingGates,
			evidenceExists: true,
			invalid: false,
		};
	}
	const derivedGates = deriveApplicableGateSet(evidence, {
		currentDeclaredFiles: readCurrentTaskDeclaredFiles(directory, taskId),
	});
	return {
		isComplete: derivedGates.missingGates.length === 0,
		missingGates: derivedGates.missingGates,
		evidenceExists: true,
		invalid: false,
	};
}

export async function hasCompleteDurableGateEvidenceForTask(
	directory: string,
	taskId: string,
): Promise<boolean> {
	return (await getDurableGateEvidenceStatusForTask(directory, taskId))
		.isComplete;
}

function gateEvidenceToEntry(
	taskId: string,
	gate: string,
	type: SyntheticGateEvidenceType,
	evidence: TaskEvidence,
): Evidence | null {
	const gateRecord = evidence.gates[gate];
	if (!gateRecord) {
		return null;
	}

	const base = {
		task_id: taskId,
		timestamp: gateRecord.timestamp,
		agent: gateRecord.agent || gate,
		verdict: 'pass' as const,
		summary: `Gate evidence recorded by ${gate}`,
		metadata: { source: 'durable_gate_evidence', gate },
	};

	if (type === 'review') {
		return {
			...base,
			type,
			risk: 'low',
			issues: [],
		};
	}

	if (type === 'approval') {
		return {
			...base,
			type,
		};
	}

	return {
		...base,
		type,
		tests_passed: 0,
		tests_failed: 0,
		failures: [],
	};
}

export function mergeDurableGateEntriesFromEvidence(
	taskId: string,
	entries: Evidence[],
	evidence: TaskEvidence | null | undefined,
): Evidence[] {
	if (!evidence?.gates) {
		return entries;
	}

	const merged = [...entries];
	for (const gate of Object.keys(evidence.gates).sort()) {
		const type = GATE_EVIDENCE_TYPE_BY_GATE[gate] ?? 'approval';
		if (
			(type === 'review' || type === 'test') &&
			merged.some((entry) => entry.type === type)
		) {
			continue;
		}

		const entry = gateEvidenceToEntry(taskId, gate, type, evidence);
		if (entry) {
			merged.push(entry);
		}
	}

	return merged;
}

export async function mergeDurableGateEntries(
	directory: string,
	taskId: string,
	entries: Evidence[],
): Promise<Evidence[]> {
	return mergeDurableGateEntriesFromEvidence(
		taskId,
		entries,
		await readDurableGateEvidence(directory, taskId),
	);
}
