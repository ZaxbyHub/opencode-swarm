/**
 * Work Complete Council — pre-declaration criteria writer/reader.
 *
 * Stores acceptance criteria under .swarm/council/{safeId}.json so they can be
 * read back during council evaluation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CouncilCriteria, CouncilCriteriaItem } from './types';

const COUNCIL_DIR = '.swarm/council';
const CouncilCriteriaSchema = z.object({
	taskId: z.string(),
	criteria: z.array(
		z.object({
			id: z.string(),
			description: z.string(),
			mandatory: z.boolean(),
		}),
	),
	declaredAt: z.string(),
});
// Intentionally NO .passthrough() — Zod strips unknown keys by default.
// This provides built-in protection against prototype pollution via
// `__proto__`, `constructor`, or `prototype` own-property keys in
// persisted .swarm/council/*.json files. (council-evidence-writer.ts
// uses safeAssignOwnProps for the same purpose on evidence files.)

export function writeCriteria(
	workingDir: string,
	taskId: string,
	criteria: CouncilCriteriaItem[],
): void {
	const dir = join(workingDir, COUNCIL_DIR);
	mkdirSync(dir, { recursive: true });
	const payload: CouncilCriteria = {
		taskId,
		criteria,
		declaredAt: new Date().toISOString(),
	};
	writeFileSync(
		join(dir, `${safeId(taskId)}.json`),
		JSON.stringify(payload, null, 2),
	);
}

export function readCriteria(
	workingDir: string,
	taskId: string,
): CouncilCriteria | null {
	const filePath = join(workingDir, COUNCIL_DIR, `${safeId(taskId)}.json`);
	if (!existsSync(filePath)) return null;
	try {
		return CouncilCriteriaSchema.parse(
			JSON.parse(readFileSync(filePath, 'utf-8')),
		);
	} catch {
		return null;
	}
}

// Sanitizes taskId to a safe filename for .swarm/council/ storage (dots → underscores).
// This differs intentionally from council-evidence-writer.ts which uses the raw taskId
// (under VALID_TASK_ID regex guard) to match check_gate_status/gate-evidence filename conventions.
function safeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}
