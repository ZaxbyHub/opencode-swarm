/**
 * Shared fixture for the #3616 / #3606 shell-write gate residual suites:
 *  - `guardrails-shell-write-launcher-3616.test.ts`
 *  - `guardrails-shell-write-wordforms-3616.test.ts`
 *  - `guardrails-shell-write-deny-render-3616.test.ts`
 *
 * `gate()` drives the REAL gate exactly like the frozen acceptance checks of
 * the issue trace: `createGuardrailsHooks(ws, undefined, config).toolBefore`
 * for the `bash` tool, a `coder` session, and an active v2 scope binding
 * (default scope `src/`). Every call gets a fresh canonical workspace (plus a
 * sibling `<ws>-outside` tree for link legs) that is removed afterwards.
 *
 * Not a `.test.ts` file, so the runner never collects it.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

export function makeConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	} as GuardrailsConfig;
}

export interface GateOptions {
	/** Declared coder scope (default `['src/']`). */
	files?: string[];
	/** `block_destructive_commands` override (default: config default). */
	blockDestructive?: boolean;
	/** Extra workspace preparation (links, nested dirs). */
	prep?: (ws: string) => void;
}

export interface GateResult {
	verdict: 'ADMITTED' | 'BLOCKED';
	message: string;
	/** The (already removed) workspace root, for message assertions. */
	ws: string;
}

/** Sibling tree OUTSIDE the workspace used as a link destination. */
export function outsideRoot(ws: string): string {
	return path.join(path.dirname(ws), `${path.basename(ws)}-outside`);
}

/** Fresh canonical workspace with `src/x.txt` and `tests/x.md`. */
export function makeWorkspace(prep?: (ws: string) => void): string {
	const ws = canonicalMkdtemp('sw3616-');
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	writeFileSync(path.join(ws, 'src', 'x.txt'), 'x');
	mkdirSync(path.join(ws, 'tests'), { recursive: true });
	writeFileSync(path.join(ws, 'tests', 'x.md'), 'x');
	if (prep) prep(ws);
	return ws;
}

/** Remove the workspace and its `-outside` sibling (Windows EBUSY-tolerant). */
export function teardown(ws: string): void {
	for (const dir of [ws, outsideRoot(ws)]) {
		try {
			rmSync(dir, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 100,
			});
		} catch {
			// Windows EBUSY teardown flake; a leftover temp dir is harmless.
		}
	}
}

/**
 * Directory link: a junction on win32 (no privilege needed), a plain
 * directory symlink elsewhere.
 */
export function linkDir(target: string, link: string): void {
	if (process.platform === 'win32') {
		symlinkSync(target, link, 'junction');
	} else {
		symlinkSync(target, link, 'dir');
	}
}

let counter = 0;

export async function gate(
	command: string,
	opts?: GateOptions,
): Promise<GateResult> {
	const ws = makeWorkspace(opts?.prep);
	counter += 1;
	const sessionID = `sw3616-${counter}`;
	const callID = `call-sw3616-${counter}`;
	try {
		resetSwarmState();
		startAgentSession(sessionID, 'coder');
		installActiveScopeBinding({
			directory: ws,
			childSessionId: sessionID,
			taskId: '1.1',
			files: opts?.files ?? ['src/'],
			dispatchCallId: callID,
		});
		const hooks = createGuardrailsHooks(
			ws,
			undefined,
			makeConfig(
				opts?.blockDestructive === undefined
					? undefined
					: { block_destructive_commands: opts.blockDestructive },
			),
		);
		try {
			await hooks.toolBefore(
				{ tool: 'bash', sessionID, callID },
				{ args: { command } },
			);
			return { verdict: 'ADMITTED', message: '', ws };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { verdict: 'BLOCKED', message, ws };
		}
	} finally {
		teardown(ws);
		resetSwarmState();
	}
}

/** True when `s` contains a lone UTF-16 surrogate (a split astral pair). */
export function hasUnpairedSurrogate(s: string): boolean {
	for (let i = 0; i < s.length; i += 1) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const n = s.charCodeAt(i + 1);
			if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			const p = s.charCodeAt(i - 1);
			if (!(p >= 0xd800 && p <= 0xdbff)) return true;
		}
	}
	return false;
}
