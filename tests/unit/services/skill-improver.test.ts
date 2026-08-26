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
import type { SkillImproverLLMDelegate } from '../../../src/hooks/skill-improver-llm-factory';
import { withWriteAuthority } from '../../../src/security/write-authority';
import { runSkillImprover } from '../../../src/services/skill-improver';
import {
	getQuotaState,
	reserveQuota,
	resolveQuotaPath,
} from '../../../src/services/skill-improver-quota';
import { type AgentSessionState, swarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { freezeClock, type Restore } from '../../helpers/test-clock';

let tmp: string;
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;
let restoreClock: Restore;
beforeEach(() => {
	// Clear any module mocks leaked by prior test files (mock.module isolation
	// is unreliable in Bun --smol; this is best-effort cleanup per the
	// writing-tests skill rule #3).
	mock.restore();
	restoreClock = freezeClock({
		fixedNow: Date.UTC(2026, 7, 26, 12),
		isoNow: '2026-08-26T12:00:00.000Z',
	});
	isolatedEnv = createIsolatedTestEnv();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-skill-improve-'));
});
afterEach(() => {
	try {
		rmSync(tmp, { recursive: true, force: true });
	} finally {
		restoreClock();
		isolatedEnv.cleanup();
		mock.restore();
	}
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
	require_user_approval: false,
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

	it('keeps knowledge enrichment quota state separate from skill_improver', async () => {
		await reserveQuota(tmp, { nCalls: 1, maxCalls: 2, window: 'utc' });
		await reserveQuota(tmp, {
			nCalls: 2,
			maxCalls: 3,
			window: 'utc',
			scope: 'knowledge-enrichment',
		});

		const skillState = await getQuotaState(tmp, {
			maxCalls: 2,
			window: 'utc',
		});
		const enrichmentState = await getQuotaState(tmp, {
			maxCalls: 3,
			window: 'utc',
			scope: 'knowledge-enrichment',
		});

		expect(skillState.calls_used).toBe(1);
		expect(enrichmentState.calls_used).toBe(2);
		expect(resolveQuotaPath(tmp)).not.toBe(
			resolveQuotaPath(tmp, 'knowledge-enrichment'),
		);
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

	it('fails closed when require_user_approval is enabled without a matching authority context', async () => {
		const r = await runSkillImprover({
			directory: tmp,
			config: { ...baseConfig, require_user_approval: true },
			sessionId: 'sess-approval-1',
		});
		expect(r.ran).toBe(false);
		expect(r.reason).toContain('requires an exact human write approval');
		expect(r.approvalRequired?.request?.action).toBe('skill_improve');
		expect(r.approvalRequired?.candidateContent).toContain(
			'# Skill Improvement Proposal',
		);
		expect(r.approvalRequired?.allowedPaths).toHaveLength(1);
		expect(r.approvalRequired?.request?.allowedPathDigest).toBeDefined();
		expect(r.quota.calls_used).toBe(1);
		expect(existsSync(path.join(tmp, '.swarm', 'skill-improver'))).toBe(false);
	});

	it('binds approval-gated draft_skills runs to an exact write manifest', async () => {
		const dir = path.join(tmp, '.swarm');
		await mkdir(dir, { recursive: true });
		const entry: SwarmKnowledgeEntry = {
			id: '33333333-3333-4333-9333-333333333333',
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
			directive_priority: 'high',
		};
		await writeFile(
			resolveSwarmKnowledgePath(tmp),
			`${JSON.stringify(entry)}\n`,
			'utf-8',
		);
		const r = await runSkillImprover({
			directory: tmp,
			config: {
				...baseConfig,
				require_user_approval: true,
				write_mode: 'draft_skills',
			},
			mode: 'draft_skills',
			sessionId: 'sess-approval-draft',
		});
		expect(r.ran).toBe(false);
		const candidateContent = r.approvalRequired?.candidateContent;
		expect(candidateContent).toBeDefined();
		const manifest = JSON.parse(candidateContent ?? '{}');
		expect(manifest.kind).toBe('skill_improver_write_manifest');
		expect(manifest.proposalContent).toContain('# Skill Improvement Proposal');
		expect(manifest.drafts).toHaveLength(1);
		expect(manifest.drafts[0].content).toContain('always declare scope');
		expect(r.approvalRequired?.allowedPaths).toContain(manifest.drafts[0].path);
		expect(existsSync(path.join(tmp, '.swarm', 'skills', 'proposals'))).toBe(
			false,
		);
		const request = r.approvalRequired?.request;
		if (!candidateContent || !request) {
			throw new Error('expected exact draft approval manifest');
		}
		const fact = {
			v: 1 as const,
			id: 'waf_draft_test',
			issuingSessionId: 'sess-human',
			issuedByCommand: 'approve-write' as const,
			issuedAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 30_000).toISOString(),
			...request,
		};
		const applied = await withWriteAuthority(
			{ origin: 'human_approved', fact },
			() =>
				runSkillImprover({
					directory: tmp,
					config: {
						...baseConfig,
						require_user_approval: true,
						write_mode: 'draft_skills',
					},
					mode: 'draft_skills',
					sessionId: 'sess-approval-draft',
					approvedCandidateContent: candidateContent,
				}),
		);
		expect(applied.ran).toBe(true);
		const approvedDraftPath = path.resolve(tmp, manifest.drafts[0].path);
		expect(readFileSync(approvedDraftPath, 'utf-8')).toBe(
			manifest.drafts[0].content,
		);
	});

	it('writes the exact approved candidate content without rerunning the delegate output', async () => {
		const firstDelegate: SkillImproverLLMDelegate = async () =>
			'## Concrete recommendations\n- first candidate';
		const first = await runSkillImprover({
			directory: tmp,
			config: { ...baseConfig, require_user_approval: true },
			sessionId: 'sess-approval-2',
			delegate: firstDelegate,
			now: new Date('2026-08-26T12:00:00.000Z'),
		});
		expect(first.ran).toBe(false);
		const approvedCandidateContent = first.approvalRequired?.candidateContent;
		const approvalRequest = first.approvalRequired?.request;
		if (!approvedCandidateContent || !approvalRequest) {
			throw new Error(
				'expected approval challenge with exact candidate content',
			);
		}
		const fact = {
			v: 1 as const,
			id: 'waf_test',
			issuingSessionId: 'sess-human',
			issuedByCommand: 'approve-write' as const,
			issuedAt: '2026-08-26T12:00:00.000Z',
			expiresAt: '2026-08-26T12:30:00.000Z',
			...approvalRequest,
		};
		const changedDelegate: SkillImproverLLMDelegate = async () =>
			'## Concrete recommendations\n- second candidate that must not be written';
		const result = await withWriteAuthority(
			{ origin: 'human_approved', fact },
			() =>
				runSkillImprover({
					directory: tmp,
					config: { ...baseConfig, require_user_approval: true },
					sessionId: 'sess-approval-2',
					approvedCandidateContent,
					delegate: changedDelegate,
					now: new Date('2026-08-26T12:05:00.000Z'),
				}),
		);
		expect(result.ran).toBe(true);
		expect(existsSync(result.proposalPath!)).toBe(true);
		const persisted = readFileSync(result.proposalPath!, 'utf-8');
		expect(persisted).toBe(approvedCandidateContent);
		expect(persisted).toContain('first candidate');
		expect(persisted).not.toContain('second candidate');
		const quota = await getQuotaState(tmp, {
			maxCalls: baseConfig.max_calls_per_day,
			window: baseConfig.quota_window,
		});
		expect(quota.calls_used).toBe(1);
	});

	it('writes a proposal under .swarm/skill-improver/proposals/', async () => {
		const r = await runSkillImprover({
			directory: tmp,
			config: baseConfig,
		});
		expect(r.ran).toBe(true);
		expect(r.proposalPath?.replace(/\\/g, '/')).toContain(
			'.swarm/skill-improver/proposals/',
		);
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
				applied_explicit_count: 1,
				succeeded_after_shown_count: 1,
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
			directive_priority: 'high',
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

describe('runSkillImprover auto-apply full-auto gate (#1234 Part 3D)', () => {
	const sessionId = 'sess-autoapply-1';

	afterEach(() => {
		swarmState.agentSessions.delete(sessionId);
	});

	function fullAutoSession(): AgentSessionState {
		// hasActiveFullAuto only reads `fullAutoMode`; a minimal cast keeps the
		// fixture focused on the gate under test.
		return { fullAutoMode: true } as unknown as AgentSessionState;
	}

	// A delegate is required for auto-apply to run (it is the critic gate). It
	// also drives main proposal-body generation, so it must return a string.
	const delegate: SkillImproverLLMDelegate = async () => 'proposal body';

	it('does NOT auto-apply when the session is not in full-auto', async () => {
		const r = await runSkillImprover({
			directory: tmp,
			config: baseConfig,
			delegate,
			sessionId,
		});
		expect(r.ran).toBe(true);
		expect(r.autoApply).toBeUndefined();
	});

	it('does NOT auto-apply when no sessionId is provided (cross-session leak guard)', async () => {
		// Make some OTHER session full-auto; a request without a sessionId must
		// not inherit it via hasActiveFullAuto's global scan.
		swarmState.agentSessions.set(sessionId, fullAutoSession());
		const r = await runSkillImprover({
			directory: tmp,
			config: baseConfig,
			delegate,
			// sessionId intentionally omitted
		});
		expect(r.ran).toBe(true);
		expect(r.autoApply).toBeUndefined();
	});

	it('auto-applies when THIS session is in full-auto', async () => {
		swarmState.agentSessions.set(sessionId, fullAutoSession());
		const r = await runSkillImprover({
			directory: tmp,
			config: baseConfig,
			delegate,
			sessionId,
		});
		expect(r.ran).toBe(true);
		expect(r.autoApply).toBeDefined();
		// No proposals seeded → empty result object, but defined (gate open).
		expect(r.autoApply?.approved).toEqual([]);
	});

	it('does NOT auto-apply when allowAutoApply=false even in full-auto', async () => {
		swarmState.agentSessions.set(sessionId, fullAutoSession());
		const r = await runSkillImprover({
			directory: tmp,
			config: baseConfig,
			delegate,
			sessionId,
			allowAutoApply: false,
		});
		expect(r.ran).toBe(true);
		expect(r.autoApply).toBeUndefined();
	});
});
