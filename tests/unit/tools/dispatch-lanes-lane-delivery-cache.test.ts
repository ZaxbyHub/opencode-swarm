import { beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	hasLaneOutputBeenDelivered,
	LANE_DELIVERY_CACHE_FILENAME,
	MAX_DELIVERED_LANE_OUTPUT_KEYS,
	markLaneOutputDelivered,
	resetLaneDeliveryStoreForTests,
} from '../../../src/background/lane-delivery-store';
import { _test_exports } from '../../../src/tools/dispatch-lanes';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tmp: string;

beforeEach(() => {
	resetLaneDeliveryStoreForTests();
	tmp = canonicalMkdtemp('lane-delivery-cache-');
});

function cacheFile(directory: string = tmp): string {
	return path.join(directory, '.swarm', LANE_DELIVERY_CACHE_FILENAME);
}

function readCache(directory: string = tmp): string {
	return fs.readFileSync(cacheFile(directory), 'utf-8');
}

describe('lane-delivery cache — persistence (issue #1988 C7)', () => {
	test('mark persists and a fresh store instance round-trips from disk', () => {
		markLaneOutputDelivered(tmp, 'session-1', 'batch\0lane\0digest');
		expect(fs.existsSync(cacheFile())).toBe(true);
		// Simulate a plugin restart: in-memory state gone, disk state loads.
		resetLaneDeliveryStoreForTests();
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-1', 'batch\0lane\0digest'),
		).toBe(true);
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-1', 'batch\0lane\0other'),
		).toBe(false);
	});

	test('keys are session-scoped: another session is not suppressed', () => {
		markLaneOutputDelivered(tmp, 'session-1', 'batch\0lane\0digest');
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-2', 'batch\0lane\0digest'),
		).toBe(false);
		markLaneOutputDelivered(tmp, 'session-2', 'batch\0lane\0digest');
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-2', 'batch\0lane\0digest'),
		).toBe(true);
	});

	test('directories are isolated buckets', () => {
		const other = canonicalMkdtemp('lane-delivery-other-');
		try {
			markLaneOutputDelivered(tmp, 'session-1', 'batch\0lane\0digest');
			expect(
				hasLaneOutputBeenDelivered(other, 'session-1', 'batch\0lane\0digest'),
			).toBe(false);
		} finally {
			fs.rmSync(other, { recursive: true, force: true });
		}
	});
});

describe('lane-delivery cache — bound enforcement', () => {
	test('global 1024-key ceiling evicts the oldest key FIFO within a session', () => {
		for (let i = 0; i <= MAX_DELIVERED_LANE_OUTPUT_KEYS; i++) {
			markLaneOutputDelivered(tmp, 'session-1', `batch\0lane\0digest-${i}`);
		}
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-1', 'batch\0lane\0digest-0'),
		).toBe(false);
		expect(
			hasLaneOutputBeenDelivered(
				tmp,
				'session-1',
				`batch\0lane\0digest-${MAX_DELIVERED_LANE_OUTPUT_KEYS}`,
			),
		).toBe(true);
	});

	test('other sessions are pruned FIFO first when the global ceiling is hit', () => {
		// Oldest session's keys go before the current session's newest keys.
		markLaneOutputDelivered(tmp, 'session-old', 'batch\0lane\0oldest');
		for (let i = 0; i < MAX_DELIVERED_LANE_OUTPUT_KEYS; i++) {
			markLaneOutputDelivered(tmp, 'session-new', `batch\0lane\0digest-${i}`);
		}
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-old', 'batch\0lane\0oldest'),
		).toBe(false);
		expect(
			hasLaneOutputBeenDelivered(
				tmp,
				'session-new',
				`batch\0lane\0digest-${MAX_DELIVERED_LANE_OUTPUT_KEYS - 1}`,
			),
		).toBe(true);
	});

	test('17th tracked session evicts the oldest session entirely', () => {
		for (let i = 0; i < 16; i++) {
			markLaneOutputDelivered(tmp, `session-${i}`, `batch\0lane\0digest-${i}`);
		}
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-0', 'batch\0lane\0digest-0'),
		).toBe(true);
		markLaneOutputDelivered(tmp, 'session-16', 'batch\0lane\0digest-16');
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-0', 'batch\0lane\0digest-0'),
		).toBe(false);
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-1', 'batch\0lane\0digest-1'),
		).toBe(true);
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-16', 'batch\0lane\0digest-16'),
		).toBe(true);
	});
});

describe('lane-delivery cache — fail-open behavior', () => {
	test('corrupt cache file is renamed and the store starts empty', () => {
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
		fs.writeFileSync(cacheFile(), '{ not valid json');
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-1', 'batch\0lane\0digest'),
		).toBe(false);
		expect(fs.existsSync(`${cacheFile()}.corrupt`)).toBe(true);
		expect(fs.existsSync(cacheFile())).toBe(false);
	});

	test('first mark after corruption heals the file', () => {
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
		fs.writeFileSync(cacheFile(), 'null');
		markLaneOutputDelivered(tmp, 'session-1', 'batch\0lane\0digest');
		expect(fs.existsSync(cacheFile())).toBe(true);
		expect(() => readCache()).not.toThrow();
		resetLaneDeliveryStoreForTests();
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-1', 'batch\0lane\0digest'),
		).toBe(true);
	});

	test('version-mismatched cache file is treated as unusable', () => {
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
		fs.writeFileSync(
			cacheFile(),
			JSON.stringify({ version: 2, order: [], sessions: {} }),
		);
		expect(
			hasLaneOutputBeenDelivered(tmp, 'session-1', 'batch\0lane\0digest'),
		).toBe(false);
	});

	test('undefined directory stays memory-only (direct test-seam path)', () => {
		markLaneOutputDelivered(undefined, 'session-1', 'batch\0lane\0digest');
		expect(
			hasLaneOutputBeenDelivered(undefined, 'session-1', 'batch\0lane\0digest'),
		).toBe(true);
		resetLaneDeliveryStoreForTests();
		expect(
			hasLaneOutputBeenDelivered(undefined, 'session-1', 'batch\0lane\0digest'),
		).toBe(false);
		expect(fs.existsSync(cacheFile())).toBe(false);
	});
});

describe('recordToLaneResult — delivery store integration', () => {
	function makeRecord(): Parameters<
		typeof _test_exports.recordToLaneResult
	>[0] {
		return {
			correlationId: 'corr-1',
			laneId: 'lane-1',
			status: 'completed',
			swarmPrefixedAgent: 'swarm_explorer',
			normalizedAgent: 'explorer',
			subagentSessionId: 'sub-1',
			createdAt: '2026-08-15T00:00:00.000Z',
			completedAt: '2026-08-15T00:00:01.000Z',
			updatedAt: '2026-08-15T00:00:02.000Z',
			result: {
				text: 'lane output body',
				digest: 'digest-abc',
				outputRef: 'L1:aaaa:bbbb:cccc',
			},
		} as unknown as Parameters<typeof _test_exports.recordToLaneResult>[0];
	}

	test('second delivery in the same session is suppressed; disk survives restart', () => {
		const first = _test_exports.recordToLaneResult(makeRecord(), 'batch-1', {
			directory: tmp,
			sessionID: 'session-1',
		});
		expect(first.output).toBe('lane output body');

		const second = _test_exports.recordToLaneResult(makeRecord(), 'batch-1', {
			directory: tmp,
			sessionID: 'session-1',
		});
		expect(second.output).toBeUndefined();
		expect(second.output_omitted_repeat).toBe(true);

		// Restart: in-memory state gone, persisted state still suppresses.
		resetLaneDeliveryStoreForTests();
		const third = _test_exports.recordToLaneResult(makeRecord(), 'batch-1', {
			directory: tmp,
			sessionID: 'session-1',
		});
		expect(third.output_omitted_repeat).toBe(true);
	});

	test("another session is never suppressed by this session's delivery", () => {
		_test_exports.recordToLaneResult(makeRecord(), 'batch-1', {
			directory: tmp,
			sessionID: 'session-1',
		});
		const other = _test_exports.recordToLaneResult(makeRecord(), 'batch-1', {
			directory: tmp,
			sessionID: 'session-2',
		});
		expect(other.output).toBe('lane output body');
		expect(other.output_omitted_repeat).toBeUndefined();
	});
});
