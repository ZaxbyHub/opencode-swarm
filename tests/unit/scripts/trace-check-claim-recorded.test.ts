import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// issue-tracer v3.0.2 claim gate (SKILL.md rule 13): `trace-check.sh phase 0`
// reports whether state.md's `tools:` line carries the claim token or the
// not_applicable marker. The rule is advisory (WARN, never FAIL): traces that
// predate the gate must keep validating, and a hard failure needs a
// protocol-version decision.
const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-check.sh',
);
const TOKEN = '3f2a9c1e-7b4d-4e58-9a06-c1d2e3f40516';
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
	const p = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 50_000,
	});
	if (p.exitCode !== 0) throw new Error(p.stderr.toString());
	return p.stdout.toString().trim();
}
function phase0(cwd: string) {
	const p = Bun.spawnSync({
		cmd: bashCommand(SCRIPT, 'phase', '0', '--slug', 'issue-1'),
		cwd,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 50_000,
	});
	return { code: p.exitCode, out: p.stdout.toString() };
}
function traceWithTools(tools: string) {
	const root = canonicalMkdtemp('trace-check-claim-');
	roots.push(root);
	git(root, 'init', '-q', '-b', 'main');
	git(root, 'config', 'user.email', 'trace@example.invalid');
	git(root, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(root, 'subject.txt'), 'base\n');
	git(root, 'add', '-A');
	git(root, 'commit', '-q', '-m', 'base');
	const head = git(root, 'rev-parse', 'HEAD');
	const tree = git(root, 'rev-parse', 'HEAD^{tree}');
	const dir = path.join(root, '.agents/issue-traces/issue-1');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'state.md'),
		`# Trace State: issue-1\nprotocol: 3.0.0\nphase: 0\ntier: S\nclassification: unset\nbase-ref: main\nbase-sha: ${head}\nfreshness: synced\nphase0-tree-id: ${tree}\ncheckpoint-tree-id: unset\nhandshake: MATCH\ntools: ${tools}\nmerge: not-applicable\nnext-action: test\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n`,
	);
	return root;
}

describe('trace-check phase 0 claim-recorded rule (issue-tracer claim gate)', () => {
	test('a session token on the tools line is recorded (OK)', () => {
		const r = phase0(traceWithTools(`session=${TOKEN}`));
		expect(r.out).toContain('OK claim-recorded');
		expect(r.out).not.toContain('WARN claim-recorded');
		expect(r.out).not.toContain('FAIL');
		expect(r.code).toBe(0);
	}, 90_000);

	test('the token may sit among other comma-list tool entries', () => {
		const r = phase0(traceWithTools(`gh, subagents, session=${TOKEN}`));
		expect(r.out).toContain('OK claim-recorded');
	}, 90_000);

	test('claim: not_applicable with a reason is recorded (OK)', () => {
		const r = phase0(
			traceWithTools('gh, claim: not_applicable (association NONE)'),
		);
		expect(r.out).toContain('OK claim-recorded');
		expect(r.out).not.toContain('WARN claim-recorded');
	}, 90_000);

	test('tools: none (a trace that skipped the claim gate) WARNs but does not FAIL', () => {
		const r = phase0(traceWithTools('none'));
		expect(r.out).toContain('WARN claim-recorded');
		expect(r.out).not.toContain('OK claim-recorded');
		expect(r.out).not.toContain('FAIL');
		expect(r.code).toBe(0);
	}, 90_000);

	test('a too-short token and a reasonless not_applicable do not count as recorded', () => {
		expect(phase0(traceWithTools('session=abc')).out).toContain(
			'WARN claim-recorded',
		);
		expect(phase0(traceWithTools('claim: not_applicable ()')).out).toContain(
			'WARN claim-recorded',
		);
	}, 90_000);
});
