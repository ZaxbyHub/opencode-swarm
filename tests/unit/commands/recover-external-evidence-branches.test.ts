import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleRecoverCommand } from '../../../src/commands/recover.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Recover branch matrix for the #3422 no-WAL shapes: absence vs
 * events-present vs corrupt evidence vs evidence-exists-incomplete.
 * Complements tests/unit/commands/recover.test.ts (which pins the
 * WALs-exist/known-tasks shape) and the frozen C4 (absence-branch remedies).
 */

let dir = '';

beforeEach(() => {
	dir = canonicalMkdtemp('swarm3422-recover-branches-');
	mkdirSync(join(dir, '.git'), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writePlanWithTask(taskId: string): void {
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'recover-branches',
			swarm: 'probe',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'ops',
					status: 'in_progress',
					tasks: [
						{
							id: taskId,
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'Commit and push the release',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		}),
	);
}

test('absence branch: no WAL, no evidence, no events → never-dispatched shape with three remedies', async () => {
	writePlanWithTask('3.2');
	const out = await handleRecoverCommand(dir, ['3.2']);
	expect(out).toContain(
		'No coder dispatch or settlement evidence was found for task 3.2',
	);
	expect(out).toContain('/swarm attest 3.2');
	expect(out).toContain('manual close');
	expect(out).toContain('thin coder dispatch');
});

test('events-present branch: coder_settlement events without a WAL routes to the runbook, not the absence message', async () => {
	writePlanWithTask('4.1');
	// Seed the bounded core-event log with a coder_settlement lifecycle event
	// naming this task (the scan consults .swarm/events.jsonl via
	// coreEventsFilePath and greps for the pair).
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		join(dir, '.swarm', 'events.jsonl'),
		'{"kind":"coder_settlement","taskId":"4.1","action":"dispatched"}\n',
	);
	const out = await handleRecoverCommand(dir, ['4.1']);
	expect(out).toContain(
		'coder-settlement lifecycle events exist for it in the core event log',
	);
	expect(out).toContain('docs/troubleshooting/recovery-runbook.md');
	expect(out).not.toContain(
		'No coder dispatch or settlement evidence was found for task 4.1',
	);
});

test('corrupt-evidence branch: an unparseable evidence file gets the inspect refusal, not the absence message', async () => {
	writePlanWithTask('5.1');
	mkdirSync(join(dir, '.swarm', 'evidence'), { recursive: true });
	writeFileSync(join(dir, '.swarm', 'evidence', '5.1.json'), '{ not json');
	const out = await handleRecoverCommand(dir, ['5.1']);
	expect(out).toContain('unreadable (corrupt)');
	expect(out).toContain('.swarm/evidence/5.1.json');
	expect(out).not.toContain(
		'No coder dispatch or settlement evidence was found for task 5.1',
	);
});

test('evidence-exists-incomplete branch: valid evidence without dispatch names the attest next step', async () => {
	writePlanWithTask('6.1');
	mkdirSync(join(dir, '.swarm', 'evidence'), { recursive: true });
	// A minimal parseable evidence file with no coder dispatch history
	// (e.g. seeded by a todo scan) and no external bundle.
	writeFileSync(
		join(dir, '.swarm', 'evidence', '6.1.json'),
		JSON.stringify({
			taskId: '6.1',
			required_gates: [],
			gates: {},
			workflow: {
				schema: 'exact-task-v1',
				generation: 0,
				state: 'idle',
				retryCount: 0,
				retryHistory: [],
				retryEpoch: 0,
				lastOutcome: 'none',
				updatedAt: '2026-01-15T00:00:00.000Z',
			},
		}),
	);
	const out = await handleRecoverCommand(dir, ['6.1']);
	expect(out).toContain(
		'No settlement WAL for task 6.1. Task-evidence exists (present)',
	);
	expect(out).toContain('/swarm attest 6.1');
});
