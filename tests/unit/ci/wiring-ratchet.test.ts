/**
 * Wiring ratchet for src/ci exports (issue #2497; plan-critic R3).
 *
 * Every export under src/ci/*.ts must be reachable from the production
 * entry (`src/commands/ci.ts`) by walking ACTUAL import statements
 * transitively — no internal-only orphan exports, no unwired surfaces.
 * This is the in-repo strengthening above the frozen C9 coarse scan.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = process.cwd();
const CI_DIR = path.join(REPO, 'src', 'ci');
const ENTRY = path.join(REPO, 'src', 'commands', 'ci.ts');

// Matches both `import ... from '...'` and re-export edges
// (`export { x } from '...'` / `export type { x } from '...'`), which are
// real edges of the module graph (the src/ci barrel is built from them).
const IMPORT_RE =
	/(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|[\w$]+|\*\s+as\s+[\w$]+)?\s*(?:from\s+)?['"]([^'"]+)['"]/g;

function resolveSpec(fromFile: string, spec: string): string | null {
	if (!spec.startsWith('.')) return null; // external package
	const resolved = path.resolve(path.dirname(fromFile), spec);
	// Source imports use the .js ESM specifier convention for .ts files.
	const base = resolved.endsWith('.js') ? resolved.slice(0, -3) : resolved;
	for (const candidate of [`${base}.ts`, base, path.join(base, 'index.ts')]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return null;
}

function importsOf(file: string): Array<{ target: string; file: string }> {
	const source = fs.readFileSync(file, 'utf-8');
	const out: Array<{ target: string; file: string }> = [];
	let match: RegExpExecArray | null;
	IMPORT_RE.lastIndex = 0;
	while ((match = IMPORT_RE.exec(source)) !== null) {
		const target = resolveSpec(file, match[1]);
		if (target) out.push({ target, file });
	}
	return out;
}

function exportedNames(file: string): string[] {
	const source = fs.readFileSync(file, 'utf-8');
	const names: string[] = [];
	// export const/function/class/let X — single declarator form only.
	for (const m of source.matchAll(
		/export\s+(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/g,
	)) {
		names.push(m[1]);
	}
	// export { a, b as c } from '...' / export { a, b };
	for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) {
		for (const part of m[1].split(',')) {
			const entry = part.trim();
			// Inline `type X` entries re-export X from the ORIGIN module,
			// whose declaration site this scan already checks — skip them so
			// a barrel's type re-exports are not double-counted as the
			// barrel's own declarations.
			if (entry.startsWith('type ')) continue;
			const name = entry
				.split(/\s+as\s+/)
				.pop()
				?.trim();
			if (name) names.push(name);
		}
	}
	return [...new Set(names)];
}

/** Recursive *.ts listing: orphan exports in nested subdirectories must be
 * scanned too (reviewer Probe C, #2497 4.5 round 1). */
function listCiModules(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
		}
	};
	walk(CI_DIR);
	return out;
}

describe('src/ci wiring ratchet', () => {
	test('every src/ci module is reachable from src/commands/ci.ts via real imports', () => {
		const ciModules = listCiModules();
		const reachable = new Set<string>();
		const queue = [ENTRY];
		while (queue.length > 0) {
			const file = queue.pop() as string;
			if (reachable.has(file)) continue;
			reachable.add(file);
			for (const { target } of importsOf(file)) queue.push(target);
		}
		const orphans = ciModules.filter((m) => !reachable.has(m));
		expect(
			orphans.map((m) => path.relative(REPO, m)),
			'src/ci modules not imported (transitively) by the production entry src/commands/ci.ts',
		).toEqual([]);
	});

	test('every export in src/ci modules is referenced by the production graph or a test seam', () => {
		const ciModules = listCiModules();
		const reachable = new Set<string>();
		const queue = [ENTRY];
		while (queue.length > 0) {
			const file = queue.pop() as string;
			if (reachable.has(file)) continue;
			reachable.add(file);
			for (const { target } of importsOf(file)) queue.push(target);
		}
		// Reference consumers: the reachable production graph plus this
		// feature's test files — the repo sanctions test-only _internals-style
		// seams (AGENTS.md invariant 7), so an export consumed by tests is
		// wired; an export consumed by NEITHER is dead.
		for (const f of fs.readdirSync(path.join(REPO, 'tests/unit/ci'))) {
			// Every test/helper under tests/unit/ci is this feature's test seam.
			reachable.add(path.join(REPO, 'tests/unit/ci', f));
		}
		reachable.add(path.join(REPO, 'tests/unit/commands/ci.test.ts'));
		const graphSources = new Map<string, string>();
		for (const file of reachable) {
			try {
				graphSources.set(file, fs.readFileSync(file, 'utf-8'));
			} catch {
				// Non-file or unreadable node: skip.
			}
		}
		const orphans: string[] = [];
		for (const module of ciModules) {
			const rel = path.relative(REPO, module);
			for (const name of exportedNames(module)) {
				let referenced = false;
				for (const [file, source] of graphSources) {
					if (file === module) continue;
					// Match the bare identifier anywhere (import, usage, or — accepted
					// limitation — a comment mention; a text scan, not a symbol-graph
					// walk, keeps this deterministic under bun test).
					if (new RegExp(`\\b${name}\\b`).test(source)) {
						referenced = true;
						break;
					}
				}
				if (!referenced) orphans.push(`${rel}: ${name}`);
			}
		}
		expect(
			orphans,
			'src/ci exports referenced by neither the production graph nor a test seam',
		).toEqual([]);
	});
});
