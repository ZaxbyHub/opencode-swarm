#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from './gate-utils';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SCRIPT_REPO_FALLBACK = path.resolve(SCRIPT_DIR, '..');
const GIT_TIMEOUT_MS = 30_000;

export interface BashPortabilityResult {
	messages: string[];
	violations: number;
	files: string[];
	exitCode: number;
}

export async function resolveRepoRoot(
	startDir: string = process.cwd(),
): Promise<string> {
	for (const candidate of [startDir, SCRIPT_REPO_FALLBACK]) {
		const proc = await runGit(['rev-parse', '--show-toplevel'], candidate, GIT_TIMEOUT_MS)
			.catch(() => null);
		if (!proc) {
			continue;
		}
		if (proc.exitCode === 0) {
			const top = proc.stdout.trim();
			if (top.length > 0) {
				return path.resolve(top);
			}
		}
	}
	return SCRIPT_REPO_FALLBACK;
}

function toPosixRelative(root: string, file: string): string {
	return path.relative(root, file).replace(/\\/g, '/');
}

function walkShFiles(startDir: string): string[] {
	if (!fs.existsSync(startDir)) {
		return [];
	}
	const out: string[] = [];
	const stack = [startDir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		const entries = fs
			.readdirSync(current, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name));
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith('.sh')) {
				out.push(full);
			}
		}
	}
	return out;
}

function listSkillScriptsDirs(root: string): string[] {
	const skillsRoot = path.join(root, '.opencode', 'skills');
	if (!fs.existsSync(skillsRoot)) {
		return [];
	}
	const out: string[] = [];
	for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const scriptsDir = path.join(skillsRoot, entry.name, 'scripts');
		if (fs.existsSync(scriptsDir)) {
			out.push(scriptsDir);
		}
	}
	return out;
}

function listShellFiles(root: string): string[] {
	const out: string[] = [];
	out.push(...walkShFiles(path.join(root, 'scripts')));
	for (const skillScriptsDir of listSkillScriptsDirs(root)) {
		out.push(...walkShFiles(skillScriptsDir));
	}
	return out.sort((a, b) => a.localeCompare(b));
}

function stripCommentOnlyLines(content: string): string {
	return content
		.split(/\r?\n/)
		.filter((line) => !/^[ \t]*#/.test(line))
		.join('\n');
}

function detectSetU(codeOnly: string): boolean {
	const pattern = /(^|[ \t])set[ \t]+-[^-]*u|(^|[ \t])set[ \t]+-[^-]*[eu][^-]*u/;
	return codeOnly.split('\n').some((line) => pattern.test(line));
}

function extractEmptyInitArrayNames(codeOnly: string): string[] {
	const out = new Set<string>();
	for (const line of codeOnly.split('\n')) {
		const match = line.match(
			/^[ \t]*(?:local[ \t]+|readonly[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=\([ \t]*\)/,
		);
		if (match) {
			out.add(match[1]);
		}
	}
	return [...out].sort();
}

export function evaluateBashPortability(
	files: Array<{ file: string; content: string }>,
): BashPortabilityResult {
	const messages: string[] = [];
	const violatingFiles: string[] = [];
	let violations = 0;

	for (const { file, content } of files) {
		let fileHasViolation = false;
		const codeOnly = stripCommentOnlyLines(content);

		if (
			/\b(declare|typeset|local|readonly)\b[ \t]+-[A-Za-z]*A[A-Za-z]*\b/.test(
				codeOnly,
			)
		) {
			messages.push(
				`ERROR: ${file} uses an associative array (declare/typeset/local/readonly -A) — bash 4+ only, not supported on macOS's bash 3.2.`,
			);
			messages.push(
				// Compatibility text is frozen to the pre-port Bash owner by issue #2094.
				'       Use a plain indexed array or parallel files instead (see scripts/check-invariants.sh for the established pattern).',
			);
			fileHasViolation = true;
		}

		if (
			/\bgrep\b[^|&;]*(-[A-Za-z]*P[A-Za-z]*\b|--perl-regexp\b)/.test(codeOnly)
		) {
			messages.push(
				'ERROR: ' +
					file +
					' uses `grep -P`/PCRE mode (any flag combination, or --perl-regexp) — BSD grep on macOS has no -P support at all.',
			);
			messages.push(
				'       Use `grep -E` with explicit alternation instead (see scripts/check-invariants.sh for the established pattern).',
			);
			fileHasViolation = true;
		}

		if (/(^|[^A-Za-z0-9_])coproc([^A-Za-z0-9_]|$)/.test(codeOnly)) {
			messages.push(
				`ERROR: ${file} uses \`coproc\` (bash 4+ keyword) — not supported on macOS's bash 3.2.`,
			);
			fileHasViolation = true;
		}

		if (/(^|[^A-Za-z0-9_])(mapfile|readarray)([^A-Za-z0-9_]|$)/.test(codeOnly)) {
			messages.push(
				`ERROR: ${file} uses \`mapfile\`/\`readarray\` (bash 4+ builtins) — not supported on macOS's bash 3.2.`,
			);
			messages.push(
				'       Use a while-read loop instead (see scripts/check-invariants.sh for the established pattern).',
			);
			fileHasViolation = true;
		}

		if (detectSetU(codeOnly)) {
			for (const arrName of extractEmptyInitArrayNames(codeOnly)) {
				const barePattern = `"${'${'}${arrName}[@]}"`;
				const guardedPattern = `${'${'}${arrName}[@]+"${'${'}${arrName}[@]}"}`;
				const bareHits = codeOnly
					.split('\n')
					.filter((line) => line.includes(barePattern));
				const unguarded = bareHits.filter(
					(line) => !line.includes(guardedPattern),
				);
				if (unguarded.length > 0) {
					messages.push(
						`ERROR: ${file} expands "\${${arrName}[@]}" under \`set -u\` but ${arrName}=() is initialized empty somewhere in the file.`,
					);
					messages.push(
						`       Under bash 3.2 (macOS) this aborts with 'unbound variable' when ${arrName} is empty (fixed in bash 4.4).`,
					);
					messages.push(
						`       Use the alternate-value form: \${${arrName}[@]+"\${${arrName}[@]}"}`
					);
					fileHasViolation = true;
				}
			}
		}

		if (fileHasViolation) {
			violations++;
			violatingFiles.push(file);
		}
	}

	messages.push('');
	messages.push('=== Summary ===');
	messages.push(`Files with bash4+-only constructs: ${violations}`);
	if (violations > 0) {
		messages.push('');
		messages.push('Violating files:');
		for (const file of violatingFiles) {
			messages.push(`  - ${file}`);
		}
	} else {
		messages.push('No bash4+-only constructs found in scripts/.');
	}

	return {
		messages,
		violations,
		files: violatingFiles,
		exitCode: violations > 0 ? 1 : 0,
	};
}

export async function main(startDir: string = process.cwd()): Promise<number> {
	const repoRoot = await resolveRepoRoot(startDir);
	const selfShim = path.join(repoRoot, 'scripts', 'check-bash-portability.sh');
	const files = listShellFiles(repoRoot)
		.filter((file) => path.resolve(file) !== path.resolve(selfShim))
		.map((file) => ({
			file: toPosixRelative(repoRoot, file),
			content: fs.readFileSync(file, 'utf-8'),
		}));
	const result = evaluateBashPortability(files);
	for (const line of result.messages) {
		console.log(line);
	}
	return result.exitCode;
}

const isDirectRun =
	typeof process.argv[1] === 'string' &&
	path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);

if (isDirectRun) {
	void main()
		.then((exitCode) => {
			process.exit(exitCode);
		})
		.catch((error) => {
			throw error;
		});
}
