import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function runBun(args: string[]) {
	const proc = Bun.spawnSync({
		cmd: [process.execPath, ...args],
		cwd: repoRoot,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 60_000,
	});
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

test('issue #2487 compatibility registry independently qualifies current source', () => {
	const result = runBun([
		'run',
		'scripts/check-issue-2487-compatibility.ts',
		repoRoot,
	]);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain('schema v37');
	expect(result.stdout).toContain('18 SQLite tables');
	expect(result.stdout).toContain('16 reachable legacy surfaces');
});

test('issue #2487 qualification runner exposes bounded production scenarios', () => {
	const source = readFileSync(`${repoRoot}/scripts/repro-2487.mjs`, 'utf8');
	for (const scenario of [
		'cross-runtime',
		'recovery',
		'kill-switches',
		'archive-restore',
		'reachability',
		'field-scale',
	]) {
		expect(source).toContain(`'${scenario}'`);
	}
	expect(source).toContain('CHILD_TIMEOUT_MS = 60_000');
	expect(source).toContain("stdio: ['ignore', 'pipe', 'pipe']");
	expect(source).toContain("child.kill('SIGKILL')");
	expect(source).toContain('MAX_OBSERVABILITY_EVENT_ROWS');
	expect(source).toContain('const canonicalize = (value) =>');
	expect(source).not.toContain(
		'JSON.stringify(value, Object.keys(value).sort())',
	);
	expect(source).toContain('actualSurvivorHash !== expectedSurvivorHash');
	expect(source).toContain('survivorRowsHashed');
	expect(source).toContain('crash-window');
	expect(source).toContain('archiveSqliteSnapshot');
	const result = runBun(['run', 'repro:2487']);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain(
		'Bun→Node and Node→Bun close-reopen matched 18 migrated SQLite tables',
	);
	expect(result.stdout).toContain(
		'killed transaction, explicit rollback, and migration rollback/retry',
	);
	expect(result.stdout).toContain(
		'always-on getProjectDb/closeProjectDb/archiveSqliteSnapshot',
	);
	expect(result.stdout).toContain('archiveSqliteSnapshot/VACUUM INTO');
	expect(result.stdout).toContain('production legacy telemetry import');
	expect(result.stdout).toContain('50000 observability rows retained');
	expect(result.stdout).toMatch(/full ordered survivor hash [0-9a-f]{64}/);
	expect(result.stdout).toContain(
		'ISSUE-2487 QUALIFICATION PASS: 6 scenario(s)',
	);
});

test('issue #2487 reachability scenario dispatches through the validator', () => {
	const result = runBun([
		'scripts/repro-2487.mjs',
		'--scenario',
		'reachability',
	]);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain('scenario reachability passed');
	expect(result.stdout).toContain(
		'ISSUE-2487 QUALIFICATION PASS: 1 scenario(s)',
	);
});
