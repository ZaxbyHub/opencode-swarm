import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ToolContext } from '@opencode-ai/plugin';
import { activatePrWorkflow } from '../../../src/hooks/pr-workflow-gate';
import type { ToolResult } from '../../../src/tools/create-tool';
import {
	_internals,
	pr_workflow_status,
} from '../../../src/tools/pr-workflow-status';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures';

function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

async function runTool(
	directory: string,
	sessionID?: string,
): Promise<Record<string, unknown>> {
	const result = await (
		pr_workflow_status as unknown as {
			execute: (args: unknown, ctx: ToolContext) => Promise<unknown>;
		}
	).execute({}, { directory, sessionID } as unknown as ToolContext);
	return JSON.parse(resultToString(result as ToolResult)) as Record<
		string,
		unknown
	>;
}

const realReadGate = _internals.readPrWorkflowGateState;
const realHead = _internals.resolveCurrentGitHeadAsync;
const realClean = _internals.resolveIsWorkingTreeCleanAsync;
const realRunGit = _internals.runGitCapture;

// Deterministic git stub: detached HEAD, one tracked + one untracked change,
// a single origin remote (fetch/push rows). Individual tests override members.
function installDefaultGitStub(): void {
	_internals.resolveCurrentGitHeadAsync = async () => 'a'.repeat(40);
	_internals.resolveIsWorkingTreeCleanAsync = async () => false;
	_internals.runGitCapture = async (_dir: string, args: string[]) => {
		if (args[0] === 'rev-parse') return 'HEAD\n';
		if (args[0] === 'status') return ' M src/a.ts\n?? new.txt\n';
		if (args[0] === 'remote') {
			return 'origin\thttps://github.com/o/r.git (fetch)\norigin\thttps://github.com/o/r.git (push)\n';
		}
		return null;
	};
}

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	installDefaultGitStub();
});

afterEach(async () => {
	_internals.readPrWorkflowGateState = realReadGate;
	_internals.resolveCurrentGitHeadAsync = realHead;
	_internals.resolveIsWorkingTreeCleanAsync = realClean;
	_internals.runGitCapture = realRunGit;
	await teardownPrWorkflowGateFixtures();
});

describe('pr_workflow_status — git state observation', () => {
	test('reports HEAD, detached branch, dirty files, and remotes', async () => {
		const parsed = await runTool(tempDir, SESSION_ID);
		const git = parsed.git as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(git.head).toBe('a'.repeat(40));
		expect(git.detached).toBe(true);
		expect(git.branch).toBeNull();
		expect(git.isClean).toBe(false);
		expect(git.dirtyFileCount).toBe(2);
		expect(git.dirtyFiles).toEqual([
			{ status: 'M', path: 'src/a.ts' },
			{ status: '??', path: 'new.txt' },
		]);
		expect(git.dirtyFilesTruncated).toBe(false);
		expect(git.remotes).toEqual([
			{ name: 'origin', url: 'https://github.com/o/r.git' },
		]);
		expect(git.remotesTruncated).toBe(false);
	});

	test('reports a named branch when HEAD is not detached', async () => {
		_internals.runGitCapture = async (_dir: string, args: string[]) => {
			if (args[0] === 'rev-parse') return 'feature/pr-head\n';
			if (args[0] === 'status') return '';
			return null;
		};
		_internals.resolveIsWorkingTreeCleanAsync = async () => true;
		const git = (await runTool(tempDir, SESSION_ID)).git as Record<
			string,
			unknown
		>;
		expect(git.branch).toBe('feature/pr-head');
		expect(git.detached).toBe(false);
		expect(git.isClean).toBe(true);
		expect(git.dirtyFiles).toEqual([]);
	});

	test('caps the dirty-file list at 50 and flags truncation', async () => {
		_internals.runGitCapture = async (_dir: string, args: string[]) => {
			if (args[0] === 'status') {
				return Array.from({ length: 60 }, (_v, i) => ` M src/f${i}.ts`).join(
					'\n',
				);
			}
			if (args[0] === 'rev-parse') return 'HEAD\n';
			return null;
		};
		const git = (await runTool(tempDir, SESSION_ID)).git as Record<
			string,
			unknown
		>;
		expect((git.dirtyFiles as unknown[]).length).toBe(50);
		expect(git.dirtyFileCount).toBe(60);
		expect(git.dirtyFilesTruncated).toBe(true);
	});

	test('neutralizes markup in remote URLs and bounds length', async () => {
		const evilUrl = `https://evil/<script>\`inject\`${'x'.repeat(400)}`;
		_internals.runGitCapture = async (_dir: string, args: string[]) => {
			if (args[0] === 'remote') return `origin\t${evilUrl} (fetch)`;
			if (args[0] === 'status') return '';
			if (args[0] === 'rev-parse') return 'HEAD\n';
			return null;
		};
		const git = (await runTool(tempDir, SESSION_ID)).git as Record<
			string,
			unknown
		>;
		const url = (git.remotes as Array<{ url: string }>)[0].url;
		expect(url).not.toContain('<');
		expect(url).not.toContain('>');
		expect(url).not.toContain('`');
		// 200-char bound plus the single-character ellipsis truncation marker.
		expect(url.length).toBeLessThanOrEqual(201);
	});

	test('only issues fixed read-only git verbs (no PR-controlled execution)', async () => {
		const seenVerbs = new Set<string>();
		_internals.runGitCapture = async (_dir: string, args: string[]) => {
			seenVerbs.add(args[0]);
			if (args[0] === 'rev-parse') return 'HEAD\n';
			if (args[0] === 'status') return '';
			return null;
		};
		await runTool(tempDir, SESSION_ID);
		for (const verb of seenVerbs) {
			expect(['rev-parse', 'status', 'remote']).toContain(verb);
		}
	});
});

describe('pr_workflow_status — session-pinned gate read', () => {
	test('no session context → gate inactive with reason', async () => {
		const parsed = await runTool(tempDir, undefined);
		const gate = parsed.gate as Record<string, unknown>;
		expect(parsed.sessionID).toBeNull();
		expect(gate.active).toBe(false);
		expect(gate.reason).toBe('no-session-context');
		// Git state is still observed even without a session.
		expect((parsed.git as Record<string, unknown>).head).toBe('a'.repeat(40));
	});

	test('no gate for this session → no-active-gate payload (not a throw)', async () => {
		const parsed = await runTool(tempDir, SESSION_ID);
		const gate = parsed.gate as Record<string, unknown>;
		expect(gate.active).toBe(false);
		expect(gate.reason).toBe('no-active-gate');
		expect(parsed.nextStep).toContain('No active PR workflow gate');
	});

	test('surfaces the caller session gate summary (mode, bound head)', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const gate = (await runTool(tempDir, SESSION_ID)).gate as Record<
			string,
			unknown
		>;
		expect(gate.active).toBe(true);
		expect(gate.mode).toBe('PR_REVIEW');
		expect(gate.prHeadBound).toBe(true);
		expect(gate.prHeadSha).toBe(HEAD_SHA);
		expect(gate.baseDispatchBatches).toBe(0);
		expect(gate.validationBatches).toBe(0);
	});

	test('reports prHeadBound false before the PR head is bound', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
		const gate = (await runTool(tempDir, SESSION_ID)).gate as Record<
			string,
			unknown
		>;
		expect(gate.active).toBe(true);
		expect(gate.mode).toBe('PR_FEEDBACK');
		expect(gate.prHeadBound).toBe(false);
		expect(gate.prHeadSha).toBeNull();
	});

	test('does NOT read another session gate (session-pinned)', async () => {
		// A sibling session activates a gate; the caller has none. Reading the
		// caller's own session must NOT surface the sibling's state — enumerating
		// .swarm/pr-workflow-gates/* would leak `other-session`'s mode/head.
		const otherSession = 'other-session-999';
		await activatePrWorkflow(tempDir, otherSession, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const parsed = await runTool(tempDir, SESSION_ID);
		const gate = parsed.gate as Record<string, unknown>;
		expect(gate.active).toBe(false);
		expect(gate.reason).toBe('no-active-gate');
		// No field from the sibling gate leaked into the caller's payload.
		expect(JSON.stringify(parsed)).not.toContain(otherSession);
		expect(gate.mode).toBeUndefined();
		expect(gate.prHeadSha).toBeUndefined();
	});

	test('resolves the gate with the caller sessionID exactly once', async () => {
		const calls: Array<[string, string]> = [];
		_internals.readPrWorkflowGateState = mock(
			async (directory: string, sessionID: string) => {
				calls.push([directory, sessionID]);
				return null;
			},
		) as typeof realReadGate;
		await runTool(tempDir, 'caller-xyz');
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe(tempDir);
		expect(calls[0][1]).toBe('caller-xyz');
	});
});
