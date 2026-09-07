/**
 * `swarm ci` command handler (issue #2497).
 *
 * Advisory headless CI: evaluates a checked-out repo's authoritative gates
 * read-only (see src/ci/evaluate.ts), renders Markdown + [SWARM_CI_JSON],
 * and maps the run outcome to a machine exit status:
 *   0 = every evaluated gate passed (and at least one was evaluated)
 *   1 = gate violation / no-data / corrupt evidence / nothing to evaluate
 *   2 = cancelled (SIGINT/SIGTERM)
 *   3 = deadline or internal error
 *
 * The command must run without a TTY and without the OpenCode host
 * (scrubbed CI environments), so it carries NO toolPolicy (neither
 * human-only nor agent-gated). It uses `ctx.directory` — never
 * process.cwd() — per AGENTS.md invariant 4, spawns no subprocess, and
 * consumes no stdin.
 */

import {
	type AdvisoryCiReport,
	evaluateAdvisoryCi,
	renderFullReport,
	renderJsonBlock,
	runAdvisoryCiRuntime,
} from '../ci/index.js';
import { DEFAULT_QA_GATES } from '../db/qa-gate-profile.js';
import type { CommandContext, CommandFailure } from './registry.js';

export const DEFAULT_CI_DEADLINE_MS = 300_000;

export interface CiSignalCancellation {
	/** The handler invoked on SIGINT/SIGTERM; exported for unit testing the
	 * wiring without relying on platform signal delivery. */
	handler: () => void;
	install: () => void;
	dispose: () => void;
}

/** Wire SIGINT/SIGTERM to the run's AbortController. Kept as a seam so the
 * cancellation contract is unit-testable on platforms where self-signalling
 * a native process is unreliable (Windows Git Bash; see frozen check C5's
 * notes). */
export function createSignalCancellation(
	controller: AbortController,
	onCancelled: () => void = () => {},
): CiSignalCancellation {
	const handler = () => {
		if (!controller.signal.aborted) {
			controller.abort();
			onCancelled();
		}
	};
	let installed = false;
	return {
		handler,
		install: () => {
			if (installed) return;
			installed = true;
			process.once('SIGINT', handler);
			process.once('SIGTERM', handler);
		},
		dispose: () => {
			if (!installed) return;
			installed = false;
			process.removeListener('SIGINT', handler);
			process.removeListener('SIGTERM', handler);
		},
	};
}

function parseTimeoutMs(args: string[]): number {
	const index = args.indexOf('--timeout-ms');
	if (index === -1) return DEFAULT_CI_DEADLINE_MS;
	const raw = args[index + 1];
	if (raw === undefined || raw.startsWith('--')) {
		throw new Error(
			'Invalid --timeout-ms value: expected a positive number of milliseconds.',
		);
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(
			'Invalid --timeout-ms value: expected a positive number of milliseconds.',
		);
	}
	return parsed;
}

function validateNoUnknownFlags(args: string[]): void {
	const allowed = new Set(['--timeout-ms', '--json']);
	for (const arg of args) {
		if (!arg.startsWith('--')) continue;
		if (!allowed.has(arg)) {
			throw new Error(`Unknown flag: ${arg}`);
		}
	}
}

export async function handleCiCommand(
	ctx: CommandContext,
): Promise<string | CommandFailure> {
	validateNoUnknownFlags(ctx.args);
	const deadlineMs = parseTimeoutMs(ctx.args);
	const jsonOnly = ctx.args.includes('--json');
	// Captured once, before any output: the report channel is stdout.
	const tty = Boolean(process.stdout?.isTTY);

	const controller = new AbortController();
	const signals = createSignalCancellation(controller);
	signals.install();

	try {
		const result = await _internals.runAdvisoryCiRuntime({
			directory: ctx.directory,
			deadlineMs,
			signal: controller.signal,
			evaluate: (runCtx) =>
				evaluateAdvisoryCi({
					directory: ctx.directory,
					tty,
					journal: runCtx.journal,
					registerCleanup: runCtx.registerCleanup,
				}),
		});

		if (result.outcome === 'pass' && result.report) {
			return jsonOnly
				? renderJsonBlock(result.report)
				: renderFullReport(result.report);
		}
		if (result.outcome === 'violations' && result.report) {
			return {
				text: jsonOnly
					? renderJsonBlock(result.report)
					: renderFullReport(result.report),
				ok: false as const,
				exitCode: 1,
			};
		}
		// cancelled / deadline / error — evaluation never completed, so the
		// machine block carries the full report shape with neutral evaluation
		// fields. One `version: 1` schema for every exit code keeps the
		// #2498 consumer contract branch-independent.
		const tail = result.journal
			.slice(-5)
			.map((e) => `${e.type}${e.detail ? `: ${e.detail}` : ''}`)
			.join('; ');
		const detail = result.detail ?? result.outcome;
		// 'pass'/'violations' returned above, so only the abort outcomes reach
		// this diagnostic branch.
		const diagnosticReason =
			result.outcome === 'cancelled' ||
			result.outcome === 'deadline' ||
			result.outcome === 'error'
				? result.outcome
				: 'error';
		const diagnosticReport: AdvisoryCiReport = {
			version: 1,
			verdict: 'fail',
			exit_reason: diagnosticReason,
			gates: [],
			tasks: [],
			plan: { present: false, task_count: 0 },
			environment: { mode: 'advisory', tty, host: 'none' },
			gate_profile: 'default',
			effective_gates: { ...DEFAULT_QA_GATES },
			not_evaluated: [],
			not_evaluable: [],
			counts: { pass: 0, fail: 0, no_data: 0, corrupt: 0, error: 0 },
		};
		return {
			text: jsonOnly
				? renderJsonBlock(diagnosticReport)
				: `swarm ci ${result.outcome}: ${detail}\n` +
					`journal tail: ${tail || '(empty)'}\n` +
					renderJsonBlock(diagnosticReport),
			ok: false as const,
			exitCode: result.outcome === 'cancelled' ? 2 : 3,
		};
	} finally {
		signals.dispose();
	}
}

/** Test seam: dependency injection over the runtime entry so handler-level
 * diagnostic-branch tests can drive cancelled/deadline outcomes without
 * timing or signal-delivery dependence (repo convention: DI over mock.module;
 * restore in afterEach). */
export const _internals = { runAdvisoryCiRuntime };
