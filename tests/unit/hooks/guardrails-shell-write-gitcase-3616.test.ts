/**
 * #3616 D11 head suite: the protected-component compare is PRODUCTION-wired
 * through the platform seam.
 *
 * Legs:
 * 1. Seam test: darwin folds (.GIT == .git), win32 folds, linux/other stays
 *    exact; exact matches hold on all platforms.
 * 2. Call-site test (every host): the recursive-delete evaluator reaches the
 *    seam through `dcComponentEquals` with `process.platform`. On a folding
 *    host (win32/darwin) `.GIT` is denied with DESTRUCTIVE_TARGET_PROTECTED;
 *    on an exact host (linux) the protected compare misses and the target
 *    falls through to the artifact allowlist (DESTRUCTIVE_TARGET_NOT_SAFE_
 *    ARTIFACT). The deny CODE discriminates the fold, so reverting the
 *    delegation to an exact compare fails this leg on win32/darwin.
 * 3. Real-FS gate probe (every host; the macOS CI lane transcript is the
 *    recorded darwin probe #3616 AC12 demands): with a real `.git` directory
 *    in the workspace, the live gate denies `rm -rf .GIT` with the
 *    platform's protected/not-allowlisted reason.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	dcEvaluateRecursiveDeleteTargets,
	dcProtectedComponentEqualsForPlatform,
} from '../../../src/hooks/guardrails/destructive-command';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const FOLDING_HOST =
	process.platform === 'win32' || process.platform === 'darwin';

function config(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	} as GuardrailsConfig;
}

describe('#3616 D11: protected-component compare seam', () => {
	test('seam folds case on darwin and win32, stays exact on linux', () => {
		const darwin = dcProtectedComponentEqualsForPlatform('darwin');
		const win32 = dcProtectedComponentEqualsForPlatform('win32');
		const linux = dcProtectedComponentEqualsForPlatform('linux');
		// darwin: macOS default filesystems are case-insensitive — the
		// fold is fail-closed (a case-SENSITIVE darwin volume only
		// over-denies).
		expect(darwin('.GIT', '.git')).toBe(true);
		expect(darwin('.git', '.git')).toBe(true);
		expect(darwin('.gitx', '.git')).toBe(false);
		// win32 folds (pre-existing behavior, now via the seam).
		expect(win32('.GIT', '.git')).toBe(true);
		expect(win32('.gitx', '.git')).toBe(false);
		// linux/other platforms stay exact.
		expect(linux('.GIT', '.git')).toBe(false);
		expect(linux('.git', '.git')).toBe(true);
	}, 30_000);

	test('production evaluator reaches the platform fold through dcComponentEquals', () => {
		const result = dcEvaluateRecursiveDeleteTargets({
			targets: ['.GIT'],
			cwd: process.cwd(),
		});
		expect(result.allowed).toBe(false);
		expect(result.code).toBe(
			FOLDING_HOST
				? 'DESTRUCTIVE_TARGET_PROTECTED'
				: 'DESTRUCTIVE_TARGET_NOT_SAFE_ARTIFACT',
		);
	}, 30_000);

	test('real-FS gate probe: rm -rf .GIT denied when .git exists', async () => {
		const ws = canonicalMkdtemp('gitcase-3616-');
		try {
			mkdirSync(path.join(ws, '.git'), { recursive: true });
			mkdirSync(path.join(ws, 'src'), { recursive: true });
			const sessionID = 'gitcase-3616';
			resetSwarmState();
			startAgentSession(sessionID, 'coder');
			installActiveScopeBinding({
				directory: ws,
				childSessionId: sessionID,
				taskId: '1.1',
				files: ['src/'],
				dispatchCallId: 'call-gitcase',
			});
			const hooks = createGuardrailsHooks(ws, undefined, config());
			let message: string | null = null;
			try {
				await hooks.toolBefore(
					{ tool: 'bash', sessionID, callID: 'call-gitcase' },
					{ args: { command: 'rm -rf .GIT' } },
				);
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
			expect(message).not.toBeNull();
			expect(message ?? '').toMatch(
				FOLDING_HOST
					? /contains protected \.git or \.swarm state/
					: /is not an allowlisted build\/cache artifact/,
			);
		} finally {
			try {
				rmSync(ws, { recursive: true, force: true });
			} catch {
				// teardown flake
			}
			resetSwarmState();
		}
	}, 60_000);
});
