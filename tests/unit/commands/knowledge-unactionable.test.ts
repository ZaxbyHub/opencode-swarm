/**
 * Tests for /swarm knowledge unactionable and /swarm knowledge retry-hardening
 * (#1234 Part 3A).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	handleKnowledgeRetryHardeningCommand,
	handleKnowledgeUnactionableCommand,
} from '../../../src/commands/knowledge.js';

function makeUnactionable(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		tier: 'swarm',
		lesson: `Lesson for ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.3,
		status: 'quarantined_unactionable',
		confirmed_by: [],
		project_name: 'test',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		unactionable_reason: 'Missing required scope fields',
		quarantined_at: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('handleKnowledgeUnactionableCommand', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-unact-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('returns empty message when queue file does not exist', async () => {
		const result = await handleKnowledgeUnactionableCommand(dir, []);
		expect(result).toContain('No unactionable entries');
	});

	it('returns empty message when queue is empty', async () => {
		const queuePath = path.join(dir, '.swarm', 'knowledge-unactionable.jsonl');
		fs.writeFileSync(queuePath, '', 'utf-8');
		const result = await handleKnowledgeUnactionableCommand(dir, []);
		expect(result).toContain('No unactionable entries');
	});

	it('lists unactionable entries', async () => {
		const entries = [
			makeUnactionable('UA-001'),
			makeUnactionable('UA-002', { retire_candidate: true }),
		];
		const queuePath = path.join(dir, '.swarm', 'knowledge-unactionable.jsonl');
		fs.writeFileSync(
			queuePath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
			'utf-8',
		);

		const result = await handleKnowledgeUnactionableCommand(dir, []);
		expect(result).toContain('UA-001');
		expect(result).toContain('UA-002');
	});
});

describe('handleKnowledgeRetryHardeningCommand', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-retry-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reports no entries when queue is empty', async () => {
		const result = await handleKnowledgeRetryHardeningCommand(dir, []);
		expect(result).toContain('No retire candidates');
	});

	it('resets retire_candidate flags', async () => {
		const entries = [
			makeUnactionable('UA-R1', { retire_candidate: true }),
			makeUnactionable('UA-R2', { retire_candidate: true }),
			makeUnactionable('UA-R3'),
		];
		const queuePath = path.join(dir, '.swarm', 'knowledge-unactionable.jsonl');
		fs.writeFileSync(
			queuePath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
			'utf-8',
		);

		const result = await handleKnowledgeRetryHardeningCommand(dir, []);
		expect(result).toContain('2');

		const after = fs
			.readFileSync(queuePath, 'utf-8')
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const retireCandidates = after.filter(
			(e: Record<string, unknown>) => e.retire_candidate === true,
		);
		expect(retireCandidates).toHaveLength(0);
	});
});
