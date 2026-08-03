import { beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
	ensureAgentSession,
	getAgentSession,
	resetSwarmState,
	resolveSessionWorkspaceDirectory,
} from '../../../src/state';

const REPO_ROOT = join(__dirname, '../../..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/**
 * Closed allowlist of AUDITED production call sites, with the exact number of
 * calls each may make. Adding a file here is a security review, not a
 * formality: every entry must pass `provisionWorktree`'s own output, at the
 * session-creation site, on a path no tool argument can reach.
 */
const AUDITED_CALLERS: ReadonlyArray<{
	file: string;
	calls: number;
	why: string;
}> = [
	{
		file: 'src/hooks/delegation-gate/worktree-isolation.ts',
		calls: 1,
		why: 'standard worktree dispatch — called immediately after client.session.create with provisionResult.worktreePath',
	},
	{
		file: 'src/turbo/lean/lane-scope.ts',
		calls: 1,
		why: "Lean Turbo lane dispatch — called with the laneRoot threaded from LeanTurboRunner._internals.provisionWorktree, and only when the runner's trusted `isolated` provisioning signal is set",
	},
];

const SECURITY_INVARIANT = `
SECURITY INVARIANT: recordSessionWorkspaceRoot() performs NO path validation.
Its entire security property rests on every production call site passing
provisionWorktree's own output at the session-creation site (unreachable from
any tool argument). The audited call sites are:
${AUDITED_CALLERS.map((c) => `  - ${c.file} (${c.calls}): ${c.why}`).join('\n')}
If an unaudited caller is added, that property silently breaks and
reintroduces a privilege-escalation bug -- an agent-supplied path (e.g.
declare_scope's 'working_directory' argument feeding ensureAgentSession's
third argument) could relocate the root that path-containment and
scope-binding checks are evaluated against. See issue #2002.
`.trim();

/** Recursively walk a directory, yielding absolute file paths. */
function walk(dir: string): string[] {
	const entries = readdirSync(dir);
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			if (entry === 'node_modules' || entry === 'tests') continue;
			files.push(...walk(full));
		} else if (
			stat.isFile() &&
			/\.(ts|tsx)$/.test(entry) &&
			!/\.test\.ts$/.test(entry)
		) {
			files.push(full);
		}
	}
	return files;
}

/**
 * Find production call sites of `recordSessionWorkspaceRoot(` in a file's
 * source text, excluding:
 *  - the function's own definition (`export function recordSessionWorkspaceRoot(`)
 *  - bare import/export specifier lines (no trailing `(` invocation)
 */
function findCallSites(filePath: string, relPath: string): string[] {
	const text = readFileSync(filePath, 'utf8');
	const lines = text.split('\n');
	const hits: string[] = [];

	lines.forEach((line, idx) => {
		if (!line.includes('recordSessionWorkspaceRoot')) return;

		// Skip the definition itself.
		if (/export\s+function\s+recordSessionWorkspaceRoot\s*\(/.test(line)) {
			return;
		}

		// Skip import/export specifier references (no call parens after the name).
		// e.g. "	recordSessionWorkspaceRoot," or "import { recordSessionWorkspaceRoot } from ..."
		const isImportLike =
			/^\s*recordSessionWorkspaceRoot\s*,?\s*$/.test(line) ||
			/import\s*\{[^}]*recordSessionWorkspaceRoot[^}]*\}\s*from/.test(line) ||
			/export\s*\{[^}]*recordSessionWorkspaceRoot[^}]*\}/.test(line);
		if (isImportLike) return;

		// Skip comment lines referencing the function by name (documentation).
		const trimmed = line.trim();
		if (
			trimmed.startsWith('//') ||
			trimmed.startsWith('*') ||
			trimmed.startsWith('/*')
		) {
			return;
		}

		// Must be an actual call: `recordSessionWorkspaceRoot(` somewhere in the line.
		if (/recordSessionWorkspaceRoot\s*\(/.test(line)) {
			hits.push(`${relPath}:${idx + 1}: ${line.trim()}`);
		}
	});

	return hits;
}

describe('recordSessionWorkspaceRoot has only audited production callers', () => {
	test('no unaudited call site was introduced anywhere under src/', () => {
		const files = walk(SRC_ROOT);
		const allHits: string[] = [];

		for (const file of files) {
			const relPath = relative(REPO_ROOT, file).replace(/\\/g, '/');
			allHits.push(...findCallSites(file, relPath));
		}

		const unexpectedCallSites = allHits.filter(
			(hit) =>
				!AUDITED_CALLERS.some((caller) => hit.startsWith(`${caller.file}:`)),
		);

		if (unexpectedCallSites.length > 0) {
			throw new Error(
				[
					'Found unaudited production call site(s) of recordSessionWorkspaceRoot():',
					...unexpectedCallSites,
					'',
					SECURITY_INVARIANT,
				].join('\n'),
			);
		}

		// Exact counts: an extra call inside an already-audited file is just as
		// much a new authority path as an entirely new file.
		for (const caller of AUDITED_CALLERS) {
			expect(
				allHits.filter((hit) => hit.startsWith(`${caller.file}:`)).length,
			).toBe(caller.calls);
		}
		expect(unexpectedCallSites).toEqual([]);
	});

	test('ensureAgentSession does not assign workspaceDirectory (agent-supplied directory is discarded)', () => {
		const stateFile = join(SRC_ROOT, 'state.ts');
		const text = readFileSync(stateFile, 'utf8');

		const startMatch = text.match(
			/export\s+function\s+ensureAgentSession\s*\(/,
		);
		expect(startMatch).not.toBeNull();
		if (!startMatch || startMatch.index === undefined) {
			throw new Error('Could not locate ensureAgentSession function start');
		}
		const startIdx = startMatch.index;

		// Walk braces from the opening `{` of the function to find its matching close.
		const openBraceIdx = text.indexOf('{', startIdx);
		expect(openBraceIdx).toBeGreaterThan(-1);

		let depth = 0;
		let endIdx = -1;
		for (let i = openBraceIdx; i < text.length; i++) {
			if (text[i] === '{') depth++;
			else if (text[i] === '}') {
				depth--;
				if (depth === 0) {
					endIdx = i;
					break;
				}
			}
		}
		expect(endIdx).toBeGreaterThan(openBraceIdx);

		const body = text.slice(openBraceIdx, endIdx);

		expect(body).not.toMatch(/workspaceDirectory\s*=/);
	});

	test('workspaceDirectory may only be assigned via recordSessionWorkspaceRoot (no direct assignments outside src/state.ts)', () => {
		/**
		 * Regex pattern to match workspaceDirectory assignment, excluding:
		 *  - Comparisons: ===, !==, ==, !=
		 *  - Field declarations in interfaces/types (e.g., "workspaceDirectory?: string")
		 *  - Comments and documentation
		 *
		 * Pattern: workspaceDirectory followed by whitespace and a single = (not ==)
		 */
		const assignmentPattern = /workspaceDirectory\s*=[^=]/;

		function findWorkspaceDirectoryAssignments(
			filePath: string,
			relPath: string,
		): string[] {
			const text = readFileSync(filePath, 'utf8');
			const lines = text.split('\n');
			const hits: string[] = [];

			lines.forEach((line, idx) => {
				if (!line.includes('workspaceDirectory')) return;

				// Skip comment lines
				const trimmed = line.trim();
				if (
					trimmed.startsWith('//') ||
					trimmed.startsWith('*') ||
					trimmed.startsWith('/*')
				) {
					return;
				}

				// Skip interface/type field declarations (colon before name or after)
				if (/:\s*string|interface\s+|type\s+/.test(line)) {
					return;
				}

				// Check for actual assignment (= but not ==, ===, !=, !==)
				if (assignmentPattern.test(line)) {
					hits.push(`${relPath}:${idx + 1}: ${line.trim()}`);
				}
			});

			return hits;
		}

		const files = walk(SRC_ROOT);
		const allHits: string[] = [];
		const stateFilePath = join(SRC_ROOT, 'state.ts');

		for (const file of files) {
			const relPath = relative(REPO_ROOT, file).replace(/\\/g, '/');
			allHits.push(...findWorkspaceDirectoryAssignments(file, relPath));
		}

		// Filter out assignments in src/state.ts (the authorized setter)
		const unauthorizedAssignments = allHits.filter(
			(hit) => !hit.startsWith('src/state.ts:'),
		);

		if (unauthorizedAssignments.length > 0) {
			throw new Error(
				[
					'Found unauthorized assignment(s) to workspaceDirectory outside src/state.ts:',
					...unauthorizedAssignments,
					'',
					'SECURITY INVARIANT: workspaceDirectory may only be written via recordSessionWorkspaceRoot(),',
					'whose trusted-caller allowlist is enforced by the sibling test in this file.',
					'See issue #2002.',
				].join('\n'),
			);
		}

		expect(unauthorizedAssignments).toEqual([]);
	});
});

describe('ensureAgentSession discards agent-supplied directory (behavioural)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	test('session.workspaceDirectory stays undefined and resolver falls back to fallbackDirectory', () => {
		const sessionId = 'workspace-root-single-caller-behavioural';
		const someOtherDirectory = '/some/agent-supplied/path';
		const projectRoot = '/repo/project-root';

		ensureAgentSession(sessionId, 'coder', someOtherDirectory);

		const session = getAgentSession(sessionId);
		expect(session).toBeDefined();
		expect(session?.workspaceDirectory).toBeUndefined();

		expect(resolveSessionWorkspaceDirectory(sessionId, projectRoot)).toBe(
			projectRoot,
		);
	});
});
