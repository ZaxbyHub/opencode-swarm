/**
 * Issue #3315 acceptance check AC21 — test_runner isolation from the bound
 * PR_REVIEW checkout.
 * Classification: DISCRIMINATING — RED at base, GREEN after the fix.
 *
 * Base defect (trace 3315-prescribed-tools-reachable, E1): `test_runner`
 * carries PR_REVIEW `validate` capability metadata, so admission lets it run
 * while a PR_REVIEW gate is bound — but it executes IN PLACE in the bound
 * checkout. Its untracked outputs (snapshot files, fixtures) then flip the
 * tree dirty mid-workflow and block dispatch/artifact-writing/completion with
 * a message that names no paths.
 *
 * Post-fix contract (AC21): test_runner in a bound PR_REVIEW gate either
 * refuses AT ADMISSION with a targeted refusal naming test_runner and the
 * bound-checkout protection, or runs with its working directory outside the
 * bound checkout. This check freezes both arms:
 *
 *  (a) admission must reject with a message matching /test_runner/ (any
 *      spelling) AND /BLOCKED/ — at base admission RESOLVES (validate
 *      capability), so this fails at base with a null outcome;
 *  (b) two-arm evidence: if admission resolved, the test_runner tool's real
 *      execute actually runs the fixture test file (proving the arm is never
 *      vacuous — the sentinel file the inner test writes must exist), and the
 *      bound checkout's porcelain is compared before/after.
 *
 * The FINAL assertion is always evaluated: either the admission rejection was
 * the targeted refusal, or (when admission resolved) the porcelain stayed
 * unchanged. At base admission resolves, the inner run writes
 * `tests/snapshot-output.txt`, the porcelain gains `?? tests/snapshot-output.txt`,
 * and the file FAILS with that diff printed as evidence. After the fix the
 * refusal arm makes the same assertion pass without the runner ever touching
 * the bound checkout.
 *
 * The inner run is a real `bun test` on one tiny deterministic test file
 * (sub-second; bounded by timeout_ms below).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import { test_runner } from '../../../src/tools/test-runner.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** Array-form git with explicit cwd; output ignored (mutation commands). */
function gitQuiet(dir: string, args: string[]): void {
	execFileSync('git', ['-C', dir, ...args], {
		stdio: 'ignore',
		timeout: 30_000,
	});
}

/** Array-form git capturing bounded stdout (rev-parse / status probes). */
function gitOut(dir: string, args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], {
		encoding: 'utf-8',
		maxBuffer: 1024 * 1024,
		timeout: 30_000,
	}).trim();
}

function porcelain(dir: string): string {
	return gitOut(dir, ['status', '--porcelain=v1', '--untracked-files=all']);
}

const SENTINEL_RELATIVE = join('tests', 'snapshot-output.txt');

describe('test_runner isolation from the bound PR_REVIEW checkout (issue #3315 AC21)', () => {
	test('refuses at admission naming test_runner, or runs without dirtying the bound checkout', async () => {
		const repo = canonicalMkdtemp('test-runner-isolation-3315-');
		try {
			gitQuiet(repo, ['init', '-q']);
			gitOut(repo, ['config', 'user.email', 't@example.com']);
			gitOut(repo, ['config', 'user.name', 'T']);
			gitOut(repo, ['config', 'core.autocrlf', 'false']);
			// `.swarm/` is committed to .gitignore so gate-state writes never
			// dirty the porcelain (mirrors the production
			// ensureSwarmGitExcluded behavior).
			writeFileSync(join(repo, '.gitignore'), '.swarm/\n');
			writeFileSync(
				join(repo, 'package.json'),
				'{"name":"isolation-fixture","private":true,"scripts":{"test":"bun test"}}\n',
			);
			mkdirSync(join(repo, 'tests'));
			// The inner test writes its sentinel NEXT TO ITSELF via node:fs —
			// deterministic, fast, and exactly the E1 untracked-output shape.
			writeFileSync(
				join(repo, 'tests', 'writes-file.test.ts'),
				[
					"import { test, expect } from 'bun:test';",
					"import { writeFileSync } from 'node:fs';",
					"import { join } from 'node:path';",
					"test('writes sentinel next to itself', () => {",
					"\twriteFileSync(join(import.meta.dir, 'snapshot-output.txt'), 'sentinel\\n');",
					// vacuous-ok: keeps the GENERATED fixture test non-empty; the file write is the behavior under test.
					'\texpect(true).toBe(true);',
					'});',
					'',
				].join('\n'),
			);
			gitQuiet(repo, ['add', '.']);
			gitQuiet(repo, ['commit', '-q', '-m', 'fixture']);
			const head = gitOut(repo, ['rev-parse', 'HEAD']);

			const session = 'test-runner-isolation-3315';
			await activatePrWorkflow(repo, session, 'PR_REVIEW', {
				prHeadSha: head,
			});
			const porcelainBefore = porcelain(repo);

			// (a) Admission probe. POST-FIX: rejects with the targeted refusal
			// naming test_runner and the bound checkout. BASE: resolves (validate
			// capability metadata), leaving admissionMessage null.
			let admissionMessage: string | null = null;
			try {
				await enforcePrWorkflowToolBefore(repo, session, 'test_runner', {
					files: ['tests/writes-file.test.ts'],
				});
			} catch (error) {
				admissionMessage =
					error instanceof Error ? error.message : String(error);
			}
			const admissionRejected = admissionMessage !== null;
			const targetedRefusal =
				admissionRejected &&
				/test[_ ]runner/i.test(admissionMessage as string) &&
				/BLOCKED/.test(admissionMessage as string);

			// (b) Two-arm evidence. Only when admission resolved (base behavior)
			// does the runner actually execute — the sentinel assertion below
			// makes a never-run fixture impossible to satisfy. This arm runs
			// BEFORE the contract assertions so the base failure carries the
			// porcelain diff as printed evidence.
			let porcelainUnchanged: boolean | null = null;
			if (!admissionRejected) {
				const raw = (await test_runner.execute(
					{
						scope: 'convention',
						files: ['tests/writes-file.test.ts'],
						timeout_ms: 45_000,
					},
					{ directory: repo } as never,
				)) as string;
				const parsedRun = JSON.parse(raw) as {
					success?: boolean;
					framework?: string;
					outcome?: string;
				};
				console.log(
					`test_runner executed in the bound checkout: framework=${parsedRun.framework} outcome=${parsedRun.outcome}`,
				);
				// The run genuinely executed: the sentinel exists. If the runner
				// had not run, this fails — the arm cannot pass vacuously.
				expect(
					existsSync(join(repo, SENTINEL_RELATIVE)),
					`test_runner resolved at admission but the inner run never executed (sentinel ${SENTINEL_RELATIVE} missing)`,
				).toBe(true);
				const porcelainAfter = porcelain(repo);
				if (porcelainAfter !== porcelainBefore) {
					console.log(
						`bound-checkout porcelain changed after the in-place run:\n  before: ${JSON.stringify(porcelainBefore)}\n  after:  ${JSON.stringify(porcelainAfter)}`,
					);
				}
				porcelainUnchanged = porcelainAfter === porcelainBefore;
			}

			// Post-fix contract (a). At base admission resolves, so this fails on
			// the null outcome — the documented base signature — AFTER the
			// porcelain evidence above has been printed.
			expect(
				admissionRejected && targetedRefusal,
				admissionRejected
					? `test_runner admission rejected without the targeted bound-checkout refusal: ${admissionMessage}`
					: 'test_runner admission RESOLVED at the bound PR_REVIEW gate; the untargeted base behavior lets the runner execute in place (issue #3315 E1/AC21)',
			).toBe(true);

			// FINAL assertion — always evaluated. Post-fix: admission rejected
			// with the targeted refusal (left leg true). Base: admission resolved
			// and the in-place run dirtied the bound checkout (right leg false),
			// so the check fails with the porcelain diff printed above.
			expect(
				admissionRejected ? targetedRefusal : porcelainUnchanged,
				admissionRejected
					? 'test_runner admission was rejected, but not with the targeted bound-checkout refusal'
					: 'test_runner ran in place in the bound PR_REVIEW checkout and dirtied its porcelain (issue #3315 E1/AC21)',
			).toBe(true);
		} finally {
			safeRmRecursive(repo);
		}
	});
});
