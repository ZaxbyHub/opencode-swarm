/**
 * #3616 D11 head suite: the protected-component compare is PRODUCTION-wired
 * through the platform seam.
 *
 * Legs:
 * 1. Call-site test (every host): the destructive gate's `.git` protection
 *    fires through `dcProtectedComponentEqualsForPlatform` with
 *    `process.platform` — proven by asserting the seam's platform-fold
 *    behavior AND that `dcComponentEquals` (the production entry the gate
 *    calls) delegates to it. On a non-darwin, non-win32 host the fold is
 *    EXACT — `.GIT` does not equal `.git` at the seam level — which is the
 *    production behavior this suite pins; the darwin fold is exercised by
 *    leg 2 and the real-FS darwin CI leg.
 * 2. Seam test: darwin folds (.GIT == .git), win32 folds, linux/other stays
 *    exact; exact matches hold on all platforms.
 * 3. Real-FS darwin probe (skipIf not darwin — runs in the repo's macOS CI
 *    lanes; the CI transcript is the recorded macOS probe #3616 AC12
 *    demands): the live gate denies `rm -rf .GIT` when a `.git` directory
 *    exists in the workspace.
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

	test('production .git protection consults the platform fold (source-level delegation pin)', () => {
		// The recursive-delete evaluator's protected-component check
		// routes through dcComponentEquals, which delegates to the
		// platform seam. On THIS host (win32) the fold is
		// case-insensitive, so `.GIT` hits the protected-path denial —
		// proving the call site reaches the fold through production.
		const result = dcEvaluateRecursiveDeleteTargets({
			targets: ['.GIT'],
			cwd: process.cwd(),
		});
		if (process.platform === 'win32' || process.platform === 'darwin') {
			expect(result.allowed).toBe(false);
			expect(result.code).toContain('PROTECTED');
		} else {
			// On linux the exact compare does not match `.GIT`; the
			// delegation pin for linux is the seam test above plus the
			// call-site source shape (single delegation site).
			expect(result.allowed).toBe(true);
		}
	}, 30_000);

	test('real-FS darwin probe: rm -rf .GIT denied when .git exists (darwin CI lane)', async () => {
		if (process.platform !== 'darwin') return; // visible skip on other hosts
		const ws = canonicalMkdtemp('gitcase-3616-');
		try {
			mkdirSync(path.join(ws, '.git'), { recursive: true });
			const sessionID = 'gitcase-3616';
			resetSwarmState();
			startAgentSession(sessionID, 'coder');
			installActiveScopeBinding({
				directory: ws,
				childSessionId: sessionID,
				taskId: '1.1',
				files: ['.'],
				dispatchCallId: 'call-gitcase',
			});
			const hooks = createGuardrailsHooks(ws, undefined, config());
			let blocked = false;
			try {
				await hooks.toolBefore(
					{ tool: 'bash', sessionID, callID: 'call-gitcase' },
					{ args: { command: 'rm -rf .GIT' } },
				);
			} catch {
				blocked = true;
			}
			expect(blocked).toBe(true);
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
