import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	buildLaneOutputPreview,
	MAX_LANE_OUTPUT_STORED_BYTES,
	readLaneOutput,
	storeLaneOutput,
} from '../../../src/background/lane-output-store';

function makeTempDir(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'lane-output-store-')),
	);
}

describe('lane-output-store', () => {
	test('stores output under hashed .swarm lane-results path and reads by opaque ref', () => {
		const directory = makeTempDir();
		const stored = storeLaneOutput(directory, {
			batchId: 'batch:with:windows-unsafe-chars',
			laneId: '../lane',
			agent: 'mega_explorer',
			role: 'explorer',
			sessionId: 'session-1',
			source: 'collect_lane_results',
			text: 'full lane output',
		});

		expect(stored.degraded).toBe(false);
		expect(stored.ref).toMatch(/^L1:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/);
		const artifact = readLaneOutput(directory, stored.ref!)?.artifact;
		expect(artifact?.text).toBe('full lane output');
		expect(artifact?.batchId).toBe('batch:with:windows-unsafe-chars');
		expect(artifact?.laneId).toBe('../lane');

		const files = fs.readdirSync(
			path.join(directory, '.swarm', 'lane-results'),
		);
		expect(files[0]).toMatch(/^[a-f0-9]{64}$/);
	});

	test('idempotently returns the same ref for repeated identical output', () => {
		const directory = makeTempDir();
		const first = storeLaneOutput(directory, {
			batchId: 'batch',
			laneId: 'lane',
			agent: 'explorer',
			role: 'explorer',
			source: 'dispatch_lanes',
			text: 'same output',
		});
		const second = storeLaneOutput(directory, {
			batchId: 'batch',
			laneId: 'lane',
			agent: 'explorer',
			role: 'explorer',
			source: 'dispatch_lanes',
			text: 'same output',
		});

		expect(second).toEqual(first);
	});

	test('returns degraded metadata instead of writing oversized artifacts', () => {
		const directory = makeTempDir();
		const stored = storeLaneOutput(directory, {
			batchId: 'batch',
			laneId: 'lane',
			agent: 'explorer',
			role: 'explorer',
			source: 'dispatch_lanes',
			text: 'x'.repeat(MAX_LANE_OUTPUT_STORED_BYTES + 1),
		});

		expect(stored.degraded).toBe(true);
		expect(stored.ref).toBeUndefined();
		expect(stored.error).toContain('storage limit');
		expect(fs.existsSync(path.join(directory, '.swarm', 'lane-results'))).toBe(
			false,
		);
	});

	test('builds head and tail preview with retrieval hint', () => {
		const preview = buildLaneOutputPreview({
			text: `head-${'x'.repeat(400)}-tail`,
			ref:
				'L1:a'.replace('a', 'a'.repeat(64)) +
				`:${'b'.repeat(64)}:${'c'.repeat(64)}`,
			maxChars: 300,
		});

		expect(preview.output_truncated).toBe(true);
		expect(preview.output.startsWith('hea')).toBe(true);
		expect(preview.output.endsWith('il')).toBe(true);
		expect(preview.output).toContain('retrieve_lane_output ref=');
	});
});
