/**
 * Test hygiene: no test may run `git config --global`.
 *
 * `tests/integration/cross-process-init-orphan-recovery.test.ts` used to set
 * `user.name`/`user.email` with `git config --global`, which overwrote the
 * developer's real `~/.gitconfig` — every later commit on the machine was
 * authored as "Test User". Test repositories set a repo-local identity
 * (`git config user.name …` inside the repo) and, where a child git must not
 * see the developer's config at all, `GIT_CONFIG_GLOBAL=os.devNull`.
 *
 * This scan fails on any code line under the test trees that passes
 * `--global` to `git config`, in either the shell-string or the argv form.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const TEST_TREES = ['tests', 'test'];
/** Tests colocated with the code under src/ (`*.test.ts`). */
const SRC_TREE = 'src';
const COLOCATED_TEST = /\.test\.(ts|js|mjs|cjs)$/;
const SELF = path.relative(REPO_ROOT, import.meta.path);

// The argv form spans lines when formatted (`'config',\n'--global',`), so
// both patterns run over the whole file text.
const SHELL_FORM = /\bgit\s+config\s+--global\b/g;
const ARGV_FORM = /['"`]config['"`]\s*,\s*['"`]--global['"`]/g;

function* sourceFiles(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* sourceFiles(full);
		else if (/\.(ts|js|mjs|cjs|sh)$/.test(entry.name)) yield full;
	}
}

function isCommentLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.startsWith('//') ||
		trimmed.startsWith('*') ||
		trimmed.startsWith('/*') ||
		trimmed.startsWith('#')
	);
}

function findInSource(rel: string, text: string): string[] {
	const lines = text.split('\n');
	const hits: string[] = [];
	for (const pattern of [SHELL_FORM, ARGV_FORM]) {
		for (const match of text.matchAll(pattern)) {
			const lineIndex = text.slice(0, match.index).split('\n').length - 1;
			const line = lines[lineIndex] ?? '';
			if (isCommentLine(line)) continue;
			hits.push(`${rel}:${lineIndex + 1}: ${line.trim()}`);
		}
	}
	return hits;
}

function findGlobalGitConfigWrites(root: string): string[] {
	const hits: string[] = [];
	const files = [
		...TEST_TREES.flatMap((tree) => [...sourceFiles(path.join(root, tree))]),
		...[...sourceFiles(path.join(root, SRC_TREE))].filter((file) =>
			COLOCATED_TEST.test(file),
		),
	];
	for (const file of files) {
		const rel = path.relative(root, file);
		if (rel === SELF) continue;
		hits.push(...findInSource(rel, fs.readFileSync(file, 'utf8')));
	}
	return hits;
}

describe('no test writes the global git config', () => {
	test('the scan detects both forms, across lines, and ignores comments', () => {
		expect(
			findInSource('a.ts', "execSync('git config --global user.name x')"),
		).toHaveLength(1);
		expect(
			findInSource('a.ts', "run(['config', '--global', 'user.name'])"),
		).toHaveLength(1);
		expect(
			findInSource(
				'a.ts',
				"run(dir, [\n\t'config',\n\t'--global',\n\t'user.email',\n]);",
			),
		).toHaveLength(1);
		expect(findInSource('a.ts', "execSync('git config user.name x')")).toEqual(
			[],
		);
		expect(
			findInSource('a.ts', '\t// `git config --global` used to leak'),
		).toEqual([]);
	});

	test('no test file (tests/, test/, src/**/*.test.*) runs `git config --global`', () => {
		expect(findGlobalGitConfigWrites(REPO_ROOT)).toEqual([]);
	});
});
