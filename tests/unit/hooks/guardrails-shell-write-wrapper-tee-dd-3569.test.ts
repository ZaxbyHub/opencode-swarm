/**
 * #3569 core shipped suite — wrapper-consumed tee/dd operand windows.
 *
 * The tee/dd branches of detectBuiltinWrites read the WRAPPER-CONSUMED token
 * tail (#3485 PRR-006 pattern), and the canonical dcPreprocessWrappers chdir
 * rewrite feeds detection+resolution (the same pipeline the gate, explain,
 * and scope_validate all route through). In-scope operands admit with the
 * REAL target resolved at the child cwd — no fabricated `ws\tee`/`ws\src`
 * destinations; escaping operands deny naming the real path.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { dcPreprocessWrappers } from '../../../src/hooks/guardrails/destructive-command';
import {
	detectPosixWrites,
	resolveWriteTargets,
} from '../../../src/hooks/shell-write-detect';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { evaluateScopeValidate } from '../../../src/tools/scope-validate';
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

async function gate(command: string): Promise<'ADMITTED' | string> {
	const ws = canonicalMkdtemp('wtd3569-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `wtd3569-s${++counter}`;
	const callID = `wtd3569-call-${counter}`;
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
		return 'ADMITTED';
	} catch (error) {
		return (error as Error).message.split('\n')[0] ?? 'DENIED';
	} finally {
		resetSwarmState();
	}
}

/** The gate's own pipeline: preprocess -> detect -> resolve. */
function mirroredTargets(ws: string, command: string): string[] {
	// The cd target must EXIST for the resolver to treat the && cd branch as
	// deterministic (the W1 dual-outcome model resolves a nonexistent target
	// under both cwd outcomes) — mirrors the gate fixture's workspace.
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const pre = dcPreprocessWrappers(command);
	expect(pre.failClosed).toBe(false);
	const detectionCommand = pre.changed ? pre.command : command;
	const analysis = detectPosixWrites(detectionCommand);
	return resolveWriteTargets(detectionCommand, analysis.writes, ws).map(
		(r) => r.resolvedPath ?? 'null',
	);
}

beforeEach(() => {
	resetSwarmState();
});

describe('gate verdicts', () => {
	test('wrapper-prefixed in-scope tee/dd ADMIT (no fabricated targets)', async () => {
		for (const cmd of [
			'sudo -D src tee a',
			'sudo --chdir=src tee a',
			'env -C src tee ok.txt',
			'sudo -D src dd of=a',
		]) {
			expect(await gate(cmd)).toBe('ADMITTED');
		}
	});
	test('escaping operands DENY naming the real target', async () => {
		expect(await gate('sudo -D src tee ../../esc')).toContain('esc');
		expect(await gate('sudo -D src dd of=../../esc')).toContain('esc');
	});
	test('plain neighbors unchanged', async () => {
		expect(await gate('tee src/f')).toBe('ADMITTED');
		expect(await gate('dd of=src/f')).toBe('ADMITTED');
		expect(await gate('tee ../../esc')).not.toBe('ADMITTED');
	});
});

describe('mirrored pipeline resolves exactly the real child-cwd target', () => {
	test('sudo -D src tee a -> exactly [<ws>/src/a] (union-shaped dedupe)', () => {
		const ws = canonicalMkdtemp('wtd3569-det-');
		created.push(ws);
		const targets = mirroredTargets(ws, 'sudo -D src tee a');
		expect(targets).toEqual([path.resolve(ws, 'src', 'a')]);
	});
	test('env -C src tee ok.txt -> exactly [<ws>/src/ok.txt]', () => {
		const ws = canonicalMkdtemp('wtd3569-det-');
		created.push(ws);
		const targets = mirroredTargets(ws, 'env -C src tee ok.txt');
		expect(targets).toEqual([path.resolve(ws, 'src', 'ok.txt')]);
	});
	test('escaping operand resolves to the child-cwd escape path', () => {
		const ws = canonicalMkdtemp('wtd3569-det-');
		created.push(ws);
		const expected = path.resolve(path.resolve(ws, 'src'), '..', '..', 'esc');
		expect(mirroredTargets(ws, 'sudo -D src dd of=../../esc')).toEqual([
			expected,
		]);
		expect(mirroredTargets(ws, 'sudo -D src tee ../../esc')).toEqual([
			expected,
		]);
	});
});

describe('consumer parity: scope_validate and explain (plan F2 requirement)', () => {
	test('explain matches the gate for wrapper tee shapes (block/allow)', async () => {
		// The explain service signature: (directory, args) with args like the
		// CLI: --agent coder --scope <dir> <command words...>. Assert the
		// rendered DECISION (block/allow), per the parity-test rule.
		const ws = canonicalMkdtemp('wtd3569-explain-');
		created.push(ws);
		mkdirSync(path.join(ws, 'src'), { recursive: true });
		const scopeArg = path.join(ws, 'src');
		const blocked = await handleGuardrailExplain(ws, [
			'--agent',
			'coder',
			'--scope',
			scopeArg,
			'sudo',
			'-D',
			'src',
			'tee',
			'../../esc',
		]);
		expect(blocked).toContain('Decision | block');
		const allowed = await handleGuardrailExplain(ws, [
			'--agent',
			'coder',
			'--scope',
			scopeArg,
			'sudo',
			'-D',
			'src',
			'tee',
			'a',
		]);
		expect(allowed).toContain('Decision | allow');
	});
	test('scope_validate evaluates wrapper commands through the real consumer (mutation-sensitive)', () => {
		// REAL consumer call (4.5 r2: the prior leg mirrored the pipeline and
		// stayed green with scope-validate's preprocessing branch removed).
		// In-scope wrapper write: allowed with exactly the child-cwd target;
		// escaping operand: denied.
		const ws = canonicalMkdtemp('wtd3569-parity-');
		created.push(ws);
		mkdirSync(path.join(ws, 'src'), { recursive: true });
		const ok = evaluateScopeValidate(
			{
				command: 'sudo -D src tee a',
				shell: 'posix',
				scope_files: ['src/'],
			},
			ws,
		);
		expect(ok.allowed).toBe(true);
		// Targets are workspace-relative: the wrapper-chdir resolution put
		// the operand under src/ (NOT the parent-cwd `a` the raw window
		// produced pre-fix).
		expect(ok.targets?.map((t) => t.path)).toEqual(['src/a']);
		let denied: unknown = null;
		try {
			evaluateScopeValidate(
				{
					command: 'sudo -D src tee ../../esc',
					shell: 'posix',
					scope_files: ['src/'],
				},
				ws,
			);
		} catch (error) {
			denied = error;
		}
		expect((denied as Error)?.message).toContain('ROOT_ESCAPE');
	});
});

describe('inplace wrapper window (4.5 r3 reviewer Critical)', () => {
	test('a chdir-wrapped sed with a braced script emits every branch file', async () => {
		// env -C src sed -i {s/a/b/,../../outside} y — bash edits BOTH
		// ../../outside and y; the detector must emit every branch (the
		// misaligned-arrays variant admitted this while real bash escaped).
		const got = await gate('env -C src sed -i {s/a/b/,../../outside} y');
		expect(got).not.toBe('ADMITTED');
	});
	test('plain and wrapped single-file inplace edits keep their verdicts', async () => {
		expect(await gate('sed -i s/a/b/ src/f')).toBe('ADMITTED');
		expect(await gate('sudo -D src sed -i s/a/b/ f')).toBe('ADMITTED');
	});
});

describe('consumer union parity: wrapper + brace shapes (4.5 r4)', () => {
	test('scope_validate denies the wrapper+brace sed and tee shapes the gate denies', () => {
		const ws = canonicalMkdtemp('wtd3569-r4-');
		created.push(ws);
		mkdirSync(path.join(ws, 'src'), { recursive: true });
		for (const command of [
			'env -C src sed -i {s/a/b/,../../outside} y',
			'env -C src tee {a,../../esc}',
			'env -C src awk -i inplace {1,../../outside}',
		]) {
			let threw: unknown = null;
			try {
				evaluateScopeValidate(
					{ command, shell: 'posix', scope_files: ['src/'] },
					ws,
				);
			} catch (error) {
				threw = error;
			}
			expect((threw as Error)?.message).toContain('SCOPE_VIOLATION');
		}
	});
	test('awk implicit program slot never consumes an expanding word (gate)', async () => {
		const got = await gate('env -C src awk -i inplace {1,../../outside}');
		expect(got).not.toBe('ADMITTED');
	});
});

describe('explain union kills: wrapper + brace shapes (4.5 r5)', () => {
	test('explain renders BLOCK for the shapes only the raw union catches', async () => {
		// Mutation-sensitive: disabling the explain union (the rawAnalysis
		// regain block) flips these to allow — the preprocessed analysis
		// alone serializes braces quoted.
		for (const words of [
			['env', '-C', 'src', 'tee', '{a,../../esc}'],
			['env', '-C', 'src', 'sed', '-i', '{s/a/b/,../../outside}', 'y'],
		]) {
			const ws = canonicalMkdtemp('wtd3569-r5-');
			created.push(ws);
			mkdirSync(path.join(ws, 'src'), { recursive: true });
			const out = await handleGuardrailExplain(ws, [
				'--agent',
				'coder',
				'--scope',
				path.join(ws, 'src'),
				...words,
			]);
			expect(out).toContain('Decision | block');
		}
	});
});

describe('awk program slot satisfies on expanding words (4.5 r5)', () => {
	test('an expanding awk program word satisfies the slot — the NEXT positional stays a file', async () => {
		// awk -i inplace {src,src/a} ../outside: the brace word supplies the
		// program; the branch files AND ../outside must all be reported (the
		// phantom-program variant dropped ../outside and ADMITTED).
		const got = await gate('awk -i inplace {src,src/a} ../outside');
		expect(got).not.toBe('ADMITTED');
	});
	test('all-in-scope variant admits (no over-block)', async () => {
		expect(await gate('awk -i inplace {src,src/a} src/y')).toBe('ADMITTED');
	});
});
