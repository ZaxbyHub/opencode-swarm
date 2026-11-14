import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const checkpoint = path.resolve(
	'.opencode/skills/swarm-pr-review/scripts/lane_checkpoint.sh',
);
const validator = path.resolve(
	'.opencode/skills/issue-tracer/scripts/trace-check.sh',
);
const slug = 'release-checkpoint';
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

function setup() {
	const root = canonicalMkdtemp('dispatch-3600-review-');
	roots.push(root);
	const trace = path.join('.agents', 'issue-traces', slug);

	function write(file: string, content: string) {
		const destination = path.join(root, file);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.writeFileSync(destination, content);
	}

	function run(args: string[]) {
		const result = Bun.spawnSync({
			cmd: args,
			cwd: root,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 20_000,
		});
		return {
			code: result.exitCode,
			stdout: result.stdout.toString(),
			output: result.stdout.toString() + result.stderr.toString(),
		};
	}

	function git(...args: string[]) {
		const result = run(['git', ...args]);
		if (result.code !== 0) throw new Error(result.output);
		return result.stdout.trim();
	}

	function runScript(script: string, ...args: string[]) {
		return run(bashCommand(script, ...args));
	}

	return { root, trace, write, git, runScript };
}

test('a review lane emits its partial rows and unsettled coverage at either budget', () => {
	const { root, write, runScript } = setup();
	const rows = '| F1 | src/feature.ts | 23 | invalid state |\n';
	write('partial rows.md', rows);
	function observe(toolUses: string, elapsedSeconds: string) {
		return runScript(
			checkpoint,
			'--tool-uses',
			toolUses,
			'--max-tool-uses',
			'12',
			'--elapsed-seconds',
			elapsedSeconds,
			'--max-seconds',
			'30',
			'--lane-id',
			'lane-a',
			'--dimension',
			'correctness',
			'--rows',
			'partial rows.md',
		);
	}

	const active = observe('11', '29');
	expect(active.code, active.output).toBe(0);
	expect(active.output).not.toContain('UNSETTLED');

	for (const [uses, seconds] of [
		['12', '29'],
		['11', '30'],
	]) {
		const exhausted = observe(uses, seconds);
		expect(exhausted.code, exhausted.output).toBe(3);
		expect(exhausted.output).toContain('UNSETTLED');
		expect(exhausted.output).toContain('lane-a');
		expect(exhausted.output).toContain('correctness');
		expect(exhausted.output.replaceAll('\r\n', '\n')).toContain(rows);
		expect(exhausted.output).not.toContain('APPROVE');
	}

	const invalid = observe('twelve', '29');
	expect(invalid.code).not.toBe(0);
	expect(invalid.output).not.toContain('APPROVE');
	expect(fs.readFileSync(path.join(root, 'partial rows.md'), 'utf8')).toBe(
		rows,
	);
}, 30_000);

test('merge admission requires a complete broad review of the exact release head', () => {
	const { trace, write, git, runScript } = setup();
	git('init', '-q', '-b', 'main');
	git('config', 'user.name', 'Release fixture');
	git('config', 'user.email', 'trace@example.invalid');
	write('feature.txt', 'base\n');
	git('add', 'feature.txt');
	git('commit', '-qm', 'base');
	const base = git('rev-parse', 'HEAD');
	write('feature.txt', 'head\n');
	git('commit', '-qam', 'head');
	const head = git('rev-parse', 'HEAD');
	const tree = git('rev-parse', 'HEAD^{tree}');

	function state(releaseBound: boolean) {
		write(
			path.join(trace, 'state.md'),
			[
				'# Trace State: release-checkpoint',
				'protocol: 3.0.0',
				'phase: 5.1',
				'tier: M',
				'classification: VALID',
				'base-ref: main',
				'base-sha: ' + base,
				'freshness: synced',
				'phase0-tree-id: ' + tree,
				'checkpoint-tree-id: ' + tree,
				'handshake: MATCH',
				'tools: none',
				'merge: APPROVED:' + head,
				'release-bound: ' + (releaseBound ? 'yes' : 'no'),
				'next-action: merge',
				'',
				'## Gates',
				'| gate | verdict | reviewed-commit | tree-id | artifact |',
				'|---|---|---|---|---|',
				'| merge-approval | RECORDED | ' +
					head +
					' | ' +
					tree +
					' | 10b-merge-approval.md |',
				'',
			].join('\n'),
		);
	}

	function review(revision: string, status: string, verdict: string) {
		write(
			path.join(trace, '10c-broad-review.md'),
			[
				'# Broad review receipt',
				'reviewed-commit: ' + revision,
				'status: ' + status,
				'verdict: ' + verdict,
				'',
			].join('\n'),
		);
	}

	write(
		path.join(trace, '10b-merge-approval.md'),
		[
			'## User approval (verbatim)',
			'Approved.',
			'## PR head SHA',
			head,
			'## Final critic reviewed-commit',
			head,
			'',
		].join('\n'),
	);

	const merge = () => runScript(validator, 'merge', '--slug', slug);
	state(false);
	const ordinary = merge();
	expect(ordinary.code, ordinary.output).toBe(0);

	state(true);
	const missing = merge();
	expect(missing.code, missing.output).not.toBe(0);
	expect(missing.output).toMatch(/broad[- ]review/i);

	review(base, 'COMPLETE', 'APPROVE');
	const stale = merge();
	expect(stale.code, stale.output).not.toBe(0);
	expect(stale.output).toMatch(/broad[- ]review/i);

	review(head, 'PARTIAL', 'APPROVE');
	const incomplete = merge();
	expect(incomplete.code, incomplete.output).not.toBe(0);
	expect(incomplete.output).toMatch(/broad[- ]review/i);

	review(head, 'COMPLETE', 'REQUEST_CHANGES');
	const rejected = merge();
	expect(rejected.code, rejected.output).not.toBe(0);
	expect(rejected.output).toMatch(/broad[- ]review/i);

	review(head, 'COMPLETE', 'APPROVE');
	const unverified = merge();
	expect(unverified.code, unverified.output).not.toBe(0);
	expect(unverified.output).toMatch(/broad[- ]review/i);
}, 90_000);
