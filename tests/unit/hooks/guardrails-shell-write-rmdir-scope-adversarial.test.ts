/**
 * Adversarial coverage for the bare-rmdir empty-directory-removal exemption
 * (issue #3450, PR #3456 review F-2/F-3/F-5, FB-007). The exemption must hold
 * only for a single, literal, POSIX `rmdir <dir>` whose operand is exactly
 * the directory the kernel removes:
 * - a dedupe-key collision (same operand twice, a `cd` between them, or an
 *   `rmdir -p` of the same operand) demotes the write to the ordinary
 *   declared-scope check at every dedupe site;
 * - an operand with a `..` segment, a `#` anywhere in the command, a quoted
 *   or escaped operand, or a leading dash is never tagged;
 * - repository control state (`.git` / `.swarm`) is never exempt, even for a
 *   role (architect) that passes file authority for those paths.
 * Every gate case runs in its own fresh workspace and session.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { isEmptyDirectoryRemovalWithinWorkspace } from '../../../src/hooks/guardrails/tool-before';
import {
	detectPosixWrites,
	mergeWriteAnalyses,
	resolveWriteTargets,
	type WriteTarget,
} from '../../../src/hooks/shell-write-detect';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const isWin32 = process.platform === 'win32';
const SCOPE_VIOLATION =
	/^WRITE BLOCKED \[shell-write-scope\]: SCOPE_VIOLATION: shell write target /;
const created: string[] = [];
let counter = 0;

afterAll(() => {
	for (const dir of created) removeTreeWithRetry(dir);
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

/**
 * A fresh workspace plus a sibling directory outside it (both directly under
 * the canonical temp dir, so `cd ../<outside>` from the workspace reaches it).
 */
function freshWorkspace(dirs: string[] = []): { ws: string; outside: string } {
	const ws = canonicalMkdtemp('rmdir-adv-ws-');
	const outside = canonicalMkdtemp('rmdir-adv-out-');
	created.push(ws, outside);
	for (const dir of dirs) mkdirSync(path.join(ws, dir), { recursive: true });
	mkdirSync(path.join(outside, 'a'), { recursive: true });
	return { ws, outside: path.basename(outside) };
}

/** Runs `command` through the real guardrails toolBefore; returns the outcome. */
async function gate(
	role: string,
	ws: string,
	command: string,
	tool = 'bash',
): Promise<string> {
	const sessionID = `rmdir-adv-${++counter}`;
	const callID = `rmdir-adv-call-${counter}`;
	startAgentSession(sessionID, role);
	installActiveScopeBinding({
		directory: ws,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	const hooks = createGuardrailsHooks(ws, undefined, config());
	try {
		await hooks.toolBefore({ tool, sessionID, callID }, { args: { command } });
		return 'ADMITTED';
	} catch (error) {
		return (error as Error).message;
	}
}

function tagged(command: string): Array<[string | null, boolean]> {
	return detectPosixWrites(command).writes.map((w) => [
		w.path,
		w.emptyDirectoryRemoval === true,
	]);
}

const rmdirWrite = (p: string, tag: boolean): WriteTarget =>
	tag
		? {
				category: 'builtin_write',
				operator: 'rmdir',
				path: p,
				emptyDirectoryRemoval: true,
			}
		: { category: 'builtin_write', operator: 'rmdir', path: p };

describe('detectPosixWrites: which rmdir operands carry the tag', () => {
	it('tags a single literal operand and each distinct literal of a sequence', () => {
		expect(tagged('rmdir a')).toEqual([['a', true]]);
		expect(tagged('rmdir one; rmdir two')).toEqual([
			['one', true],
			['two', true],
		]);
		expect(tagged('rmdir one && rmdir two')).toEqual([
			['one', true],
			['two', true],
		]);
	});

	it('demotes EVERY occurrence of a repeated operand, with or without a cd between them', () => {
		// #3518 P-4: duplicate occurrences survive per-occurrence (suffixed
		// operator) so each is judged at its own cwd — and the #3456 demotion
		// defense applies to every survivor of a colliding key (a repeated
		// operand may run under different working directories).
		expect(tagged('rmdir a; rmdir a')).toEqual([
			['a', false],
			['a', false],
		]);
		expect(tagged('rmdir a; cd ../o && rmdir a')).toEqual([
			['a', false],
			['a', false],
		]);
	});

	it('keeps an untagged write when rmdir -p shares the operand (either order)', () => {
		for (const command of ['rmdir a; rmdir -p a', 'rmdir -p a; rmdir a']) {
			const forA = tagged(command).filter(([p]) => p === 'a');
			expect(forA.length).toBeGreaterThan(0);
			expect(forA.every(([, isTagged]) => !isTagged)).toBe(true);
		}
	});

	it.each([
		['a `..` segment after a link', 'rmdir link/../x'],
		['a `..` segment', 'rmdir a/../b'],
		['a bare `..`', 'rmdir ..'],
		['a mid-word `#` (bash reads one word)', 'rmdir d#/x'],
		['a trailing comment', 'rmdir x # note'],
		['a double-quoted operand', 'rmdir "a"'],
		['a single-quoted operand', "rmdir 'a'"],
		['a backslash-escaped operand', 'rmdir a\\b'],
	])('never tags %s', (_label, command) => {
		const writes = tagged(command);
		expect(writes.length).toBeGreaterThan(0);
		expect(writes.every(([, isTagged]) => !isTagged)).toBe(true);
	});

	it('never tags a single leading-dash operand', () => {
		expect(
			detectPosixWrites('rmdir -weird').writes.some(
				(w) => w.emptyDirectoryRemoval === true,
			),
		).toBe(false);
	});

	it('keeps an upper-case RMDIR under its own key; the cd withdraws both tags', () => {
		const writes = detectPosixWrites('rmdir a; cd ../o && RMDIR a').writes;
		expect(writes.map((w) => [w.operator, w.emptyDirectoryRemoval])).toEqual([
			['rmdir', undefined],
			['RMDIR', undefined],
		]);
	});
});

describe('dedupe sites demote a colliding tagged write', () => {
	it('resolveWriteTargets demotes a tagged write whose key repeats under a cd', () => {
		const input = [rmdirWrite('a', true)];
		const [result] = resolveWriteTargets(
			'rmdir a; cd /o && rmdir a',
			input,
			'/ws',
		);
		expect(result.original.emptyDirectoryRemoval).toBeUndefined();
		// The caller's object is not mutated.
		expect(input[0].emptyDirectoryRemoval).toBe(true);
		const [single] = resolveWriteTargets('rmdir a', input, '/ws');
		expect(single.original.emptyDirectoryRemoval).toBe(true);
	});

	it('resolveWriteTargets demotes a key repeated in the caller writes', () => {
		const result = resolveWriteTargets(
			'rmdir a',
			[rmdirWrite('a', true), rmdirWrite('a', false)],
			'/ws',
		);
		expect(result.map((r) => r.original.emptyDirectoryRemoval)).toEqual([
			undefined,
			undefined,
		]);
	});

	it('mergeWriteAnalyses demotes on an authority-key collision', () => {
		const primary = { writes: [rmdirWrite('a', true)], hasWrites: true };
		const merged = mergeWriteAnalyses(
			primary,
			{ writes: [rmdirWrite('a', false)], hasWrites: true },
			false,
		);
		expect(merged.writes).toEqual([rmdirWrite('a', false)]);
		expect(primary.writes[0].emptyDirectoryRemoval).toBe(true);
	});

	it('mergeWriteAnalyses demotes on a repeated key within one grammar', () => {
		const merged = mergeWriteAnalyses(
			{
				writes: [rmdirWrite('a', true), rmdirWrite('a', false)],
				hasWrites: true,
			},
			{ writes: [rmdirWrite('b', false)], hasWrites: true },
			false,
		);
		expect(merged.writes).toEqual([
			rmdirWrite('a', false),
			rmdirWrite('b', false),
		]);
	});
});

describe('real gate: sequences and operand shapes fall back to scope', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('rejects the same operand again after a cd outside the workspace', async () => {
		const { ws, outside } = freshWorkspace(['a']);
		expect(
			await gate('coder', ws, `rmdir a; cd ../${outside} && rmdir a`),
		).toMatch(SCOPE_VIOLATION);
	});

	it('rejects rmdir -p of the same operand after a cd outside', async () => {
		const { ws, outside } = freshWorkspace(['a']);
		expect(
			await gate('coder', ws, `rmdir a; cd ../${outside} && rmdir -p a`),
		).toMatch(SCOPE_VIOLATION);
	});

	it('rejects rmdir followed by rmdir -p of the same operand', async () => {
		const { ws } = freshWorkspace(['a']);
		expect(await gate('coder', ws, 'rmdir a; rmdir -p a')).toMatch(
			SCOPE_VIOLATION,
		);
	});

	it('rejects a cd into .swarm that reuses an exempt operand', async () => {
		const { ws } = freshWorkspace(['lk', '.swarm/lk']);
		expect(await gate('coder', ws, 'rmdir lk; cd .swarm && rmdir lk')).toMatch(
			SCOPE_VIOLATION,
		);
	});

	it('still scope-checks the other writes of a mixed sequence', async () => {
		const { ws } = freshWorkspace(['ok']);
		expect(await gate('coder', ws, 'rmdir ok; echo x > other.txt')).toMatch(
			SCOPE_VIOLATION,
		);
	});

	it('rejects rmdir of the workspace root itself', async () => {
		const { ws } = freshWorkspace();
		expect(await gate('coder', ws, 'rmdir .')).toMatch(SCOPE_VIOLATION);
	});

	it('rejects an operand whose `..` follows a link out of the workspace', async () => {
		const { ws, outside } = freshWorkspace();
		const outsideAbs = path.join(path.dirname(ws), outside);
		mkdirSync(path.join(outsideAbs, 'inner'), { recursive: true });
		symlinkSync(
			path.join(outsideAbs, 'inner'),
			path.join(ws, 'link'),
			isWin32 ? 'junction' : 'dir',
		);
		// The kernel removes <outside>/a; the lexical reading is <ws>/a.
		expect(await gate('coder', ws, 'rmdir link/../a')).toMatch(SCOPE_VIOLATION);
	});

	it('rejects an operand with a mid-word `#`', async () => {
		const { ws } = freshWorkspace(['d#/x']);
		expect(await gate('coder', ws, 'rmdir d#/x')).toMatch(SCOPE_VIOLATION);
	});

	it('resolves an upper-case RMDIR after a cd in its own context', async () => {
		// Distinct dedupe keys keep distinct cwd contexts, so the second write
		// resolves outside the workspace and file authority refuses it. The
		// first operand is in scope, so it passes without the exemption (the
		// cd withdraws every tag in the line).
		const { ws, outside } = freshWorkspace(['src/a']);
		expect(
			await gate('coder', ws, `rmdir src/a; cd ../${outside} && RMDIR src/a`),
		).toMatch(
			/^WRITE BLOCKED: Agent "coder" is not authorised to write .*AUTHORITY_ROOT_ESCAPE/,
		);
	});
});

describe('real gate: control state is never exempt (FB-007)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it.each([
		['.swarm/lk'],
		['.git/gk'],
	])('rejects an architect bound to src/ removing %s', async (target) => {
		const { ws } = freshWorkspace([target]);
		expect(await gate('architect', ws, `rmdir ${target}`)).toMatch(
			SCOPE_VIOLATION,
		);
	});

	it('keeps the coder control-state authority refusal', async () => {
		const { ws } = freshWorkspace(['.swarm/lk']);
		expect(await gate('coder', ws, 'rmdir .swarm/lk')).toMatch(
			/^WRITE BLOCKED: Agent "coder" is not authorised to write .*repository control state/,
		);
	});

	it('explains a coder rmdir of .swarm content as blocked', async () => {
		const { ws } = freshWorkspace(['.swarm/lk']);
		const explained = await handleGuardrailExplain(ws, [
			'--agent',
			'coder',
			'--scope',
			'src',
			'rmdir',
			'.swarm/lk',
		]);
		expect(explained).toMatch(/\| *Decision *\| *block */i);
		expect(explained).toContain('scope_violation');
	});
});

describe('real gate: the exemption still admits plain cases', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('admits a coder removing an out-of-scope workspace directory', async () => {
		const { ws } = freshWorkspace(['.scratch/one']);
		expect(await gate('coder', ws, 'rmdir .scratch/one')).toBe('ADMITTED');
	});

	it('admits a coder removing two distinct directories in sequence', async () => {
		const { ws } = freshWorkspace(['.scratch/one', '.scratch/two']);
		expect(
			await gate('coder', ws, 'rmdir .scratch/one && rmdir .scratch/two'),
		).toBe('ADMITTED');
	});

	it('admits an architect removing an out-of-scope non-control directory', async () => {
		const { ws } = freshWorkspace(['.scratch/arch']);
		expect(await gate('architect', ws, 'rmdir .scratch/arch')).toBe('ADMITTED');
	});
});

describe('isEmptyDirectoryRemovalWithinWorkspace: control state', () => {
	it('rejects targets under .git and .swarm, present or missing', () => {
		const { ws } = freshWorkspace(['.git/x', '.swarm/x', 'sub/.git/x']);
		for (const target of [
			'.git/x',
			'.swarm/x',
			'.swarm/missing',
			'sub/.git/x',
			path.join(ws, '.swarm', 'x'),
		]) {
			expect(isEmptyDirectoryRemovalWithinWorkspace(target, ws)).toBe(false);
		}
		expect(isEmptyDirectoryRemovalWithinWorkspace('sub/x', ws)).toBe(true);
	});

	it('rejects a case variant of a control directory', () => {
		// On a case-insensitive volume (win32, default macOS) `.SWARM` IS
		// `.swarm`; on a case-sensitive one the parent does not exist.
		const { ws } = freshWorkspace(['.swarm/x', '.git/x']);
		expect(isEmptyDirectoryRemovalWithinWorkspace('.SWARM/x', ws)).toBe(false);
		expect(isEmptyDirectoryRemovalWithinWorkspace('.Git/x', ws)).toBe(false);
	});

	it('rejects a case variant even when it is its own directory', () => {
		// The exact-case directories exist, so on a case-sensitive volume
		// (Linux) the parent resolves and only the lower-case fold in
		// isControlStateRelativePath keeps the result false; on a
		// case-insensitive volume the variant is the control directory itself.
		const { ws } = freshWorkspace(['.SWARM', '.Git']);
		expect(isEmptyDirectoryRemovalWithinWorkspace('.SWARM/x', ws)).toBe(false);
		expect(isEmptyDirectoryRemovalWithinWorkspace('.Git/x', ws)).toBe(false);
	});

	it('rejects a link into .swarm (canonical location)', () => {
		const { ws } = freshWorkspace(['.swarm/x']);
		symlinkSync(
			path.join(ws, '.swarm'),
			path.join(ws, 'ctl-link'),
			isWin32 ? 'junction' : 'dir',
		);
		expect(isEmptyDirectoryRemovalWithinWorkspace('ctl-link/x', ws)).toBe(
			false,
		);
	});

	it('rejects a .swarm link that points elsewhere (lexical location)', () => {
		const { ws } = freshWorkspace(['elsewhere/x']);
		symlinkSync(
			path.join(ws, 'elsewhere'),
			path.join(ws, '.swarm'),
			isWin32 ? 'junction' : 'dir',
		);
		expect(isEmptyDirectoryRemovalWithinWorkspace('.swarm/x', ws)).toBe(false);
		expect(isEmptyDirectoryRemovalWithinWorkspace('elsewhere/x', ws)).toBe(
			true,
		);
	});
});
