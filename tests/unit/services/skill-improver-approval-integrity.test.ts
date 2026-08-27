import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { issueWriteApprovalFact } from '../../../src/security/write-authority';
import {
	buildSkillImproverApprovalRequest,
	type PreparedSkillImproverApprovalCandidate,
	runSkillImprover,
	writeApprovedSkillImproverCandidate,
} from '../../../src/services/skill-improver';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { freezeClock, type Restore } from '../../helpers/test-clock';

let tmp: string;
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;
let restoreClock: Restore;

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

beforeEach(() => {
	mock.restore();
	restoreClock = freezeClock({
		fixedNow: Date.UTC(2026, 7, 26, 12),
		isoNow: '2026-08-26T12:00:00.000Z',
	});
	isolatedEnv = createIsolatedTestEnv();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-skill-improve-approval-'));
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

describe('skill_improver approval integrity', () => {
	it('FB-002 rejects absolute approved paths during manifest preparation', async () => {
		const candidateContent = JSON.stringify(
			{
				kind: 'skill_improver_write_manifest',
				version: 1,
				writeMode: 'draft_skills',
				source: 'llm',
				proposalContent: '# Skill Improvement Proposal\n',
				drafts: [
					{
						slug: 'escape',
						path: '/tmp/escape/SKILL.md',
						content: 'bad',
						sourceKnowledgeIds: [],
					},
				],
				draftSourceStamps: [],
			},
			null,
			2,
		);
		const result = await runSkillImprover({
			directory: tmp,
			config: {
				...baseConfig,
				require_user_approval: true,
				write_mode: 'draft_skills',
			},
			mode: 'draft_skills',
			sessionId: 'sess-fb-002',
			approvedCandidateContent: candidateContent,
		});
		expect(result.ran).toBe(false);
		expect(result.reason).toContain('approved path rejected');
		expect(result.reason).toContain('/tmp/escape/SKILL.md');
	});

	it('FB-007 consumes an approved candidate exactly once after a successful write', async () => {
		const first = await runSkillImprover({
			directory: tmp,
			config: { ...baseConfig, require_user_approval: true },
			sessionId: 'sess-fb-007',
		});
		const approvedCandidateContent = first.approvalRequired?.candidateContent;
		const approvalRequest = first.approvalRequired?.request;
		if (!approvedCandidateContent || !approvalRequest) {
			throw new Error('expected approval challenge');
		}
		await issueWriteApprovalFact({
			directory: tmp,
			request: approvalRequest,
			issuingSessionId: 'sess-human',
		});
		const applied = await runSkillImprover({
			directory: tmp,
			config: { ...baseConfig, require_user_approval: true },
			sessionId: 'sess-fb-007',
			approvedCandidateContent,
		});
		expect(applied.ran).toBe(true);
		const replay = await runSkillImprover({
			directory: tmp,
			config: { ...baseConfig, require_user_approval: true },
			sessionId: 'sess-fb-007',
			approvedCandidateContent,
		});
		expect(replay.ran).toBe(false);
		expect(replay.reason).toContain('exact human write approval');
	});

	it('FB-003 rejects traversal paths at the approved write sink', async () => {
		const request = buildSkillImproverApprovalRequest({
			sessionId: 'sess-fb-003',
			candidateContent: 'candidate',
			allowedPaths: [
				'.swarm/skill-improver/proposals/demo.md',
				'.swarm/knowledge.jsonl',
			],
		});
		if (!request) {
			throw new Error('expected approval request');
		}
		await issueWriteApprovalFact({
			directory: tmp,
			request,
			issuingSessionId: 'sess-human',
		});
		const prepared: PreparedSkillImproverApprovalCandidate = {
			directory: tmp,
			sessionId: 'sess-fb-003',
			now: new Date('2026-08-26T12:00:00.000Z'),
			source: 'llm',
			proposalPath: path.join(
				tmp,
				'.swarm',
				'skill-improver',
				'proposals',
				'demo.md',
			),
			proposalContent: '# ok\n',
			allowedPaths: [
				'.swarm/skill-improver/proposals/demo.md',
				'.swarm/knowledge.jsonl',
			],
			candidateContent: 'candidate',
			draftWrites: [
				{
					slug: 'escape',
					path: '../escape/SKILL.md',
					content: 'bad',
					sourceKnowledgeIds: [],
				},
			],
			draftSourceStamps: [],
			request,
			quota: { date: '2026-08-26', calls_used: 1, max_calls: 3 },
			quotaWindow: 'utc',
			maxCalls: 0,
			maxCallsPerDay: 3,
			released: true,
		};
		const result = await writeApprovedSkillImproverCandidate(prepared);
		expect(result.ran).toBe(false);
		expect(result.reason).toContain('approved path rejected');
		expect(result.reason).toContain('../escape/SKILL.md');
	});

	it('FB-010 FB-027 rolls back prior writes when source stamp application goes stale', async () => {
		const knowledgePath = resolveSwarmKnowledgePath(tmp);
		const knowledgeEntry: SwarmKnowledgeEntry = {
			id: '11111111-1111-4111-8111-111111111111',
			tier: 'swarm',
			lesson: 'test lesson',
			category: 'process',
			tags: ['approval'],
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
			project_name: 't',
		};
		await mkdir(path.dirname(knowledgePath), { recursive: true });
		await writeFile(
			knowledgePath,
			`${JSON.stringify(knowledgeEntry)}\n`,
			'utf8',
		);
		const request = buildSkillImproverApprovalRequest({
			sessionId: 'sess-fb-010',
			candidateContent: 'candidate',
			allowedPaths: [
				'.swarm/skill-improver/proposals/demo.md',
				'.swarm/skills/proposals/test/SKILL.md',
				'.swarm/knowledge.jsonl',
			],
		});
		if (!request) {
			throw new Error('expected approval request');
		}
		await issueWriteApprovalFact({
			directory: tmp,
			request,
			issuingSessionId: 'sess-human',
		});
		const prepared: PreparedSkillImproverApprovalCandidate = {
			directory: tmp,
			sessionId: 'sess-fb-010',
			now: new Date('2026-08-26T12:00:00.000Z'),
			source: 'llm',
			proposalPath: path.join(
				tmp,
				'.swarm',
				'skill-improver',
				'proposals',
				'demo.md',
			),
			proposalContent: '# proposal\n',
			allowedPaths: [
				'.swarm/skill-improver/proposals/demo.md',
				'.swarm/skills/proposals/test/SKILL.md',
				'.swarm/knowledge.jsonl',
			],
			candidateContent: 'candidate',
			draftWrites: [
				{
					slug: 'test',
					path: '.swarm/skills/proposals/test/SKILL.md',
					content: '# skill\n',
					sourceKnowledgeIds: [knowledgeEntry.id],
				},
			],
			draftSourceStamps: [
				{
					knowledgePath: '.swarm/knowledge.jsonl',
					ids: [knowledgeEntry.id],
					slug: 'test',
					draftGeneratedSkillPath: '.swarm/skills/proposals/test/SKILL.md',
					updatedAt: '2026-08-26T12:00:00.000Z',
				},
				{
					knowledgePath: '.swarm/knowledge.jsonl',
					ids: ['22222222-2222-4222-8222-222222222222'],
					slug: 'other',
					draftGeneratedSkillPath: '.swarm/skills/proposals/other/SKILL.md',
					updatedAt: '2026-08-26T12:00:00.000Z',
				},
			],
			request,
			quota: { date: '2026-08-26', calls_used: 1, max_calls: 3 },
			quotaWindow: 'utc',
			maxCalls: 0,
			maxCallsPerDay: 3,
			released: true,
		};
		const result = await writeApprovedSkillImproverCandidate(prepared);
		expect(result.ran).toBe(false);
		expect(result.reason).toContain('stale');
		expect(
			existsSync(
				path.join(tmp, '.swarm', 'skill-improver', 'proposals', 'demo.md'),
			),
		).toBe(false);
		expect(
			existsSync(
				path.join(tmp, '.swarm', 'skills', 'proposals', 'test', 'SKILL.md'),
			),
		).toBe(false);
		const restored = readFileSync(knowledgePath, 'utf8');
		expect(restored).not.toContain('draft_generated_skill_slug');
		expect(restored).not.toContain('draft_generated_skill_path');
	});
});
