import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAcknowledgeSpecDriftCommand } from '../commands/acknowledge-spec-drift';

describe('handleAcknowledgeSpecDriftCommand smoke', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			`ack-spec-drift-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	test('preserves a corrupt marker', async () => {
		const markerPath = join(tempDir, '.swarm', 'spec-staleness.json');
		await writeFile(markerPath, '{ invalid json');

		const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

		expect(result).toContain('Spec drift marker is corrupt');
		expect(existsSync(markerPath)).toBe(true);
	});

	test('records the caller identity on a successful acknowledgment', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Smoke Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
				migration_status: 'native',
				specHash: 'oldhash123',
			}),
		);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), '# Spec\n\nSmoke.\n');
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			JSON.stringify({
				planTitle: 'Smoke Plan',
				phase: 1,
				specHash_plan: 'oldhash123',
				specHash_current: 'newhash456',
				reason: 'spec.md changed since plan saved',
				timestamp: '2026-08-14T13:00:00.000Z',
			}),
		);

		await handleAcknowledgeSpecDriftCommand(tempDir, [], 'cli');

		const events = (
			await readFile(join(tempDir, '.swarm', 'events.jsonl'), 'utf-8')
		)
			.trim()
			.split('\n');
		const event = JSON.parse(events[0]);
		expect(event.type).toBe('spec_drift_acknowledged');
		expect(event.acknowledgedBy).toBe('cli');
		expect(event.transitionId).toEqual(expect.any(String));
	});
});
