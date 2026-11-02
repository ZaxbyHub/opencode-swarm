import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	FRAGMENT_SATISFACTION,
	evaluateRequirement,
	isPendingFragment,
	isUserVisiblePath,
} from '../../../../scripts/user-visible-paths';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-pending-fragment.ts');

describe('user-visible-paths (8.x port, issue #3228) — table verdicts', () => {
	test('shipped monorepo surface is user-visible', () => {
		expect(isUserVisiblePath('packages/core/src/state.ts')).toBe(true);
		expect(isUserVisiblePath('packages/opencode/src/index.ts')).toBe(true);
		expect(isUserVisiblePath('packages/claude-code/hooks/pre-install.ts')).toBe(true);
		expect(isUserVisiblePath('packages/telemetry/src/index.ts')).toBe(true);
		// claude-code ships scripts/hooks/agents per its package.json#files.
		expect(isUserVisiblePath('packages/claude-code/scripts/link.js')).toBe(true);
		// The shipped per-package npm manifests.
		expect(isUserVisiblePath('packages/telemetry/package.json')).toBe(true);
	});

	test('test trees, tooling, and non-shipped roots are not user-visible', () => {
		expect(isUserVisiblePath('packages/opencode/tests/publishing/x.test.ts')).toBe(false);
		expect(isUserVisiblePath('packages/core/tests/unit/y.test.ts')).toBe(false);
		expect(isUserVisiblePath('packages/telemetry/telemetry.test.ts')).toBe(false);
		expect(isUserVisiblePath('tests/smoke/packaging.test.ts')).toBe(false);
		expect(isUserVisiblePath('scripts/check-pending-fragment.ts')).toBe(false);
		expect(isUserVisiblePath('node_modules/zod/lib/x.js')).toBe(false);
		expect(isUserVisiblePath('docs/configuration.md')).toBe(false);
		expect(isUserVisiblePath('bun.lock')).toBe(false);
		expect(isUserVisiblePath('biome.json')).toBe(false);
	});

	test('workflow changes are user-visible; the private root manifest is not', () => {
		expect(isUserVisiblePath('.github/workflows/release-please-next.yml')).toBe(true);
		expect(isUserVisiblePath('.github/workflows/fragment-gate.yml')).toBe(true);
		// 8.x divergence from main: the ROOT package.json is the private
		// workspace manifest here, not the shipped npm manifest.
		expect(isUserVisiblePath('package.json')).toBe(false);
	});

	test('colocated test-file suffix exclusion wins even under a visible prefix', () => {
		expect(isUserVisiblePath('packages/core/src/thing.test.ts')).toBe(false);
	});

	test('fragment satisfaction is added-only', () => {
		expect(FRAGMENT_SATISFACTION).toBe('added-only');
		expect(isPendingFragment('docs/releases/pending/3150-x.md')).toBe(true);
		expect(isPendingFragment('docs/releases/pending/nested/x.md')).toBe(true);
		expect(isPendingFragment('docs/releases/v1.0.0.md')).toBe(false);
		expect(isPendingFragment('packages/core/src/x.ts')).toBe(false);
	});

	test('evaluateRequirement verdicts', () => {
		// Not required: no visible surface.
		expect(evaluateRequirement(['tests/x.test.ts', 'README.md'], [])).toEqual({ required: false, satisfied: true });
		// Required and satisfied by an added fragment.
		expect(evaluateRequirement(['packages/core/src/x.ts'], ['docs/releases/pending/new.md'])).toEqual({
			required: true,
			satisfied: true,
		});
		// Required, NOT satisfied: fragment missing.
		expect(evaluateRequirement(['packages/core/src/x.ts'], [])).toEqual({ required: true, satisfied: false });
		// Modifying someone else's pending fragment does not satisfy (added-only).
		expect(
			evaluateRequirement(
				['packages/core/src/x.ts', 'docs/releases/pending/other.md'],
				['packages/core/src/x.ts'],
			),
		).toEqual({ required: true, satisfied: false });
	});
});

describe('check-pending-fragment CLI (--print-requirement transports)', () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), 'frag-gate-'));
	const writeList = (name: string, data: string): string => {
		const p = path.join(tmp, name);
		writeFileSync(p, data);
		return p;
	};

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
	});

	function runGate(args: string[]): { code: number | null; stdout: string } {
		const result = spawnSync('bun', [GATE_SCRIPT, '--print-requirement', ...args], {
			cwd: REPO_ROOT,
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
			encoding: 'utf8',
		});
		return { code: result.status, stdout: (result.stdout ?? '').trim() };
	}

	test('jsonl transport: violation verdict + exit 1', () => {
		const changed = writeList('changed.jsonl', '"packages/opencode/src/x.ts"\n');
		const added = writeList('added.jsonl', '');
		const result = runGate(['--paths-format', 'jsonl', '--changed-file', changed, '--added-file', added]);
		expect(result.stdout).toBe('required=true satisfied=false');
		expect(result.code).toBe(1);
	});

	test('jsonl transport: satisfied verdict + exit 0', () => {
		const changed = writeList('changed2.jsonl', '"packages/opencode/src/x.ts"\n');
		const added = writeList('added2.jsonl', '"docs/releases/pending/pr-x.md"\n');
		const result = runGate(['--paths-format', 'jsonl', '--changed-file', changed, '--added-file', added]);
		expect(result.stdout).toBe('required=true satisfied=true');
		expect(result.code).toBe(0);
	});

	test('nul transport: matches git diff -z framing', () => {
		const changed = writeList('changed.nul', 'packages/core/src/a.ts\0packages/core/src/b.ts\0');
		const added = writeList('added.nul', 'packages/core/src/a.ts\0');
		const result = runGate(['--paths-format', 'nul', '--changed-file', changed, '--added-file', added]);
		expect(result.stdout).toBe('required=true satisfied=false');
		expect(result.code).toBe(1);
	});

	test('chore-only diff: not required, exit 0', () => {
		const changed = writeList('changed3.jsonl', '"scripts/tool.ts"\n');
		const added = writeList('added3.jsonl', '');
		const result = runGate(['--paths-format', 'jsonl', '--changed-file', changed, '--added-file', added]);
		expect(result.stdout).toBe('required=false satisfied=true');
		expect(result.code).toBe(0);
	});

	test('a file list without --paths-format is unusable (exit 2), never a silent mis-decode (review PRR-016)', () => {
		const changed = writeList('changed-nofmt.nul', 'packages/opencode/src/x.ts\0');
		const added = writeList('added-nofmt.jsonl', '');
		const result = runGate(['--changed-file', changed, '--added-file', added]);
		expect(result.code).toBe(2);
	});

	test('garbage jsonl line is unusable (exit 2), never a silent empty list', () => {
		const changed = writeList('changed4.jsonl', 'not-json{\n');
		const added = writeList('added4.jsonl', '');
		const result = runGate(['--paths-format', 'jsonl', '--changed-file', changed, '--added-file', added]);
		expect(result.code).toBe(2);
	});
});
