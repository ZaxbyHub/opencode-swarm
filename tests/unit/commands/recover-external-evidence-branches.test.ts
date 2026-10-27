import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleRecoverCommand } from '../../../src/commands/recover.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Recover branch matrix for the #3422 no-WAL shapes: absence vs
 * events-present vs corrupt evidence vs evidence-exists-incomplete, plus the
 * issue #3432 review additions (PRR-005 structured event match, PRR-006
 * unknown-dispatch-history branch, PRR-012 truncation note, PRR-016
 * known-tasks listing in every no-WAL shape). Complements
 * tests/unit/commands/recover.test.ts (which pins the WALs-exist/known-tasks
 * shape) and the frozen C4 (absence-branch remedies).
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

function seedEvents(lines: string[]): void {
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(join(dir, '.swarm', 'events.jsonl'), `${lines.join('\n')}\n`);
}

/** The exact record shape appendCoreEventSync writes for settlement lifecycle events. */
function settlementEvent(taskId: string): string {
	return JSON.stringify({
		type: 'coder_settlement',
		action: 'dispatched',
		timestamp: '2026-01-15T00:00:00.000Z',
		taskId,
		transitionId: `dispatch:${taskId}`,
		actor: 'test',
	});
}

/** An unreadable junk WAL — still listed (state 'unreadable') with its taskId. */
function seedJunkWal(taskId: string): void {
	mkdirSync(join(dir, '.swarm', 'coder-settlements'), { recursive: true });
	writeFileSync(
		join(dir, '.swarm', 'coder-settlements', `${taskId}.json`),
		'{}',
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

test('known-tasks listing appears in the no-WAL shapes when other WALs exist (PRR-016)', async () => {
	writePlanWithTask('3.2');
	seedJunkWal('9.9');
	const out = await handleRecoverCommand(dir, ['3.2']);
	expect(out).toContain('Known tasks: 9.9');
});

test('events-present branch: coder_settlement events without a WAL routes to the runbook, not the absence message', async () => {
	writePlanWithTask('4.1');
	// Seed the bounded core-event log with a structured coder_settlement
	// lifecycle record naming this task (the scan matches on the parsed
	// record's type + taskId, per issue #3432 review PRR-005).
	seedEvents([settlementEvent('4.1')]);
	const out = await handleRecoverCommand(dir, ['4.1']);
	expect(out).toContain(
		'coder-settlement lifecycle events exist for it in the core event log',
	);
	expect(out).toContain('docs/troubleshooting/recovery-runbook.md');
	expect(out).not.toContain(
		'No coder dispatch or settlement evidence was found for task 4.1',
	);
});

test('structured match: a settlement event for task 4.10 does NOT dispatch-match a request for 4.1 (PRR-005)', async () => {
	writePlanWithTask('4.1');
	seedEvents([
		'{"torn line',
		// Non-settlement record that mentions the task id.
		'{"type":"todo_scan","taskId":"4.1","action":"scanned"}',
		// Same-type record for a superstring id — the old substring scan
		// matched this and misrouted to the runbook branch.
		settlementEvent('4.10'),
	]);
	const out = await handleRecoverCommand(dir, ['4.1']);
	expect(out).toContain(
		'No coder dispatch or settlement evidence was found for task 4.1',
	);
	expect(out).not.toContain(
		'coder-settlement lifecycle events exist for it in the core event log',
	);
});

test('unknown-dispatch-history branch: an unreadable/oversized event log gets its own honest message (PRR-006)', async () => {
	writePlanWithTask('7.1');
	// Oversized ( > 8 MiB scan cap) event log: the scan cannot establish
	// dispatch history and must not narrate "no coder dispatch ran".
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		join(dir, '.swarm', 'events.jsonl'),
		`x\n`.repeat(8 * 1024 * 1024 + 16),
	);
	const out = await handleRecoverCommand(dir, ['7.1']);
	expect(out).toContain('dispatch history could not be established');
	expect(out).not.toContain('no coder dispatch ran for this task');
	expect(out).not.toContain(
		'No coder dispatch or settlement evidence was found for task 7.1',
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

test('listing cap in a no-WAL shape discloses that the absence is only proven for the listed prefix (PRR-012)', async () => {
	writePlanWithTask('7.1');
	// 201 junk WALs push the listing past MAX_SETTLEMENT_WAL_SCAN (200).
	mkdirSync(join(dir, '.swarm', 'coder-settlements'), { recursive: true });
	for (let i = 1; i <= 201; i++) {
		writeFileSync(
			join(
				dir,
				'.swarm',
				'coder-settlements',
				`a${String(i).padStart(3, '0')}.json`,
			),
			'{}',
		);
	}
	const out = await handleRecoverCommand(dir, ['7.1']);
	expect(out).toContain(
		'the absence above is only established for the listed tasks',
	);
	expect(out).toContain(
		'No coder dispatch or settlement evidence was found for task 7.1',
	);
});
