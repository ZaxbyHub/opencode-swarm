import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');

/**
 * Source files on the plugin-host path that can write to the terminal while the
 * host bubbletea TUI owns it. Each is scanned for raw `console.warn` calls that
 * bypass the TUI-safety contract (issue #1249 class; broader sweep in epic
 * #1752). As PR2–5 of #1752 migrate the remaining modules, add them to this
 * scope list so the same class of regression cannot recur there.
 *
 * The contract: every `console.warn` must be guarded by a `quiet`/`config.quiet`
 * check (either `!config.quiet` / `!quiet`, or a `quiet ... else` two-way
 * branch). The bundled-skill sync failure path legitimately retains a guarded
 * `console.warn` for the `quiet=false` host parity branch; that is allowed
 * because it is guarded. The success path is now debug-gated only.
 *
 * Unconditional `console.error` / `logger.error()` on exceptional paths (init
 * failure, pr-monitor errors) are intentionally out of scope — the two
 * intentional FATAL `console.error` calls in src/index.ts are biome-ignored
 * with an explicit issue #675 rationale.
 */
const TUI_SAFETY_SCOPES: Array<{
	file: string;
	label: string;
	quietTokens: string[];
}> = [
	// src/index.ts uses `config.quiet` as the guard variable name.
	{
		file: 'src/index.ts',
		label: 'index.ts',
		quietTokens: ['!config.quiet'],
	},
	// src/config/bundled-skills.ts uses a local `quiet` parameter.
	{
		file: 'src/config/bundled-skills.ts',
		label: 'bundled-skills.ts',
		quietTokens: ['!quiet', 'quiet)'],
	},
	// src/commands/registry.ts: the command path must never write stderr
	// mid-turn; assert it has zero unguarded console.warn (it should have
	// zero console.warn at all).
	{
		file: 'src/commands/registry.ts',
		label: 'registry.ts',
		quietTokens: ['!config.quiet', '!quiet'],
	},
	// PR2 of epic #1752 migrated these init-path modules to advisoryWarn/log.
	// They must contain ZERO raw console.warn/error/log (the `noConsole` lint
	// rule is deferred to PR5, so this static guard is the interim regression
	// net). quietTokens: [] means findUnguardedWarns flags ANY console.warn.
	{
		file: 'src/config/loader.ts',
		label: 'loader.ts',
		quietTokens: [],
	},
	{
		file: 'src/agents/architect.ts',
		label: 'architect.ts',
		quietTokens: [],
	},
	{
		file: 'src/session/snapshot-reader.ts',
		label: 'snapshot-reader.ts',
		quietTokens: [],
	},
	{
		file: 'src/config/project-init.ts',
		label: 'project-init.ts',
		quietTokens: [],
	},
	// PR3 of epic #1752 migrated these hook-path modules (chat/tool/system
	// message hooks + their service deps + the prm subsystem) to
	// advisoryWarn/log. Same contract as the PR2 block above: zero raw
	// console.warn. This is the interim regression guard until PR5 enables
	// Biome `noConsole` globally.
	{
		file: 'src/hooks/delegation-gate.ts',
		label: 'delegation-gate.ts',
		quietTokens: [],
	},
	{
		file: 'src/hooks/delegation-gate/worktree-isolation.ts',
		label: 'worktree-isolation.ts',
		quietTokens: [],
	},
	{
		file: 'src/hooks/knowledge-store.ts',
		label: 'knowledge-store.ts',
		quietTokens: [],
	},
	{
		file: 'src/hooks/skill-usage-log.ts',
		label: 'skill-usage-log.ts',
		quietTokens: [],
	},
	{
		file: 'src/council/council-evidence-writer.ts',
		label: 'council-evidence-writer.ts',
		quietTokens: [],
	},
	{
		file: 'src/diff/ast-diff.ts',
		label: 'ast-diff.ts',
		quietTokens: [],
	},
	{
		file: 'src/services/context-budget-service.ts',
		label: 'context-budget-service.ts',
		quietTokens: [],
	},
	{
		file: 'src/session/worktree-link-suggestion.ts',
		label: 'worktree-link-suggestion.ts',
		quietTokens: [],
	},
	{
		file: 'src/prm/index.ts',
		label: 'prm-index.ts',
		quietTokens: [],
	},
	{
		file: 'src/prm/replay.ts',
		label: 'prm-replay.ts',
		quietTokens: [],
	},
	{
		file: 'src/prm/trajectory-store.ts',
		label: 'prm-trajectory-store.ts',
		quietTokens: [],
	},
];

function readScope(file: string): string {
	return readFileSync(path.resolve(REPO_ROOT, file), 'utf-8');
}

/**
 * Asserts that every `console.warn(` line in `src` is preceded (within 8 lines)
 * by a quiet-guard. A guard is recognized in EITHER of two forms (both are used
 * in this codebase):
 *   - negated guard: a `!config.quiet` / `!quiet` token in the preceding context
 *   - two-way else branch: a `quiet`/`config.quiet` token AND a `} else` in the
 *     preceding context (the `if (config.quiet) ... else console.warn(...)` form
 *     used by scheduleVersionCheck and the bundled-skill failure path).
 * Any `console.warn` lacking either form is collected as unguarded.
 *
 * Limitation: the `hasElseBranch` check matches a `} else` and a quiet token
 * anywhere in the 8-line window without verifying they belong to the same
 * if-statement; this is adequate for the owned files (which have clean guard
 * patterns) but is not AST-accurate for arbitrary dense control flow.
 */
function findUnguardedWarns(
	src: string,
	quietTokens: string[],
): Array<{ line: number; context: string }> {
	const lines = src.split('\n');
	const unguarded: Array<{ line: number; context: string }> = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (!/console\.warn\(/.test(lines[i])) continue;
		const context = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
		const hasNegatedGuard = quietTokens.some((token) =>
			context.includes(token),
		);
		const hasElseBranch =
			context.includes('} else') &&
			quietTokens.some((token) => context.includes(token.replace('!', '')));
		if (!hasNegatedGuard && !hasElseBranch) {
			unguarded.push({ line: i + 1, context });
		}
	}
	return unguarded;
}

describe('Plugin TUI safety', () => {
	test('no process.exit in SIGINT/SIGTERM handlers', () => {
		const INDEX_SRC = readScope('src/index.ts');
		const sigintBlock = /process\.once\(\s*['"]SIGINT['"][\s\S]*?process\.exit/;
		const sigtermBlock =
			/process\.once\(\s*['"]SIGTERM['"][\s\S]*?process\.exit/;
		expect(sigintBlock.test(INDEX_SRC)).toBe(false);
		expect(sigtermBlock.test(INDEX_SRC)).toBe(false);
	});

	test('no SIGINT/SIGTERM handler registrations via any method', () => {
		const INDEX_SRC = readScope('src/index.ts');
		const methods = ['process.once', 'process.on', 'process.addListener'];
		const signals = ['SIGINT', 'SIGTERM'];
		for (const method of methods) {
			for (const signal of signals) {
				expect(INDEX_SRC).not.toContain(`${method}('${signal}'`);
				expect(INDEX_SRC).not.toContain(`${method}("${signal}"`);
			}
		}
	});

	test('Config Doctor console.warn calls are guarded by config.quiet', () => {
		const INDEX_SRC = readScope('src/index.ts');
		const doctorSection = INDEX_SRC.slice(
			INDEX_SRC.indexOf('Config Doctor'),
			INDEX_SRC.indexOf('Advisory emission must never block startup') + 50,
		);
		const warnCalls = doctorSection.match(/console\.warn\(/g) || [];
		const quietGuards = doctorSection.match(/!config\.quiet/g) || [];
		expect(warnCalls.length).toBeGreaterThan(0);
		expect(quietGuards.length).toBeGreaterThanOrEqual(warnCalls.length);
	});

	test('every console.warn in index.ts is guarded by config.quiet check', () => {
		const INDEX_SRC = readScope('src/index.ts');
		const unguarded = findUnguardedWarns(INDEX_SRC, ['!config.quiet']).map(
			(u) => u.line,
		);
		expect(unguarded).toEqual([]);
	});

	test('bundled-skill sync has no unguarded console.warn (issue #1249 class)', () => {
		const src = readScope('src/config/bundled-skills.ts');
		const unguarded = findUnguardedWarns(src, ['!quiet', 'quiet)']);
		expect(unguarded).toEqual([]);
	});

	test('command registry has no unguarded console.warn (command path TUI safety)', () => {
		const src = readScope('src/commands/registry.ts');
		const unguarded = findUnguardedWarns(src, ['!config.quiet', '!quiet']);
		expect(unguarded).toEqual([]);
		expect(
			(src.match(/console\.warn\(/g) || []).length,
			'registry.ts command path must contain zero console.warn calls (mid-turn stderr corrupts the TUI)',
		).toBe(0);
	});

	test('TUI_SAFETY_SCOPES files all exist and are non-empty', () => {
		for (const scope of TUI_SAFETY_SCOPES) {
			const src = readScope(scope.file);
			expect(src.length, `${scope.file} should be non-empty`).toBeGreaterThan(
				0,
			);
		}
	});

	test('PR2/PR3-migrated modules have zero raw console.warn (epic #1752)', () => {
		// PR2 (loader.ts, architect.ts, snapshot-reader.ts, project-init.ts)
		// and PR3 (delegation-gate, worktree-isolation, knowledge-store,
		// skill-usage-log, council-evidence-writer, ast-diff,
		// context-budget-service, worktree-link-suggestion, prm/*) were
		// migrated to advisoryWarn/log. They must contain ZERO raw
		// console.warn so the bubbletea TUI is never corrupted on the init
		// and hook paths (issue #1249 class). This is the interim regression
		// guard until PR5 enables Biome `noConsole` globally.
		for (const scope of TUI_SAFETY_SCOPES) {
			if (scope.quietTokens.length > 0) continue; // skip guarded-scope files
			const src = readScope(scope.file);
			const warnCount = (src.match(/console\.warn\(/g) || []).length;
			expect(
				warnCount,
				`${scope.file} must contain zero raw console.warn after epic #1752 PR2/PR3 migration`,
			).toBe(0);
		}
	});

	test('gitignore-warning.ts has exactly one intentional raw console.warn (tracked-file security)', () => {
		// src/utils/gitignore-warning.ts retains ONE intentionally-unguarded
		// console.warn — the ".swarm/ files are tracked by Git" remediation
		// warning (must-see-always security/hygiene). All other advisories in
		// this file route through advisoryWarn. Assert the count is exactly 1
		// and the comment rationale is present.
		const src = readScope('src/utils/gitignore-warning.ts');
		const warnMatches = src.match(/console\.warn\(/g) || [];
		expect(warnMatches.length).toBe(1);
		expect(src).toContain('INTENTIONALLY NOT gated behind quiet');
	});
});
