import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const script = path.resolve(
	'.opencode/skills/issue-tracer/scripts/check-published-argv.sh',
);

test('published argv parity — confirms each shared executable criterion once (#3621 AC2)', () => {
	const root = canonicalMkdtemp('published-argv-clean-');
	try {
		const issue = path.join(root, 'issue.md');
		const reproduction = path.join(root, '02-reproduction.md');
		fs.writeFileSync(
			issue,
			[
				'## Problem',
				'',
				'```markdown',
				'- [ ] AC1: Historical example.',
				'  - argv: bash wrong-example.sh',
				'```',
				'',
				'## Acceptance criteria',
				'- [ ] AC1: First behavior.',
				'  - class: NEW-SURFACE',
				'  - argv: bash check.sh "value with spaces"',
				'- [ ] AC2: Preserved behavior.',
				'  - class: PRESERVING',
				'  - argv: bash preserve.sh',
				'- [ ] AC3: Guidance.',
				'  - class: NON-EXECUTABLE(DOCS_ONLY)',
				'',
			].join('\r\n'),
		);
		fs.writeFileSync(
			reproduction,
			[
				'## Acceptance checks',
				'| AC | class | check | argv | expect | pre-fix | post-fix | notes |',
				'| --- | --- | --- | --- | --- | --- | --- | --- |',
				'| AC1 | NEW-SURFACE | C1 | bash check.sh "value with spaces" | missing | ERROR | GREEN | evidence |',
				'| AC2 | PRESERVING | C2 | bash preserve.sh | - | GREEN | GREEN | evidence |',
				'| AC3 | NON-EXECUTABLE | DOCS_ONLY | - | - | - | pending | reviewer evidence |',
				'',
			].join('\n'),
		);
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
		expect(result.exitCode, output).toBe(0);
		const lines = result.stdout.toString().split(/\r?\n/);
		expect(lines.filter((line) => /\bAC1\b/.test(line))).toHaveLength(1);
		expect(lines.filter((line) => /\bAC2\b/.test(line))).toHaveLength(1);
		expect(lines.some((line) => /\bAC3\b/.test(line))).toBe(false);
	} finally {
		safeRmRecursive(root);
	}
});
