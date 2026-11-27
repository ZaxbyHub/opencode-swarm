/**
 * Communication debug-log lifecycle maintenance
 * (src/maintenance/communication-log.ts + the prune_communication_log tool).
 *
 * Pins the programmatic trimming policy: closed incidents whose closure is
 * durably provable (every named task's evidence at `complete`) are pruned
 * automatically; everything else needs the audited AI-release tool; open
 * entries and the structural sections are never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	_test_exports,
	parseCommunicationLog,
	pruneCommunicationLog,
	releaseCommunicationLogEntry,
	reportCommunicationLogWorklist,
} from '../../../src/maintenance/communication-log';
import { executePruneCommunicationLog } from '../../../src/tools/prune-communication-log';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const LOG_HEADER = `# Swarm Communication Debug Log

Policy: gelöste Einträge werden entfernt — Fix und Beweis leben im Upstream-PR.

## Format

- Datum, Symptom, Mechanik, Recovery, Status

---

## Offene Punkte (Stand 27.11)

- Beobachtung: bleibt immer stehen.
`;

function incidentBlock(
	headline: string,
	taskLine: string,
	statusLine: string,
): string {
	return `\n## Vorfall ${headline}\n- Task-ID: ${taskLine}\n- Symptom: x\n- Recovery: y\n- Status: ${statusLine}\n`;
}

function writeLog(directory: string, incidents: string): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'swarm_communication_debug.md'),
		LOG_HEADER + incidents,
	);
}

function readLog(directory: string): string {
	return fs.readFileSync(
		path.join(directory, '.swarm', 'swarm_communication_debug.md'),
		'utf8',
	);
}

/** Evidence fixture at a given workflow state (raw, schema-shaped). */
function writeEvidence(directory: string, taskId: string, state: string): void {
	fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'evidence', `${taskId}.json`),
		JSON.stringify({
			taskId,
			required_gates: ['reviewer'],
			gates: {},
			requirements_state: 'unknown',
			workflow: {
				schema: 'exact-task-v1',
				generation: 1,
				state,
				retryCount: 0,
				retryHistory: [],
				retryEpoch: 0,
				lastOutcome:
					state === 'complete' ? 'task_completed' : 'accepted_mutation',
				lastTransitionId: `fixture:${taskId}`,
				updatedAt: '2026-01-01T00:00:00.000Z',
			},
		}),
	);
}

let directory: string;
const realInternals = { ..._internals };

beforeEach(() => {
	directory = canonicalMkdtemp('swarm-commlog-');
	_test_exports.autoPassMemo.clear();
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	_test_exports.autoPassMemo.clear();
	fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

describe('parseCommunicationLog', () => {
	test('extracts incidents with status and task ids; ignores structural sections', () => {
		const raw =
			LOG_HEADER +
			incidentBlock(
				'2026-11-27 — 2.17 Keil',
				'2.17; Session(s): x',
				'GESCHLOSSEN — Task 2.17 completed',
			) +
			incidentBlock('2026-11-26 — offen', '2.16', 'OFFEN — wartet');
		const { incidents } = parseCommunicationLog(raw);
		expect(incidents).toHaveLength(2);
		expect(incidents[0]).toMatchObject({
			status: 'closed',
			taskIds: ['2.17'],
		});
		expect(incidents[1]).toMatchObject({ status: 'open', taskIds: ['2.16'] });
	});

	test('an incident without a Status line is unclear', () => {
		const raw =
			LOG_HEADER + `\n## Vorfall ohne Status\n- Task-ID: 1.1\n- Symptom: x\n`;
		const { incidents } = parseCommunicationLog(raw);
		expect(incidents[0].status).toBe('unclear');
	});

	test('status prose mentioning "offen" inside a closed status stays closed', () => {
		const raw =
			LOG_HEADER +
			incidentBlock('x', '1.1', 'GESCHLOSSEN — früher offen, jetzt zu');
		const { incidents } = parseCommunicationLog(raw);
		expect(incidents[0].status).toBe('closed');
	});
});

describe('pruneCommunicationLog (automatic pass)', () => {
	test('prunes a closed incident whose task is durably complete, preserving structure + audit', async () => {
		writeEvidence(directory, '2.17', 'complete');
		writeLog(
			directory,
			incidentBlock('2026-11-27 — 2.17', '2.17', 'GESCHLOSSEN — completed') +
				incidentBlock('2026-11-26 — offen', '2.18', 'OFFEN'),
		);
		const events: unknown[] = [];
		_internals.appendCoreEventSync = ((
			_dir: string,
			event: Record<string, unknown>,
		) => {
			events.push(event);
		}) as typeof _internals.appendCoreEventSync;

		const result = await pruneCommunicationLog(directory);

		expect(result.pruned).toHaveLength(1);
		expect(result.pruned[0]).toMatchObject({
			taskIds: ['2.17'],
			cause: 'closed_durably_complete',
		});
		expect(result.openCount).toBe(1);
		const after = readLog(directory);
		expect(after).not.toContain('2026-11-27 — 2.17');
		expect(after).toContain('2026-11-26 — offen');
		expect(after).toContain('## Offene Punkte');
		expect(after).toContain('# Swarm Communication Debug Log');
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'communication_log_pruned',
			cause: 'closed_durably_complete',
		});
	});

	test('keeps a closed incident whose task is NOT durably complete (AI worklist)', async () => {
		writeEvidence(directory, '2.17', 'coder_delegated');
		writeLog(
			directory,
			incidentBlock('2.17 unproven', '2.17', 'GESCHLOSSEN — behauptet'),
		);
		const result = await pruneCommunicationLog(directory);
		expect(result.pruned).toHaveLength(0);
		expect(result.unclearClosed).toHaveLength(1);
		expect(result.unclearClosed[0].why).toBe('task_not_durably_complete');
		expect(readLog(directory)).toContain('2.17 unproven');
	});

	test('keeps a closed incident without a task id', async () => {
		writeLog(directory, incidentBlock('ohne Task', 'keine', 'GESCHLOSSEN'));
		const result = await pruneCommunicationLog(directory);
		expect(result.unclearClosed[0].why).toBe('no_task_id');
		expect(readLog(directory)).toContain('ohne Task');
	});

	test('a missing log is a no-op', async () => {
		const result = await pruneCommunicationLog(directory);
		expect(result.unchanged).toBe(true);
		expect(result.pruned).toHaveLength(0);
	});

	test('the mtime memo skips a re-run on an unchanged file', async () => {
		writeEvidence(directory, '1.1', 'complete');
		writeLog(directory, incidentBlock('memo', '1.1', 'GESCHLOSSEN'));
		let reads = 0;
		const realRead = _internals.readFileSync;
		_internals.readFileSync = ((file: string) => {
			reads++;
			return realRead(file);
		}) as typeof _internals.readFileSync;
		await pruneCommunicationLog(directory); // prunes + memoizes
		const firstReads = reads;
		await pruneCommunicationLog(directory); // memo hit
		expect(reads).toBe(firstReads);
		expect(readLog(directory)).not.toContain('memo');
	});

	test('fail-open: a write error leaves the file untouched', async () => {
		writeEvidence(directory, '1.1', 'complete');
		writeLog(directory, incidentBlock('write-fail', '1.1', 'GESCHLOSSEN'));
		const before = readLog(directory);
		_internals.writeFileSync = ((): void => {
			throw new Error('disk full');
		}) as typeof _internals.writeFileSync;
		const result = await pruneCommunicationLog(directory);
		expect(result.unchanged).toBe(true);
		expect(readLog(directory)).toBe(before);
	});
});

describe('releaseCommunicationLogEntry (AI-release)', () => {
	test('releases a closed-but-unproven entry with an audited reason', async () => {
		writeEvidence(directory, '2.17', 'rework_required');
		writeLog(
			directory,
			incidentBlock('AI-Fall 2.17', '2.17', 'GESCHLOSSEN — unproven'),
		);
		const events: unknown[] = [];
		_internals.appendCoreEventSync = ((
			_dir: string,
			event: Record<string, unknown>,
		) => {
			events.push(event);
		}) as typeof _internals.appendCoreEventSync;

		const result = await releaseCommunicationLogEntry({
			directory,
			headlinePrefix: 'AI-Fall 2.17',
			reason: 'verified via upstream PR fragment; evidence schema migrated',
			actorSessionID: 'ses-ai',
		});

		expect(result.outcome).toBe('released');
		expect(readLog(directory)).not.toContain('AI-Fall 2.17');
		expect(events[0]).toMatchObject({
			type: 'communication_log_pruned',
			cause: 'ai_released',
			actor: 'ses-ai',
		});
	});

	test('refuses an open entry', async () => {
		writeLog(directory, incidentBlock('Offen-Fall', '1.1', 'OFFEN — wartet'));
		const result = await releaseCommunicationLogEntry({
			directory,
			headlinePrefix: 'Offen-Fall',
			reason: 'test',
			actorSessionID: 'ses-ai',
		});
		expect(result.outcome).toBe('refused_open');
		expect(readLog(directory)).toContain('Offen-Fall');
	});

	test('an ambiguous prefix is refused with candidates', async () => {
		writeLog(
			directory,
			incidentBlock('Fall A', '1.1', 'GESCHLOSSEN') +
				incidentBlock('Fall B', '1.2', 'GESCHLOSSEN'),
		);
		const result = await releaseCommunicationLogEntry({
			directory,
			headlinePrefix: 'Fall',
			reason: 'test',
			actorSessionID: 'ses-ai',
		});
		expect(result.outcome).toBe('ambiguous');
	});
});

describe('prune_communication_log tool', () => {
	test('worklist mode reports the AI-release candidates', async () => {
		writeEvidence(directory, '2.17', 'rework_required');
		writeLog(
			directory,
			incidentBlock('W-Case', '2.17', 'GESCHLOSSEN — unproven') +
				incidentBlock('W-Open', '1.1', 'OFFEN'),
		);
		const out = JSON.parse(
			await executePruneCommunicationLog({}, directory, {
				sessionID: 'ses-arch',
			}),
		) as Record<string, unknown>;
		expect(out.success).toBe(true);
		expect(out.mode).toBe('worklist');
		expect(out.open_entries).toBe(1);
		expect(out.ai_release_worklist).toHaveLength(1);
	});

	test('a removal requires a reason and an active session', async () => {
		writeLog(directory, incidentBlock('R-Case', '1.1', 'GESCHLOSSEN'));
		const noReason = JSON.parse(
			await executePruneCommunicationLog(
				{ entry_headline: 'R-Case' },
				directory,
				{ sessionID: 'ses-arch' },
			),
		) as Record<string, unknown>;
		expect(noReason.success).toBe(false);
		expect(String(noReason.message)).toContain('reason');
		const noSession = JSON.parse(
			await executePruneCommunicationLog(
				{ entry_headline: 'R-Case', reason: 'ok' },
				directory,
				{},
			),
		) as Record<string, unknown>;
		expect(noSession.success).toBe(false);
		expect(String(noSession.message)).toContain('sessionID');
	});

	test('a justified removal of a no-status entry succeeds and audits', async () => {
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'swarm_communication_debug.md'),
			LOG_HEADER +
				`\n## Vorfall unklarster Fall\n- Task-ID: 1.1\n- Symptom: x\n`,
		);
		const out = JSON.parse(
			await executePruneCommunicationLog(
				{
					entry_headline: 'unklarster Fall',
					reason: 'duplikat, im PR dokumentiert',
				},
				directory,
				{ sessionID: 'ses-arch' },
			),
		) as Record<string, unknown>;
		expect(out.success).toBe(true);
		expect(out.removed_headline).toBe('unklarster Fall');
		expect(readLog(directory)).not.toContain('unklarster Fall');
	});
});

describe('reportCommunicationLogWorklist', () => {
	test('classifies closed entries by provability', async () => {
		writeEvidence(directory, '1.1', 'complete');
		writeEvidence(directory, '2.2', 'idle');
		writeLog(
			directory,
			incidentBlock('provable', '1.1', 'GESCHLOSSEN') +
				incidentBlock('unproven', '2.2', 'GESCHLOSSEN'),
		);
		const report = await reportCommunicationLogWorklist(directory);
		expect(report.unclearClosed).toHaveLength(2);
		const byWhy = report.unclearClosed.map((e) => e.why).sort();
		expect(byWhy).toEqual([
			'auto_prunable_next_pass',
			'task_not_durably_complete',
		]);
	});
});
