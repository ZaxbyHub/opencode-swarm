import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	_internals,
	_test_exports,
	executeDispatchLanes,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';

const originalInternals = { ..._internals };

function makeTempDir(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-read-only-tools-')),
	);
}

afterEach(() => {
	Object.assign(_internals, originalInternals);
});

describe('dispatch_lanes read-only tool permissions', () => {
	test('injects immutable lane, head, revision, and ownership into PR workflow prompts', () => {
		const contracted = _test_exports.applyPrWorkflowPromptContract(
			[
				{
					id: 'review-1',
					agent: 'reviewer',
					prompt: 'Caller-authored prompt',
					workflow_lane: 'review-chunk-1',
					review_item_ids: ['C-1', 'C-2'],
				},
			],
			{
				mode: 'swarm-pr-review:reviewer',
				prHeadSha: 'abc123',
				revisionDigest: 'revision-1',
				scope: 'complete PR diff def456...abc123',
				callerFocus: 'README only',
			},
		);
		expect(contracted.ok).toBe(true);
		if (!contracted.ok) throw new Error('expected prompt contract');
		const prompt = contracted.lanes[0].prompt;
		expect(prompt).toContain('[CONTROLLER-BOUND PR WORKFLOW CONTRACT]');
		expect(prompt).toContain('workflow_lane: review-chunk-1');
		expect(prompt).toContain('pr_head_sha: abc123');
		expect(prompt).toContain('revision_digest: revision-1');
		expect(prompt).toContain('assigned_item_ids: C-1, C-2');
		expect(prompt).toContain(
			'declared_scope: complete PR diff def456...abc123',
		);
		expect(prompt).toContain('caller_focus_non_authoritative: README only');
		expect(prompt).toContain(
			'mandatory_lane_checklist: re-read every assigned candidate',
		);
		expect(prompt).toContain('Do not waive or abbreviate work for speed');
	});

	test('passes the exact read-only tool map with shell and bash removed (#1691)', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-1' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'done' }] },
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				lanes: [{ id: 'scan', agent: 'explorer', prompt: 'scan docs' }],
			},
			directory,
		);

		expect(result.success).toBe(true);
		expect(ops.prompt).toHaveBeenCalledTimes(1);
		expect(ops.prompt.mock.calls[0][0].body.tools).toEqual(
			_test_exports.buildReadOnlyTools(),
		);
		expect(ops.prompt.mock.calls[0][0].body.tools).toMatchObject({
			write: false,
			edit: false,
			patch: false,
			lint: false,
		});
		// Issue #1691: shell and bash are REMOVED from read-only lane tools entirely
		// (not just set to false) — they should not appear in the tool map at all.
		expect(ops.prompt.mock.calls[0][0].body.tools).not.toHaveProperty('shell');
		expect(ops.prompt.mock.calls[0][0].body.tools).not.toHaveProperty('bash');
		const promptText = ops.prompt.mock.calls[0][0].body.parts[0].text;
		expect(promptText).toContain('If a standard explorer finds zero issues');
		expect(promptText).toContain('[CLEAN] | lane | coverage_scope | evidence');
		expect(promptText).toContain(
			'[CLEAN] | micro_lane | coverage_scope | evidence',
		);
		expect(promptText).not.toContain(
			'If a standard explorer finds zero issues, emit only the header row',
		);
	});
});
