import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	bindPrWorkflowHead,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';

// Split from pr-workflow-gate-shell.test.ts (FR-006): PR_REVIEW read-only
// enforcement and PR_FEEDBACK mutation classification/protected-path cases.

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveCurrentUpstreamPushTarget =
	_test_exports.resolveCurrentUpstreamPushTarget;
const originalResolveCurrentUpstreamPushTargetAsync =
	_test_exports.resolveCurrentUpstreamPushTargetAsync;
const originalResolveRemoteRefsContainingHead =
	_test_exports.resolveRemoteRefsContainingHead;
const originalResolveRemoteRefsContainingHeadAsync =
	_test_exports.resolveRemoteRefsContainingHeadAsync;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-gate-shell-readonly-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => 'abc123';
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	_test_exports.resolveCurrentGitHeadAsync = async (dir) =>
		_test_exports.resolveCurrentGitHead(dir);
	_test_exports.resolveIsWorkingTreeCleanAsync = async (dir) =>
		_test_exports.resolveIsWorkingTreeClean(dir);
	_test_exports.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-branch',
		remoteTrackingRef: 'refs/remotes/origin/pr-branch',
	});
	_test_exports.resolveCurrentUpstreamPushTargetAsync = async (dir) =>
		_test_exports.resolveCurrentUpstreamPushTarget(dir);
	_test_exports.resolveRemoteRefsContainingHead = () => [
		'refs/remotes/origin/pr-branch',
	];
	_test_exports.resolveRemoteRefsContainingHeadAsync = async (...a) =>
		_test_exports.resolveRemoteRefsContainingHead(...a);
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveCurrentUpstreamPushTarget =
		originalResolveCurrentUpstreamPushTarget;
	_test_exports.resolveCurrentUpstreamPushTargetAsync =
		originalResolveCurrentUpstreamPushTargetAsync;
	_test_exports.resolveRemoteRefsContainingHead =
		originalResolveRemoteRefsContainingHead;
	_test_exports.resolveRemoteRefsContainingHeadAsync =
		originalResolveRemoteRefsContainingHeadAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR feedback shell mutation gate - read-only classifications', () => {
	test('blocks direct explorer and validation Task bypasses in PR review', async () => {
		await activatePrWorkflow(directory, 'review-direct', 'PR_REVIEW');
		_test_exports.resolveCurrentGitHead = () => 'a'.repeat(40);
		await expect(
			enforcePrWorkflowToolBefore(directory, 'review-direct', 'shell', {
				command: `git switch --detach ${'a'.repeat(40)}`,
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

		await bindPrWorkflowHead(directory, 'review-direct', 'a'.repeat(40));
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
