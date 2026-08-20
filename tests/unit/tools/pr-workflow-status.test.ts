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

const realReadGate = _internals.readPrWorkflowGateStateForRecovery;

const realHead = _internals.resolveCurrentGitHeadAsync;
const realClean = _internals.resolveIsWorkingTreeCleanAsync;
const realRunGit = _internals.runGitCapture;
const realClassifyGitState = _internals.classifyGitState;

// Deterministic git stub: detached HEAD, one tracked + one untracked change,
// a single origin remote (fetch/push rows). Individual tests override members.
function installDefaultGitStub(): void {
	_internals.resolveCurrentGitHeadAsync = async () => 'a'.repeat(40);
	_internals.resolveIsWorkingTreeCleanAsync = async () => false;
	_internals.classifyGitState = async () => ({
		kind: 'clean',
		code: 'CLEAN',
		retryable: true,
		requiredAction: 'No checkout recovery is required.',
		evidence: {
			worktreeRoot: tempDir,
			gitDir: `${tempDir}/.git`,
			operations: [],
			unmergedCodes: [],
			paths: [],
			trackedCount: 0,
			untrackedCount: 0,
			pathsTruncated: false,
		},
	});
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
	_internals.readPrWorkflowGateStateForRecovery = realReadGate;
	_internals.resolveCurrentGitHeadAsync = realHead;
	_internals.resolveIsWorkingTreeCleanAsync = realClean;
	_internals.runGitCapture = realRunGit;
	_internals.classifyGitState = realClassifyGitState;
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

	// PRR-013: `runGitCapture` collapses every failure class (non-zero exit,
	// spawn error, timeout) into `null` alike, including when ONLY the
	// `rev-parse --abbrev-ref HEAD` call fails while sibling concurrent git
	// reads (status, HEAD verify) succeed — an ordinary independent-spawn
	// partial-failure mode, not a contrived case. `resolveBranch` must report
	// that as `detached: null` (unknown), never `false` (which would assert a
	// verified non-detached branch that was never actually confirmed).
	test('reports detached as null (unknown), not false, when rev-parse fails in isolation', async () => {
		_internals.runGitCapture = async (_dir: string, args: string[]) => {
			if (args[0] === 'rev-parse') return null;
			if (args[0] === 'status') return '';
			if (args[0] === 'remote') return '';
			return null;
		};
		const git = (await runTool(tempDir, SESSION_ID)).git as Record<
			string,
			unknown
		>;
		expect(git.branch).toBeNull();
		expect(git.detached).toBeNull();
	});

	test('surfaces checkout recovery classification and manual next step', async () => {
		_internals.classifyGitState = async () => ({
			kind: 'recovery-required',
			code: 'GIT_OPERATION_IN_PROGRESS',
			retryable: false,
			requiredAction:
				'Complete or abort the active Git operation manually before starting the PR workflow.',
			evidence: {
				worktreeRoot: tempDir,
				gitDir: `${tempDir}/.git`,
				operations: ['merge'],
				unmergedCodes: [],
				paths: ['src/a.ts'],
				trackedCount: 1,
				untrackedCount: 0,
				pathsTruncated: false,
			},
		});

		const parsed = await runTool(tempDir, SESSION_ID);
		expect(parsed.checkout).toEqual({
			kind: 'recovery-required',
			code: 'GIT_OPERATION_IN_PROGRESS',
			retryable: false,
			requiredAction:
				'Complete or abort the active Git operation manually before starting the PR workflow.',
			evidence: {
				worktreeRoot: tempDir,
				gitDir: `${tempDir}/.git`,
				operations: ['merge'],
				unmergedCodes: [],
				paths: ['src/a.ts'],
				trackedCount: 1,
				untrackedCount: 0,
				pathsTruncated: false,
			},
		});
		expect(parsed.nextStep).toContain('Manual Git recovery required');
		expect(parsed.nextStep).toContain('code=GIT_OPERATION_IN_PROGRESS');
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
		const parsed = await runTool(tempDir, SESSION_ID);
		const gate = parsed.gate as Record<string, unknown>;
		expect(gate.active).toBe(true);
		expect(gate.mode).toBe('PR_REVIEW');
		expect(gate.prHeadBound).toBe(true);
		expect(gate.prHeadSha).toBe(HEAD_SHA);
		expect(gate.baseDispatchBatches).toBe(0);
		expect(gate.validationBatches).toBe(0);
	});

	test('reports prHeadBound false before the PR head is bound', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
		const parsed = await runTool(tempDir, SESSION_ID);
		const gate = parsed.gate as Record<string, unknown>;
		expect(gate.active).toBe(true);
		expect(gate.mode).toBe('PR_FEEDBACK');
		expect(gate.prHeadBound).toBe(false);
		expect(gate.prHeadSha).toBeNull();
		expect(parsed.nextStep).toContain('exact tracking checkout');
		expect(parsed.nextStep).toContain('bind');
		expect(parsed.nextStep).not.toContain('switch --detach');
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
		_internals.readPrWorkflowGateStateForRecovery = mock(
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

describe('durable checkout recovery status', () => {
	test('remains authoritative after live Git becomes clean', async () => {
		_internals.readPrWorkflowGateStateForRecovery = async () => ({
			salvaged: false,
			schemaErrors: [],
			revisionSalvageable: true,
			armedShapeUnreadable: false,
			state: {
				schemaVersion: 1,
				revision: 1,
				sessionID: SESSION_ID,
				mode: 'PR_REVIEW',
				activatedAt: '2026-08-01T00:00:00.000Z',
				updatedAt: '2026-08-01T00:00:01.000Z',
				checkoutRecovery: {
					code: 'UNMERGED_INDEX',
					retryable: false,
					requiredAction: 'Resolve the conflicted index manually.',
					detectedAt: '2026-08-01T00:00:01.000Z',
					evidence: {
						worktreeRoot: tempDir,
						gitDir: `${tempDir}/.git`,
						operations: [],
						unmergedCodes: ['UU'],
						paths: ['conflict.ts'],
						trackedCount: 1,
						untrackedCount: 0,
						pathsTruncated: false,
					},
				},
			},
		});

		const parsed = await runTool(tempDir, SESSION_ID);
		expect((parsed.checkout as Record<string, unknown>).code).toBe(
			'UNMERGED_INDEX',
		);
		expect(parsed.nextStep).toContain('retryable=false');
		expect(parsed.nextStep).toContain('Resolve the conflicted index manually.');
	});

	test('uses the live classifier when no durable recovery is recorded (FB-005)', async () => {
		// The persisted-recovery test above bypasses the live result. This case
		// proves live checkout classification remains authoritative without it.
		let classifyCalls = 0;
		_internals.readPrWorkflowGateStateForRecovery = async () => null;
		_internals.classifyGitState = async () => {
			classifyCalls += 1;
			return {
				kind: 'recovery-required',
				code: 'UNMERGED_INDEX',
				retryable: false,
				requiredAction: 'Resolve the live conflicted index.',
				evidence: {
					worktreeRoot: tempDir,
					gitDir: `${tempDir}/.git`,
					operations: [],
					unmergedCodes: ['UU'],
					paths: ['live-conflict.ts'],
					trackedCount: 1,
					untrackedCount: 0,
					pathsTruncated: false,
				},
			};
		};

		const parsed = await runTool(tempDir, SESSION_ID);
		const checkout = parsed.checkout as Record<string, unknown>;
		expect(classifyCalls).toBe(1);
		expect(checkout.code).toBe('UNMERGED_INDEX');
		expect(checkout.requiredAction).toBe('Resolve the live conflicted index.');
		expect(parsed.nextStep).toContain('Resolve the live conflicted index.');
	});
});

// PRR-008: `describeNextStep`'s final branch must not conflate a genuinely
// clean tree (`isClean === true`) with an unknown one (`isClean === null`,
// meaning `git status` itself failed). Collapsing both into the "all clear,
// continue" message would report a git failure as "all clear".
describe('pr_workflow_status — nextStep tree-state messaging', () => {
	test('reports the tree state as unknown, not "continue read-only review", when git status fails', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		_internals.resolveIsWorkingTreeCleanAsync = async () => null;
		const parsed = await runTool(tempDir, SESSION_ID);
		const git = parsed.git as Record<string, unknown>;
		expect(git.isClean).toBeNull();
		const nextStep = parsed.nextStep as string;
		expect(nextStep).not.toContain('Continue read-only review');
		expect(nextStep).toContain(
			'could not determine whether the working tree is clean',
		);
	});

	test('still reports "Continue read-only review" when isClean is genuinely true', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		_internals.resolveIsWorkingTreeCleanAsync = async () => true;
		const parsed = await runTool(tempDir, SESSION_ID);
		expect(parsed.nextStep).toContain('Continue read-only review');
	});
});

describe('truncateToByteBudget — byte-accurate stdout cap', () => {
	test('leaves content under the byte budget untouched', () => {
		expect(_internals.truncateToByteBudget('hello', 512 * 1024)).toBe('hello');
	});

	test('truncates ASCII content to the exact byte count', () => {
		const value = 'a'.repeat(100);
		expect(_internals.truncateToByteBudget(value, 40)).toBe('a'.repeat(40));
	});

	test('truncates by real UTF-8 byte count, not UTF-16 code-unit count', () => {
		// Each emoji is 1 JS string element pair (2 UTF-16 code units) but 4 UTF-8
		// bytes. A naive `.slice(0, N)` on `.length` would keep far more actual
		// bytes than a byte-oriented cap name promises; encoding-based truncation
		// must stop after exactly 2 emoji (8 bytes) for a budget of 8.
		const twoEmoji = '😀😀';
		const encodedLen = new TextEncoder().encode(twoEmoji).length;
		expect(encodedLen).toBe(8);
		const result = _internals.truncateToByteBudget(`${twoEmoji}${twoEmoji}`, 8);
		expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(8);
		expect(result).toBe(twoEmoji);
	});

	test('does not leave a lone surrogate when the budget splits a multi-byte character', () => {
		// A budget landing mid-emoji must decode cleanly (replacement char or
		// clean drop), never an unpaired UTF-16 surrogate that breaks JSON output.
		const value = '😀'; // 4 UTF-8 bytes, 2 UTF-16 code units
		const result = _internals.truncateToByteBudget(value, 2);
		for (let i = 0; i < result.length; i++) {
			const code = result.charCodeAt(i);
			const isLoneSurrogate = code >= 0xd800 && code <= 0xdfff;
			expect(isLoneSurrogate).toBe(false);
		}
	});
});
