/**
 * Behavioral pins for the FLAKE_TRACKING_ISSUE branch of
 * scripts/ci/detect-and-quarantine-flakes.sh (PR #3883, review findings
 * F-001/F-002).
 *
 * The sibling flake-detection-issue-dedupe-3248 suite pins the script as
 * source text. Text pins cannot catch deletion of the no-create guard or of
 * the pinned-issue validation, so this suite executes the real script with a
 * stub `gh` on PATH (no network, no real gh binary) and asserts which `gh`
 * subcommands were invoked.
 *
 * Contract under test: when FLAKE_TRACKING_ISSUE is set, the script comments
 * on that issue only if it is a currently-open, non-PR issue in $GH_REPO; in
 * every other case it keeps the artifact and NEVER runs `gh issue create`
 * (and never falls back to title discovery). With the variable unset the
 * standalone discovery-then-create behaviour is unchanged.
 */
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const DETECTOR = path.join(
	REPO_ROOT,
	'scripts',
	'ci',
	'detect-and-quarantine-flakes.sh',
);
// Each case spawns bash + a stub gh (~2-3s on Windows); the 5s default flakes under load.
setDefaultTimeout(30_000);

const REPO = 'ZaxbyHub/opencode-swarm';
const OPEN_ISSUE_ROW = `3852\thttps://api.github.com/repos/${REPO}`;

// Stub gh: records every invocation (one line per call) to $STUB_LOG and
// answers from STUB_* env vars. `gh api` prints STUB_API_OUT verbatim (the
// script's --jq filter is applied by real gh, so the stub returns the
// post-filter value: a TSV row for an open issue, empty for closed/PR).
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$1 $2" in
	"api repos/"*)
		[ "\${STUB_API_FAIL:-0}" = "1" ] && exit 1
		printf '%s' "\${STUB_API_OUT:-}"
		exit 0 ;;
	"issue comment")
		exit "\${STUB_COMMENT_RC:-0}" ;;
	"issue create")
		exit "\${STUB_CREATE_RC:-0}" ;;
	"issue list")
		printf '%s' "\${STUB_LIST_OUT:-}"
		exit 0 ;;
	"issue view")
		printf '%s' "\${STUB_VIEW_OUT:-}"
		exit 0 ;;
esac
exit 0
`;

let tmpRoot: string;
let stubDir: string;

beforeAll(() => {
	tmpRoot = canonicalMkdtemp('flake-pinned-3883-');
	stubDir = path.join(tmpRoot, 'bin');
	fs.mkdirSync(stubDir);
	fs.writeFileSync(path.join(stubDir, 'gh'), GH_STUB, { mode: 0o755 });
});

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

interface RunResult {
	status: number | null;
	stdout: string;
	calls: string[];
}

function run(extraEnv: Record<string, string>): RunResult {
	const cwd = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
	fs.writeFileSync(
		path.join(cwd, 'flake-annotations.txt'),
		'::error file=tests/unit/tools/example-flaky.test.ts::boom\n',
	);
	const log = path.join(cwd, 'gh-calls.log');
	fs.writeFileSync(log, '');
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) env[k] = v;
	}
	// Hermetic: drop anything the host may have set that the script reads.
	for (const k of [
		'FLAKE_TRACKING_ISSUE',
		'GH_REPO',
		'DETECTION_RUN_URL',
		'SUGGESTIONS_FILE',
		'FLAKE_ANNOTATIONS',
	]) {
		delete env[k];
	}
	// Windows spells the key `Path`; collapse to one `PATH` so the stub dir wins.
	const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
	const basePath = pathKey ? env[pathKey] : '';
	if (pathKey) delete env[pathKey];
	const result = Bun.spawnSync(['bash', DETECTOR], {
		cwd,
		stdin: 'ignore',
		timeout: 20_000,
		env: {
			...env,
			PATH: `${stubDir}${path.delimiter}${basePath}`,
			GH_REPO: REPO,
			STUB_LOG: log,
			...extraEnv,
		},
	});
	const calls = fs
		.readFileSync(log, 'utf-8')
		.split('\n')
		.filter((l) => l.length > 0);
	return {
		status: result.exitCode,
		stdout: result.stdout.toString(),
		calls,
	};
}

const created = (r: RunResult) =>
	r.calls.filter((c) => c.startsWith('issue create'));
const commented = (r: RunResult) =>
	r.calls.filter((c) => c.startsWith('issue comment'));
const listed = (r: RunResult) =>
	r.calls.filter((c) => c.startsWith('issue list'));

describe('flake-detection pinned tracking issue (PR #3883)', () => {
	test('open #3852 in this repo: exactly one comment on it, never create or discovery', () => {
		const r = run({
			FLAKE_TRACKING_ISSUE: '3852',
			STUB_API_OUT: OPEN_ISSUE_ROW,
		});
		expect(r.status).toBe(0);
		expect(commented(r)).toHaveLength(1);
		expect(commented(r)[0]).toContain('issue comment 3852');
		expect(commented(r)[0]).toContain(`--repo ${REPO}`);
		expect(r.calls[0]).toContain(`api repos/${REPO}/issues/3852`);
		expect(created(r)).toHaveLength(0);
		expect(listed(r)).toHaveLength(0);
		expect(r.stdout).toContain('Commented on existing tracking issue #3852.');
	});

	test('the lookup filter still selects only open non-PR issues (stub returns post-filter output, so pin the filter text)', () => {
		const script = fs.readFileSync(DETECTOR, 'utf-8');
		expect(script).toContain(
			'select(.state == "open" and (.pull_request | not)) | [.number, .repository_url] | @tsv',
		);
	});

	test('empty lookup result (closed issue or pull request): no comment, no create', () => {
		const r = run({ FLAKE_TRACKING_ISSUE: '3852', STUB_API_OUT: '' });
		expect(r.status).toBe(0);
		expect(commented(r)).toHaveLength(0);
		expect(created(r)).toHaveLength(0);
		expect(listed(r)).toHaveLength(0);
		expect(r.stdout).toContain(
			'::warning::Configured flake tracking issue is unavailable or closed.',
		);
		expect(r.stdout).toContain('flake-suggestions.txt artifact');
	});

	test('foreign repository_url: not adopted, no comment, no create', () => {
		const r = run({
			FLAKE_TRACKING_ISSUE: '3852',
			STUB_API_OUT: '3852\thttps://api.github.com/repos/someone-else/fork',
		});
		expect(commented(r)).toHaveLength(0);
		expect(created(r)).toHaveLength(0);
	});

	test('mismatched issue number in the lookup row: not adopted', () => {
		const r = run({
			FLAKE_TRACKING_ISSUE: '3852',
			STUB_API_OUT: `9999\thttps://api.github.com/repos/${REPO}`,
		});
		expect(commented(r)).toHaveLength(0);
		expect(created(r)).toHaveLength(0);
	});

	test('lookup failure (rate limit/network): no create, no comment, still exit 0', () => {
		const r = run({ FLAKE_TRACKING_ISSUE: '3852', STUB_API_FAIL: '1' });
		expect(r.status).toBe(0);
		expect(commented(r)).toHaveLength(0);
		expect(created(r)).toHaveLength(0);
		expect(listed(r)).toHaveLength(0);
	});

	test.each([
		'03852',
		'abc',
		'38 52',
		'3852x',
		'-1',
	])('invalid configured number %p is rejected before any gh call', (bad) => {
		const r = run({ FLAKE_TRACKING_ISSUE: bad, STUB_API_OUT: OPEN_ISSUE_ROW });
		expect(r.status).toBe(0);
		expect(r.calls).toHaveLength(0);
		expect(r.stdout).toContain(
			'::warning::Invalid configured flake tracking issue number.',
		);
	});

	test('comment failure on the open pinned issue: no create, artifact message, exit 0', () => {
		const r = run({
			FLAKE_TRACKING_ISSUE: '3852',
			STUB_API_OUT: OPEN_ISSUE_ROW,
			STUB_COMMENT_RC: '1',
		});
		expect(r.status).toBe(0);
		expect(commented(r)).toHaveLength(1);
		expect(created(r)).toHaveLength(0);
		expect(r.stdout).toContain('::warning::gh issue comment #3852 failed');
	});

	test('variable unset (standalone): title discovery runs, then create when nothing matches', () => {
		const r = run({ STUB_LIST_OUT: '' });
		expect(r.status).toBe(0);
		expect(listed(r)).toHaveLength(1);
		expect(created(r)).toHaveLength(1);
		expect(commented(r)).toHaveLength(0);
	});

	test('empty-string variable behaves as unset (non-upstream workflow expression)', () => {
		const r = run({ FLAKE_TRACKING_ISSUE: '' });
		expect(listed(r)).toHaveLength(1);
		expect(created(r)).toHaveLength(1);
	});
});
