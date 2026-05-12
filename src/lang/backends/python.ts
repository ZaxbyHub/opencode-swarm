/**
 * Python backend.
 *
 * Phase 5 of language-agnostic plugin work. Overrides `extractImports`
 * with Python-specific import regexes (`import x`, `from x import y`)
 * so the test-impact analyzer can build a graph for Python projects.
 * Other hooks (selectTestFramework, selectBuildCommand, parseTestOutput,
 * testFilesFor) inherit the registry-driven defaults.
 *
 * Invariants (same as typescript.ts):
 *   - No subprocess calls; defers binary checks to `isCommandAvailable`.
 *   - No `bun:` imports, no `Bun.*` calls.
 *   - Backend-purity test in `tests/unit/lang/backend-purity.test.ts`
 *     enforces both at PR time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FrameworkSelection, LanguageBackend } from '../backend';
import { defaultBackendFor } from '../default-backend';
import { LANGUAGE_REGISTRY } from '../profiles';

const PROFILE_ID = 'python';

/**
 * Python import patterns.
 *
 *   `import foo`              → "foo"
 *   `import foo.bar`          → "foo.bar"
 *   `import foo as f`         → "foo"
 *   `import foo, bar`         → "foo", "bar"
 *   `from foo import x`       → "foo"
 *   `from foo.bar import x`   → "foo.bar"
 *   `from . import mod`       → ".mod"  (PR #825 review P1 #5: previously
 *                                "." which resolved to __init__.py
 *                                instead of mod.py — silent miss)
 *   `from . import a, b`      → ".a", ".b"
 *   `from .foo import x`      → ".foo"
 *   `from ..bar.baz import x` → "..bar.baz"
 *
 * For `from X import Y`, when X is purely relative (`.` / `..` / `...`),
 * the target Y is the actual imported NAME — we emit `X+Y` so the
 * analyzer's resolver can locate `Y.py` or `Y/__init__.py` relative to
 * the test file's package directory.
 *
 * Multi-line `from x import (\n  a,\n  b\n)` is captured (we scan the
 * parenthesized block for names). Conditional/lazy imports inside
 * `if TYPE_CHECKING:` or `try: ... except ImportError:` are captured as
 * if they were unconditional — same fidelity the TypeScript backend
 * offers for `if (cond) require(...)`.
 */
const IMPORT_REGEX_FROM_WITH_TARGETS =
	/^\s*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n#]+)/gm;
const IMPORT_REGEX_IMPORT = /^\s*import\s+([^\n#]+)/gm;

function parseImportTargets(rawTargets: string): string[] {
	// Strip surrounding parens (multi-line group import form), then drop
	// per-line `# ...` comments (e.g. `# noqa`, `# type: ignore`). Without
	// stripping comments, a target like `List # noqa` would fail the
	// `[\w]+$` test and the name would be silently dropped from the
	// impact graph. Adversarial review C2.
	//
	// Also handle backslash line continuations (`from x import a, \\\n  b`):
	// the captured group ends at the literal `\n`, so the first line
	// captures `a, \\`. Strip trailing `\` before splitting.
	const cleaned = rawTargets
		.replace(/[()]/g, '')
		.split('\n')
		.map((line) => line.replace(/#.*$/, '').replace(/\\\s*$/, ''))
		.join(' ');
	const out: string[] = [];
	for (const seg of cleaned.split(',')) {
		const trimmed = seg.trim();
		if (trimmed.length === 0) continue;
		// `name as alias` → keep `name`.
		const name = trimmed.split(/\s+as\s+/)[0].trim();
		if (/^[\w]+$/.test(name)) out.push(name);
	}
	return out;
}

function extractImports(_sourceFile: string, source: string): string[] {
	const out = new Set<string>();
	// Pre-tokenize: join backslash line continuations so multi-line
	// non-parenthesized imports (`from x import a, \\\n  b`) are visible
	// to the line-anchored regexes below. Python's tokenizer does this
	// before parsing.
	source = source.replace(/\\\r?\n[ \t]*/g, ' ');

	IMPORT_REGEX_FROM_WITH_TARGETS.lastIndex = 0;
	let m: RegExpExecArray | null = IMPORT_REGEX_FROM_WITH_TARGETS.exec(source);
	while (m !== null) {
		const fromClause = m[1]; // e.g. "."  ".foo"  "foo.bar"  ""
		const targets = parseImportTargets(m[2]);
		// `from .` (purely relative, no package) — emit `.<target>` per target.
		// `from .foo` — emit ".foo" itself (target lives inside ".foo").
		// `from foo.bar` — emit "foo.bar" (absolute — analyzer ignores).
		const isPurelyRelative = fromClause.length > 0 && /^\.+$/.test(fromClause);
		if (isPurelyRelative && targets.length > 0) {
			for (const t of targets) out.add(`${fromClause}${t}`);
		} else if (fromClause.length > 0) {
			out.add(fromClause);
		}
		m = IMPORT_REGEX_FROM_WITH_TARGETS.exec(source);
	}

	IMPORT_REGEX_IMPORT.lastIndex = 0;
	m = IMPORT_REGEX_IMPORT.exec(source);
	while (m !== null) {
		// `import foo, bar as B, baz` → split on commas (respecting `as`
		// aliases), drop each `as alias` segment, keep the module path.
		const segments = m[1].split(',');
		for (const seg of segments) {
			const trimmed = seg.trim();
			if (trimmed.length === 0) continue;
			const mod = trimmed.split(/\s+as\s+/)[0].trim();
			// Skip anything that doesn't look like a module path (e.g.,
			// trailing comments that survived the [^\n#] guard).
			if (/^[\w.]+$/.test(mod)) out.add(mod);
		}
		m = IMPORT_REGEX_IMPORT.exec(source);
	}

	return [...out];
}

/**
 * Detect a Python web framework. Reads pyproject.toml /
 * requirements.txt for common framework packages.
 */
async function selectFramework(
	dir: string,
): Promise<FrameworkSelection | null> {
	const candidates: Array<[string, string]> = [
		['django', 'django'],
		['flask', 'flask'],
		['fastapi', 'fastapi'],
		['starlette', 'starlette'],
		['tornado', 'tornado'],
		['aiohttp', 'aiohttp'],
		['bottle', 'bottle'],
	];
	for (const candidate of ['pyproject.toml', 'requirements.txt', 'setup.py']) {
		try {
			const content = fs.readFileSync(path.join(dir, candidate), 'utf-8');
			const lower = content.toLowerCase();
			for (const [pkg, name] of candidates) {
				if (lower.includes(pkg)) {
					return { name, detectedVia: candidate };
				}
			}
		} catch {
			// not present
		}
	}
	return null;
}

/**
 * Identify entry points: setup.py / pyproject.toml `[project.scripts]`
 * entries, then `main.py` / `app.py` / `manage.py` if present.
 */
async function selectEntryPoints(dir: string): Promise<string[]> {
	const points = new Set<string>();
	// pyproject.toml [project.scripts] block
	try {
		const content = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf-8');
		const scriptsBlock = content.match(
			/\[project\.scripts\][\s\S]*?(?=\n\[|$)/,
		);
		if (scriptsBlock) {
			for (const line of scriptsBlock[0].split('\n')) {
				const m = line.match(/=\s*['"]([^'":]+)/);
				if (m) {
					// `mypkg.cli:main` → mypkg/cli.py
					const modPath = `${m[1].replace(/\./g, '/')}.py`;
					points.add(modPath);
				}
			}
		}
	} catch {
		// no pyproject
	}
	// Common entry-point filenames
	for (const name of ['manage.py', 'main.py', 'app.py', '__main__.py']) {
		try {
			fs.accessSync(path.join(dir, name));
			points.add(name);
		} catch {
			// not present
		}
	}
	return [...points];
}

/**
 * Build the Python backend from the registered profile.
 */
export function buildPythonBackend(): LanguageBackend {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) {
		throw new Error(
			'buildPythonBackend: python profile not in LANGUAGE_REGISTRY. ' +
				'profiles.ts must be imported before this backend.',
		);
	}
	// Start from the registry-driven default backend (so selectTestFramework,
	// buildTestCommand, parseTestOutput, selectBuildCommand all work without
	// being explicitly listed here) and override only the Python-specific
	// behaviors.
	return {
		...defaultBackendFor(profile),
		extractImports,
		selectFramework,
		selectEntryPoints,
	};
}

export const _internals: {
	extractImports: typeof extractImports;
} = { extractImports };
