/**
 * Go backend.
 *
 * Phase 5 of language-agnostic plugin work. Overrides `extractImports`
 * with Go-specific import regexes — both single-line `import "x"` and
 * grouped `import (\n "a"\n "b"\n)` forms — so the test-impact analyzer
 * can build a graph for Go projects.
 *
 * Invariants identical to other backends — see `python.ts` and
 * `typescript.ts` for the rationale; backend-purity test enforces.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FrameworkSelection, LanguageBackend } from '../backend';
import { defaultBackendFor } from '../default-backend';
import { LANGUAGE_REGISTRY } from '../profiles';

const PROFILE_ID = 'go';

/**
 * Go import patterns.
 *
 *   `import "foo"`                       → "foo"
 *   `import alias "foo"`                 → "foo"
 *   `import _ "foo"`                     → "foo"  (side-effect import)
 *   `import . "foo"`                     → "foo"  (dot-import; rare)
 *   `import (\n "foo"\n alias "bar"\n)`  → "foo", "bar"
 *
 * The single-line and grouped forms are extracted separately. Comments are
 * removed with a small lexical state machine first: a quoted path in a line
 * or block comment must never become an import, and parentheses in comments
 * must not terminate a grouped import block.
 */
const IMPORT_REGEX_SINGLE =
	/^\s*import\s+(?:[a-zA-Z_.][a-zA-Z0-9_]*\s+)?"([^"]+)"/gm;
const IMPORT_REGEX_GROUP = /^\s*import\s*\(([\s\S]*?)\)/gm;
const IMPORT_REGEX_GROUP_LINE = /(?:[a-zA-Z_.][a-zA-Z0-9_]*\s+)?"([^"]+)"/g;

function stripGoComments(source: string): string {
	let state: 'normal' | 'line' | 'block' | 'string' | 'raw' = 'normal';
	let out = '';
	let escaped = false;
	for (let index = 0; index < source.length; index++) {
		const current = source[index];
		const next = source[index + 1];
		if (state === 'line') {
			if (current === '\n' || current === '\r') {
				state = 'normal';
				out += current;
			} else {
				out += ' ';
			}
			continue;
		}
		if (state === 'block') {
			if (current === '*' && next === '/') {
				out += '  ';
				index++;
				state = 'normal';
			} else {
				out += current === '\n' || current === '\r' ? current : ' ';
			}
			continue;
		}
		if (state === 'string') {
			out += current;
			if (escaped) escaped = false;
			else if (current === '\\') escaped = true;
			else if (current === '"') state = 'normal';
			continue;
		}
		if (state === 'raw') {
			out += current;
			if (current === '`') state = 'normal';
			continue;
		}
		if (current === '/' && next === '/') {
			out += '  ';
			index++;
			state = 'line';
		} else if (current === '/' && next === '*') {
			out += '  ';
			index++;
			state = 'block';
		} else {
			out += current;
			if (current === '"') state = 'string';
			else if (current === '`') state = 'raw';
		}
	}
	return out;
}

function extractImports(_sourceFile: string, source: string): string[] {
	const out = new Set<string>();
	const uncommented = stripGoComments(source);

	// Single-line imports.
	IMPORT_REGEX_SINGLE.lastIndex = 0;
	let m: RegExpExecArray | null = IMPORT_REGEX_SINGLE.exec(uncommented);
	while (m !== null) {
		out.add(m[1]);
		m = IMPORT_REGEX_SINGLE.exec(uncommented);
	}

	// Grouped imports — match the parenthesized block, then iterate
	// quoted entries inside.
	IMPORT_REGEX_GROUP.lastIndex = 0;
	m = IMPORT_REGEX_GROUP.exec(uncommented);
	while (m !== null) {
		const block = m[1];
		IMPORT_REGEX_GROUP_LINE.lastIndex = 0;
		let inner: RegExpExecArray | null = IMPORT_REGEX_GROUP_LINE.exec(block);
		while (inner !== null) {
			out.add(inner[1]);
			inner = IMPORT_REGEX_GROUP_LINE.exec(block);
		}
		m = IMPORT_REGEX_GROUP.exec(uncommented);
	}

	return [...out];
}

/**
 * Detect a Go web framework via go.mod require entries.
 */
async function selectFramework(
	dir: string,
): Promise<FrameworkSelection | null> {
	let content: string;
	try {
		content = fs.readFileSync(path.join(dir, 'go.mod'), 'utf-8');
	} catch {
		return null;
	}
	const candidates: Array<[string, string]> = [
		['github.com/gin-gonic/gin', 'gin'],
		['github.com/labstack/echo', 'echo'],
		['github.com/gofiber/fiber', 'fiber'],
		['github.com/gorilla/mux', 'gorilla'],
		['github.com/go-chi/chi', 'chi'],
	];
	for (const [pkg, name] of candidates) {
		if (content.includes(pkg)) {
			return { name, detectedVia: `go.mod require ${pkg}` };
		}
	}
	return null;
}

/**
 * Identify entry points: top-level `main.go` (the most common); when
 * absent, common `cmd/*` subdirectory `main.go` files (Go convention for
 * multi-binary repos).
 */
async function selectEntryPoints(dir: string): Promise<string[]> {
	const points: string[] = [];
	try {
		fs.accessSync(path.join(dir, 'main.go'));
		points.push('main.go');
	} catch {
		// not present — look for cmd/*/main.go
	}
	try {
		const cmdDir = path.join(dir, 'cmd');
		const subdirs = fs
			.readdirSync(cmdDir, { withFileTypes: true })
			.filter((d) => d.isDirectory());
		for (const sub of subdirs) {
			const main = path.join('cmd', sub.name, 'main.go');
			try {
				fs.accessSync(path.join(dir, main));
				points.push(main);
			} catch {
				// not present
			}
		}
	} catch {
		// no cmd/ directory
	}
	return points;
}

/**
 * Build the Go backend from the registered profile.
 */
export function buildGoBackend(): LanguageBackend {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) {
		throw new Error(
			'buildGoBackend: go profile not in LANGUAGE_REGISTRY. ' +
				'profiles.ts must be imported before this backend.',
		);
	}
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
