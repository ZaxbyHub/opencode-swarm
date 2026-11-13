import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Directive-2 text pins for the #3605/#3601 skill-surface additions: the
// progressive-disclosure ratchet caps line count only, so the new binding
// prose needs content pins that fail when the prose is deleted. Also pins the
// version lockstep (issue-tracer canonical + shims) and the Phase 9 ledger
// wiring including its reference doc.

const ROOT = process.cwd();

function read(relative: string): string {
	return readFileSync(join(ROOT, relative), 'utf-8');
}

describe('issue-tracer cluster-preflight + generator skill pins (#3605 AC2/AC3)', () => {
	test('gate-table Phase 1 exit condition names the cluster-preflight artifact', () => {
		const skill = read('.opencode/skills/issue-tracer/SKILL.md');
		const row = skill.split('\n').find((l) => l.includes('| 1 Intake |')) ?? '';
		expect(row).toContain('repro/cluster-preflight.md');
		expect(row).toContain('claim + open-PR evidence');
	}, 30_000);

	test('Phase 4.2 names the fail-closed generator', () => {
		const skill = read('.opencode/skills/issue-tracer/SKILL.md');
		const section = skill.slice(
			skill.indexOf('### Phase 4.2'),
			skill.indexOf('### Phase 4.5'),
		);
		expect(section).toContain('generate-recurrence-table.sh');
		expect(section).toContain('unmatched joins');
	}, 30_000);

	test('trace-check.sh carries the cluster-preflight phase-1 rule', () => {
		const script = read('.opencode/skills/issue-tracer/scripts/trace-check.sh');
		expect(script).toContain('rule_bad cluster-preflight');
		expect(script).toContain('no candidate sections');
		expect(script).toContain('missing claim or open-PR evidence');
	}, 30_000);

	test('issue-tracer version is 3.0.3 in the canonical and both shims (lockstep)', () => {
		for (const relative of [
			'.opencode/skills/issue-tracer/SKILL.md',
			'.claude/skills/issue-tracer/SKILL.md',
			'.agents/skills/issue-tracer/SKILL.md',
		]) {
			expect(read(relative)).toContain('version: 3.0.3');
		}
	}, 30_000);
});

describe('swarm-pr-review cost/yield ledger skill pins (#3605 AC4)', () => {
	test('Phase 9 carries the ledger step naming the script and the aggregate', () => {
		const skill = read('.opencode/skills/swarm-pr-review/SKILL.md');
		const phase9 = skill.slice(
			skill.indexOf('## Phase 9'),
			skill.indexOf('### Finding ID format'),
		);
		expect(phase9).toContain('cost-yield-ledger.sh');
		expect(phase9).toContain('per-finding cost');
		expect(phase9).toContain('lane-cost-recovery.md');
	}, 30_000);

	test('the lane-cost-recovery reference exists and pins the token semantics', () => {
		const referencePath =
			'.opencode/skills/swarm-pr-review/references/lane-cost-recovery.md';
		expect(existsSync(join(ROOT, referencePath))).toBe(true);
		const reference = read(referencePath);
		expect(reference).toContain('model_request_count');
		expect(reference).toContain('used as a denominator');
	}, 30_000);

	test('the ledger script exists and refuses unpaired rows', () => {
		const scriptPath =
			'.opencode/skills/swarm-pr-review/scripts/cost-yield-ledger.sh';
		expect(existsSync(join(ROOT, scriptPath))).toBe(true);
		expect(read(scriptPath)).toContain('LEDGER-REFUSED: unpaired');
	}, 30_000);
});

describe('publication gate order wiring pin (#3601 AC1)', () => {
	test('copilot-pr-publication-gate.sh invokes the order checker inside the body branch', () => {
		const gate = read('scripts/copilot-pr-publication-gate.sh');
		expect(gate).toContain('check-publication-body-order.sh');
		// Guarded call, not set -e suicidal, and resolved from the script's own dir.
		expect(gate).toContain(
			'if ! bash "$gate_dir/check-publication-body-order.sh"',
		);
		expect(gate).toContain('BASH_SOURCE');
	}, 30_000);
});
