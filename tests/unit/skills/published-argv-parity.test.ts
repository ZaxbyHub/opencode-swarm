import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const script = path.resolve(
	'.opencode/skills/issue-tracer/scripts/check-published-argv.sh',
);

test('published argv parity — reports every divergent acceptance command (#3621 AC1)', () => {
	const root = canonicalMkdtemp('published-argv-parity-');
	try {
		const issue = path.join(root, 'issue.md');
		const reproduction = path.join(root, '02-reproduction.md');
		const published = [
			'bash check-alpha.sh',
			'bash check-beta.sh $(touch sentinel)',
		];
		const traced = ['bash actual-alpha.sh', 'bash actual-beta.sh'];
		fs.writeFileSync(
			issue,
			[
				'## Acceptance criteria',
				'- [ ] AC1: First behavior.',
				'  - class: NEW-SURFACE',
				`  - argv: ${published[0]}`,
				'- [ ] AC2: Second behavior.',
				'  - class: NEW-SURFACE',
				`  - argv: ${published[1]}`,
				'- [ ] AC3: Preserved behavior.',
				'  - class: PRESERVING',
				'  - argv: bash same.sh',
				'',
			].join('\n'),
		);
		fs.writeFileSync(
			reproduction,
			[
				'## Acceptance checks',
				'| AC | class | check | argv | expect | pre-fix | post-fix | notes |',
				'| --- | --- | --- | --- | --- | --- | --- | --- |',
				`| AC1 | NEW-SURFACE | C1 | ${traced[0]} | missing | ERROR | GREEN | evidence |`,
				`| AC2 | NEW-SURFACE | C2 | ${traced[1]} | missing | ERROR | GREEN | evidence |`,
				'| AC3 | PRESERVING | C3 | bash same.sh | - | GREEN | GREEN | evidence |',
				'',
			].join('\n'),
		);

		// The base validator only compared the trace table with its local manifest.
		const result = Bun.spawnSync({
			cmd: bashCommand(
				script,
				'--reproduction',
				reproduction,
				'--published-issue-body',
				issue,
			),
			cwd: root,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 10_000,
		});
		const output = `${result.stdout}\n${result.stderr}`;
		expect(result.exitCode, output).toBe(1);
		for (const [index, publishedArgv] of published.entries()) {
			const diagnostic = output
				.split(/\r?\n/)
				.find(
					(line) =>
						line.includes(`AC${index + 1}`) && line.includes(publishedArgv),
				);
			expect(diagnostic, output).toContain(traced[index]);
		}
		expect(fs.existsSync(path.join(root, 'sentinel'))).toBe(false);
	} finally {
		safeRmRecursive(root);
	}
});
