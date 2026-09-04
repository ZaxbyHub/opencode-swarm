import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { evaluateBashPortability } from '../../../scripts/check-bash-portability';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const isWindows = process.platform === 'win32';
const REPO_ROOT = path.resolve(__dirname, '../../../');
const SHIM_PATH = path.join(REPO_ROOT, 'scripts', 'check-bash-portability.sh');
const TS_PATH = path.join(REPO_ROOT, 'scripts', 'check-bash-portability.ts');
const GATE_UTILS_PATH = path.join(REPO_ROOT, 'scripts', 'gate-utils.ts');

function runShim(cwd: string, execCwd: string = cwd) {
	if (isWindows) {
		throw new Error('bash not available on Windows');
	}
	const result = spawnSync(
		'bash',
		[path.join(cwd, 'scripts', 'check-bash-portability.sh')],
		{
			cwd: execCwd,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: 30_000,
		},
	);
	return {
		stdout: result.stdout || '',
		stderr: result.stderr || '',
		exitCode: result.status ?? 1,
	};
}

function makeFixture(name: string): string {
	const root = canonicalMkdtemp(`check-bash-portability-${name}-`);
	fs.mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
	fs.copyFileSync(
		SHIM_PATH,
		path.join(root, 'scripts', 'check-bash-portability.sh'),
	);
	fs.copyFileSync(
		TS_PATH,
		path.join(root, 'scripts', 'check-bash-portability.ts'),
	);
	fs.copyFileSync(GATE_UTILS_PATH, path.join(root, 'scripts', 'gate-utils.ts'));
	return root;
}

describe('check-bash-portability', () => {
	test('passes on the real repo', () => {
		if (isWindows) return;
		const result = spawnSync('bash', [SHIM_PATH], {
			cwd: REPO_ROOT,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: 30_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain(
			'No bash4+-only constructs found in scripts/ or .opencode/skills/*/scripts/.',
		);
	});

	test('flags associative arrays and grep -P families', () => {
		const result = evaluateBashPortability([
			{
				file: 'scripts/a.sh',
				content: 'declare -gA bad=()\ngrep -Po "x" file\n',
			},
		]);
		expect(result.exitCode).toBe(1);
		expect(result.messages.join('\n')).toContain('associative array');
		expect(result.messages.join('\n')).toContain('`grep -P`/PCRE mode');
		expect(result.files).toEqual(['scripts/a.sh']);
	});

	test('flags coproc and mapfile/readarray families', () => {
		const result = evaluateBashPortability([
			{
				file: 'scripts/b.sh',
				content: 'coproc foo { echo hi; }\nreadarray lines < <(printf x)\n',
			},
		]);
		expect(result.exitCode).toBe(1);
		expect(result.messages.join('\n')).toContain('`coproc`');
		expect(result.messages.join('\n')).toContain('`mapfile`/`readarray`');
	});

	test('flags bare empty-array expansion under set -u and ignores the guarded form', () => {
		const failing = evaluateBashPortability([
			{
				file: 'scripts/c.sh',
				content: 'set -euo pipefail\nitems=()\nprintf "%s\\n" "${items[@]}"\n',
			},
		]);
		expect(failing.exitCode).toBe(1);
		expect(failing.messages.join('\n')).toContain(
			'items=() is initialized empty',
		);

		const passing = evaluateBashPortability([
			{
				file: 'scripts/c.sh',
				content:
					'set -euo pipefail\nitems=()\nprintf "%s\\n" ${items[@]+"${items[@]}"}\n',
			},
		]);
		expect(passing.exitCode).toBe(0);
	});

	test('FB-001 regression: detects set -u per line without blank-line bleed', () => {
		const afterBlankLine = evaluateBashPortability([
			{
				file: 'scripts/e.sh',
				content: 'set -e\n\nset -u\nitems=()\nprintf "%s\\n" "${items[@]}"\n',
			},
		]);
		expect(afterBlankLine.exitCode).toBe(1);

		const unrelatedU = evaluateBashPortability([
			{
				file: 'scripts/e.sh',
				content:
					'set -e\n\nu_token=enabled\nitems=()\nprintf "%s\\n" ${items[@]}\n',
			},
		]);
		expect(unrelatedU.exitCode).toBe(0);
	});

	test('ignores comment-only mentions of banned constructs', () => {
		const result = evaluateBashPortability([
			{
				file: 'scripts/d.sh',
				content:
					'# declare -A is forbidden\n# grep -P is forbidden too\nprintf ok\\n\n',
			},
		]);
		expect(result.exitCode).toBe(0);
	});

	test('shim resolves the repo root from script location instead of the current directory', async () => {
		if (isWindows) return;
		const fixture = makeFixture('nested-cwd');
		const nested = path.join(fixture, 'nested', 'deep');
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(
			path.join(fixture, 'scripts', 'ci', 'bad.sh'),
			'#!/usr/bin/env bash\ncoproc foo { echo hi; }\n',
		);
		const result = runShim(fixture, nested);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('scripts/ci/bad.sh');
		fs.rmSync(fixture, { recursive: true, force: true });
	});
});
