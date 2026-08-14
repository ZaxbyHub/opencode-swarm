import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAcknowledgeSpecDriftCommand } from '../../../src/commands/acknowledge-spec-drift';
import { readEffectiveSpecSync } from '../../../src/sdd/effective-spec';

function buildPlan(specHash?: string) {
	return {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: 'Test task',
						depends: [],
					},
				],
			},
		],
		migration_status: 'native',
		...(specHash ? { specHash } : {}),
	};
}

describe('handleAcknowledgeSpecDriftCommand', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `ack-spec-drift-${randomUUID()}`);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	test('returns no drift when the marker is absent', async () => {
		await expect(handleAcknowledgeSpecDriftCommand(tempDir, [])).resolves.toBe(
			'No spec drift detected.',
		);
	});

	test('keeps a corrupt marker blocking instead of deleting it', async () => {
		const markerPath = join(tempDir, '.swarm', 'spec-staleness.json');
		await writeFile(markerPath, '{ invalid json');

		const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

		expect(result).toContain('Spec drift marker is corrupt');
		expect(existsSync(markerPath)).toBe(true);
	});

	test('acknowledges drift, refreshes snapshot, updates plan, and records an idempotent event', async () => {
		const specContent = '# Spec\n\nUpdated requirements.\n';
		const markerRaw = JSON.stringify({
			planTitle: 'Test Plan',
			phase: 1,
			specHash_plan: 'oldhash123',
			specHash_current: 'stalehash456',
			reason: 'spec.md changed since plan saved',
			timestamp: '2026-08-14T12:00:00.000Z',
		});

		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(buildPlan('oldhash123'), null, 2),
		);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), specContent);
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), '# Old\n');
		await writeFile(join(tempDir, '.swarm', 'spec-staleness.json'), markerRaw);

		const result = await handleAcknowledgeSpecDriftCommand(tempDir, [], 'user');

		expect(result).toContain('Spec drift acknowledged for plan "Test Plan"');
		expect(result).toContain(
			'Warning: Spec drift was acknowledged; verify that the implementation still matches the current spec before proceeding.',
		);
		expect(existsSync(join(tempDir, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
		expect(
			await readFile(join(tempDir, '.swarm', 'spec-snapshot.md'), 'utf-8'),
		).toBe(specContent);

		const plan = JSON.parse(
			await readFile(join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
		) as { specHash?: string };
		expect(plan.specHash).toBe(readEffectiveSpecSync(tempDir)?.hash);

		const events = readFileSync(
			join(tempDir, '.swarm', 'events.jsonl'),
			'utf-8',
		)
			.trim()
			.split('\n');
		expect(events).toHaveLength(1);
		const event = JSON.parse(events[0]);
		expect(event.type).toBe('spec_drift_acknowledged');
		expect(event.acknowledgedBy).toBe('user');
		expect(event.markerHash).toEqual(expect.any(String));
		expect(event.transitionId).toEqual(expect.any(String));
	});

	test('accepts already-reconciled plan state on retry without duplicating the audit event', async () => {
		const specContent = '# Spec\n\nRetry-safe requirements.\n';
		const markerRaw = JSON.stringify({
			planTitle: 'Test Plan',
			phase: 1,
			specHash_plan: 'oldhash123',
			specHash_current: 'retryhash456',
			reason: 'spec.md changed since plan saved',
			timestamp: '2026-08-14T12:05:00.000Z',
		});

		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(buildPlan('oldhash123'), null, 2),
		);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), specContent);
		await writeFile(join(tempDir, '.swarm', 'spec-staleness.json'), markerRaw);

		await handleAcknowledgeSpecDriftCommand(tempDir, [], 'cli');
		const firstEvents = readFileSync(
			join(tempDir, '.swarm', 'events.jsonl'),
			'utf-8',
		)
			.trim()
			.split('\n');
		expect(firstEvents).toHaveLength(1);

		await writeFile(join(tempDir, '.swarm', 'spec-staleness.json'), markerRaw);
		const retryResult = await handleAcknowledgeSpecDriftCommand(
			tempDir,
			[],
			'cli',
		);

		expect(retryResult).toContain(
			'Spec drift acknowledged for plan "Test Plan"',
		);
		const secondEvents = readFileSync(
			join(tempDir, '.swarm', 'events.jsonl'),
			'utf-8',
		)
			.trim()
			.split('\n');
		expect(secondEvents).toHaveLength(1);
		expect(existsSync(join(tempDir, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
	});

	test('fails closed when events.jsonl is corrupt and leaves the marker in place', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(buildPlan('oldhash123'), null, 2),
		);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), '# Spec\n\nCurrent.\n');
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			JSON.stringify({
				planTitle: 'Test Plan',
				phase: 1,
				specHash_plan: 'oldhash123',
				specHash_current: 'newhash456',
				reason: 'spec.md changed since plan saved',
				timestamp: '2026-08-14T12:10:00.000Z',
			}),
		);
		await writeFile(join(tempDir, '.swarm', 'events.jsonl'), '{not jsonl}\n');

		const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

		expect(result).toContain('Spec drift recovery failed and remains blocking');
		expect(result).toContain('events.jsonl is not valid JSONL');
		expect(existsSync(join(tempDir, '.swarm', 'spec-staleness.json'))).toBe(
			true,
		);
	});
});
