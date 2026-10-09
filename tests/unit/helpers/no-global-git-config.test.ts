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
// every pattern runs over the whole file text. `--system` writes the
// machine-wide config; `--file`/`-f` aimed at the user's own config file
// (`~/.gitconfig`, `$HOME/.gitconfig`, `os.homedir()`, `~/.config/git/config`)
// is `--global` by another name.
// `git` plus any number of `-C <dir>` / `-c k=v` prefix options.
const GIT = String.raw`\bgit(?:\s+-[cC]\s+(?:"[^"]*"|'[^']*'|\S+))*`;
// Any option/operand tokens may sit between `config` and the scope flag
// (`--add --global`, `-l --global`, `--replace-all --global`, `k v --global`);
// the lazy same-line span stops at statement separators.
const SHELL_FORM = new RegExp(
	String.raw`${GIT}\s+config\b[^\n\r;|&]*?\s--(?:global|system)\b`,
	'g',
);
// argv form: `'config'` then up to eight more quoted tokens, then the flag.
const ARGV_FORM =
	/['"`]config['"`]\s*,(?:\s*['"`][^'"`\n]*['"`]\s*,){0,8}\s*['"`]--(?:global|system)['"`]/g;
// The scope flag held in a variable/property (`const scope = '--global'`).
const FLAG_HELD_FORM = /[=:]\s*['"`]--(?:global|system)['"`]/g;
const HOME_TARGET = String.raw`(?:~|\$\{?HOME\}?|\$\{?USERPROFILE\}?|homedir\(\))`;
const SHELL_FILE_FORM = new RegExp(
	String.raw`${GIT}\s+config\s+(?:--file|-f)(?:\s+|=)['"]?${HOME_TARGET}`,
	'g',
);
const ARGV_FILE_FORM = new RegExp(
	String.raw`['"\`]config['"\`]\s*,\s*['"\`](?:--file|-f)['"\`]\s*,\s*[^,\]\n]*${HOME_TARGET}`,
	'g',
);
const PATTERNS = [
	SHELL_FORM,
	ARGV_FORM,
	FLAG_HELD_FORM,
	SHELL_FILE_FORM,
	ARGV_FILE_FORM,
];

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
	for (const pattern of PATTERNS) {
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

	test('the scan detects --system and --file/-f aimed at the user config', () => {
		for (const hit of [
			"execSync('git config --system core.x y')",
			"run(['config', '--system', 'core.x', 'y'])",
			'execSync("git config --file ~/.gitconfig user.name x")',
			'execSync(`git config -f=$HOME/.gitconfig user.name x`)',
			"run(['config', '--file', path.join(os.homedir(), '.gitconfig'), 'k', 'v'])",
			"run(['config',\n\t'-f',\n\t`${os.homedir()}/.config/git/config`])",
		]) {
			expect(findInSource('a.ts', hit)).toHaveLength(1);
		}
		// A repo-local --file target is fine.
		expect(
			findInSource(
				'a.ts',
				"run(['config', '--file', join(repo, '.git/config')])",
			),
		).toEqual([]);
	});

	test('the scan detects option tokens between config and the scope flag', () => {
		for (const hit of [
			"execSync('git config --add --global user.name x')",
			"execSync('git config -l --global')",
			"execSync('git config --replace-all --global user.name x')",
			"execSync('git config user.name x --global')",
			'execSync(`git -C ${repo} config --global user.name x`)',
			'execSync(\'git -C "/some dir" config --system core.x y\')',
			"execSync('git -c core.x=y config --global user.name x')",
			"run(['config', '--add', '--global', 'user.name', 'x'])",
			"run(['config', 'user.name', 'x', '--global'])",
			"run(dir, [\n\t'config',\n\t'--replace-all',\n\t'--system',\n\t'k',\n])",
		]) {
			expect(findInSource('a.ts', hit)).toHaveLength(1);
		}
	});

	test('the scan detects the scope flag held in a variable or property', () => {
		for (const hit of [
			"const scope = '--global';",
			'let flag = "--system"',
			"const opts = { scope: '--global' };",
		]) {
			expect(findInSource('a.ts', hit)).toHaveLength(1);
		}
	});

	test('the scan ignores repo-local config, other tools, and statement boundaries', () => {
		for (const ok of [
			"execSync('git config --local user.name x')",
			"execSync('git -C repo config user.name x')",
			"run(['config', 'user.name', 'x'])",
			"run(['config', '--local', 'user.name', 'x'])",
			"execSync('npm install --global left-pad')",
			"run(['install', '--global', 'pkg'])",
			"execSync('git config user.name x'); run(['--global'])",
			"execSync('git status'); execSync('npm ls --global')",
		]) {
			expect(findInSource('a.ts', ok)).toEqual([]);
		}
	});

	test('no test file (tests/, test/, src/**/*.test.*) writes a global/system git config', () => {
		expect(findGlobalGitConfigWrites(REPO_ROOT)).toEqual([]);
	});
});
