import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { readLedgerEvents } from '../../../src/plan/ledger';
import { savePlan } from '../../../src/plan/manager';

export function specHash(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function createSpecRecoveryWorkspace(
	prefix: string,
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	await mkdir(join(directory, '.swarm'), { recursive: true });
	return directory;
}

export function buildSpecRecoveryPlan(specHashValue: string | null): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Spec WAL Plan',
		swarm: 'spec-wal-swarm',
		current_phase: 1,
		migration_status: 'native',
		...(specHashValue === null ? {} : { specHash: specHashValue }),
		phases: [
			{
				id: 1,
				name: 'Recovery',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: 'Recover spec drift transaction',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

export async function seedSpecRecoveryPlan(
	directory: string,
	specHashValue: string | null,
): Promise<void> {
	await savePlan(directory, buildSpecRecoveryPlan(specHashValue));
}

export async function writeSpecMarker(
	directory: string,
	args: {
		planHash: string | null;
		currentHash: string | null;
		reason?: string;
	},
): Promise<void> {
	await writeFile(
		join(directory, '.swarm', 'spec-staleness.json'),
		`${JSON.stringify(
			{
				planTitle: 'Spec WAL Plan',
				phase: 1,
				specHash_plan: args.planHash,
				specHash_current: args.currentHash,
				reason: args.reason ?? 'spec changed during test',
				timestamp: '2026-08-14T00:00:00.000Z',
			},
			null,
			2,
		)}\n`,
		'utf8',
	);
}

export async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

export async function countSpecRecoverySnapshots(
	directory: string,
	transitionId: string,
): Promise<number> {
	const events = await readLedgerEvents(directory);
	return events.filter((event) => {
		if (event.event_type !== 'snapshot') return false;
		const payload = event.payload as Record<string, unknown> | undefined;
		const approval = payload?.approval as Record<string, unknown> | undefined;
		return approval?.specDriftTransitionId === transitionId;
	}).length;
}
