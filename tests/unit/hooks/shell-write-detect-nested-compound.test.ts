/**
 * Nested-compound decomposition for the POSIX write detector.
 *
 * bash-parser 0.5.0 cannot parse compound statements nested inside a loop/if
 * body ("Unexpected 'Then'/'Do'/'In'"), so bog-standard read-only diagnostic
 * pipelines like `for d in …; do if [ -d "$d" ]; then grep …; fi; done` used
 * to hit the fail-closed parseError denial. The decomposition replaces the
 * qualifying bodies with the inert `:` no-op in a skeleton and analyzes every
 * real body as its own fragment, unioning writes. Pins: read-only nested
 * shapes parse clean, write-carrying nested shapes are still DETECTED
 * (body writes, done-redirects, if-condition writes, loop-head $(…) writes),
 * cd-context withdrawal for body writes, recursion for deeper nesting, and
 * fail-closed behavior for genuinely malformed keyword structures.
 */
import { describe, expect, test } from 'bun:test';
import {
	detectPosixWrites,
	resolveWriteTargets,
} from '../../../src/hooks/shell-write-detect';

describe('detectPosixWrites — nested compound decomposition', () => {
	describe('read-only nested shapes parse clean with no writes', () => {
		const readOnlyShapes = [
			'for d in ~/.cache/x ~/.config/y; do if [ -d "$d" ]; then echo "== $d"; grep -m1 version "$d/f.json" 2>/dev/null; fi; done',
			'for d in a b; do if [ -d "$d" ]; then echo x; fi; done',
			'for d in a b; do while true; do echo x; done; done',
			'for d in a b; do case x in a) echo 1;; esac; done',
			'if [ -d /tmp ]; then for d in a; do echo "$d"; done; fi',
			'if true; then if false; then echo x; fi; fi',
			'for x in 1 2; do for y in 3 4; do if true; then echo "$y"; fi; done; done',
			'for d in a b; do if [ -f "$d" ]; then cat "$d"; else echo missing; fi; done',
			'while read -r line; do if [ -n "$line" ]; then echo "$line"; fi; done < input.txt',
			'if grep -q x input; then while read -r l; do echo "$l"; done; else echo none; fi',
		];

		for (const command of readOnlyShapes) {
			test(`no parseError, no writes: ${command.slice(0, 60)}…`, () => {
				const analysis = detectPosixWrites(command);
				expect(analysis.parseError).not.toBe(true);
				expect(analysis.writes).toHaveLength(0);
				expect(analysis.hasWrites).toBe(false);
			});
		}
	});

	describe('write-carrying nested shapes are still detected', () => {
		test('redirect inside a nested if body', () => {
			const analysis = detectPosixWrites(
				'for d in a b; do if true; then echo x > /tmp/out.txt; fi; done',
			);
			expect(analysis.parseError).not.toBe(true);
			expect(
				analysis.writes.some(
					(write) => write.operator === '>' && write.path === '/tmp/out.txt',
				),
			).toBe(true);
		});

		test('destructive command inside a nested if body', () => {
			const analysis = detectPosixWrites(
				'for f in *.log; do if [ -f "$f" ]; then rm "$f"; fi; done',
			);
			expect(analysis.parseError).not.toBe(true);
			expect(analysis.writes.some((write) => write.operator === 'rm')).toBe(
				true,
			);
		});

		test('in-place edit inside a nested loop body', () => {
			const analysis = detectPosixWrites(
				'for f in a b; do if [ -f "$f" ]; then sed -i s/x/y/ "$f"; fi; done',
			);
			expect(analysis.parseError).not.toBe(true);
			expect(analysis.writes.some((write) => write.operator === 'sed -i')).toBe(
				true,
			);
		});

		test('loop redirect on done stays visible in the skeleton', () => {
			const analysis = detectPosixWrites(
				'for d in a b; do if true; then echo x; fi; done > /tmp/done-redirect.txt',
			);
			expect(analysis.parseError).not.toBe(true);
			expect(
				analysis.writes.some(
					(write) =>
						write.operator === '>' && write.path === '/tmp/done-redirect.txt',
				),
			).toBe(true);
		});

		test('write in the if condition stays visible in the skeleton', () => {
			const analysis = detectPosixWrites(
				'if grep -q x input > /tmp/cond.txt; then for d in a; do echo "$d"; done; fi',
			);
			expect(analysis.parseError).not.toBe(true);
			expect(
				analysis.writes.some(
					(write) => write.operator === '>' && write.path === '/tmp/cond.txt',
				),
			).toBe(true);
		});

		test('write in the loop-head word list stays visible in the skeleton', () => {
			const analysis = detectPosixWrites(
				'for d in $(ls > /tmp/head.txt); do if true; then echo "$d"; fi; done',
			);
			expect(analysis.parseError).not.toBe(true);
			expect(
				analysis.writes.some(
					(write) =>
						write.operator.includes('$(') && write.path === '/tmp/head.txt',
				),
			).toBe(true);
		});

		test('sibling loops both decompose in one pass', () => {
			const analysis = detectPosixWrites(
				'for a in 1 2; do if true; then echo "$a" > /tmp/one.txt; fi; done; for b in 3 4; do if true; then echo "$b" > /tmp/two.txt; fi; done',
			);
			expect(analysis.parseError).not.toBe(true);
			const paths = analysis.writes.map((write) => write.path);
			expect(paths).toContain('/tmp/one.txt');
			expect(paths).toContain('/tmp/two.txt');
		});
	});

	describe('cd-context and safety semantics', () => {
		test('a cd in the skeleton withdraws nested body writes', () => {
			const analysis = detectPosixWrites(
				'cd /tmp && for d in a b; do if true; then echo x > out.txt; fi; done',
			);
			expect(analysis.parseError).not.toBe(true);
			const out = analysis.writes.find(
				(write) => write.operator === '>' && write.path === 'out.txt',
			);
			expect(out).toBeDefined();
			expect(out?.unresolvedContext).toBe(true);
		});

		test('no cd means body writes resolve normally', () => {
			const analysis = detectPosixWrites(
				'for d in a b; do if true; then echo x > out.txt; fi; done',
			);
			const out = analysis.writes.find(
				(write) => write.operator === '>' && write.path === 'out.txt',
			);
			expect(out).toBeDefined();
			expect(out?.unresolvedContext).not.toBe(true);
		});

		test('a skeleton write after a cd-free block still resolves (no over-withdrawal)', () => {
			const analysis = detectPosixWrites(
				'for d in a b; do if true; then echo y; fi; done; echo x > /tmp/post.txt',
			);
			const post = analysis.writes.find(
				(write) => write.operator === '>' && write.path === '/tmp/post.txt',
			);
			expect(post).toBeDefined();
			expect(post?.unresolvedContext).not.toBe(true);
		});
	});

	// #2703-review F-001 (resolver level): a directory-change word inside a
	// nested BODY breaks the static ordering between the decomposed pieces —
	// loop/if bodies run zero or more times between skeleton statements, so a
	// skeleton write after the block, and a body write before its own cd,
	// both land at the post-cd directory on later iterations. Every write of
	// the decomposed command must be withdrawn (resolvedPath null, resolved
	// false) so the live gate denies fail-closed — never resolved against the
	// workspace/lane cwd.
	describe('cd in a nested body withdraws everything (resolver level)', () => {
		const shapes: Array<{ command: string; writePath: string; label: string }> =
			[
				{
					command:
						'for i in 1; do if true; then cd /etc; fi; done; echo x > hosts',
					writePath: 'hosts',
					label: 'cd in an if body; write after the loop',
				},
				{
					command:
						'for i in 1; do case $i in 1) cd /etc;; esac; done; echo x > hosts',
					writePath: 'hosts',
					label: 'cd in a case arm; write after the loop',
				},
				{
					command:
						'for i in 1; do while true; do pushd /etc; break; done; done; echo x > hosts',
					writePath: 'hosts',
					label: 'pushd in a nested loop; write after the outer loop',
				},
				{
					command:
						'for i in 1; do if true; then echo x > hosts; cd /etc; fi; done',
					writePath: 'hosts',
					label: 'write before the cd inside the same body (iteration 2 lands post-cd)',
				},
				{
					command:
						'for i in 1; do if true; then cd /etc; echo x > hosts; fi; done',
					writePath: 'hosts',
					label: 'cd and write both inside the body',
				},
				{
					command:
						'for d in packages/a packages/b; do if [ -d "$d" ]; then cd "$d"; npm test > out.txt; cd -; fi; done',
					writePath: 'out.txt',
					label: 'honest-agent per-package test run (dynamic cd target)',
				},
				{
					command:
						'for i in 1; do if true; then cd ..; fi; done; echo x > file.txt',
					writePath: 'file.txt',
					label: 'cd .. in a body (lane-relative landing)',
				},
			];

		for (const { command, writePath, label } of shapes) {
			test(`denied, never resolved at the starting cwd: ${label}`, () => {
				const analysis = detectPosixWrites(command);
				expect(analysis.parseError).not.toBe(true);
				const write = analysis.writes.find(
					(candidate) => candidate.path === writePath,
				);
				expect(write).toBeDefined();
				expect(write?.unresolvedContext).toBe(true);

				const cwd = '/tmp/ws-probe';
				const resolvedTargets = resolveWriteTargets(
					command,
					analysis.writes,
					cwd,
				);
				const target = resolvedTargets.find(
					(entry) => entry.original === write,
				);
				expect(target).toBeDefined();
				expect(target?.resolved).toBe(false);
				expect(target?.resolvedPath).toBeNull();
			});
		}

		test('the skeleton-cd shape keeps its body-write withdrawal at the resolver too', () => {
			const command =
				'cd /tmp && for d in a b; do if true; then echo x > out.txt; fi; done';
			const analysis = detectPosixWrites(command);
			const out = analysis.writes.find(
				(write) => write.operator === '>' && write.path === 'out.txt',
			);
			expect(out).toBeDefined();
			const resolvedTargets = resolveWriteTargets(
				command,
				analysis.writes,
				'/tmp/ws-probe',
			);
			const target = resolvedTargets.find((entry) => entry.original === out);
			expect(target?.resolved).toBe(false);
			expect(target?.resolvedPath).toBeNull();
		});
	});

	describe('fail-closed behavior is preserved', () => {
		const malformedShapes = [
			// Stray done without an opener.
			'for d in a b; do echo x; done; done',
			// Unclosed if.
			'if true; then echo x',
			// Unclosed loop body.
			'for d in a b; do if true; then echo x; fi',
			// A body that is itself malformed cannot rescue the command.
			'for d in a b; do if true; then echo "unclosed; fi; done',
		];

		for (const command of malformedShapes) {
			test(`parseError preserved: ${command.slice(0, 60)}`, () => {
				const analysis = detectPosixWrites(command);
				expect(analysis.parseError).toBe(true);
			});
		}
	});
});
