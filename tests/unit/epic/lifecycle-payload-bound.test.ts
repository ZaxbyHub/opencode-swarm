/**
 * The epic lifecycle row is bounded before it reaches the coordination store.
 *
 * The record grows per wave (frozen file scopes, cochange pairs, a per-wave
 * component snapshot, merge failures) and the store rejects any payload over
 * `MAX_PAYLOAD_CHARS` (1 MiB) with a bare `payload must contain 1..1048576
 * characters`. Unbounded, a long epic's row would eventually cross that line
 * and every later transition — including both close variants — would throw the
 * same raw store error with no remedy. `updateEpicRecord` refuses at a
 * threshold below the hard cap, with a message that tells the user what to do.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCoordinationStateRaw } from '../../../src/db/coordination-store';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	EPIC_LIFECYCLE_NAMESPACE,
	EpicRecordTooLargeError,
	epicRecordPayloadTooLarge,
	inspectEpic,
	updateEpicRecord,
} from '../../../src/epic/lifecycle';
import { openEpicForTest, stubEpicRecord } from '../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
let restoreClock: Restore | null = null;

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-03-01T00:00:00.000Z' });
	dir = canonicalMkdtemp('epic-payload-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Payload Bound',
			swarm: 'payload-swarm',
			current_phase: 1,
			migration_status: 'native',
			phases: [],
		}),
	);
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A record padded past the soft ceiling with frozen wave scopes. */
function oversizedRecord() {
	const record = stubEpicRecord();
	const filler = 'x'.repeat(2048);
	record.waves = Array.from({ length: 600 }, (_, i) => ({
		seq: i + 1,
		taskIds: ['1.1'],
		files: {
			'1.1': Array.from({ length: 80 }, (_, f) => `src/${filler}/${f}.ts`),
		},
		cochange: [],
		components: [],
		status: 'issued' as const,
		issuedAt: '2026-03-01T00:00:00.000Z',
	}));
	return record;
}

describe('epicRecordPayloadTooLarge', () => {
	test('a normal record is under the ceiling', () => {
		expect(epicRecordPayloadTooLarge(stubEpicRecord())).toBe(false);
	});

	test('a record with many padded waves is over the ceiling', () => {
		expect(epicRecordPayloadTooLarge(oversizedRecord())).toBe(true);
	});
});

describe('updateEpicRecord refuses an oversized row with a remedy', () => {
	test('the write is refused and the stored row is unchanged', () => {
		const epic = openEpicForTest(dir);
		const before = getCoordinationStateRaw(
			dir,
			EPIC_LIFECYCLE_NAMESPACE,
			epic.epicKey,
		);

		expect(() =>
			updateEpicRecord(dir, epic.epicKey, () => oversizedRecord()),
		).toThrow(EpicRecordTooLargeError);

		const after = getCoordinationStateRaw(
			dir,
			EPIC_LIFECYCLE_NAMESPACE,
			epic.epicKey,
		);
		expect(after?.revision).toBe(before?.revision);
		expect(after?.payload).toBe(before?.payload);
		expect(inspectEpic(dir, null).record?.status).toBe('open');
	});

	test('the error names the epic and the remedy (not the raw store message)', () => {
		const epic = openEpicForTest(dir);
		let thrown: unknown;
		try {
			updateEpicRecord(dir, epic.epicKey, () => oversizedRecord());
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(EpicRecordTooLargeError);
		const message = (thrown as Error).message;
		expect(message).toContain(epic.epicKey);
		expect(message).toContain('/swarm epic close');
		// The bare store error this replaces.
		expect(message).not.toContain('1..1048576');
	});

	test('a normal update still applies', () => {
		const epic = openEpicForTest(dir);
		const updated = updateEpicRecord(dir, epic.epicKey, (record) => ({
			...record,
			forced: true,
		}));
		expect(updated?.forced).toBe(true);
		expect(inspectEpic(dir, null).record?.forced).toBe(true);
	});
});
