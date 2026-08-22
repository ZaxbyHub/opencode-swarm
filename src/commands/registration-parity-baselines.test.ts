import { describe, expect, it } from 'bun:test';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
	VALID_COMMANDS,
} from './registry';
import {
	HUMAN_ONLY_SWARM_COMMANDS,
	SWARM_COMMAND_TOOL_ALLOWLIST,
	SWARM_COMMAND_TOOL_COMMANDS,
} from './tool-policy';

describe('Command registration parity — classification baselines', () => {
	// ── PART B: No-regression classification snapshot (FR-008/SC-12) ──

	describe('no-regression classification snapshot (FR-008/SC-12)', () => {
		// Authoritative pre-existing baseline (29 allowlist entries)
		const BASELINE_28_ALLOWLIST = new Set([
			'agents',
			'config',
			'config doctor',
			'doctor tools',
			'status',
			'show-plan',
			'help',
			'history',
			'evidence',
			'evidence summary',
			'retrieve',
			'diagnose',
			'preflight',
			'benchmark',
			'knowledge',
			'memory',
			'memory status',
			'memory pending',
			'memory recall-log',
			'memory value-log',
			'memory stale',
			'memory export',
			'memory evaluate',
			'sdd',
			'sdd status',
			'sdd validate',
			// FR-004: sdd project moved from human-only to agent
			'sdd project',
			'sync-plan',
			'export',
			'auto-proceed',
			// #1850: cohort memory sharing commands (agent/utility + diagnostics)
			'memory link',
			'memory link status',
			'memory unlink',
		]);

		// Authoritative pre-existing baseline (10 human-only entries)
		const BASELINE_10_HUMAN_ONLY = new Set([
			'acknowledge-spec-drift',
			'reset',
			'reset-session',
			'rollback',
			'checkpoint',
			'consolidate',
			'memory compact',
			'memory import',
			'memory migrate',
			// FR-004: sdd project removed — moved to agent
			'knowledge hive-quarantine', // #2033 human-only exact-ID quarantine
		]);

		// Authoritative pre-existing baseline (33 tool commands = 29 allowlist + 4 human-only)
		const BASELINE_32_TOOL_COMMANDS = new Set([
			...BASELINE_28_ALLOWLIST,
			'memory compact',
			'memory import',
			'memory migrate',
			// FR-004: sdd project removed — now in allowlist
			'knowledge hive-quarantine', // #2033 human-only
		]);

		// Authoritative pre-existing baseline (14 no-args entries)
		const BASELINE_14_NO_ARGS = new Set([
			'agents',
			'config',
			'config doctor',
			'doctor tools',
			'status',
			'history',
			'evidence summary',
			'diagnose',
			'preflight',
			'sync-plan',
			'export',
			'memory',
			'memory status',
			'memory export',
			// #1850: memory link status has toolNoArgs: true
			'memory link status',
		]);

		// After the fix, only these additions are permitted to differ.
		// `pr subscribe` / `pr unsubscribe` moved from human-only to agent
		// Newer agent-callable commands added to the allowlist since the
		// pre-fix baseline was frozen. All are read-only/diagnostic and
		// therefore agent-appropriate: costs (token/cost totals), ci-simulate
		// (dry-run CI), guardrail explain (dry-run guardrail preview),
		// guardrail-log (read decision log), lanes (list worktree lanes),
		// memory consolidation-log (read consolidation log), gate-audit (bounded
		// production audit), and gate-stats (offline audit reducer). `review`
		const NEWER_ALLOWLIST_ADDITIONS = [
			'ci-simulate',
			'costs',
			'guardrail explain',
			'guardrail-log',
			'lanes',
			'memory consolidation-log',
			'gate-audit',
			'gate-stats',
			'context-map stats',
		];
		const EXPECTED_ADDITIONS = {
			allowlist: new Set([
				'pr status',
				'pr subscribe',
				'pr unsubscribe',
				'learning',
				'post-mortem',
				...NEWER_ALLOWLIST_ADDITIONS,
				// #1822: governed skill optimizer — read-only/proposal commands
				'skill-opt',
				'skill-opt plan',
				'skill-opt status',
				'skill-opt diff',
				'skill-opt history',
			]),
			// Aliases that inherit a human-only/restricted canonical target (so
			// the Bash CLI guardrail blocks the alias/dash form too — see
			// HUMAN_ONLY_SWARM_COMMANDS). `clear` (→ reset-session, restricted)
			// is a pre-existing alias that the canonical-aware derivation now
			// also covers, closing a latent bypass.
			// FR-004: sdd-project removed — canonical target (sdd project) is now agent
			// `abort-pr-workflow` is a restricted human-only escape hatch for
			// unrecoverable PR_REVIEW/PR_FEEDBACK mechanical gates.
			// `approve-plan-critic` is a restricted human-only escape hatch for
			// the ratchet-tighter critic_pre_plan execution gate (issue #2012).
			humanOnly: new Set([
				'memory-import',
				'memory-migrate',
				'clear',
				'abort-pr-workflow',
				'approve-plan-critic',
				'review',
				// #1822: governed skill optimizer — mutating commands (human-gated)
				'skill-opt run',
				'skill-opt approve',
				'skill-opt reject',
				'skill-opt rollback',
				// #2268: settlement recovery escape hatch — --force releases
				// in-process dispatch ownership, an operator-only assertion.
				'recover',
			]),
			toolCommands: new Set([
				'pr subscribe',
				'pr unsubscribe',
				'pr status',
				'learning',
				'post-mortem',
				...NEWER_ALLOWLIST_ADDITIONS,
				'review',
				// #1822: all 9 skill-opt commands carry a toolPolicy
				'skill-opt',
				'skill-opt plan',
				'skill-opt status',
				'skill-opt diff',
				'skill-opt history',
				'skill-opt run',
				'skill-opt approve',
				'skill-opt reject',
				'skill-opt rollback',
				// #2268: human-only commands stay in the swarm_command z.enum —
				// agent attempts are refused with a surface-to-user message.
				'recover',
			]),
			noArgs: new Set(['pr status', 'lanes', 'context-map stats']),
		};
		const expectedAllowlist = new Set([
			...BASELINE_28_ALLOWLIST,
			...EXPECTED_ADDITIONS.allowlist,
		]);
		const expectedHumanOnly = new Set([
			...BASELINE_10_HUMAN_ONLY,
			...EXPECTED_ADDITIONS.humanOnly,
		]);

		const expectedToolCommands = new Set([
			...BASELINE_32_TOOL_COMMANDS,
			...EXPECTED_ADDITIONS.toolCommands,
		]);

		const expectedNoArgs = new Set([
			...BASELINE_14_NO_ARGS,
			...EXPECTED_ADDITIONS.noArgs,
		]);

		it('SWARM_COMMAND_TOOL_ALLOWLIST matches baseline plus the permitted additions', () => {
			const actual = SWARM_COMMAND_TOOL_ALLOWLIST;
			const extra = [...actual].filter((x) => !expectedAllowlist.has(x));
			const missing = [...expectedAllowlist].filter((x) => !actual.has(x));
			expect(
				extra.length === 0 && missing.length === 0,
				`SWARM_COMMAND_TOOL_ALLOWLIST mismatch.\n` +
					`Extra in actual: ${extra.join(', ') || 'none'}\n` +
					`Missing from actual: ${missing.join(', ') || 'none'}`,
			).toBe(true);
		});

		it('HUMAN_ONLY_SWARM_COMMANDS matches the permitted aliases and manual-only commands', () => {
			const actual = HUMAN_ONLY_SWARM_COMMANDS;
			const extra = [...actual].filter((x) => !expectedHumanOnly.has(x));
			const missing = [...expectedHumanOnly].filter((x) => !actual.has(x));
			expect(
				extra.length === 0 && missing.length === 0,
				`HUMAN_ONLY_SWARM_COMMANDS mismatch.\n` +
					`Extra in actual: ${extra.join(', ') || 'none'}\n` +
					`Missing from actual: ${missing.join(', ') || 'none'}`,
			).toBe(true);
		});

		it('SWARM_COMMAND_TOOL_COMMANDS (z.enum) matches baseline plus the permitted additions', () => {
			const actual = new Set(SWARM_COMMAND_TOOL_COMMANDS);
			const extra = [...actual].filter((x) => !expectedToolCommands.has(x));
			const missing = [...expectedToolCommands].filter((x) => !actual.has(x));
			expect(
				extra.length === 0 && missing.length === 0,
				`SWARM_COMMAND_TOOL_COMMANDS mismatch.\n` +
					`Extra in actual: ${extra.join(', ') || 'none'}\n` +
					`Missing from actual: ${missing.join(', ') || 'none'}`,
			).toBe(true);
		});

		it('NO_ARGS (derived from toolNoArgs) matches baseline plus pr status and lanes', () => {
			const actual = new Set(
				VALID_COMMANDS.filter(
					(cmd) =>
						(
							COMMAND_REGISTRY[
								cmd as keyof typeof COMMAND_REGISTRY
							] as CommandEntry
						)?.toolNoArgs === true,
				),
			);
			const extra = [...actual].filter((x) => !expectedNoArgs.has(x));
			const missing = [...expectedNoArgs].filter((x) => !actual.has(x));
			expect(
				extra.length === 0 && missing.length === 0,
				`NO_ARGS mismatch.\n` +
					`Extra in actual: ${extra.join(', ') || 'none'}\n` +
					`Missing from actual: ${missing.join(', ') || 'none'}`,
			).toBe(true);
		});

		it('only the permitted additions differ from the pre-fix baseline', () => {
			const actualAllowlist = SWARM_COMMAND_TOOL_ALLOWLIST;
			const diffFromBaseline = [
				...[...actualAllowlist].filter((x) => !BASELINE_28_ALLOWLIST.has(x)),
				...[...BASELINE_28_ALLOWLIST].filter((x) => !actualAllowlist.has(x)),
			];
			const permittedDiffs = EXPECTED_ADDITIONS.allowlist;
			const unexpectedDiffs = diffFromBaseline.filter(
				(x) => !permittedDiffs.has(x),
			);
			expect(
				unexpectedDiffs.length === 0,
				`Unexpected differences from pre-fix ALLOWLIST baseline: ${unexpectedDiffs.join(', ')}.\n` +
					`Only these additions are permitted: ${[...permittedDiffs].join(', ')}`,
			).toBe(true);
		});
	});
});
