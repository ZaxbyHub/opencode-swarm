/**
 * Pins the flake-detection issue dedupe (issue #3248 AC6 + PR #3254 review
 * PRR-001/002/003/006/020/021/022 hardening).
 *
 * Before the dedupe, scripts/ci/detect-and-quarantine-flakes.sh created a
 * NEW tracking issue after every failed merge-group run — 97 same-titled
 * duplicates filed in the 2026-09/10 cohort. The script now searches for an
 * OPEN bot-authored issue with the exact title and comments there instead.
 *
 * Trust rule pinned here (the v7.188.0 lookalike-issue class): issue titles
 * are user-controllable in a public repo, so title DISCOVERY adopts only an
 * issue with BOTH the byte-exact title AND a bot author (author.is_bot), and
 * the routed issue number must be bare numeric. The explicit
 * FLAKE_TRACKING_ISSUE pin (PR #3883) bypasses discovery and the author check:
 * its trust root is a workflow constant. Its behaviour is exercised against a
 * stub `gh` in flake-detection-pinned-issue-behavior-3883.test.ts. The pins
 * in this file are source-text pins.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const DETECTOR = path.join(
	REPO_ROOT,
	'scripts',
	'ci',
	'detect-and-quarantine-flakes.sh',
);
const WORKFLOW = path.join(
	REPO_ROOT,
	'.github',
	'workflows',
	'flake-detection.yml',
);

describe('flake-detection tracking-issue dedupe (issue #3248)', () => {
	const script = fs.readFileSync(DETECTOR, 'utf-8');

	test('defines the canonical tracking title once and creates with it', () => {
		expect(script).toContain(
			'TRACKING_TITLE="Auto-detected flaky tests (merge-group) — review for quarantine"',
		);
		expect(script).toContain('--title "$TRACKING_TITLE"');
	});

	test('searches for an existing OPEN issue before creating (server-side filter)', () => {
		// PRR-021: --state open and --limit are load-bearing — `--state all`
		// would byte-match a CLOSED tracker and comment into a dead thread;
		// a truncated limit silently empties the window. The search phrase
		// must be title-scoped so the repo's other open issues cannot crowd
		// the result window; --json + --template extraction avoids jq.
		expect(script).toContain('--state open');
		expect(script).toContain(
			'--search "in:title \\"Auto-detected flaky tests (merge-group)\\""',
		);
		// Selection rows carry ONLY number+title — the trust decision comes
		// from the authoritative per-issue fetch, not a row field.
		expect(script).toContain('--json number,title');
		expect(script).not.toContain('--json number,title,author');
		expect(script).toContain('--limit 20');
		expect(script).toContain('--template');
	});

	test('adopts only bot-authored same-titled issues via the AUTHORITATIVE is_bot check (PRR-001, round 2 findings 1+2)', () => {
		// gh renders this workflow's own actor as `app/github-actions` while
		// the REST API renders `github-actions[bot]` (quarantine-aging.ts
		// :13-14) — a login literal matches only one serializer. And titles
		// may contain tabs AND newlines (probe issue #3258 round-tripped
		// both), so NO field positioned after the title in a rendered row is
		// trustworthy: a newline title can synthesize entire fake rows naming
		// any issue number with any flag values. The design must therefore
		// be two-phase: the title byte-match on 2-field rows only NOMINATES a
		// number, and a separate authoritative `gh issue view` of that
		// number's real author decides adoption.
		expect(script).toContain('{{range .}}{{.number}}\t{{.title}}');
		expect(script).toContain('read -r cand_number cand_title');
		// The authoritative per-issue check — not a row field — decides.
		expect(script).toContain('gh issue view "$cand_number" --repo "$REPO"');
		expect(script).toContain("--template '{{.author.is_bot}}'");
		expect(script).toContain('[ "$author_flag" = "true" ]');
		// The row must NOT carry a positional trust field after the title.
		expect(script).not.toContain('{{.author.is_bot}}\t');
		expect(script).not.toContain('cand_is_bot');
	});

	test('the adoption assignment itself is pinned (PRR-020)', () => {
		// Deleting `existing_issue="$cand_number"` kills the dedupe entirely
		// (always-create) while every substring pin still passes — pin the
		// assignment, not just the comparison.
		expect(script).toContain('existing_issue="$cand_number"');
	});

	test('routes comments only to bare-numeric issue numbers (PRR-003)', () => {
		// A crafted multi-line/tab title must not desync an attacker-chosen
		// value into `gh issue comment`.
		expect(script).toContain('*[!0-9]*');
	});

	test('exact-title matching selects the existing issue (em-dash title is byte-compared)', () => {
		expect(script).toContain('[ "$cand_title" = "$TRACKING_TITLE" ]');
	});

	test('the lookup delimiter is a literal TAB in both the template and IFS', () => {
		// A mutation to a space delimiter would silently disable matching
		// (cand_number absorbs the whole row) while every other pin still
		// passes — pin the byte itself.
		expect(script).toContain('IFS="\t"');
		expect(script).toContain('{{.number}}\t{{.title}}');
	});

	test('comments on the existing issue instead of creating a duplicate', () => {
		expect(script).toContain('gh issue comment "$existing_issue"');
		// The comment route must be tried BEFORE the create route.
		const commentAt = script.indexOf('gh issue comment "$existing_issue"');
		const createAt = script.indexOf('gh issue create --repo "$REPO"');
		expect(commentAt).toBeGreaterThan(-1);
		expect(createAt).toBeGreaterThan(commentAt);
	});

	test('the comment body is distinguishable from a fresh-issue body', () => {
		expect(script).toContain(
			'This comment was added automatically by the flake-detection',
		);
	});

	test('the report body cites the triggering CI run when the URL is provided', () => {
		expect(script).toContain('${DETECTION_RUN_URL:-}');
		expect(script).toContain('Triggering CI run: ${DETECTION_RUN_URL}');
	});

	test('non-adoption paths are loud (PRR-006): lookalike, zero-match, lookup-failure', () => {
		// All three create-while-open-ish paths must emit a ::warning:: so a
		// silent resumption of duplicate filing is visible in the run log.
		expect(script).toContain(
			'::warning::open same-titled issue is not bot-authored',
		);
		expect(script).toContain(
			'::warning::no open bot-authored issue with the exact tracking title',
		);
		expect(script).toContain('::warning::gh issue list lookup failed');
	});

	test('detection stays advisory: the script never exits non-zero (PRR-022)', () => {
		// STRONGER than the old endsWith pin: the detector must contain NO
		// `exit 1` anywhere — an inserted intermediate failure branch fails
		// this pin even though the file still ends with `exit 0`.
		expect(script.trimEnd().endsWith('exit 0')).toBe(true);
		expect(script).not.toContain('exit 1');
		// The three failure paths warn instead of exiting.
		expect(script).toContain('::warning::gh issue comment');
		expect(script).toContain('::warning::gh issue create');
	});

	test('the workflow passes the triggering run URL to the script', () => {
		const workflow = fs.readFileSync(WORKFLOW, 'utf-8');
		expect(workflow).toContain(
			'DETECTION_RUN_URL: ${{ github.event.workflow_run.html_url }}',
		);
	});

	test('the upstream workflow pins the replacement issue and standalone callers retain discovery', () => {
		const workflow = fs.readFileSync(WORKFLOW, 'utf-8');
		expect(workflow).toContain(
			"FLAKE_TRACKING_ISSUE: ${{ github.repository == 'ZaxbyHub/opencode-swarm' && '3852' || '' }}",
		);
		expect(script).toContain('repos/$REPO/issues/$FLAKE_TRACKING_ISSUE');
		expect(script).toContain('elif issue_matches="$(gh issue list');
	});
});
