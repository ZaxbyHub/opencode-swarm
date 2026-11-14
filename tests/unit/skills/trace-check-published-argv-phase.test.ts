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
				timeout: 45_000,
			});
		for (const cmd of [
			['git', 'init', '-q'],
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
		const result = run([
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
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode, output).toBe(1);
		expect(output).toContain(
			'AC1 published argv: bash published.sh | trace argv: bash traced.sh',
		);
		expect(output).toContain('FAIL published-argv');
	} finally {
		safeRmRecursive(root);
	}
}, 60_000);
