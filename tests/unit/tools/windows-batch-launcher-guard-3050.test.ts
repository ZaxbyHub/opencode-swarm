/**
 * Issue #3050, Phase 4.2 guardrail — no module may construct a Windows batch
 * wrapper as a raw spawn target.
 *
 * The defect class: a `.bat`/`.cmd` path handed to a spawner without going
 * through `resolveContainedWindowsBatchCommand`. Node's
 * `child_process.spawn` rejects a batch file outright (EINVAL); Bun tolerates
 * one, which is what let this survive on the primary dev/test runtime.
 *
 * SCOPE, deliberately narrow. A scan for *any* `.bat`/`.cmd` literal in `src/`
 * flags ~20 sites — PATH-extension lists (`*-executable.ts`), `existsSync`
 * probes, npm-shim joins, and `pkg-audit.ts`'s hand-rolled launcher for a
 * different class. Those are dispositioned in the trace as out of scope, and a
 * guard red on them would be weakened until it proved nothing. This guard
 * pins the class this issue actually closes: a **project-local wrapper path**
 * (`vendor/bin` joined with a batch extension) used as a spawn target.
 *
 * ANTI-VACUITY. The resolver's own `export function
 * resolveContainedWindowsBatchCommand(` declaration is excluded with a
 * negative lookbehind, so a "defined but never called" mutation still trips
 * this test rather than satisfying it vacuously.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

/** Every .ts file under src/, co-located tests excluded. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...sourceFiles(full));
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
			out.push(full);
		}
	}
	return out;
}

/**
 * A project-local batch wrapper being CONSTRUCTED: a `path.join('vendor',
 * 'bin', …)` whose argument list appends a batch extension.
 *
 * Scoped to that exact shape on purpose. A looser `${name}.bat` rule also
 * matches `src/hooks/spawn-helper.ts` (`${rawCmd}.cmd`, a package-manager shim
 * deliberately spawned raw) and the PATH probe-candidate list in
 * `src/services/directive-predicate-runner.ts` — neither is a Composer wrapper,
 * and a guard red on them would be weakened until it proved nothing.
 */
const BATCH_CONSTRUCTION =
	/path\.join\(\s*'vendor',\s*'bin',[\s\S]{0,120}?\.(?:bat|cmd)\b/g;

/**
 * A CALL to the resolver. The negative lookbehind skips the helper's own
 * declaration, so this counts real uses only.
 */
const RESOLVER_CALL =
	/(?<!export\sfunction\s)(?<!function\s)resolveContainedWindowsBatchCommand\s*\(/g;

/** How far back to look for the resolver call that sanctions a construction. */
const EXEMPTION_WINDOW = 200;

function count(text: string, pattern: RegExp): number {
	const re = new RegExp(pattern.source, pattern.flags);
	return (text.match(re) ?? []).length;
}

/**
 * Batch constructions in `text` that are NOT the wrapper-path argument of a
 * `resolveContainedWindowsBatchCommand(` call. Proximity, not a whole-file
 * count: a module that correctly routes one wrapper must not thereby license an
 * unrelated raw batch path elsewhere in the same file.
 */
function unsanctionedConstructions(text: string): string[] {
	const re = new RegExp(BATCH_CONSTRUCTION.source, BATCH_CONSTRUCTION.flags);
	const offenders: string[] = [];
	for (const match of text.matchAll(re)) {
		const start = match.index ?? 0;
		const preceding = text.slice(Math.max(0, start - EXEMPTION_WINDOW), start);
		if (!preceding.includes('resolveContainedWindowsBatchCommand(')) {
			const line = text.slice(0, start).split('\n').length;
			offenders.push(`line ${line}: ${match[0].replace(/\s+/g, ' ')}`);
		}
	}
	return offenders;
}

describe('#3050 guardrail: batch wrappers must route through the contained launcher', () => {
	test('no src module constructs a project-local batch wrapper outside the resolver', () => {
		const offenders: string[] = [];

		for (const file of sourceFiles(SRC_DIR)) {
			const unsanctioned = unsanctionedConstructions(
				fs.readFileSync(file, 'utf8'),
			);
			if (unsanctioned.length > 0) {
				offenders.push(
					`${path.relative(REPO_ROOT, file)}: ${unsanctioned.join('; ')}`,
				);
			}
		}

		expect(offenders, offenders.join('\n')).toEqual([]);
	});

	test('the resolver call form is recognised, not just its declaration', () => {
		// Proves the pattern discriminates. Without the negative lookbehind the
		// helper's own `export function resolveContainedWindowsBatchCommand(`
		// line would satisfy the count, and a "defined but never called" mutation
		// would pass this guard vacuously.
		const resolverSource = fs.readFileSync(
			path.join(SRC_DIR, 'utils', 'windows-batch.ts'),
			'utf8',
		);
		expect(count(resolverSource, RESOLVER_CALL)).toBe(0);

		const backendSource = fs.readFileSync(
			path.join(SRC_DIR, 'lang', 'default-backend.ts'),
			'utf8',
		);
		expect(count(backendSource, RESOLVER_CALL)).toBeGreaterThan(0);
	});

	test('the PHP vendor builder is wired to the resolver, not hand-rolled', () => {
		// Call-site form, so removing the call while leaving the helper exported
		// trips this: a plain identifier check would still pass.
		const backendSource = fs.readFileSync(
			path.join(SRC_DIR, 'lang', 'default-backend.ts'),
			'utf8',
		);
		expect(backendSource).toMatch(
			/resolveContainedWindowsBatchCommand\(\s*\n?\s*dir,\s*\n?\s*path\.join\(\s*'vendor',\s*'bin',\s*`\$\{name\}\.bat`/,
		);
	});
});
