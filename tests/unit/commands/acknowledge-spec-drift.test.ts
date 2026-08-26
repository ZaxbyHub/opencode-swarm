import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAcknowledgeSpecDriftCommand } from '../../../src/commands/acknowledge-spec-drift';
import { readEffectiveSpecSync } from '../../../src/sdd/effective-spec';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

/**
 * #2039: `.swarm/events.jsonl` line 1 is now the `swarm-events-manifest`
 * header written by the core event store. Raw line-count assertions must
 * skip the manifest and count EVENT lines only.
 */
function readEventLines(directory: string): string[] {
	return readFileSync(join(directory, '.swarm', 'events.jsonl'), 'utf-8')
		.trim()
		.split('\n')
		.filter((line) => {
			try {
				return (
					(JSON.parse(line) as { type?: unknown }).type !==
					'swarm-events-manifest'
				);
			} catch {
				return true;
			}
		});
}

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
		tempDir = join(canonicalTmpDir(), `ack-spec-drift-${randomUUID()}`);
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

		// #2039: skip the manifest header line — only EVENT lines count.
		const events = readEventLines(tempDir);
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
		// #2039: skip the manifest header line — only EVENT lines count.
		const firstEvents = readEventLines(tempDir);
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
		const secondEvents = readEventLines(tempDir);
		expect(secondEvents).toHaveLength(1);
		expect(existsSync(join(tempDir, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
	});

	test('fails closed when the authority index is corrupt and leaves the marker in place', async () => {
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
		// #2039 CONTRACT CHANGE: the fail-closed surface moved from a malformed
		// events.jsonl line to the authority index
		// (`.swarm/events-authority-index.json`). A corrupt index throws
		// CORE_EVENT_AUTHORITY_INDEX_UNREADABLE from hasSpecDriftAuditEvent —
		// mirroring the malformed-JSONL throw it replaced — so the command
		// fails closed and the marker stays blocking.
		await writeFile(
			join(tempDir, '.swarm', 'events-authority-index.json'),
			'{not json',
		);

		const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

		expect(result).toContain('Spec drift recovery failed and remains blocking');
		expect(result).toContain('CORE_EVENT_AUTHORITY_INDEX_UNREADABLE');
		expect(existsSync(join(tempDir, '.swarm', 'spec-staleness.json'))).toBe(
			true,
		);
	});

	test('tolerates a malformed events.jsonl window line while acknowledging (#2039 documented tolerance)', async () => {
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
				specHash_current: 'newhash789',
				reason: 'spec.md changed since plan saved',
				timestamp: '2026-08-14T12:15:00.000Z',
			}),
		);
		// #2039: malformed window lines are now SKIPPED by every consumer
		// (the bounded window scan never blocks authority lookups), so a
		// corrupt event line no longer blocks acknowledgment.
		await writeFile(join(tempDir, '.swarm', 'events.jsonl'), '{not jsonl}\n');

		const result = await handleAcknowledgeSpecDriftCommand(tempDir, []);

		expect(result).toContain('Spec drift acknowledged for plan "Test Plan"');
		expect(existsSync(join(tempDir, '.swarm', 'spec-staleness.json'))).toBe(
			false,
		);
	});
});
