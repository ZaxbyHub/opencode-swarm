import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MemoryGateway } from '../../../src/memory';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = canonicalMkdtemp('swarm-related-gateway-');
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('merge proposal identity', () => {
	test('canonicalizes participants and avoids same-clock set collisions', async () => {
		const gateway = new MemoryGateway(
			{ directory: tmpDir, agentRole: 'curator' },
			{
				config: { enabled: true, provider: 'local-jsonl' },
				now: () => new Date('2026-09-01T00:00:00.000Z'),
			},
		);
		const a = 'mem_1111111111111111';
		const b = 'mem_2222222222222222';
		const c = 'mem_3333333333333333';
		const first = await gateway.propose({
			operation: 'merge',
			relatedMemoryIds: [b, a],
			rationale: 'First set.',
		});
		const reordered = await gateway.propose({
			operation: 'merge',
			relatedMemoryIds: [a, b],
			rationale: 'Equivalent set.',
		});
		const different = await gateway.propose({
			operation: 'merge',
			relatedMemoryIds: [a, c],
			rationale: 'Different set.',
		});

		expect(first.relatedMemoryIds).toEqual([a, b]);
		expect(reordered.id).toBe(first.id);
		expect(different.id).not.toBe(first.id);
		await gateway.dispose();
	});

	test('rejects duplicate-only participants', async () => {
		const gateway = new MemoryGateway(
			{ directory: tmpDir, agentRole: 'curator' },
			{ config: { enabled: true, provider: 'local-jsonl' } },
		);
		await expect(
			gateway.propose({
				operation: 'merge',
				relatedMemoryIds: ['mem_1111111111111111', 'mem_1111111111111111'],
				rationale: 'Invalid duplicate set.',
			}),
		).rejects.toThrow('2-8 distinct relatedMemoryIds');
		await gateway.dispose();
	});
});
