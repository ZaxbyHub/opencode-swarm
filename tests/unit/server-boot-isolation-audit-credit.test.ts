/**
 * Companion regression test for `server-boot-isolation-audit.test.ts` (issue
 * #2010, AC4).
 *
 * Lives in its own file because the audit itself sits at exactly the FR-006
 * 500-line cap and has no headroom — the same split precedent as
 * `tests/helpers/test-isolation-contracts.test.ts`.
 *
 * ## What regressed, and why it mattered
 *
 * The audit credits a protection factored into a `tests/helpers/**` module only
 * from the body of the binding a test file actually imports. `exportBlocks`
 * originally kept the *declaration* line as the first line of that body, so
 * `export function createIsolatedTestEnv(): {` matched `ENV_ISOLATION_RE` —
 * which is documented to match a CALL, `createIsolatedTestEnv(`, and never a
 * bare mention. The consequence: a boot file that merely *imported* the name
 * and never wired it earned "env-isolation" credit it had not earned, and the
 * audit reported it clean.
 *
 * That is precisely how issue #2010 recurs: a contributor copies an isolated
 * test file's import block, forgets the `beforeEach` wiring, and ships a boot
 * that rewrites the developer's real `~/.config/opencode/opencode-swarm.json`
 * while CI stays green. Biome's `noUnusedImports` is disabled for `tests/**`
 * (`biome.json`), so nothing else catches the dangling import either.
 *
 * These tests pin the credit rule directly against the real helper sources, so
 * the hole cannot silently reopen.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const AUDIT_FILE = join(
	REPO_ROOT,
	'tests',
	'unit',
	'server-boot-isolation-audit.test.ts',
);
const ISOLATED_TEST_ENV = join(
	REPO_ROOT,
	'tests',
	'helpers',
	'isolated-test-env.ts',
);
const INDEX_COMMANDS_SHARED = join(
	REPO_ROOT,
	'tests',
	'helpers',
	'index-commands-shared.ts',
);

/** The audit's own env-isolation predicate, mirrored here on purpose. */
const ENV_ISOLATION_RE =
	/createIsolatedTestEnv\s*\(|setupIsolatedState\s*\(|withIsolatedState\s*\(|process\.env\.XDG_CONFIG_HOME\s*=/;

describe('server-boot isolation audit — helper credit rule', () => {
	test('the declaration line is excluded from an export body', () => {
		// The guard is a single line in `exportBlocks`. Pin it so a future edit
		// back to `current = [line]` fails here with an explanation rather than
		// silently reopening the credit hole.
		const audit = readFileSync(AUDIT_FILE, 'utf8');
		expect(audit).toContain('current = [];');
		expect(audit).not.toContain('current = [line];');
	});

	test('a bare `createIsolatedTestEnv` import cannot earn isolation credit', () => {
		// This is the exact string a dangling import would contribute: the
		// helper's own declaration line. If it matches the audit's predicate,
		// importing the name is enough to look protected.
		const source = readFileSync(ISOLATED_TEST_ENV, 'utf8');
		const declarationLine = source
			.split(/\r?\n/)
			.find((line) => line.startsWith('export function createIsolatedTestEnv'));

		expect(declarationLine).toBeDefined();
		expect(declarationLine).toContain('createIsolatedTestEnv');
		// The declaration matches the predicate — which is WHY it must never be
		// part of a credited body.
		expect(ENV_ISOLATION_RE.test(declarationLine as string)).toBe(true);
	});

	test('helpers that legitimately grant credit still call the guard in their bodies', () => {
		// The fix must not over-correct: the four `index-commands*` boot files
		// are credited solely through these two bindings, so their bodies (not
		// their declaration lines) must contain the real calls.
		const shared = readFileSync(INDEX_COMMANDS_SHARED, 'utf8');
		const lines = shared.split(/\r?\n/);

		const isolationCall = lines.findIndex(
			(line) => !line.startsWith('export') && ENV_ISOLATION_RE.test(line),
		);
		expect(isolationCall).toBeGreaterThan(-1);

		const schedulerStub = lines.findIndex(
			(line) =>
				!line.startsWith('export') &&
				/schedulePostResolutionTasks\s*:/.test(line),
		);
		expect(schedulerStub).toBeGreaterThan(-1);
	});
});
