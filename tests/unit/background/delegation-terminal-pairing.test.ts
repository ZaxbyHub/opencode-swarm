import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	buildDelegationTerminalIdentityFields,
	delegationCostRecordMaterial,
} from '../../../src/background/delegation-cost-identity.js';
import { emitDelegationEventlessTerminalEnd } from '../../../src/background/delegation-lifecycle.js';
import { capSessionMap } from '../../../src/index.js';
import { telemetry } from '../../../src/telemetry.js';

/**
 * Issue #2482 / #2244: paired delegation begin/end with record-attributed
 * identity — recovered eventless terminals (terminal-without-event, stale
 * sweep) and lane/Task hash disjointness.
 */

const baseRecord = {
	parentSessionId: 'sess-1',
	callID: 'call-1',
	swarmPrefixedAgent: 'mega_coder',
	subagentSessionId: 'child-1',
};

describe('delegation-cost-identity', () => {
	test('lane records keep the lane: discriminator; Task records use the documented Task shape', () => {
		const lane = delegationCostRecordMaterial({
			...baseRecord,
			laneId: 'lane-7',
		});
		expect(lane).toBe('sess-1\0call-1\0lane:lane-7');
		const task = delegationCostRecordMaterial({
			...baseRecord,
			laneId: undefined,
		});
		expect(task).toBe('sess-1\0call-1');
		expect(task).not.toBe(lane);
	});

	test('lane vs Task record_ids can never collide, even for a shared (session, callID)', () => {
		const hash = (material: string) =>
			createHash('sha256')
				.update(`delegation-cost-id-v1\0${material}`)
				.digest('hex');
		const laneId = hash(
			delegationCostRecordMaterial({ ...baseRecord, laneId: 'x' }),
		);
		const taskId = hash(
			delegationCostRecordMaterial({ ...baseRecord, laneId: undefined }),
		);
		expect(laneId).not.toBe(taskId);
		// Task-material ids are byte-stable (the same identity the foreground
		// Task handoff hashes — consistency, not a new convention).
		expect(
			hash(delegationCostRecordMaterial({ ...baseRecord, laneId: undefined })),
		).toBe(taskId);
	});

	test('recovered identity fields carry the recovered marker and deterministic digests', () => {
		const fields = buildDelegationTerminalIdentityFields({
			record: { ...baseRecord, laneId: undefined },
			recovered: true,
		});
		expect(fields.recovered).toBe(true);
		expect(fields.version).toBe(1);
		expect(fields.record_id).toHaveLength(32);
		const notRecovered = buildDelegationTerminalIdentityFields({
			record: { ...baseRecord, laneId: undefined },
		});
		expect(notRecovered.recovered).toBeUndefined();
		expect(notRecovered.record_id).toBe(fields.record_id);
	});
});

describe('emitDelegationEventlessTerminalEnd — regression: background begin-without-end (#2244)', () => {
	// Previous behavior: delegationCostRecordMaterial THREW for records without
	// a laneId, so Task-tool background terminals could never emit their end —
	// their delegation_begin stayed unpaired forever.
	test('emits delegation_end attributed from the durable record, with recovered: true', () => {
		const events: Array<{ kind: string; payload: Record<string, unknown> }> =
			[];
		const origEnd = telemetry.delegationEnd;
		const origBegin = telemetry.delegationBegin;
		(telemetry as { delegationEnd: unknown }).delegationEnd = (
			sessionId: string,
			agentName: string,
			taskId: string,
			result: string,
			costFields?: Record<string, unknown>,
		) => {
			events.push({
				kind: 'delegation_end',
				payload: { sessionId, agentName, taskId, result, ...costFields },
			});
		};
		(telemetry as { delegationBegin: unknown }).delegationBegin = () => {
			events.push({ kind: 'delegation_begin', payload: {} });
		};
		try {
			emitDelegationEventlessTerminalEnd(
				{ ...baseRecord, planTaskId: 'task-9', laneId: undefined },
				'stale',
			);
		} finally {
			(telemetry as { delegationEnd: unknown }).delegationEnd = origEnd;
			(telemetry as { delegationBegin: unknown }).delegationBegin = origBegin;
		}
		expect(events.length).toBe(1);
		const evt = events[0]!;
		expect(evt.kind).toBe('delegation_end');
		// Attribution from the durable record, never the parent-session map.
		expect(evt.payload.agentName).toBe('mega_coder');
		expect(evt.payload.sessionId).toBe('sess-1');
		expect(evt.payload.taskId).toBe('task-9');
		expect(evt.payload.result).toBe('stale');
		expect(evt.payload.recovered).toBe(true);
		expect(evt.payload.record_id).toHaveLength(32);
	});

	test('never throws — observation-only even with a hostile record shape', () => {
		expect(() =>
			emitDelegationEventlessTerminalEnd(
				{
					parentSessionId: 's',
					callID: 'c',
					swarmPrefixedAgent: 'a',
					subagentSessionId: '',
					laneId: undefined,
				},
				'completed',
			),
		).not.toThrow();
	});
});

describe('capSessionMap — regression: just-inserted entry self-eviction (#2244 item 2)', () => {
	test('the justInserted key survives the cap even when it is the oldest slot', () => {
		// Previous behavior: a re-set entry kept its ORIGINAL insertion
		// position, so at the cap the freshly-written entry could evict itself.
		const map = new Map<string, number>();
		map.set('old', 2); // re-set below keeps its original position
		map.set('a', 1);
		map.set('old', 3);
		// size 2, cap 1: 'old' is the oldest slot AND the just-inserted key —
		// the guard must break instead of evicting itself.
		capSessionMap(map, 1, 'old');
		expect(map.has('old')).toBe(true);
		expect(map.size).toBe(2); // guard stopped eviction at the fresh entry
		// Without the guard param the historical behavior applies (bounded).
		const map2 = new Map<string, number>();
		map2.set('a', 1);
		map2.set('b', 2);
		map2.set('c', 3);
		capSessionMap(map2, 2);
		expect(map2.size).toBe(2);
	});
});
