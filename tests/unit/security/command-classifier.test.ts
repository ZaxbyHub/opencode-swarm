import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { classifyCommandRisk } from '../../../src/full-auto/policy';
import {
	classifyCommand,
	getSharedClassifierGuardrailBlock,
} from '../../../src/security/command-classifier.js';
import { evaluateScopeValidate } from '../../../src/tools/scope-validate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('shared command classifier', () => {
	test('uses most severe compound segment', () => {
		const result = classifyCommand('echo safe && git reset --hard HEAD');
		expect(result.aggregate).toBe('destructive');
		expect(
			result.segments.some((entry) => entry.category === 'destructive'),
		).toBe(true);
	});

	test('classifies find -delete as destructive', () => {
		expect(classifyCommand('find . -delete').aggregate).toBe('destructive');
	});

	test('surfaces shared immediate-block metadata for unconditional destructive commands only', () => {
		const findDelete = classifyCommand('find . -delete');
		expect(getSharedClassifierGuardrailBlock(findDelete)).toEqual({
			ruleId: 'find-delete',
			category: 'destructive',
			destructiveCategory: 'find delete',
			message:
				'BLOCKED: "find -delete" detected — dynamic delete expansion is not allowed from shell commands',
		});

		const scopedDelete = classifyCommand('rm -rf build');
		expect(scopedDelete.aggregate).toBe('destructive');
		expect(getSharedClassifierGuardrailBlock(scopedDelete)).toBeNull();
	});

	test('does not overstate bare mkfs without a typed filesystem suffix', () => {
		expect(classifyCommand('mkfs /dev/sdb').aggregate).toBe('unknown');
		expect(classifyCommand('mkfs.ext4 /dev/sdb').aggregate).toBe(
			'catastrophic',
		);
	});

	test('never treats substitutions or interpreter pipelines as safe', () => {
		expect(classifyCommand('echo $(cat file)').aggregate).toBe('unknown');
		expect(classifyCommand('printf payload | bash').aggregate).toBe('unknown');
	});

	test('treats $IFS indirection as ambiguous shell syntax', () => {
		const result = classifyCommand('echo$IFShello');
		expect(result.aggregate).toBe('unknown');
		expect(result.ambiguous).toBe(true);
	});

	test('normalizes wrappers and quote splicing', () => {
		expect(classifyCommand('bash -c "r""m -rf node_modules"').aggregate).toBe(
			'destructive',
		);
	});

	test('fails unknown on unmatched quotes and oversized commands', () => {
		expect(classifyCommand("echo 'unterminated").aggregate).toBe('unknown');
		expect(classifyCommand(`echo ${'x'.repeat(70_000)}`).aggregate).toBe(
			'unknown',
		);
	});

	test('returns an immutable bounded result without raw-command persistence', () => {
		const result = classifyCommand('git status');
		expect(result.aggregate).toBe('safe');
		expect(result.originalDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.segments)).toBe(true);
	});
});

describe('windows-recursive-delete: nested-path rmdir is not a cmd.exe switch (#3505 AC3)', () => {
	test.each([
		'rmdir src/share/opencode2',
		'rmdir /tmp/Scratch',
		'rmdir keg/share/x',
		'del src/s/q/f.txt',
	])('classifies %s without a windows-recursive-delete segment', (command) => {
		const result = classifyCommand(command);
		expect(
			result.segments.some(
				(entry) => entry.ruleId === 'windows-recursive-delete',
			),
		).toBe(false);
		expect(result.aggregate).not.toBe('destructive');
	});

	// Deliberate widening pin (#3505 disclosed Out-of-scope consequence): per
	// cmd.exe grammar a quoted "/s" is a PATH, not a switch, so the token-aware
	// rewrite stops matching quoted switch text. These rows are matched by
	// today's substring rule and intentionally flip.
	test.each([
		'rmdir "dir /s name"',
		'rd "/s" x',
	])('deliberate widening: %s is not matched by windows-recursive-delete (quoted switch text is a path)', (command) => {
		expect(
			classifyCommand(command).segments.some(
				(entry) => entry.ruleId === 'windows-recursive-delete',
			),
		).toBe(false);
	});

	test('Full-Auto classifyCommandRisk does not deny the nested-path rows', () => {
		for (const command of [
			'rmdir src/share/opencode2',
			'rmdir /tmp/Scratch',
			'rmdir keg/share/x',
		]) {
			expect(
				classifyCommandRisk(command, '.', { directory: '.' }).decision,
			).not.toBe('deny');
		}
		expect(
			classifyCommandRisk('rmdir /s build', '.', { directory: '.' }).decision,
		).toBe('deny');
	});
});

describe('scope_validate consumer: nested-path rmdirs are no longer destructive (#3505 AC3, plan-critic R2-2)', () => {
	const SV_DIR = canonicalMkdtemp('classifier-scope-validate-');
	// #3512 review N-4: remove the fixture dir so the suite does not leak
	// classifier-scope-validate-* directories into the system temp root.
	afterAll(() => {
		rmSync(SV_DIR, { recursive: true, force: true });
	});
	const outcome = (command: string): { allowed: boolean; code?: string } => {
		try {
			evaluateScopeValidate(
				{ command, shell: 'posix', scope_files: ['src/'] },
				SV_DIR,
			);
			return { allowed: true };
		} catch (err) {
			const e = err as { code?: string };
			return { allowed: false, code: e.code ?? 'UNKNOWN' };
		}
	};

	test('in-scope nested-path rmdir is allowed', () => {
		expect(outcome('rmdir src/share/opencode2').allowed).toBe(true);
	});

	test('out-of-scope nested-path rmdirs no longer fail DESTRUCTIVE_COMMAND', () => {
		for (const command of ['rmdir /tmp/Scratch', 'rmdir keg/share/x']) {
			expect(outcome(command).code).not.toBe('DESTRUCTIVE_COMMAND');
		}
	});

	test('true-positive floor: rmdir /s build still fails DESTRUCTIVE_COMMAND', () => {
		expect(outcome('rmdir /s build').code).toBe('DESTRUCTIVE_COMMAND');
	});
});

describe('glued cmd-delimiter recursive deletes stay destructive (#3512 review F-1)', () => {
	test.each([
		'(rd nx /s)',
		'(rd /s /q nx)',
		'rd nx /s>nul',
		'rd nx /s/q>nul',
		'if exist nx (rd nx /S)',
	])('%s keeps a destructive windows-recursive-delete segment', (command) => {
		const result = classifyCommand(command);
		expect(
			result.segments.some(
				(entry) =>
					entry.category === 'destructive' &&
					entry.ruleId === 'windows-recursive-delete',
			),
		).toBe(true);
	});

	test('quoted switch-looking tokens still stay non-matching (disclosed widening)', () => {
		for (const command of ['rd "/s" x', 'rmdir "dir /s name"']) {
			expect(
				classifyCommand(command).segments.some(
					(s) => s.ruleId === 'windows-recursive-delete',
				),
			).toBe(false);
		}
	});
});

describe('glued cmd-delimiter consumers (#3512 review F-1)', () => {
	const SV_DIR2 = canonicalMkdtemp('classifier-glued-sv-');
	afterAll(() => {
		rmSync(SV_DIR2, { recursive: true, force: true });
	});
	const outcome = (command: string): { allowed: boolean; code?: string } => {
		try {
			evaluateScopeValidate(
				{ command, shell: 'cmd', scope_files: ['src/'] },
				SV_DIR2,
			);
			return { allowed: true };
		} catch (err) {
			const e = err as { code?: string };
			return { allowed: false, code: e.code ?? 'UNKNOWN' };
		}
	};

	test('paren-glued recursive delete fails DESTRUCTIVE_COMMAND (shell=cmd)', () => {
		expect(outcome('(rd ../../outside /s)').code).toBe('DESTRUCTIVE_COMMAND');
	});

	test('redirect-glued recursive delete fails DESTRUCTIVE_COMMAND (shell=cmd)', () => {
		expect(outcome('rd ../../outside /s>nul').code).toBe('DESTRUCTIVE_COMMAND');
	});
});
