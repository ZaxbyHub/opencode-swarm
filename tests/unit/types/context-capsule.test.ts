/**
 * Type safety tests for src/types/context-capsule.ts
 * Tests type shape, required/optional fields, and compile-time safety
 */

import { describe, expect, test } from 'bun:test';
import type {
	AgentRole,
	CapsuleDelegationReason,
	CapsuleMetadata,
	ContextCapsule,
	ReadPolicyEntry,
	RoleProfile,
} from '../../../src/types/context-capsule';

describe('src/types/context-capsule.ts - TYPE SAFETY TESTS', () => {
	describe('CapsuleDelegationReason type', () => {
		test('accepts valid CapsuleDelegationReason values', () => {
			const reasons: CapsuleDelegationReason[] = [
				'new_task',
				'reviewer_rejection_fix',
				'critic_plan_review',
				'test_failure_fix',
			];

			expect(reasons).toHaveLength(4);

			const newTask: CapsuleDelegationReason = 'new_task';
			expect(newTask).toBe('new_task');

			const reviewerFix: CapsuleDelegationReason = 'reviewer_rejection_fix';
			expect(reviewerFix).toBe('reviewer_rejection_fix');

			const criticReview: CapsuleDelegationReason = 'critic_plan_review';
			expect(criticReview).toBe('critic_plan_review');

			const testFailureFix: CapsuleDelegationReason = 'test_failure_fix';
			expect(testFailureFix).toBe('test_failure_fix');
		});

		test('rejects invalid string values', () => {
			// @ts-expect-error - 'invalid' is not a valid CapsuleDelegationReason
			const invalidReason: CapsuleDelegationReason = 'invalid';

			// @ts-expect-error - 'completed' is not a valid CapsuleDelegationReason
			const completedReason: CapsuleDelegationReason = 'completed';

			// @ts-expect-error - empty string is not a valid CapsuleDelegationReason
			const emptyReason: CapsuleDelegationReason = '';
		});
	});

	describe('AgentRole type', () => {
		test('accepts valid AgentRole values', () => {
			const roles: AgentRole[] = [
				'coder',
				'reviewer',
				'critic',
				'test_engineer',
				'sme',
			];

			expect(roles).toHaveLength(5);

			const coder: AgentRole = 'coder';
			expect(coder).toBe('coder');

			const reviewer: AgentRole = 'reviewer';
			expect(reviewer).toBe('reviewer');

			const critic: AgentRole = 'critic';
			expect(critic).toBe('critic');

			const testEngineer: AgentRole = 'test_engineer';
			expect(testEngineer).toBe('test_engineer');

			const sme: AgentRole = 'sme';
			expect(sme).toBe('sme');
		});

		test('rejects invalid role values', () => {
			// @ts-expect-error - 'architect' is not a valid AgentRole
			const invalidRole: AgentRole = 'architect';

			// @ts-expect-error - 'developer' is not a valid AgentRole
			const developerRole: AgentRole = 'developer';

			// @ts-expect-error - 'admin' is not a valid AgentRole
			const adminRole: AgentRole = 'admin';
		});
	});

	describe('ReadPolicyEntry interface', () => {
		test('accepts valid ReadPolicyEntry with all required fields', () => {
			const entry: ReadPolicyEntry = {
				file_path: 'src/utils/helper.ts',
				trust_summary: true,
				read_original: false,
				reason: 'File is small, summary is fresh',
			};

			expect(entry.file_path).toBe('src/utils/helper.ts');
			expect(entry.trust_summary).toBe(true);
			expect(entry.read_original).toBe(false);
			expect(entry.reason).toBe('File is small, summary is fresh');
		});

		test('rejects ReadPolicyEntry missing required fields', () => {
			// @ts-expect-error - file_path is required
			const missingFilePath: ReadPolicyEntry = {
				trust_summary: true,
				read_original: false,
				reason: 'Test',
			};

			// @ts-expect-error - trust_summary is required
			const missingTrustSummary: ReadPolicyEntry = {
				file_path: 'test.ts',
				read_original: false,
				reason: 'Test',
			};

			// @ts-expect-error - read_original is required
			const missingReadOriginal: ReadPolicyEntry = {
				file_path: 'test.ts',
				trust_summary: true,
				reason: 'Test',
			};

			// @ts-expect-error - reason is required
			const missingReason: ReadPolicyEntry = {
				file_path: 'test.ts',
				trust_summary: true,
				read_original: false,
			};
		});

		test('rejects extra fields not in interface', () => {
			// @ts-expect-error - Extra field 'extraField' should be rejected
			const polluted: ReadPolicyEntry = {
				file_path: 'test.ts',
				trust_summary: true,
				read_original: false,
				reason: 'Test',
				extraField: 'should not be allowed',
			};
		});
	});

	describe('RoleProfile interface', () => {
		test('accepts valid RoleProfile with all required fields', () => {
			const profile: RoleProfile = {
				role: 'coder',
				strategy: 'scoped_files',
				max_files: 10,
				include_rejection: false,
				include_coverage: false,
				include_claims: false,
			};

			expect(profile.role).toBe('coder');
			expect(profile.strategy).toBe('scoped_files');
			expect(profile.max_files).toBe(10);
			expect(profile.include_rejection).toBe(false);
			expect(profile.include_coverage).toBe(false);
			expect(profile.include_claims).toBe(false);
		});

		test('accepts RoleProfile with all optional fields populated', () => {
			const profile: RoleProfile = {
				role: 'test_engineer',
				strategy: 'scoped_files_plus_rejection',
				max_files: 20,
				include_rejection: true,
				include_coverage: true,
				include_claims: true,
			};

			expect(profile.role).toBe('test_engineer');
			expect(profile.strategy).toBe('scoped_files_plus_rejection');
			expect(profile.max_files).toBe(20);
			expect(profile.include_rejection).toBe(true);
			expect(profile.include_coverage).toBe(true);
			expect(profile.include_claims).toBe(true);
		});

		test('rejects RoleProfile missing required fields', () => {
			// @ts-expect-error - role is required
			const missingRole: RoleProfile = {
				strategy: 'test',
				max_files: 10,
				include_rejection: false,
				include_coverage: false,
				include_claims: false,
			};

			// @ts-expect-error - strategy is required
			const missingStrategy: RoleProfile = {
				role: 'coder',
				max_files: 10,
				include_rejection: false,
				include_coverage: false,
				include_claims: false,
			};

			// @ts-expect-error - max_files is required
			const missingMaxFiles: RoleProfile = {
				role: 'coder',
				strategy: 'test',
				include_rejection: false,
				include_coverage: false,
				include_claims: false,
			};

			// @ts-expect-error - include_rejection is required
			const missingIncludeRejection: RoleProfile = {
				role: 'coder',
				strategy: 'test',
				max_files: 10,
				include_coverage: false,
				include_claims: false,
			};

			// @ts-expect-error - include_coverage is required
			const missingIncludeCoverage: RoleProfile = {
				role: 'coder',
				strategy: 'test',
				max_files: 10,
				include_rejection: false,
				include_claims: false,
			};

			// @ts-expect-error - include_claims is required
			const missingIncludeClaims: RoleProfile = {
				role: 'coder',
				strategy: 'test',
				max_files: 10,
				include_rejection: false,
				include_coverage: false,
			};
		});

		test('rejects extra fields not in interface', () => {
			// @ts-expect-error - Extra field 'extraField' should be rejected
			const polluted: RoleProfile = {
				role: 'coder',
				strategy: 'test',
				max_files: 10,
				include_rejection: false,
				include_coverage: false,
				include_claims: false,
				extraField: 'should not be allowed',
			};
		});
	});

	describe('CapsuleMetadata interface', () => {
		test('accepts valid CapsuleMetadata with all required fields', () => {
			const metadata: CapsuleMetadata = {
				success: true,
				capsule_path: '.swarm/capsules/1.1 abc123.json',
				token_estimate: 1500,
				cache_hits: 5,
				cache_misses: 2,
				stale_entries: 1,
				recommended_reads: ['src/important.ts'],
				skipped_reads: ['src/stable.ts'],
			};

			expect(metadata.success).toBe(true);
			expect(metadata.capsule_path).toBe('.swarm/capsules/1.1 abc123.json');
			expect(metadata.token_estimate).toBe(1500);
			expect(metadata.cache_hits).toBe(5);
			expect(metadata.cache_misses).toBe(2);
			expect(metadata.stale_entries).toBe(1);
			expect(metadata.recommended_reads).toEqual(['src/important.ts']);
			expect(metadata.skipped_reads).toEqual(['src/stable.ts']);
		});

		test('rejects CapsuleMetadata missing required fields', () => {
			// @ts-expect-error - success is required
			const missingSuccess: CapsuleMetadata = {
				capsule_path: 'test.json',
				token_estimate: 100,
				cache_hits: 0,
				cache_misses: 0,
				stale_entries: 0,
				recommended_reads: [],
				skipped_reads: [],
			};

			// @ts-expect-error - capsule_path is required
			const missingCapsulePath: CapsuleMetadata = {
				success: true,
				token_estimate: 100,
				cache_hits: 0,
				cache_misses: 0,
				stale_entries: 0,
				recommended_reads: [],
				skipped_reads: [],
			};

			// @ts-expect-error - token_estimate is required
			const missingTokenEstimate: CapsuleMetadata = {
				success: true,
				capsule_path: 'test.json',
				cache_hits: 0,
				cache_misses: 0,
				stale_entries: 0,
				recommended_reads: [],
				skipped_reads: [],
			};

			// @ts-expect-error - cache_hits is required
			const missingCacheHits: CapsuleMetadata = {
				success: true,
				capsule_path: 'test.json',
				token_estimate: 100,
				cache_misses: 0,
				stale_entries: 0,
				recommended_reads: [],
				skipped_reads: [],
			};

			// @ts-expect-error - cache_misses is required
			const missingCacheMisses: CapsuleMetadata = {
				success: true,
				capsule_path: 'test.json',
				token_estimate: 100,
				cache_hits: 0,
				stale_entries: 0,
				recommended_reads: [],
				skipped_reads: [],
			};

			// @ts-expect-error - stale_entries is required
			const missingStaleEntries: CapsuleMetadata = {
				success: true,
				capsule_path: 'test.json',
				token_estimate: 100,
				cache_hits: 0,
				cache_misses: 0,
				recommended_reads: [],
				skipped_reads: [],
			};

			// @ts-expect-error - recommended_reads is required
			const missingRecommendedReads: CapsuleMetadata = {
				success: true,
				capsule_path: 'test.json',
				token_estimate: 100,
				cache_hits: 0,
				cache_misses: 0,
				stale_entries: 0,
				skipped_reads: [],
			};

			// @ts-expect-error - skipped_reads is required
			const missingSkippedReads: CapsuleMetadata = {
				success: true,
				capsule_path: 'test.json',
				token_estimate: 100,
				cache_hits: 0,
				cache_misses: 0,
				stale_entries: 0,
				recommended_reads: [],
			};
		});

		test('rejects extra fields not in interface', () => {
			// @ts-expect-error - Extra field 'extraField' should be rejected
			const polluted: CapsuleMetadata = {
				success: true,
				capsule_path: 'test.json',
				token_estimate: 100,
				cache_hits: 0,
				cache_misses: 0,
				stale_entries: 0,
				recommended_reads: [],
				skipped_reads: [],
				extraField: 'should not be allowed',
			};
		});
	});

	describe('ContextCapsule interface', () => {
		test('accepts valid ContextCapsule with required fields only', () => {
			const capsule: ContextCapsule = {
				task_id: '1.1',
				agent_role: 'coder',
				delegation_reason: 'new_task',
				generated_at: '2024-01-20T12:00:00Z',
				files_in_scope: ['src/index.ts', 'src/utils.ts'],
				task_goal: 'Implement user authentication',
				relevant_facts: ['Uses TypeScript', 'Follows hexagonal architecture'],
				read_policy: [],
				content: '# Task\n\nImplement auth.',
			};

			expect(capsule.task_id).toBe('1.1');
			expect(capsule.agent_role).toBe('coder');
			expect(capsule.delegation_reason).toBe('new_task');
			expect(capsule.generated_at).toBe('2024-01-20T12:00:00Z');
			expect(capsule.files_in_scope).toEqual(['src/index.ts', 'src/utils.ts']);
			expect(capsule.task_goal).toBe('Implement user authentication');
			expect(capsule.relevant_facts).toEqual([
				'Uses TypeScript',
				'Follows hexagonal architecture',
			]);
			expect(capsule.read_policy).toEqual([]);
			expect(capsule.content).toBe('# Task\n\nImplement auth.');
		});

		test('accepts ContextCapsule with all optional fields populated', () => {
			const capsule: ContextCapsule = {
				task_id: '2.3',
				agent_role: 'test_engineer',
				delegation_reason: 'test_failure_fix',
				generated_at: '2024-01-21T14:30:00Z',
				files_in_scope: ['src/auth/login.ts'],
				task_goal: 'Fix authentication tests',
				prior_rejection: 'Tests are not comprehensive enough',
				required_fix: 'Add edge case tests for empty password',
				relevant_facts: ['Auth module uses bcrypt'],
				review_checklist: ['Check password hashing', 'Verify token generation'],
				coverage_targets: ['src/auth/login.ts'],
				read_policy: [
					{
						file_path: 'src/auth/login.ts',
						trust_summary: false,
						read_original: true,
						reason: 'Summary may be stale due to recent changes',
					},
				],
				content: '# Test Fix\n\nAdd edge case tests.',
			};

			expect(capsule.prior_rejection).toBe(
				'Tests are not comprehensive enough',
			);
			expect(capsule.required_fix).toBe(
				'Add edge case tests for empty password',
			);
			expect(capsule.review_checklist).toEqual([
				'Check password hashing',
				'Verify token generation',
			]);
			expect(capsule.coverage_targets).toEqual(['src/auth/login.ts']);
			expect(capsule.read_policy).toHaveLength(1);
		});

		test('rejects ContextCapsule missing required fields', () => {
			// @ts-expect-error - task_id is required
			const missingTaskId: ContextCapsule = {
				agent_role: 'coder',
				delegation_reason: 'new_task',
				generated_at: '2024-01-20T12:00:00Z',
				files_in_scope: [],
				task_goal: 'Test',
				relevant_facts: [],
				read_policy: [],
				content: 'Test',
			};

			// @ts-expect-error - agent_role is required
			const missingAgentRole: ContextCapsule = {
				task_id: '1.1',
				delegation_reason: 'new_task',
				generated_at: '2024-01-20T12:00:00Z',
				files_in_scope: [],
				task_goal: 'Test',
				relevant_facts: [],
				read_policy: [],
				content: 'Test',
			};

			// @ts-expect-error - delegation_reason is required
			const missingDelegationReason: ContextCapsule = {
				task_id: '1.1',
				agent_role: 'coder',
				generated_at: '2024-01-20T12:00:00Z',
				files_in_scope: [],
				task_goal: 'Test',
				relevant_facts: [],
				read_policy: [],
				content: 'Test',
			};

			// @ts-expect-error - generated_at is required
			const missingGeneratedAt: ContextCapsule = {
				task_id: '1.1',
				agent_role: 'coder',
				delegation_reason: 'new_task',
				files_in_scope: [],
				task_goal: 'Test',
				relevant_facts: [],
				read_policy: [],
				content: 'Test',
			};

			// @ts-expect-error - files_in_scope is required
			const missingFilesInScope: ContextCapsule = {
				task_id: '1.1',
				agent_role: 'coder',
				delegation_reason: 'new_task',
				generated_at: '2024-01-20T12:00:00Z',
				task_goal: 'Test',
				relevant_facts: [],
				read_policy: [],
				content: 'Test',
			};

			// @ts-expect-error - task_goal is required
			const missingTaskGoal: ContextCapsule = {
				task_id: '1.1',
				agent_role: 'coder',
				delegation_reason: 'new_task',
				generated_at: '2024-01-20T12:00:00Z',
				files_in_scope: [],
				relevant_facts: [],
				read_policy: [],
				content: 'Test',
			};

			// @ts-expect-error - relevant_facts is required
			const missingRelevantFacts: ContextCapsule = {
				task_id: '1.1',
				agent_role: 'coder',
				delegation_reason: 'new_task',
				generated_at: '2024-01-20T12:00:00Z',
				files_in_scope: [],
				task_goal: 'Test',
				read_policy: [],
				content: 'Test',
			};

			// @ts-expect-error - read_policy is required
			const missingReadPolicy: ContextCapsule = {
				task_id: '1.1',
				agent_role: 'coder',
				delegation_reason: 'new_task',
				generated_at: '2024-01-20T12:00:00Z',
				files_in_scope: [],
				task_goal: 'Test',
				relevant_facts: [],
				content: 'Test',
			};

			// @ts-expect-error - content is required
			const missingContent: ContextCapsule = {
				task_id: '1.1',
				agent_role: 'coder',
				delegation_reason: 'new_task',
				generated_at: '2024-01-20T12:00:00Z',
				files_in_scope: [],
				task_goal: 'Test',
				relevant_facts: [],
				read_policy: [],
			};
		});

		test('rejects extra fields not in interface', () => {
			// @ts-expect-error - Extra field 'extraField' should be rejected
			const polluted: ContextCapsule = {
				task_id: '1.1',
				agent_role: 'coder',
				delegation_reason: 'new_task',
				generated_at: '2024-01-20T12:00:00Z',
				files_in_scope: [],
				task_goal: 'Test',
				relevant_facts: [],
				read_policy: [],
				content: 'Test',
				extraField: 'should not be allowed',
			};
		});
	});

	describe('Type narrowing and compile-time safety', () => {
		test('CapsuleDelegationReason can be used in arrays', () => {
			const reasons: CapsuleDelegationReason[] = [
				'new_task',
				'reviewer_rejection_fix',
				'critic_plan_review',
				'test_failure_fix',
			];

			expect(reasons).toHaveLength(4);
			expect(reasons[0]).toBe('new_task');
		});

		test('AgentRole can be used in Record keys', () => {
			const roleMap: Record<AgentRole, string> = {
				coder: 'writes code',
				reviewer: 'reviews code',
				critic: 'critiques plans',
				test_engineer: 'writes tests',
				sme: 'provides expertise',
			};

			expect(roleMap.coder).toBe('writes code');
			expect(roleMap.reviewer).toBe('reviews code');
			expect(roleMap.critic).toBe('critiques plans');
			expect(roleMap.test_engineer).toBe('writes tests');
			expect(roleMap.sme).toBe('provides expertise');
		});

		test('ContextCapsule read_policy accepts ReadPolicyEntry[]', () => {
			const policy: ReadPolicyEntry[] = [
				{
					file_path: 'src/a.ts',
					trust_summary: true,
					read_original: false,
					reason: 'Fresh summary',
				},
				{
					file_path: 'src/b.ts',
					trust_summary: false,
					read_original: true,
					reason: 'Stale summary',
				},
			];

			const capsule: ContextCapsule = {
				task_id: '1.1',
				agent_role: 'coder',
				delegation_reason: 'new_task',
				generated_at: '2024-01-20T12:00:00Z',
				files_in_scope: ['src/a.ts', 'src/b.ts'],
				task_goal: 'Test',
				relevant_facts: [],
				read_policy: policy,
				content: 'Test',
			};

			expect(capsule.read_policy).toHaveLength(2);
			expect(capsule.read_policy[0].file_path).toBe('src/a.ts');
			expect(capsule.read_policy[1].trust_summary).toBe(false);
		});

		test('all six exported types are importable', () => {
			// Verify all types can be referenced
			const types = [
				{} as CapsuleDelegationReason,
				{} as AgentRole,
				{} as ReadPolicyEntry,
				{} as RoleProfile,
				{} as CapsuleMetadata,
				{} as ContextCapsule,
			];
			expect(types).toHaveLength(6);
		});
	});
});
