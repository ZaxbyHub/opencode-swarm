import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { withEvidenceLock } from '../evidence/lock.js';
import { atomicWriteFile } from '../evidence/task-file.js';
import { EvaluationIdentifierSchema, GateNameSchema } from './contracts.js';
import { canonicalJson } from './hashing.js';

export const GateGroundTruthV1Schema = z
	.object({
		v: z.literal(1),
		runId: EvaluationIdentifierSchema,
		taskId: EvaluationIdentifierSchema,
		candidateId: EvaluationIdentifierSchema,
		model: z.string().min(1).max(300),
		gate: GateNameSchema,
		repetition: z.number().int().nonnegative(),
		source: z.enum(['integration', 'test-impact']),
		classification: z.enum([
			'clean',
			'new_regression',
			'pre_existing',
			'flaky',
			'infrastructure_failure',
			'unknown',
		]),
		observedAt: z.iso.datetime({ offset: true }),
		confidence: z.number().min(0).max(1).optional(),
	})
	.strict();

export type GateGroundTruthV1 = z.infer<typeof GateGroundTruthV1Schema>;
export type TestImpactGateGroundTruthInput = Omit<
	GateGroundTruthV1,
	'v' | 'source'
>;

export function gateGroundTruthJoinKey(
	value: Pick<
		GateGroundTruthV1,
		'runId' | 'taskId' | 'candidateId' | 'model' | 'gate' | 'repetition'
	>,
): string {
	return [
		value.runId,
		value.taskId,
		value.candidateId,
		value.model,
		value.gate,
		String(value.repetition),
	].join('\u0000');
}

function relativePath(runId: string): string {
	return path.join('evidence', 'gate-audit', runId, 'ground-truth.jsonl');
}

function absolutePath(directory: string, runId: string): string {
	return path.join(directory, '.swarm', relativePath(runId));
}

function serialize(events: GateGroundTruthV1[]): string {
	return `${events.map((event) => canonicalJson(event)).join('\n')}\n`;
}

function parseStrict(content: string): GateGroundTruthV1[] {
	return content
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line) => GateGroundTruthV1Schema.parse(JSON.parse(line)));
}

/** Persist the exact offline join relation once; conflicting rewrites fail closed. */
export async function saveGateGroundTruth(
	directory: string,
	runId: string,
	input: GateGroundTruthV1[],
): Promise<GateGroundTruthV1[]> {
	const events = input.map((event) => GateGroundTruthV1Schema.parse(event));
	if (events.some((event) => event.runId !== runId)) {
		throw new Error('gate ground truth run id does not match its storage path');
	}
	const target = absolutePath(directory, runId);
	await mkdir(path.dirname(target), { recursive: true });
	return withEvidenceLock(
		directory,
		relativePath(runId),
		'gate-ground-truth',
		runId,
		async () => {
			let existingEvents: GateGroundTruthV1[] = [];
			try {
				existingEvents = parseStrict(await readFile(target, 'utf8'));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
			const byCanonicalEvent = new Map<string, GateGroundTruthV1>();
			for (const event of [...existingEvents, ...events]) {
				if (event.runId !== runId) {
					throw new Error(
						'gate ground truth run id does not match its storage path',
					);
				}
				byCanonicalEvent.set(canonicalJson(event), event);
			}
			const merged = [...byCanonicalEvent.values()].sort((left, right) => {
				const keyOrder = gateGroundTruthJoinKey(left).localeCompare(
					gateGroundTruthJoinKey(right),
				);
				return (
					keyOrder || canonicalJson(left).localeCompare(canonicalJson(right))
				);
			});
			const desired = serialize(merged);
			if (serialize(existingEvents) !== desired) {
				await atomicWriteFile(target, desired);
			}
			return merged;
		},
	);
}

/** Supported ingestion adapter for exact-key test-impact/integration sidecars. */
export async function recordTestImpactGateGroundTruth(
	directory: string,
	runId: string,
	input: TestImpactGateGroundTruthInput[],
): Promise<GateGroundTruthV1[]> {
	return saveGateGroundTruth(
		directory,
		runId,
		input.map((event) => ({ ...event, v: 1, source: 'test-impact' })),
	);
}

export type GateGroundTruthReadSummary = {
	events: GateGroundTruthV1[];
	malformed: number;
};

/** Read historical evidence line-by-line so one malformed record is unavailable, not trusted. */
export async function readGateGroundTruth(
	directory: string,
	runId: string,
): Promise<GateGroundTruthReadSummary> {
	let content: string;
	try {
		content = await readFile(absolutePath(directory, runId), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { events: [], malformed: 0 };
		}
		throw error;
	}
	const events: GateGroundTruthV1[] = [];
	let malformed = 0;
	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = GateGroundTruthV1Schema.parse(JSON.parse(line));
			if (event.runId !== runId) throw new Error('run id/path mismatch');
			events.push(event);
		} catch {
			malformed++;
		}
	}
	return { events, malformed };
}
