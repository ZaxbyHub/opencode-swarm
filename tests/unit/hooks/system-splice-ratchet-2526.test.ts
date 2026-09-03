/**
 * Issue #2526 ratchet: no production code may construct a synthetic
 * `role:'system'` entry for the `experimental.chat.messages.transform`
 * surface. The pinned host discards such entries (and throws on flat ones),
 * so every producer must splice a guidance carrier instead
 * (`src/hooks/system-guidance-carrier.ts`).
 *
 * This encodes the issue's exit gate ("a grep finds zero remaining
 * `role: 'system'` splices into `experimental.chat.messages.transform`") as
 * a permanent source-scan, mirroring the rebind-guard pattern.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

/**
 * The ONLY files allowed to mention a `role: 'system'` construction:
 *  - role-filter.ts: the `experimental.chat.system.transform` STRING adapter
 *    (`output.system` — a surface the host renders) plus the ContextEntry
 *    type. It never writes into `output.messages`.
 *  - messages-transform.ts: the boundary materializer CONSUMER (it compares
 *    `role === 'system'` to find entries to convert; comparisons use `===`,
 *    not object-literal construction, but the file is allowlisted wholesale
 *    because the converter's spirit is "handles system entries", not
 *    "creates them").
 */
const ALLOWLIST = new Set([
	'src/context/role-filter.ts',
	'src/hooks/messages-transform.ts',
]);

const SYSTEM_CONSTRUCTION = /role:\s*['"]system['"]/;

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			out.push(...listTsFiles(full));
		} else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
			// Co-located *.test.ts files build system entries as FIXTURES
			// (input to the materializer/consumers) — the ratchet targets
			// production splice sites only.
			out.push(full);
		}
	}
	return out;
}

describe('system-splice ratchet (issue #2526)', () => {
	test('no src/ file constructs a role:"system" message entry outside the allowlist', () => {
		const offenders: string[] = [];
		for (const file of listTsFiles(SRC_DIR)) {
			const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
			if (ALLOWLIST.has(rel)) continue;
			const source = readFileSync(file, 'utf-8');
			for (const [idx, line] of source.split('\n').entries()) {
				const trimmed = line.trim();
				// Comments (documenting the defect) are fine; constructions are not.
				if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
				if (SYSTEM_CONSTRUCTION.test(line)) {
					offenders.push(`${rel}:${idx + 1}: ${trimmed}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
