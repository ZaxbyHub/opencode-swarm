/**
 * Work Complete Council — evidence writer.
 *
 * Stamps the council synthesis result into `.swarm/evidence/{taskId}.json`
 * under `gates.council`, matching the shape other gate writers use and the
 * shape that `check_gate_status` and `update_task_status` consume (they read
 * `evidence.gates[gateName]`). Council-specific fields (verdict, vetoedBy,
 * roundNumber, allCriteriaMet) are stored alongside the standard GateInfo
 * fields (sessionId, timestamp, agent); existing consumers only check
 * `gates.council != null`, so the extras are compatible.
 *
 * Existing fields in the evidence file — top-level keys AND other `gates[*]`
 * entries — are preserved across the write. The raw taskId is used as the
 * filename; defense-in-depth regex validation rejects malformed IDs before
 * any filesystem op.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CouncilSynthesis } from './types';

const EVIDENCE_DIR = '.swarm/evidence';
// Validates raw taskId for evidence file paths — must match check_gate_status and gate-evidence
// which both use `${taskId}.json` (no sanitization). This differs intentionally from
// criteria-store.ts which uses safeId() for .swarm/council/ filenames (dots → underscores).
// Leading zeros (e.g., "01.1") are accepted — matches the canonical STRICT_TASK_ID_PATTERN in src/validation/task-id.ts.
const VALID_TASK_ID = /^\d+\.\d+(\.\d+)*$/;
const COUNCIL_GATE_NAME = 'council';
const COUNCIL_AGENT_ID = 'architect';

/**
 * Merge existing own properties into the target, skipping keys that would
 * pollute the prototype chain even though object spread does not linkify them.
 * We still filter these defensively so malicious evidence files cannot add
 * enumerable own-properties named `__proto__` / `constructor` / `prototype`
 * to the resulting JSON.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeAssignOwnProps(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	for (const key of Object.keys(source)) {
		if (FORBIDDEN_KEYS.has(key)) continue;
		const value = source[key];
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
			const nested = Object.create(null);
			safeAssignOwnProps(nested, value as Record<string, unknown>);
			target[key] = nested;
		} else if (Array.isArray(value)) {
			target[key] = value.map((item) => {
				if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
					const nested = Object.create(null);
					safeAssignOwnProps(nested, item as Record<string, unknown>);
					return nested;
				}
				return item;
			});
		} else {
			target[key] = value;
		}
	}
	return target;
}

export function writeCouncilEvidence(
	workingDir: string,
	synthesis: CouncilSynthesis,
): void {
	// Defense in depth — library-level writer should not trust upstream validation.
	if (!VALID_TASK_ID.test(synthesis.taskId)) {
		throw new Error(
			`writeCouncilEvidence: invalid taskId "${synthesis.taskId}" — must match N.M or N.M.P format`,
		);
	}

	const dir = join(workingDir, EVIDENCE_DIR);
	mkdirSync(dir, { recursive: true });

	const filePath = join(dir, `${synthesis.taskId}.json`);

	// Read existing evidence (if any) and start from a clean prototype-free object.
	const existingRoot: Record<string, unknown> = Object.create(null);
	if (existsSync(filePath)) {
		try {
			const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				safeAssignOwnProps(existingRoot, parsed as Record<string, unknown>);
			}
			// Arrays, nulls, or corrupt JSON all fall through to a fresh start.
		} catch {
			// Corrupted evidence file — start fresh rather than crashing.
		}
	}

	// Preserve any prior gates entries alongside the council entry.
	const existingGatesRaw = existingRoot.gates;
	const mergedGates: Record<string, unknown> = Object.create(null);
	if (
		existingGatesRaw &&
		typeof existingGatesRaw === 'object' &&
		!Array.isArray(existingGatesRaw)
	) {
		safeAssignOwnProps(
			mergedGates,
			existingGatesRaw as Record<string, unknown>,
		);
	}

	mergedGates[COUNCIL_GATE_NAME] = {
		// Standard GateInfo fields so check_gate_status / update_task_status see it.
		sessionId: synthesis.swarmId,
		timestamp: synthesis.timestamp,
		agent: COUNCIL_AGENT_ID,
		// Council-specific extras — safe to carry; existing readers only check presence.
		verdict: synthesis.overallVerdict,
		vetoedBy: synthesis.vetoedBy,
		roundNumber: synthesis.roundNumber,
		allCriteriaMet: synthesis.allCriteriaMet,
		// Quorum metadata — read by applyRehydrationCache and the council
		// fast-path to validate the APPROVE was recorded with sufficient
		// distinct members. Old evidence files (pre-quorum) lack this field
		// and are conservatively rehydrated as quorumSize: 1.
		quorumSize: synthesis.quorumSize,
	};

	const updated: Record<string, unknown> = Object.create(null);
	safeAssignOwnProps(updated, existingRoot);
	updated.gates = mergedGates;
	// Ensure TaskEvidence schema-required fields are always present.
	// readTaskEvidenceRaw validates against TaskEvidenceSchema (requires taskId +
	// required_gates); council-only writes omit them when no prior gate evidence
	// exists, causing ZodError → false "gate not run" block in checkCouncilGate.
	if (!updated.taskId) updated.taskId = synthesis.taskId;
	if (!Array.isArray(updated.required_gates)) updated.required_gates = [];

	writeFileSync(filePath, JSON.stringify(updated, null, 2));

	// ── Round-history audit log (non-blocking) ────────────────────────────
	// Append-only log of every council round for multi-round tasks.
	// Failures are logged but MUST NOT affect the primary evidence write above.
	try {
		const councilDir = join(workingDir, '.swarm', 'council');
		mkdirSync(councilDir, { recursive: true });
		const auditLine = JSON.stringify({
			round: synthesis.roundNumber,
			verdict: synthesis.overallVerdict,
			timestamp: synthesis.timestamp,
			vetoedBy: synthesis.vetoedBy,
		});
		appendFileSync(
			join(councilDir, `${synthesis.taskId}.rounds.jsonl`),
			`${auditLine}\n`,
		);
	} catch (auditError) {
		// Audit log failure must not break the primary evidence write.
		console.warn(
			`writeCouncilEvidence: failed to append round-history audit log: ${auditError instanceof Error ? auditError.message : String(auditError)}`,
		);
	}
}
