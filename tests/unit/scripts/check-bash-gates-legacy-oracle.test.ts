/**
 * Frozen compatibility oracles for the six Bash-only CI gates ported in issue
 * #2094. The archived Bash owners and their helper dependencies are committed
 * under tests/fixtures/bash-gates-2094/archive and cryptographically pinned to
 * the exact origin/main tree the port started from. On every platform we assert
 * the current TypeScript owner against the frozen golden diagnostics; when a
 * real Bash runtime is available we also execute the archived owner and require
 * byte-for-byte parity on stdout/stderr and exit code.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main as runBashPortability } from '../../../scripts/check-bash-portability';
import { runGit, spawnUtf8 } from '../../../scripts/gate-utils';
import { bashCommand, resolveBash } from '../../helpers/bash.js';
import {
	buildInvariantsOracleExpected,
	seedQuarantineListFiles,
} from '../../helpers/invariant-gate-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const REPO_ROOT = path.resolve(__dirname, '../../../');
const ARCHIVED_SHA = '911787b1252e848525ddd86f58e677478d0a3ca2';
const ARCHIVE_FIXTURE_ROOT = path.join(
	REPO_ROOT,
	'tests',
	'fixtures',
	'bash-gates-2094',
);
const ARCHIVE_ROOT = path.join(ARCHIVE_FIXTURE_ROOT, 'archive');
const ARCHIVE_MANIFEST_PATH = path.join(ARCHIVE_FIXTURE_ROOT, 'manifest.json');
const ARCHIVE_CORPUS_SHA256 =
	'b9cc7aba941f5b74f3d2cdf76d242ea7f27d1c86d322d64e8b54efcbfd96455b';
const hasBash = (() => {
	try {
		resolveBash();
		return true;
	} catch {
		return false;
	}
})();
const MOCK_CLEANUP_GATE = path.resolve(
	REPO_ROOT,
	'scripts/check-mock-cleanup.ts',
);
const TEST_CLOCK_GATE = path.resolve(REPO_ROOT, 'scripts/check-test-clock.ts');
const TEST_TMPDIR_GATE = path.resolve(
	REPO_ROOT,
	'scripts/check-test-tmpdir.ts',
);
const INVARIANTS_GATE = path.resolve(REPO_ROOT, 'scripts/check-invariants.ts');
const BASH_PORTABILITY_GATE = path.resolve(
	REPO_ROOT,
	'scripts/check-bash-portability.ts',
);
const tempRoots: string[] = [];
const MOCK_MODULE_CALL = ['mock', "module('./dep', () => ({}));"].join('.');
const RAW_TMPDIR_CALL = ['tmpdir', '()'].join('');
interface LegacyFixtureEntry {
	path: string;
	mode: string;
	blob: string;
	sha256: string;
}
interface LegacyFixtureManifest {
	archivedFromSha: string;
	files: LegacyFixtureEntry[];
}
interface GateRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}
const legacyFixtureManifest = JSON.parse(
	fs.readFileSync(ARCHIVE_MANIFEST_PATH, 'utf8'),
) as LegacyFixtureManifest;
function normalizeOutput(text: string): string {
	return text.replace(/\r\n/g, '\n').trimEnd();
}
function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}
function hashLegacyManifest(manifest: LegacyFixtureManifest): string {
	const lines = manifest.files
		.map(
			(entry) => `${entry.mode}\t${entry.blob}\t${entry.path}\t${entry.sha256}`,
		)
		.sort();
	return sha256(`${manifest.archivedFromSha}\n${lines.join('\n')}\n`);
}
async function git(repoDir: string, ...args: string[]): Promise<void> {
	const result = await runGit(args, repoDir, 10_000);
	if (result.exitCode === 0) return;
	throw new Error(
		`git ${args.join(' ')} failed in ${repoDir}: ${result.stderr}`,
	);
}
const runArchiveGit = (args: string[]) => runGit(args, REPO_ROOT, 10_000);
function write(repoDir: string, relPath: string, content: string): void {
	const full = path.join(repoDir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}
async function commit(repoDir: string, message: string): Promise<void> {
	await git(repoDir, 'add', '-A');
	await git(repoDir, 'commit', '-q', '-m', message);
}
async function makeRepo(prefix: string): Promise<string> {
	const repoDir = canonicalMkdtemp(prefix);
	await git(repoDir, 'init', '-q', '-b', 'main');
	await git(repoDir, 'config', 'user.email', 'test@example.com');
	await git(repoDir, 'config', 'user.name', 'Test');
	fs.cpSync(path.join(ARCHIVE_ROOT, 'scripts'), path.join(repoDir, 'scripts'), {
		recursive: true,
	});
	fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
	write(repoDir, 'README.md', 'base\n');
	await commit(repoDir, 'init');
	await git(repoDir, 'branch', 'origin/main');
	tempRoots.push(repoDir);
	return repoDir;
}

async function runTsGate(
	scriptPath: string,
	cwd: string,
	timeout = 30_000,
): Promise<GateRunResult> {
	return spawnUtf8([process.execPath, 'run', scriptPath], cwd, timeout);
}

async function runLegacyGate(
	scriptRelativePath: string,
	cwd: string,
	timeout = 30_000,
	scriptRoot: string = ARCHIVE_ROOT,
): Promise<GateRunResult> {
	return spawnUtf8(
		bashCommand(path.join(scriptRoot, ...scriptRelativePath.split('/'))),
		cwd,
		timeout,
	);
}

async function expectLegacyParity(
	scriptRelativePath: string,
	tsScriptPath: string,
	cwd: string,
	expectedStdout: string,
	timeout?: number,
): Promise<void> {
	const tsResult = await runTsGate(tsScriptPath, cwd, timeout);
	expect(tsResult).toEqual({
		exitCode: 1,
		stdout: `${expectedStdout}\n`,
		stderr: '',
	});

	if (!hasBash) return;

	const legacyResult = await runLegacyGate(
		scriptRelativePath,
		cwd,
		timeout,
		cwd,
	);
	expect(legacyResult.exitCode, legacyResult.stderr).toBe(tsResult.exitCode);
	expect(legacyResult.stdout).toBe(tsResult.stdout);
	expect(legacyResult.stderr).toBe(tsResult.stderr);
	expect(normalizeOutput(legacyResult.stdout), legacyResult.stderr).toBe(
		expectedStdout,
	);
	expect(normalizeOutput(legacyResult.stdout)).toBe(
		normalizeOutput(tsResult.stdout),
	);
	expect(normalizeOutput(legacyResult.stderr)).toBe(
		normalizeOutput(tsResult.stderr),
	);
}

async function captureConsoleLog(run: () => number | Promise<number>): Promise<{
	exitCode: number;
	stdout: string;
}> {
	const lines: string[] = [];
	const realLog = console.log;
	console.log = (line?: unknown) => {
		lines.push(String(line ?? ''));
	};
	try {
		const exitCode = await run();
		return {
			exitCode,
			stdout: lines.join('\n'),
		};
	} finally {
		console.log = realLog;
	}
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
});

describe('issue #2094 legacy-oracle parity', () => {
	test('archived Bash corpus stays pinned to origin/main 911787b and exact fixture bytes', async () => {
		expect(legacyFixtureManifest.archivedFromSha).toBe(ARCHIVED_SHA);
		expect(hashLegacyManifest(legacyFixtureManifest)).toBe(
			ARCHIVE_CORPUS_SHA256,
		);
		const archivedCommit = await runArchiveGit([
			'cat-file',
			'-e',
			`${ARCHIVED_SHA}^{commit}`,
		]);
		const provenanceMode =
			archivedCommit.exitCode === 0
				? 'verified-tree'
				: 'degraded-shallow-checkout';
		if (provenanceMode === 'degraded-shallow-checkout') {
			console.warn(
				`ARCHIVE PROVENANCE: ${ARCHIVED_SHA} unavailable; verifying manifest/blob hashes only.`,
			);
		}

		for (const entry of legacyFixtureManifest.files) {
			const fixturePath = path.join(ARCHIVE_ROOT, ...entry.path.split('/'));
			const fixtureContent = fs.readFileSync(fixturePath, 'utf8');
			expect(sha256(fixtureContent.replaceAll('\r\n', '\n'))).toBe(
				entry.sha256,
			);
			if (provenanceMode === 'verified-tree') {
				const archivedTree = await runArchiveGit([
					'ls-tree',
					ARCHIVED_SHA,
					'--',
					entry.path,
				]);
				expect(archivedTree.exitCode).toBe(0);
				expect(archivedTree.stdout.trim()).toBe(
					`${entry.mode} blob ${entry.blob}\t${entry.path}`,
				);
			}

			const fixtureBlob = await runArchiveGit(['hash-object', fixturePath]);
			expect(fixtureBlob.exitCode).toBe(0);
			expect(fixtureBlob.stdout.trim()).toBe(entry.blob);
		}
	}, 120_000);

	test('mock-cleanup preserves the archived blocking cleanup diagnostic', async () => {
		const repo = await makeRepo('gate-oracle-mock-cleanup-');
		write(
			repo,
			'tests/fixture.test.ts',
			["import { mock } from 'bun:test';", MOCK_MODULE_CALL].join('\n'),
		);
		await commit(repo, 'add violation');

		const expected = [
			'ERROR: tests/fixture.test.ts uses mock.module but has no afterEach(mock.restore()) cleanup',
			'       Add afterEach(() => mock.restore()), or use file-scoped pattern',
			'       (mock.module at top + mockClear/mockReset in beforeEach),',
			"       or document why it's skipped",
			'',
			'1 NEW violation(s) introduced by this PR. See errors above.',
			'0 pre-existing violation(s) also found (non-blocking).',
		].join('\n');

		await expectLegacyParity(
			'scripts/check-mock-cleanup.sh',
			MOCK_CLEANUP_GATE,
			repo,
			expected,
		);
	});

	test('test-clock preserves the archived blocking raw-clock diagnostic', async () => {
		const repo = await makeRepo('gate-oracle-test-clock-');
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses real time", () => {',
				'  Date.now();',
				'});',
			].join('\n'),
		);
		await commit(repo, 'add violation');

		const expected = [
			'ERROR: tests/fixture.test.ts uses the real clock (Date.now / new Date() / spyOn(Date)) but does not import or call the freezeClock helper.',
			"       Import from '../../helpers/test-clock.js' (adjust depth) and wrap",
			'       time-sensitive assertions in withFrozenClock(() => { ... }).',
			'       (A comment mentioning the helper does NOT satisfy this check —',
			'       you must import or call it.)',
			'       See docs/testing/test-stability.md (issue #1782).',
			'',
			'=== Summary ===',
			'New violations (blocking): 1',
			'Pre-existing violations (non-blocking warnings): 0',
		].join('\n');

		await expectLegacyParity(
			'scripts/check-test-clock.sh',
			TEST_CLOCK_GATE,
			repo,
			expected,
		);
	});

	test('test-tmpdir preserves the archived blocking tmpdir diagnostic', async () => {
		const repo = await makeRepo('gate-oracle-test-tmpdir-');
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { tmpdir } from 'node:os';",
				`const tmp = ${RAW_TMPDIR_CALL};`,
			].join('\n'),
		);
		await commit(repo, 'add violation');

		const expected = [
			`ERROR: tests/fixture.test.ts:2 adds a raw ${RAW_TMPDIR_CALL} call not wrapped in realpathSync.`,
			`       Use canonicalTmpDir() / canonicalMkdtemp(prefix) from tests/helpers/${RAW_TMPDIR_CALL.replace('()', '')}.ts`,
			'       (or wrap with fs.realpathSync(...) on the same line) to close the macOS',
			'       /var -> /private/var symlink gap. See FR-011 (issue #1737).',
			'',
			'=== Summary ===',
			'New violations (blocking): 1',
		].join('\n');

		await expectLegacyParity(
			'scripts/check-test-tmpdir.sh',
			TEST_TMPDIR_GATE,
			repo,
			expected,
		);
	});

	test('check-invariants preserves the archived process.cwd() and advisory diagnostics', async () => {
		const repo = await makeRepo('gate-oracle-invariants-');
		write(repo, 'scripts/mock-allowlist.txt', '# empty allowlist fixture\n');
		write(repo, 'src/tools/cwd-violation.ts', 'process.cwd();\n');
		seedQuarantineListFiles(repo); // Check 7 fail-closes on missing lists
		for (const rel of [
			'src/tools/knowledge-add.ts',
			'src/hooks/knowledge-store.ts',
			'src/hooks/curator.ts',
			'src/hooks/micro-reflector.ts',
			'src/knowledge/entry-merge.ts',
			'src/learning/provenance.ts',
			'src/services/recommendation-ledger.ts',
			'src/consensus/miner.ts',
		]) {
			write(repo, rel, 'export const ok = 1;\n');
		}
		await commit(repo, 'seed invariant fixture');

		// TS leg pins seven checks (incl. TS-only Check 7, #2477); the archived
		// Bash owner keeps its frozen six-check output — superseded byte parity.
		const { tsExpected, legacyExpected } = buildInvariantsOracleExpected();

		const tsResult = await runTsGate(INVARIANTS_GATE, repo);
		expect(tsResult).toEqual({
			exitCode: 1,
			stdout: `${tsExpected}
`,
			stderr: '',
		});

		if (!hasBash) return;

		const legacyResult = await runLegacyGate(
			'scripts/check-invariants.sh',
			repo,
			undefined,
			repo,
		);
		expect(legacyResult.exitCode, legacyResult.stderr).toBe(1);
		expect(normalizeOutput(legacyResult.stdout), legacyResult.stderr).toBe(
			legacyExpected,
		);
		expect(normalizeOutput(legacyResult.stderr)).toBe('');
	});

	test('bash-portability preserves the archived bash-3.2 compatibility diagnostics', async () => {
		const repo = await makeRepo('gate-oracle-bash-portability-');
		write(repo, 'scripts/ci/bad.sh', 'declare -gA bad=()\ngrep -Po "x" file\n');
		const expected = [
			"ERROR: scripts/ci/bad.sh uses an associative array (declare/typeset/local/readonly -A) — bash 4+ only, not supported on macOS's bash 3.2.",
			'       Use a plain indexed array or parallel files instead (see scripts/check-invariants.sh for the established pattern).',
			'ERROR: scripts/ci/bad.sh uses `grep -P`/PCRE mode (any flag combination, or --perl-regexp) — BSD grep on macOS has no -P support at all.',
			'       Use `grep -E` with explicit alternation instead (see scripts/check-invariants.sh for the established pattern).',
			'',
			'=== Summary ===',
			'Files with bash4+-only constructs: 1',
			'',
			'Violating files:',
			'  - scripts/ci/bad.sh',
		].join('\n');

		await expectLegacyParity(
			'scripts/check-bash-portability.sh',
			BASH_PORTABILITY_GATE,
			repo,
			expected,
		);

		const captured = await captureConsoleLog(() => runBashPortability(repo));
		expect(captured.exitCode).toBe(1);
		expect(normalizeOutput(captured.stdout)).toBe(expected);
	});
});
