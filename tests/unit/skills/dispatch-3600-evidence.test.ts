import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const scripts = '.opencode/skills/issue-tracer/scripts';
const slug = 'trace-evidence';
const trace = `.agents/issue-traces/${slug}`;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

function fixture() {
	const root = canonicalMkdtemp('dispatch-3600-');
	roots.push(root);

	function write(file: string, body: string) {
		const target = path.join(root, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, body);
	}

	function read(file: string) {
		return fs.readFileSync(path.join(root, file), 'utf8');
	}

	function git(...args: string[]) {
		const result = Bun.spawnSync({
			cmd: ['git', ...args],
			cwd: root,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 10_000,
		});
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	}

	function run(script: string, ...args: string[]) {
		const result = Bun.spawnSync({
			cmd: bashCommand(path.resolve(root, script), ...args),
			cwd: root,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 60_000,
		});
		return {
			code: result.exitCode,
			output: result.stdout.toString() + result.stderr.toString(),
		};
	}

	git('init', '-q', '-b', 'main');
	git('config', 'user.name', 'Trace fixture');
	git('config', 'user.email', 'trace@example.invalid');
	git('config', 'core.autocrlf', 'false');
	write('.gitignore', '.agents/issue-traces/\n');
	write('feature.txt', 'base\n');
	fs.cpSync(path.resolve(scripts), path.join(root, scripts), {
		recursive: true,
	});
	git('add', '.');
	git('commit', '-qm', 'base');

	const base = git('rev-parse', 'HEAD');
	const baseTree = git('rev-parse', 'HEAD^{tree}');
	function checkpoint(
		id: string,
		argv: string,
		files: string[],
		reason?: string,
	) {
		const result = run(
			`${scripts}/repro-check.sh`,
			'checkpoint',
			'--slug',
			slug,
			'--base',
			base,
			'--id',
			id,
			'--argv',
			argv,
			'--expect',
			'base-gap',
			...(reason ? ['--reason', reason] : []),
			'--',
			...files,
		);
		expect(result.code, result.output).toBe(0);
	}

	return { write, read, run, git, base, baseTree, checkpoint };
}

test('identity rebind updates active surfaces and rejects each stale projection', () => {
	const { base, baseTree, git, read, run, write } = fixture();
	const gates = [
		['plan-critic', '06-critic-review.md'],
		['implementation-review', '08b-implementation-review.md'],
		['final-critic', '09-final-critic.md'],
	];
	const oldRows = gates.map(
		([gate, file]) => `| ${gate} | APPROVE | ${base} | ${baseTree} | ${file} |`,
	);
	write(
		`${trace}/state.md`,
		[
			'# Trace State: trace-evidence',
			'protocol: 3.0.0',
			'phase: 5',
			'tier: M',
			'classification: VALID',
			'base-ref: main',
			`base-sha: ${base}`,
			'freshness: synced',
			`phase0-tree-id: ${baseTree}`,
			`checkpoint-tree-id: ${baseTree}`,
			'handshake: MATCH',
			'tools: none',
			'merge: AWAITING_USER_APPROVAL',
			'next-action: rebind',
			'',
			'## Gates',
			'| gate | verdict | reviewed-commit | tree-id | artifact |',
			'|---|---|---|---|---|',
			...oldRows,
			'',
		].join('\n'),
	);
	for (const [, file] of gates) {
		write(
			`${trace}/${file}`,
			`## Reviewed SHA / diff hash\nreviewed-commit: ${base}\ntree-id: ${baseTree}\n\n## Verdict\nAPPROVE\n`,
		);
	}
	write(`${trace}/10-pr-body.md`, `PR head: ${base}\n`);
	git('commit', '--allow-empty', '-qm', 'metadata-only head move');
	const head = git('rev-parse', 'HEAD');
	const tree = git('rev-parse', 'HEAD^{tree}');
	expect(head).not.toBe(base);
	expect(tree).toBe(baseTree);

	const script = `${scripts}/rebind-identities.sh`;
	const rebound = run(script, '--slug', slug, '--reason', 'head-move');
	expect(rebound.code, rebound.output).toBe(0);
	const state = read(`${trace}/state.md`);
	for (const [index, [gate, file]] of gates.entries()) {
		expect(state).toContain(oldRows[index]);
		expect(state).toContain(`| ${gate} | APPROVE | ${head} | ${tree} |`);
		expect(read(`${trace}/${file}`)).toContain(
			`reviewed-commit: ${head}\ntree-id: ${tree}`,
		);
	}
	expect(read(`${trace}/10-pr-body.md`)).toContain(`PR head: ${head}`);

	const clean = run(script, '--slug', slug, '--check');
	expect(clean.code, clean.output).toBe(0);
	const staleProjections = [
		{
			file: 'state.md',
			live: `| ${head} | ${tree} |`,
			stale: `| ${head} | ${base} |`,
		},
		...gates.map(([, file]) => ({
			file,
			live: `tree-id: ${tree}`,
			stale: `tree-id: ${base}`,
		})),
		{
			file: '10-pr-body.md',
			live: `PR head: ${head}`,
			stale: `PR head: ${base}`,
		},
	];
	for (const { file, live, stale } of staleProjections) {
		const target = `${trace}/${file}`;
		const original = read(target);
		expect(original).toContain(live);
		write(target, original.replace(live, stale));
		const checked = run(script, '--slug', slug, '--check');
		expect(checked.code).not.toBe(0);
		expect(checked.output).toContain(file);
		write(target, original);
	}

	const approvals = [
		'state.md',
		...gates.map(([, file]) => file),
		'10-pr-body.md',
	].map((file) => {
		const target = `${trace}/${file}`;
		return { target, original: read(target) };
	});
	write('feature.txt', 'changed tree\n');
	git('commit', '-qam', 'change the reviewed tree');
	expect(git('rev-parse', 'HEAD^{tree}')).not.toBe(tree);
	const refused = run(script, '--slug', slug, '--reason', 'head-move');
	expect(refused.code, refused.output).not.toBe(0);
	for (const { target, original } of approvals) {
		expect(read(target)).toBe(original);
	}
}, 90_000);

test('receipt validation rejects missing and mismatched proof', () => {
	const { base, git, run, write } = fixture();
	const outputFile = 'evidence/verify.txt';
	write(outputFile, 'validation output\n');
	git('add', outputFile);
	git('commit', '-qm', 'record execution output');
	const commit = git('rev-parse', 'HEAD');
	const blob = git('rev-parse', `${commit}:${outputFile}`);
	const wrongBlob = git('rev-parse', `${base}:feature.txt`);
	write(
		`${trace}/state.md`,
		'# Trace State: trace-evidence\nprotocol: 3.0.0\n',
	);
	const evidence = `${trace}/08-test-results.md`;
	const check = () =>
		run(`${scripts}/trace-check.sh`, 'receipts', '--slug', slug);
	const runLine = '- Evidence: C1 passed';
	const disposition = '- Disposition: edited check driver';
	const receipt = (id: string) =>
		`[receipt ${commit}:${outputFile} blob=${id}]`;

	write(
		evidence,
		`${runLine} ${receipt(blob)}\n${disposition} ${receipt(blob)}\n`,
	);
	const clean = check();
	expect(clean.code, clean.output).toBe(0);

	write(evidence, `${runLine} ${receipt(blob)}\n${disposition}\n`);
	const absent = check();
	expect(absent.code).not.toBe(0);
	expect(absent.output).toContain('edited check driver');

	write(
		evidence,
		`${runLine} ${receipt(wrongBlob)}\n${disposition} ${receipt(blob)}\n`,
	);
	const mismatch = check();
	expect(mismatch.code).not.toBe(0);
	expect(mismatch.output).toContain('C1 passed');
}, 30_000);

test('checkpoint emits a runner that copies all frozen inputs and replays each base leg', () => {
	const { checkpoint, git, read, run, write } = fixture();
	write('feature.txt', 'head\n');
	git('commit', '-qam', 'head');
	write(
		'driver one.sh',
		'test -f "copy input.txt" || exit 44\nif grep -qx base feature.txt; then echo base-gap-one; exit 1; fi\n',
	);
	write('copy input.txt', 'fixture data\n');
	write(
		'driver-two.sh',
		'if grep -qx base feature.txt; then echo base-gap-two; exit 1; fi\n',
	);
	checkpoint('C1', 'bash "driver one.sh"', ['driver one.sh', 'copy input.txt']);
	checkpoint('C2', 'bash driver-two.sh', ['driver-two.sh']);

	const replay = run(`${trace}/repro/replay-base.sh`);
	expect(replay.code, replay.output).toBe(0);
	expect(read(`${trace}/repro/C1.base.log`)).toContain('base-gap-one');
	expect(read(`${trace}/repro/C2.base.log`)).toContain('base-gap-two');
}, 90_000);

test('CHECK_WRONG amendment regenerates the current inventory without losing sibling checks or prose', () => {
	const { checkpoint, git, read, write } = fixture();
	const plan = `${trace}/05-fix-plan.md`;
	write(
		plan,
		'# Fix plan\n\n## Test inventory\n\nOld handwritten inventory.\n\n## Other decisions\n\nKeep this prose.\n',
	);
	write('driver.sh', 'echo first\n');
	write('sibling.sh', 'echo sibling\n');
	checkpoint('C1', 'bash driver.sh first', ['driver.sh']);
	checkpoint('C2', 'bash sibling.sh', ['sibling.sh']);

	write('driver.sh', 'echo corrected\n');
	const currentBlob = git('hash-object', 'driver.sh');
	checkpoint('C1', 'bash driver.sh corrected', ['driver.sh'], 'CHECK_WRONG');

	const updated = read(plan);
	expect(updated).toContain('bash driver.sh corrected');
	expect(updated).toContain(currentBlob);
	expect(updated).toContain('bash sibling.sh');
	expect(updated).toContain('## Other decisions\n\nKeep this prose.');
	expect(updated).not.toContain('bash driver.sh first');
	expect(updated).not.toContain('Old handwritten inventory.');
	expect(read(`${trace}/repro/checkpoint.manifest`)).toContain(
		'bash driver.sh first',
	);
}, 30_000);
