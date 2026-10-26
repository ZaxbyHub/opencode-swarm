/**
 * #3350 AC3 (PR #3327 follow-up) — one constant name must not mean two
 * different budgets inside src/host/v2/.
 *
 * DEFECT (base 8e5cfd387): `V2_REGISTRATION_TIMEOUT_MS` is declared as 3_500
 * in src/host/v2/setup.ts (the parallel-registration-stage budget) and as
 * 60_000 in src/host/v2/agents-commands.ts (the per-call budget for the
 * synthetic config-hook run, the agent transform, the command transform and
 * per-command prompt submission). Same name, different meaning: any reader or
 * future refactor that moves one into shared scope silently changes the other.
 *
 * CONTRACT pinned on the implementer (issue #3350 scope):
 *  - `V2_REGISTRATION_TIMEOUT_MS` appears in EXACTLY ONE file under
 *    src/host/v2/ — setup.ts, which keeps the name and its 3_500 value.
 *  - agents-commands.ts renames its per-call budget to a DISTINCT name.
 *  - Out-of-scope pin: no budget VALUE changes — 3_500 / 60_000 (setup),
 *    60_000 (agents-commands per-call), 2_000 (preflight config read).
 *
 * Static source check (reads the real files at run time; no mocks).
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const V2_SRC_DIR = path.resolve(import.meta.dir, '../../../../src/host/v2');

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listTsFiles(entryPath));
		} else if (entry.name.endsWith('.ts')) {
			out.push(entryPath);
		}
	}
	return out;
}

const filesContaining = (needle: string): string[] =>
	listTsFiles(V2_SRC_DIR)
		.filter((f) => fs.readFileSync(f, 'utf-8').includes(needle))
		.map((f) => path.relative(V2_SRC_DIR, f))
		.sort();

describe('#3350 AC3 constant-name collision', () => {
	test('V2_REGISTRATION_TIMEOUT_MS appears in exactly one file under src/host/v2/ (base: 2 files -> red)', () => {
		// The registration-stage budget belongs to setup.ts only; base also
		// declares the same NAME in agents-commands.ts with a 60_000 value.
		const offenders = filesContaining('V2_REGISTRATION_TIMEOUT_MS');
		expect(offenders).toEqual(['setup.ts']);
	});

	test('agents-commands.ts uses a distinct constant name for its per-call budget', () => {
		const src = fs.readFileSync(
			path.join(V2_SRC_DIR, 'agents-commands.ts'),
			'utf-8',
		);
		expect(src).not.toContain('V2_REGISTRATION_TIMEOUT_MS');
		// The per-call budget VALUE must survive the rename unchanged.
		expect(src).toMatch(/=\s*60_000\b/);
	});

	test('setup.ts budget values are unchanged (out-of-scope pin; green at base)', () => {
		const src = fs.readFileSync(path.join(V2_SRC_DIR, 'setup.ts'), 'utf-8');
		expect(src).toContain('const V2_SETUP_TIMEOUT_MS = 60_000;');
		expect(src).toContain('const V2_REGISTRATION_TIMEOUT_MS = 3_500;');
		expect(src).toContain('const V2_PREFLIGHT_CONFIG_TIMEOUT_MS = 2_000;');
	});
});
