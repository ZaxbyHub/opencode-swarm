import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	bindPrWorkflowHead,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-gate-shell-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => 'abc123';
	_test_exports.resolveIsWorkingTreeClean = () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR feedback shell mutation gate', () => {
	test('blocks shell writes before verification while allowing read-only intake', async () => {
		await activatePrWorkflow(directory, 'feedback-shell', 'PR_FEEDBACK');

		await expect(
			enforcePrWorkflowToolBefore(directory, 'feedback-shell', 'bash', {
				command: 'printf changed > src/example.txt',
			}),
		).rejects.toThrow('PR_FEEDBACK');

		await expect(
			enforcePrWorkflowToolBefore(directory, 'feedback-shell', 'bash', {
				command: 'git status --short',
			}),
		).resolves.toBeUndefined();

		for (const command of [
			'git commit -m fix',
			'git push origin HEAD',
			'gh pr comment 42 --body fixed',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(directory, 'feedback-shell', 'bash', {
					command,
				}),
			).rejects.toThrow('PR_FEEDBACK');
		}
		await expect(
			enforcePrWorkflowToolBefore(directory, 'feedback-shell', 'bash', {
				command: 'gh pr view 42 --json headRefOid',
			}),
		).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				'feedback-shell',
				'github_add_issue_comment',
				{},
			),
		).rejects.toThrow('PR_FEEDBACK');

		for (const toolName of [
			'github_dismiss_pull_request_review',
			'github_mark_pull_request_ready_for_review',
			'github_unresolve_review_thread',
			'github_convert_pull_request_to_draft',
			'github_unknown_pull_request_operation',
			'github_unknown_list_pull_request_reviews',
			'github_archive_pull_request_status',
			'github_lock_issue_list',
			'github_frob_get_pull_request',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(directory, 'feedback-shell', toolName, {}),
			).rejects.toThrow('PR_FEEDBACK');
		}
	});

	test('fails closed for unknown shell commands and Git mutation variants', async () => {
		await activatePrWorkflow(directory, 'feedback-fail-closed', 'PR_FEEDBACK');

		for (const command of [
			'bun run format',
			'npm run format',
			'biome format --write src',
			'python scripts/fix.py',
			'node scripts/fix.js',
			'powershell -Command Set-Content src/x.txt x',
			'git checkout -b bypass',
			'git switch -c bypass',
			'git config user.name bypass',
			'git update-index --assume-unchanged src/index.ts',
			'git diff --output=changed.patch',
			'git diff --ext-diff',
			'git grep --open-files-in-pager=fix.sh needle',
			'rg --pre scripts/fix.py needle',
			'gh api repos/o/r/issues/1 --method=PATCH -f title=changed',
			'rg needle src && node scripts/fix.js',
			'git ci -m bypass',
			'git -c alias.ci=commit ci -m bypass',
			'curl -X POST https://example.invalid/publish',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(
					directory,
					'feedback-fail-closed',
					'shell',
					{ command },
				),
			).rejects.toThrow('PR_FEEDBACK');
		}
	});

	test('allows only explicit read-only intake plus existing-ref checkout', async () => {
		await activatePrWorkflow(directory, 'feedback-intake', 'PR_FEEDBACK');

		for (const command of [
			'git status --short',
			'git -C . diff origin/main...HEAD',
			'git remote -v',
			'git config --show-origin --get remote.origin.url',
			'git checkout main',
			'git switch --detach abc123',
			'git switch -c pr-local --track origin/pr-branch',
			'git branch --set-upstream-to=origin/pr-branch pr-local',
			'git fetch origin pull/42/head',
			'gh pr view 42 --json headRefOid',
			'gh pr checkout 42',
			'gh run list --branch feature',
			'gh api repos/o/r/pulls/42/comments --method GET',
			"gh api graphql -f query='query { viewer { login } }'",
			'rg --files src',
			'Get-Content README.md',
		]) {
			await enforcePrWorkflowToolBefore(directory, 'feedback-intake', 'shell', {
				command,
			}).catch((error: unknown) => {
				throw new Error(`expected intake command to be allowed: ${command}`, {
					cause: error,
				});
			});
		}
	});

	test('allows read-only review connectors and blocks explicit remote mutations', async () => {
		await activatePrWorkflow(directory, 'feedback-connectors', 'PR_FEEDBACK');

		for (const toolName of [
			'mcp__codex_apps__github_list_pull_request_reviews',
			'mcp__codex_apps__github_list_pull_request_review_threads',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(
					directory,
					'feedback-connectors',
					toolName,
					{},
				),
			).resolves.toBeUndefined();
		}

		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				'feedback-connectors',
				'mcp__codex_apps__github_add_pull_request_review_comment',
				{},
			),
		).rejects.toThrow('PR_FEEDBACK');
	});

	test('blocks direct writes/coder before coverage and all direct validation Task bypasses', async () => {
		await activatePrWorkflow(directory, 'feedback-direct', 'PR_FEEDBACK');
		await declarePrFeedbackInventory(directory, 'feedback-direct', ['FB-001'], {
			prHeadSha: 'abc123',
		});
		await enforcePrFeedbackVerificationOwnership(
			directory,
			'feedback-direct',
			[{ laneId: 'verify-a', ownedItemIds: ['FB-001'] }],
			{ batchId: 'verify-1', prHeadSha: 'abc123' },
		);
		await expect(
			enforcePrWorkflowToolBefore(directory, 'feedback-direct', 'shell', {
				command: 'git checkout other-branch',
			}),
		).rejects.toThrow('checkout is immutable');
		await expect(
			enforcePrWorkflowToolBefore(directory, 'feedback-direct', 'shell', {
				command: 'git fetch . abc123:refs/remotes/origin/pr-head',
			}),
		).rejects.toThrow('shell commands fail closed');
		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				'feedback-direct',
				'apply_patch',
				{},
			),
		).rejects.toThrow('ownership is incomplete');
		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				'feedback-direct',
				'Task',
				{ subagent_type: 'paid_coder' },
				['paid_coder'],
			),
		).rejects.toThrow('ownership is incomplete');
		for (const [toolName, subagentType] of [
			['Task', 'reviewer'],
			['Task', 'test_engineer'],
			['Task', 'critic_oversight'],
			['Task', 'explorer'],
			['Task', 'unknown_role'],
			['run_agent', 'reviewer'],
		] as const) {
			await expect(
				enforcePrWorkflowToolBefore(directory, 'feedback-direct', toolName, {
					subagent_type: subagentType,
				}),
			).rejects.toThrow('structured dispatch_lanes_async');
		}
		await expect(
			enforcePrWorkflowToolBefore(directory, 'feedback-direct', 'run_agent', {
				agent: 'reviewer',
			}),
		).rejects.toThrow('structured dispatch_lanes_async');
		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				'feedback-direct',
				'run_agent',
				{ subagent_type: 'paid_coder', agent: 'reviewer' },
				['paid_coder'],
			),
		).rejects.toThrow('structured dispatch_lanes_async');
	});

	test('blocks direct explorer and validation Task bypasses in PR review', async () => {
		await activatePrWorkflow(directory, 'review-direct', 'PR_REVIEW');
		await expect(
			enforcePrWorkflowToolBefore(directory, 'review-direct', 'shell', {
				command: 'git checkout main',
			}),
		).resolves.toBeUndefined();
		for (const subagentType of [
			'explorer',
			'reviewer',
			'paid_reviewer',
			'council_generalist',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(
					directory,
					'review-direct',
					'Task',
					{ subagent_type: subagentType },
					['paid_reviewer', 'council_generalist'],
				),
			).rejects.toThrow('structured dispatch_lanes_async');
		}

		await bindPrWorkflowHead(directory, 'review-direct', 'abc123');
		await expect(
			enforcePrWorkflowToolBefore(directory, 'review-direct', 'shell', {
				command: 'git status --short',
			}),
		).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(directory, 'review-direct', 'read', {
				path: 'src/index.ts',
			}),
		).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				'review-direct',
				'mcp__filesystem__read_file',
				{ path: 'src/index.ts' },
			),
		).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				'review-direct',
				'mcp__graphql__read',
				{
					query: 'query GetIssue { issue { id } }',
					operationName: 'GetIssue',
				},
			),
		).resolves.toBeUndefined();
		for (const [toolName, args] of [
			['apply_patch', {}],
			['shell', { command: 'node scripts/fix.js' }],
			['shell', { command: 'git checkout other' }],
			['shell', { command: 'gh pr checkout 42' }],
			['shell', { command: 'git push origin HEAD' }],
			['github_add_issue_comment', {}],
			['filesystem_write_file', { path: 'src/index.ts', text: 'mutated' }],
			['mcp.filesystem.write_file', { path: 'src/index.ts', text: 'mutated' }],
			['opaque_connector_action', { path: 'src/index.ts' }],
			['mcp__postgres__query', { sql: 'DROP TABLE users' }],
			['mcp__filesystem__read_then_destroy_repository', { path: '.' }],
			[
				'mcp__github__get_issue',
				{ method: 'POST', body: { title: 'mutated' } },
			],
			[
				'mcp__filesystem__read_file',
				{ path: 'x', write: true, content: 'mutated' },
			],
			[
				'mcp__graphql__read',
				{ query: 'mutation { deleteIssue(id: 1) { id } }' },
			],
			['mcp__github__get_issue', { httpMethod: 'POST' }],
			['mcp__github__get_issue', { requestBody: { title: 'mutated' } }],
			['mcp__filesystem__read_file', { newContent: 'mutated' }],
			['mcp__filesystem__read_file', { operation: 'write' }],
			['mcp__filesystem__read_file', { operation: 'download' }],
			['mcp__filesystem__read_file', { action: 'download' }],
			['mcp__github__get_issue', { verb: 'POST' }],
			[
				'mcp__database__read_query',
				{
					query:
						'mutation UpdateThing @skip(if: false) { updateThing(id: 1) { id } }',
				},
			],
			[
				'mcp__database__read_query',
				{
					query:
						'MERGE INTO accounts a USING staged s ON a.id=s.id WHEN MATCHED THEN UPDATE SET balance=s.balance',
				},
			],
			[
				'mcp__database__read_query',
				{ query: 'CREATE TABLE audit_copy AS SELECT * FROM audit' },
			],
			[
				'mcp__database__read_query',
				{ rawRequest: 'POST /repos/o/r/issues/1/comments HTTP/1.1' },
			],
			['mcp__database__read_query', { query: 'ALTER SYSTEM RESET ALL' }],
			['mcp__filesystem__read_file', { append: true, text: 'changed' }],
			[
				'mcp__storage__download_file',
				{ source: 'artifact', destinationPath: 'src/generated.bin' },
			],
			['mcp__database__read_query', { query: 'SELECT 1 INTO scratch_table' }],
		] as const) {
			const outcome = await enforcePrWorkflowToolBefore(
				directory,
				'review-direct',
				toolName,
				args,
			).then(
				() => 'ALLOWED',
				(error) => String(error),
			);
			expect({ toolName, args, outcome }).toEqual({
				toolName,
				args,
				outcome: expect.stringContaining('PR_REVIEW is read-only'),
			});
		}
	});

	test('feedback blocks unclassified MCP mutation tools before verification', async () => {
		await activatePrWorkflow(directory, 'feedback-mcp', 'PR_FEEDBACK');
		for (const [toolName, args] of [
			['mcp.filesystem.write_file', { path: 'src/index.ts', text: 'mutated' }],
			['mcp__postgres__query', { sql: 'DROP TABLE users' }],
			[
				'mcp__github__get_issue',
				{ method: 'POST', body: { title: 'mutated' } },
			],
			['mcp__github__get_issue', { httpMethod: 'POST' }],
			['mcp__github__get_issue', { requestBody: { title: 'mutated' } }],
			['mcp__filesystem__read_file', { newContent: 'mutated' }],
			['mcp__filesystem__read_file', { operation: 'write' }],
			['mcp__filesystem__read_file', { operation: 'download' }],
			['mcp__filesystem__read_file', { action: 'download' }],
			['mcp__github__get_issue', { verb: 'POST' }],
			[
				'mcp__database__read_query',
				{
					query:
						'mutation UpdateThing @skip(if: false) { updateThing(id: 1) { id } }',
				},
			],
			[
				'mcp__database__read_query',
				{ query: 'CREATE TABLE audit_copy AS SELECT * FROM audit' },
			],
			[
				'mcp__database__read_query',
				{ rawRequest: 'POST /repos/o/r/issues/1/comments HTTP/1.1' },
			],
			['mcp__database__read_query', { query: 'ALTER SYSTEM RESET ALL' }],
			['mcp__filesystem__read_file', { append: true, text: 'changed' }],
			[
				'mcp__storage__download_file',
				{ source: 'artifact', destinationPath: 'src/generated.bin' },
			],
			['mcp__database__read_query', { query: 'SELECT 1 INTO scratch_table' }],
		] as const) {
			await expect(
				enforcePrWorkflowToolBefore(directory, 'feedback-mcp', toolName, args),
			).rejects.toThrow('rejects unclassified plugin/MCP tools');
		}
	});

	test('protects durable gate, delegation, lane-output, and trigger evidence paths', async () => {
		await activatePrWorkflow(directory, 'protected-evidence', 'PR_FEEDBACK');
		for (const [toolName, args] of [
			[
				'apply_patch',
				{ patch: '*** Update File: .swarm/pr-workflow-gates/state.json' },
			],
			['shell', { command: 'rm .swarm/background-delegations.jsonl' }],
			['shell', { command: 'del .swarm\\lane-results\\artifact.json' }],
			['write', { path: '.swarm/pr-review/run/trigger-eval.json' }],
		] as const) {
			await expect(
				enforcePrWorkflowToolBefore(
					directory,
					'protected-evidence',
					toolName,
					args,
				),
			).rejects.toThrow('controller-owned');
		}
	});
});
