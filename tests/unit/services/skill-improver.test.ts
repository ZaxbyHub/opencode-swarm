/**
 * Tests for the low-frequency skill_improver service + quota.
 * Closes issue #629.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { runSkillImprover } from '../../../src/services/skill-improver';
import {
	getQuotaState,
	reserveQuota,
	resolveQuotaPath,
} from '../../../src/services/skill-improver-quota';

let tmp: string;
beforeEach(() => {
	// Clear any module mocks leaked by prior test files (mock.module isolation
	// is unreliable in Bun --smol; this is best-effort cleanup per the
	// writing-tests skill rule #3).
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-skill-improve-'));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

const baseConfig = {
	enabled: true,
	model: 'opencode/big-pickle',
	fallback_models: [] as string[],
	max_calls_per_day: 3,
	trigger: 'manual' as const,
	targets: ['skills', 'spec', 'architect_prompt', 'knowledge'] as Array<
		'skills' | 'spec' | 'architect_prompt' | 'knowledge'
	>,
	write_mode: 'proposal' as const,
	require_user_approval: true,
	quota_window: 'utc' as const,
	allow_deterministic_fallback: true,
};

describe('skill_improver quota tracking', () => {
	it('rolls over date and starts at 0 calls_used', async () => {
		const state = await getQuotaState(tmp, {
			maxCalls: 10,
			window: 'utc',
		});
		expect(state.calls_used).toBe(0);
		expect(state.max_calls).toBe(10);
		expect(state.window).toBe('utc');
		expect(existsSync(resolveQuotaPath(tmp))).toBe(true);
	});

	it('reserveQuota allows within limit', async () => {
		const r = await reserveQuota(tmp, {
			nCalls: 2,
			maxCalls: 5,
			window: 'utc',
		});
		expect(r.allowed).toBe(true);
		expect(r.state.calls_used).toBe(2);
	});

	it('reserveQuota blocks once limit reached', async () => {
		await reserveQuota(tmp, { nCalls: 5, maxCalls: 5, window: 'utc' });
		const r = await reserveQuota(tmp, {
			nCalls: 1,
			maxCalls: 5,
			window: 'utc',
		});
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain('quota');
	});
});

describe('runSkillImprover', () => {
	it('refuses when disabled', async () => {
		const r = await runSkillImprover({
			directory: tmp,
			config: { ...baseConfig, enabled: false },
		});
		expect(r.ran).toBe(false);
		expect(r.reason).toContain('enabled');
	});

	it('writes a proposal under .swarm/skill-improver/proposals/', async () => {
		const r = await runSkillImprover({
			directory: tmp,
			config: baseConfig,
		});
		expect(r.ran).toBe(true);
		expect(r.proposalPath).toContain('.swarm/skill-improver/proposals/');
		expect(existsSync(r.proposalPath!)).toBe(true);
		const body = readFileSync(r.proposalPath!, 'utf-8');
		expect(body).toContain('# Skill Improvement Proposal');
		// With no client wired and fallback enabled, source must be tagged.
		expect(body).toContain('source: deterministic_fallback');
		expect(r.source).toBe('deterministic_fallback');
	});

	it('decrements quota on each run and blocks past limit', async () => {
		const cfg = { ...baseConfig, max_calls_per_day: 2 };
		const r1 = await runSkillImprover({ directory: tmp, config: cfg });
		expect(r1.ran).toBe(true);
		const r2 = await runSkillImprover({ directory: tmp, config: cfg });
		expect(r2.ran).toBe(true);
		const r3 = await runSkillImprover({ directory: tmp, config: cfg });
		expect(r3.ran).toBe(false);
		expect(r3.reason).toContain('quota');
	});

	it('default mode does NOT mutate source files', async () => {
		// Seed knowledge that would otherwise be picked up
		const dir = path.join(tmp, '.swarm');
		await mkdir(dir, { recursive: true });
		const e: SwarmKnowledgeEntry = {
			id: '11111111-1111-4111-9111-111111111111',
			tier: 'swarm',
			lesson: 'always declare scope before coder delegation',
			category: 'process',
			tags: ['scope'],
			scope: 'global',
			confidence: 0.95,
			status: 'established',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 2,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			project_name: 'test',
		};
		await writeFile(
			resolveSwarmKnowledgePath(tmp),
			JSON.stringify(e) + '\n',
			'utf-8',
		);
		const r = await runSkillImprover({
			directory: tmp,
			config: { ...baseConfig, write_mode: 'proposal' },
		});
		expect(r.ran).toBe(true);
		expect(r.draftSkillsWritten).toBeUndefined();
		// No skills/proposals/ written either when write_mode='proposal'
		expect(existsSync(path.join(tmp, '.swarm', 'skills', 'proposals'))).toBe(
			false,
		);
	});

	it('draft_skills mode emits cluster proposals when mature candidates exist', async () => {
		const dir = path.join(tmp, '.swarm');
		await mkdir(dir, { recursive: true });
		const e: SwarmKnowledgeEntry = {
			id: '22222222-2222-4222-9222-222222222222',
			tier: 'swarm',
			lesson: 'always declare scope before coder delegation',
			category: 'process',
			tags: ['scope'],
			scope: 'global',
			confidence: 0.95,
			status: 'established',
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: new Date().toISOString(),
					project_name: 't',
				},
				{
					phase_number: 2,
					confirmed_at: new Date().toISOString(),
					project_name: 't',
				},
			],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 2,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			project_name: 't',
			triggers: ['coder delegation'],
			required_actions: ['call declare_scope'],
		};
		await writeFile(
			resolveSwarmKnowledgePath(tmp),
			JSON.stringify(e) + '\n',
			'utf-8',
		);
		const r = await runSkillImprover({
			directory: tmp,
			config: { ...baseConfig, write_mode: 'draft_skills' },
			mode: 'draft_skills',
		});
		expect(r.ran).toBe(true);
		expect(existsSync(path.join(tmp, '.swarm', 'skills', 'proposals'))).toBe(
			true,
		);
	});
});
