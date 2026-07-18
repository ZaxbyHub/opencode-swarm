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

function artifactPathFromRef(directory: string, ref: string): string {
	const [, batchDigest, laneDigest, outputDigest] = ref.split(':');
	return path.join(
		directory,
		'.swarm',
		'lane-results',
		batchDigest,
		laneDigest,
		`${outputDigest}.json`,
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

	test('fails closed when one content ref collides across incompatible provenance', () => {
		const directory = makeTempDir();
		const first = storeLaneOutput(directory, {
			batchId: 'batch',
			laneId: 'lane',
			agent: 'reviewer',
			role: 'reviewer',
			sessionId: 'review-session',
			parentSessionId: 'parent',
			mode: 'swarm-pr-review:reviewer',
			workflowLane: 'review-a',
			prHeadSha: 'head-a',
			gitHead: 'head-a',
			revisionDigest: 'revision-a',
			source: 'collect_lane_results',
			text: 'same output',
		});
		const collision = storeLaneOutput(directory, {
			batchId: 'batch',
			laneId: 'lane',
			agent: 'reviewer',
			role: 'reviewer',
			sessionId: 'review-session',
			parentSessionId: 'parent',
			mode: 'swarm-pr-review:reviewer',
			workflowLane: 'review-b',
			prHeadSha: 'head-b',
			gitHead: 'head-b',
			revisionDigest: 'revision-b',
			source: 'collect_lane_results',
			text: 'same output',
		});

		expect(first.degraded).toBe(false);
		expect(collision.degraded).toBe(true);
		expect(collision.ref).toBeUndefined();
		expect(collision.error).toContain('incompatible agent/session provenance');
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

	test('rejects tampered artifacts whose integrity fields no longer match the text or ref binding', () => {
		const directory = makeTempDir();
		const stored = storeLaneOutput(directory, {
			batchId: 'batch',
			laneId: 'lane',
			agent: 'explorer',
			role: 'explorer',
			source: 'dispatch_lanes',
			text: 'full lane output',
		});
		const artifactPath = artifactPathFromRef(directory, stored.ref!);
		const originalArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));

		const tamperCases: Array<{
			name: string;
			mutate: (artifact: typeof originalArtifact) => typeof originalArtifact;
		}> = [
			{
				name: 'digest',
				mutate: (artifact) => ({ ...artifact, digest: '0'.repeat(64) }),
			},
			{
				name: 'chars',
				mutate: (artifact) => ({ ...artifact, chars: artifact.chars + 1 }),
			},
			{
				name: 'bytes',
				mutate: (artifact) => ({ ...artifact, bytes: artifact.bytes + 1 }),
			},
			{
				name: 'batch ref binding',
				mutate: (artifact) => ({ ...artifact, batchId: 'other-batch' }),
			},
			{
				name: 'lane ref binding',
				mutate: (artifact) => ({ ...artifact, laneId: 'other-lane' }),
			},
		];

		for (const tamperCase of tamperCases) {
			fs.writeFileSync(
				artifactPath,
				JSON.stringify(tamperCase.mutate(originalArtifact), null, 2),
				'utf-8',
			);
			expect(readLaneOutput(directory, stored.ref!)).toBeNull();
		}
	});
});
