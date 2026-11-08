/**
 * #3588 items 1-3 (collated trace 3586-3588-3591-shell-gate-walk-fixpoint,
 * Fixes 2/3/4): launcher chains nested two levels deep surface their
 * innermost outcomes on every channel —
 * - Fix 2: detectLauncherWrites hops across a launcher-headed 'inner' tail
 *   (`nice sudo time -o src/ok.txt true` reaches the depth-2 `time -o`).
 * - Fix 3: dcAnalyzeLauncherUncertainty re-walks launcher-headed tails in
 *   a bounded loop (`sudo sudo -i`, `sudo FOO=bar sudo -i`, `nice sudo -i`,
 *   `nice sudo -z true` deny).
 * - Fix 4: under sudo -i/-s, ANY tail word carrying shell-operator or
 *   whitespace structure after quote removal is a compound the login
 *   shell's `-c` rejoin would re-parse — deny as interactive; genuinely
 *   plain multiword tails keep their judged behavior.
 * Gate-level pins (coder agent, declared scope src/) with admit controls.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { dcAnalyzeLauncherUncertainty } from '../../../src/hooks/guardrails/destructive-command';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const created: string[] = [];
let counter = 0;
afterAll(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

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
	};
}

interface Verdict {
	verdict: 'ADMITTED' | 'DENIED';
	message: string;
}

async function gate(command: string): Promise<Verdict> {
	const ws = canonicalMkdtemp('ln3588-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `ln3588-s${++counter}`;
	const callID = `ln3588-call-${counter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: ws,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	const hooks = createGuardrailsHooks(ws, undefined, config());
	try {
		await hooks.toolBefore(
			{ tool: 'bash', sessionID, callID },
			{ args: { command } },
		);
		return { verdict: 'ADMITTED', message: '' };
	} catch (error) {
		return {
			verdict: 'DENIED',
			message: (error as Error).message.split('\n')[0] ?? '',
		};
	} finally {
		resetSwarmState();
	}
}

describe('#3588 Fix 2: detector hop loop crosses launcher inner tails', () => {
	test('nice sudo time -o emits the depth-2 in-scope timing target', () => {
		const analysis = detectPosixWrites('nice sudo time -o src/ok.txt true');
		const paths = analysis.writes
			.filter((w) => w.category === 'launcher_write')
			.map((w) => w.path);
		expect(paths).toContain('src/ok.txt');
	});

	test('nohup sudo time -o emits too (every launcher head hops)', () => {
		const analysis = detectPosixWrites('nohup sudo time -o src/ok.txt true');
		const paths = analysis.writes
			.filter((w) => w.category === 'launcher_write')
			.map((w) => w.path);
		expect(paths).toContain('src/ok.txt');
	});

	test('sudo time -o f cmd depth-1 emission is unchanged', () => {
		const analysis = detectPosixWrites('sudo time -o src/ok.txt rm x');
		const paths = analysis.writes
			.filter((w) => w.category === 'launcher_write')
			.map((w) => w.path);
		expect(paths).toContain('src/ok.txt');
	});

	test('a three-deep chain reaches the innermost -o (bound still holds)', () => {
		const analysis = detectPosixWrites(
			'nice nohup sudo time -o src/ok.txt true',
		);
		const paths = analysis.writes
			.filter((w) => w.category === 'launcher_write')
			.map((w) => w.path);
		expect(paths).toContain('src/ok.txt');
	});

	test('a non-launcher tail still stops the hop (no fabricated targets)', () => {
		const analysis = detectPosixWrites('nice sudo true');
		expect(analysis.writes).toHaveLength(0);
	});

	test('gate: in-scope depth-2 timing write admits', async () => {
		const got = await gate('nice sudo time -o src/ok.txt true');
		expect(got.verdict).toBe('ADMITTED');
	}, 30_000);

	test('gate: escaping depth-2 timing write denies', async () => {
		const got = await gate('nice sudo time -o ../../esc true');
		expect(got.verdict).toBe('DENIED');
	}, 30_000);

	test('gate: bare keyword `time -o` ADMIT control keeps the keyword grammar', async () => {
		// bash keyword `time` accepts no -o; the command word is `-o`.
		const got = await gate('time -o x true');
		expect(got.verdict).toBe('ADMITTED');
	}, 30_000);
});

describe('#3588 Fix 3: uncertainty channel re-walks nested launcher tails', () => {
	test.each([
		'sudo sudo -i',
		'sudo FOO=bar sudo -i',
		'nice sudo -i',
		'nice sudo -z true',
		'sudo sudo -s',
	])('%s denies at the gate', async (command) => {
		const got = await gate(command);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/interactive shell|unrecognized option/i);
	}, 30_000);

	test.each([
		'sudo sudo -i',
		'nice sudo -z true',
	])('%s denies in dcAnalyzeLauncherUncertainty directly', (command) => {
		const verdict = dcAnalyzeLauncherUncertainty(command);
		expect(verdict.deny).toBe(true);
		expect(verdict.reason).toMatch(/BLOCKED/);
	});

	test.each([
		'sudo FOO=bar true',
		'sudo rm -rf node_modules',
	])('%s admit control keeps a non-launcher tail stopping the re-walk', async (command) => {
		const got = await gate(command);
		expect(got.verdict).toBe('ADMITTED');
	}, 30_000);

	test('deep chain (depth 3) still denies — bound is paranoid, not depth-2', () => {
		expect(dcAnalyzeLauncherUncertainty('nice sudo sudo -i').deny).toBe(true);
	});

	test('env -i sudo -i transparent-head pin unchanged (N-25)', () => {
		expect(dcAnalyzeLauncherUncertainty('env -i sudo -i').deny).toBe(true);
	});
});

describe('#3588 Fix 4: joined compound payloads under -i/-s deny', () => {
	test.each([
		["sudo -i 'echo x > ../esc'", /interactive shell/i],
		["sudo -i 'rm -rf ../outside'", /interactive shell/i],
		["sudo -s 'echo x > ../esc'", /interactive shell/i],
		["sudo -i echo 'x > ../esc'", /interactive shell/i],
		["sudo -i -- echo 'x > ../esc'", /interactive shell/i],
		['sudo -i "echo `touch ../esc`"', /interactive shell/i],
		["sudo -s sh -c 'echo x > ../esc'", /interactive shell/i],
		// PR #3615 feedback PRR-001: parameter/brace expansion synthesizes
		// word separators at runtime with NO literal operator in the word.
		["sudo -i 'touch${IFS}esc.txt'", /interactive shell/i],
		["sudo -i 'rm${IFS}-rf${IFS}../outside'", /interactive shell/i],
		["sudo -s 'touch${IFS}esc.txt'", /interactive shell/i],
		["sudo -i '{rm,-rf,../outside}'", /interactive shell/i],
		["sudo -i '{touch,esc.txt}'", /interactive shell/i],
		['sudo -i "rm${IFS}-rf${IFS}src/ok.txt"', /interactive shell/i],
	])(
		'%s denies',
		async (command, pattern) => {
			const got = await gate(command);
			expect(got.verdict).toBe('DENIED');
			expect(got.message).toMatch(pattern);
		},
		30_000,
	);

	test('disclosed conservative policy: an IN-SCOPE quoted compound payload denies too', async () => {
		// Quoted-compound-under-root-shell is unjudgeable regardless of the
		// operand text — pinned as intended (plan Fix 4).
		const got = await gate("sudo -i 'echo x > src/ok.txt'");
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/interactive shell/i);
	}, 30_000);

	test('plain multiword tails keep admitting (every word a bare word)', async () => {
		const got = await gate('sudo -i make build');
		expect(got.verdict).toBe('ADMITTED');
	}, 30_000);

	test('plain multiword tail with an option-looking word keeps admitting', async () => {
		const got = await gate('sudo -i git status --short');
		expect(got.verdict).toBe('ADMITTED');
	}, 30_000);

	test('bare-word twin still denies through the destructive channel', async () => {
		const got = await gate('sudo -i rm -rf ../outside');
		expect(got.verdict).toBe('DENIED');
	}, 30_000);
});
