/**
 * PRR-005 / O-002 regression — budget-check throw containment.
 *
 * One of PR #2141's three deliverables (O-002) wraps both Path A and Path B
 * budget blocks in system-enhancer.ts in a scoped try/catch so that a throw
 * inside the budget check (getContextBudgetReport / formatBudgetWarning) no
 * longer escapes to the hook-level catch and silently skips the downstream
 * injections in the same branch — the pre-flight binary advisory and the
 * coder/test_engineer environment-profile injection.
 *
 * This test forces that exact throw and asserts the coder environment-profile
 * injection still appears in output.system. Pre-fix the throw escaped and the
 * env-profile injection was silently dropped on every turn the budget check
 * failed — the agent lost its platform/command-policy context exactly when the
 * budget was tightest.
 *
 * HOW THE THROW IS FORCED (no mock.module). getContextBudgetReport's first
 * statement is `validateProjectDirectory(directory)`. We pass a directory the
 * validator rejects on every platform — a Windows system location, which
 * validateProjectDirectory flags via its dual path.win32/path.posix evaluation
 * (src/utils/path-security.ts, issue #2129) regardless of host OS, so this is
 * CI-safe on ubuntu/macOS/windows. This exercises the real throw path the
 * scoped catch was added for, and — unlike a module mock — it cannot leak into
 * sibling suites sharing Bun's test-runner process (AGENTS.md invariant 7).
 *
 * A positive control (`getSessionBudgetPct === 0`) proves the throw genuinely
 * fired before `setSessionBudget`: without it, a silently-passing fixture would
 * let the report run, record a non-zero pct, and the test would pass for the
 * wrong reason (env-profile is present regardless when no throw occurs).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import {
	getSessionBudgetPct,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { _internals as coChangeInternals } from '../../../src/tools/co-change-analyzer';

// A directory validateProjectDirectory rejects on EVERY host (dual win32/posix
// evaluation flags the Windows system segment unconditionally). It is
// deliberately NON-EXISTENT so the hook's pre-budget reads (plan/knowledge via
// readFileOrEmpty) return empty immediately instead of scanning a real tree.
// Execution still reaches the budget block, where this directory makes
// getContextBudgetReport throw exactly once.
const REJECTED_DIR = 'C:\\Windows\\prr005-no-such-dir';

const BUDGET_TOKENS = 100_000;

describe('system-enhancer — budget-check throw no longer drops downstream injections (O-002)', () => {
	const config = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			delegation_gate: false,
			agent_awareness_max_chars: 300,
			delegation_max_chars: 1000,
		},
		automation: {
			mode: 'manual',
			capabilities: {
				decision_drift_detection: false,
				plan_sync: false,
				phase_preflight: false,
				config_doctor_on_startup: false,
				config_doctor_autofix: false,
				evidence_auto_summaries: false,
			},
		},
		adversarial_detection: {
			enabled: false,
			policy: 'warn',
			pairs: [['coder', 'reviewer']],
		},
		context_budget: {
			enabled: true,
			warn_threshold: 0.7,
			critical_threshold: 0.9,
			model_limits: { default: BUDGET_TOKENS },
		},
	} as unknown as PluginConfig;

	// The hook's dark-matter block (system-enhancer.ts:849-882) UNCONDITIONALLY
	// mkdir+writeFile `.swarm/dark-matter.md` under `directory` via the root-blind
	// `validateSwarmPath`. For a REJECTED_DIR that resolves as a RELATIVE path on
	// POSIX (`C:\Windows\...` is one backslash-delimited filename there), that
	// mkdir would SUCCEED under the cwd and leave a stray directory in the repo
	// tree (AGENTS.md invariant 4 spirit). Neutralize it through the call-time
	// `_internals` DI seam (system-enhancer.ts:855-861 reads
	// `coChangeInternals.detectDarkMatter` at call time so tests can mock it,
	// writing-tests Invariant 7): a thrown detectDarkMatter is swallowed by the
	// dark-matter try/catch, so no mkdir/write happens regardless of host.
	let originalDetectDarkMatter: typeof coChangeInternals.detectDarkMatter;
	beforeEach(() => {
		resetSwarmState();
		originalDetectDarkMatter = coChangeInternals.detectDarkMatter;
		coChangeInternals.detectDarkMatter = async () => {
			throw new Error(
				'dark-matter write neutralized for throw-containment test',
			);
		};
	});

	afterEach(() => {
		coChangeInternals.detectDarkMatter = originalDetectDarkMatter;
		resetSwarmState();
	});

	it('still injects the coder environment profile when the budget check throws', async () => {
		const sessionId = 'prr005-coder';
		// The budget block runs for every agent; the env-profile injection below
		// it is coder/test_engineer-gated. Set coder so the env-profile path is
		// the downstream injection a pre-fix throw would have skipped.
		swarmState.activeAgent.set(sessionId, 'coder');

		const hook = createSystemEnhancerHook(config, REJECTED_DIR);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['seeded system prompt'] as string[] };

		// The scoped try/catch must contain the throw — the hook resolves.
		await expect(
			transform({ sessionID: sessionId }, output),
		).resolves.toBeUndefined();

		// POSITIVE CONTROL: the throw happened before setSessionBudget ran, so no
		// budget was recorded for this session. If this fails, the throw did not
		// fire and the rest of the test is a false pass.
		expect(getSessionBudgetPct(sessionId)).toBe(0);

		// O-002 assertion: the environment-profile injection downstream of the
		// budget block is still present despite the throw. Pre-fix, the escaping
		// throw skipped it entirely.
		const hasEnvProfile = output.system.some(
			(s) =>
				s.includes('RUNTIME ENVIRONMENT') ||
				s.includes('powershell-native') ||
				s.includes('posix-native'),
		);
		expect(hasEnvProfile).toBe(true);

		// And the budget warning itself is absent — the throw preceded it.
		expect(output.system.some((s) => s.includes('[CONTEXT BUDGET:'))).toBe(
			false,
		);
	});
});
