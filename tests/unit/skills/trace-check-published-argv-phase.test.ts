import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

test('phase 4 reports the acceptance command that diverges from the live issue', () => {
	const root = canonicalMkdtemp('published-phase4-');
	try {
		const run = (cmd: string[]) =>
			Bun.spawnSync({
				cmd,
				cwd: root,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: 80_000,
			});
		for (const cmd of [
			['git', 'init', '-q'],
			['git', 'config', 'user.name', 'Trace fixture'],
			['git', 'config', 'user.email', 'trace@example.invalid'],
			['git', 'commit', '--allow-empty', '-qm', 'base'],
			[
				'git',
				'remote',
				'add',
				'origin',
				'https://github.com/example/fixture.git',
			],
		]) {
			expect(run(cmd).exitCode).toBe(0);
		}
		const trace = path.join(root, '.agents/issue-traces/published-test');
		fs.mkdirSync(trace, { recursive: true });
		fs.writeFileSync(
			path.join(trace, 'state.md'),
			'protocol: 3.0.0\npublished-issue: https://github.com/example/fixture/issues/3\n',
		);
		fs.writeFileSync(
			path.join(trace, '02-reproduction.md'),
			'## Acceptance checks\n| AC | class | check | argv | expect | pre-fix | post-fix | notes |\n| AC1 | NEW-SURFACE | C1 | bash traced.sh | missing | RED | GREEN | evidence |\n',
		);
		fs.writeFileSync(
			path.join(root, 'gh'),
			"#!/usr/bin/env bash\n[ \"$2\" = repos/example/fixture/issues/3 ] || exit 2\nprintf '%s\\n' '## Acceptance criteria' '- [ ] AC1: Behavior.' '  - class: NEW-SURFACE' '  - argv: bash published.sh'\n",
			{ mode: 0o755 },
		);
		const validator = path.resolve(
			'.opencode/skills/issue-tracer/scripts/trace-check.sh',
		);
		const phase4 = () =>
			run([
				bashCommand(validator)[0],
				'-c',
				'export PATH="$PWD:/usr/bin:/bin:$PATH"; [ "$(command -v gh)" = "$PWD/gh" ] || exit 19; exec bash "$@"',
				'bash',
				validator,
				'phase',
				'4',
				'--slug',
				'published-test',
			]);
		const result = phase4();
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode, output).toBe(1);
		expect(output).toContain(
			'AC1 published argv: "bash published.sh" | trace argv: "bash traced.sh"',
		);
		expect(output).toContain('FAIL published-argv');

		const gitOutput = (...args: string[]) => {
			const result = run(['git', ...args]);
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			return result.stdout.toString().trim();
		};
		const base = gitOutput('rev-parse', 'HEAD');
		fs.writeFileSync(path.join(root, 'published.sh'), 'exit 0\n');
		gitOutput('add', 'published.sh');
		gitOutput('commit', '-qm', 'head');
		const head = gitOutput('rev-parse', 'HEAD');
		const reproduction = path.join(trace, '02-reproduction.md');
		const shim = path.join(root, 'gh');
		fs.writeFileSync(
			reproduction,
			fs
				.readFileSync(reproduction, 'utf8')
				.replace('NEW-SURFACE', 'DISCRIMINATING')
				.replace('bash traced.sh', 'bash published.sh'),
		);
		fs.writeFileSync(
			shim,
			fs.readFileSync(shim, 'utf8').replace('NEW-SURFACE', 'DISCRIMINATING'),
		);
		const checkpoint = run(
			bashCommand(
				path.join(path.dirname(validator), 'repro-check.sh'),
				'checkpoint',
				'--slug',
				'published-test',
				'--base',
				base,
				'--id',
				'C1',
				'--argv',
				'bash published.sh',
				'--expect',
				'missing',
				'--',
				'published.sh',
			),
		);
		expect(checkpoint.exitCode, checkpoint.stderr.toString()).toBe(0);
		const replay = path.join(trace, 'repro/published-replay.tsv');
		fs.writeFileSync(
			replay,
			'ac_id\targv\tbase_sha\tbase_exit\thead_sha\thead_exit\n' +
				`AC1\tbash published.sh\t${base}\t0\t${head}\t0\n`,
		);
		const runner = path.join(trace, 'repro/replay-base.sh');
		const verifyGenerated = () =>
			run(
				bashCommand(
					path.join(path.dirname(validator), 'repro-check.sh'),
					'verify-generated',
					'--slug',
					'published-test',
				),
			);
		const generated = verifyGenerated();
		expect(generated.exitCode, generated.stderr.toString()).toBe(0);
		fs.writeFileSync(
			runner,
			fs
				.readFileSync(runner, 'utf8')
				.replace('# checkpoint-artifacts-format: 2\n', ''),
		);
		const verifyTampered = verifyGenerated();
		expect(verifyTampered.exitCode).not.toBe(0);
		expect(verifyTampered.stderr.toString()).toContain('generated');
		fs.unlinkSync(runner);
		const missing = phase4();
		expect(missing.stderr.toString()).toContain(
			'AC1 published argv was green at both ends',
		);
		expect(missing.stdout.toString()).toContain('FAIL published-argv');
		expect(missing.stdout.toString(), missing.stderr.toString()).toContain(
			'FAIL generated-checkpoint',
		);
	} finally {
		safeRmRecursive(root);
	}
}, 150_000);
