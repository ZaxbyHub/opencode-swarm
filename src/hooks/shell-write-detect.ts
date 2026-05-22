/**
 * Shell Write Detector — POSIX AST + Windows regex-based write-operation detection
 *
 * Parses POSIX shell commands using bash-parser and statically detects
 * file-system write operations using regex heuristics for Windows shells.
 * Used by guardrails and scope-validation hooks to catch opaque shell
 * commands that would bypass direct tool coverage.
 *
 * @module shell-write-detect
 */

import * as path from 'node:path';
import parse from 'bash-parser';

/**
 * All write-operation categories detected by this module.
 */
export type WriteCategory =
	| 'redirect'
	| 'here_doc'
	| 'builtin_write'
	| 'inplace_edit'
	| 'interpreter_eval'
	| 'network_download'
	| 'archive_extract'
	| 'git_destructive';

/**
 * A single write target detected in a shell command.
 */
export interface WriteTarget {
	/** The category of write operation. */
	category: WriteCategory;
	/** The tool or operator that triggered this write, e.g. "cp", ">", "sed -i". */
	operator: string;
	/** The file path written to, or null when the path cannot be determined statically. */
	path: string | null;
}

/**
 * Result of analyzing a single shell command.
 */
export interface WriteAnalysis {
	/** All write targets detected in the command (empty if none). */
	writes: WriteTarget[];
	/** Whether the command contains any detected writes. */
	hasWrites: boolean;
	/** Whether the command could not be parsed (fail-closed). */
	parseError?: boolean;
}

/**
 * A write target with its resolved absolute path.
 */
export interface ResolvedWriteTarget {
	/** The original write target. */
	original: WriteTarget;
	/**
	 * The resolved absolute path, or null if the path could not be determined
	 * (null original path) or was marked unresolvable (dynamic path).
	 */
	resolvedPath: string | null;
	/**
	 * Whether the path was successfully resolved to an absolute path.
	 * false when: path is null, path contains env vars ($VAR), or path
	 * contains command substitution ($(cmd) or `cmd`).
	 */
	resolved: boolean;
}

// ---------------------------------------------------------------------------
// Operator token → category mapping
// ---------------------------------------------------------------------------

/** Tokens that represent output-file redirections (write / clobber / append / read-write). */
const REDIRECT_WRITE_TOKENS = new Set([
	'GREAT',
	'DGREAT',
	'CLOBBER',
	'LESSGREAT',
]);

/** Tokens that represent here-document / here-string redirections. */
const REDIRECT_HERE_TOKENS = new Set(['DLESS', 'DLESSDASH']);

/** All write-effect redirections. */
const REDIRECT_ALL_WRITE_TOKENS = new Set([
	...REDIRECT_WRITE_TOKENS,
	...REDIRECT_HERE_TOKENS,
]);

// ---------------------------------------------------------------------------
// Builtin write-effect commands
// ---------------------------------------------------------------------------

/** Builtins that copy / move / link / resize files. */
const BUILTIN_WRITE_COMMANDS = new Set([
	'cp',
	'mv',
	'install',
	'ln',
	'truncate',
]);

/** Builtins with in-place editing semantics (modify file argument in place). */
const INPLACE_EDIT_COMMANDS = new Set(['sed', 'perl', 'awk']);

/** Interpreters that accept inline code via -c / -e / -r / -m flag. */
const INTERPRETER_EVAL_COMMANDS = new Set([
	'python',
	'python3',
	'python2',
	'node',
	'bun',
	'ruby',
	'perl',
	'php',
]);

/** Network downloaders. */
const NETWORK_DOWNLOAD_COMMANDS = new Set(['curl', 'wget', 'scp']);

/** Archive extraction commands. */
const ARCHIVE_EXTRACT_COMMANDS = new Set([
	'tar',
	'unzip',
	'gunzip',
	'gzip',
	'bzip2',
	'xz',
	'7z',
	'rar',
]);

/** Git commands (subcommand determines if destructive). */
const GIT_COMMAND = 'git';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect process substitution writes using regex when bash-parser fails.
 * Process substitution: >(command) creates implicit writes, <(command) is read-only.
 *
 * bash-parser does not support process substitution syntax, so we use regex to
 * extract and analyze >(...) patterns when the main parse fails.
 */
function detectProcessSubstitutionWrites(command: string): WriteTarget[] {
	const results: WriteTarget[] = [];

	// Match >(...) patterns (write process substitution)
	// We only flag >(...) (Great) as writes; <(...) (Less) is read-only.
	// This regex matches simple process substitution without nested parens.
	const writeProcSubPattern = />\s*\(([^)]+)\)/g;
	while (true) {
		const match = writeProcSubPattern.exec(command);
		if (match === null) break;
		const innerCommand = match[1].trim();
		if (!innerCommand) continue;

		// Recursively analyze the inner command for writes.
		// Use a minimal parse: split by | to get pipeline stages and analyze each.
		const stages = innerCommand.split('|').map((s) => s.trim());
		for (const stage of stages) {
			// Detect builtin writes (cp, mv, etc.) in the inner POSIX command.
			// Note: detectPowerShellWrites is not used here because the inner command
			// of a process substitution is POSIX bash, not PowerShell.
			const builtinResult = detectBuiltinWritesFromString(stage);
			if (builtinResult) results.push(builtinResult);

			// Detect redirections in the stage: check >> first to avoid double-matching
			// when both > and >> patterns could match the same input.
			const appendMatch = stage.match(/^\s*(.*?)\s*>>(\s*)(\S+)\s*$/);
			if (appendMatch) {
				const path = appendMatch[3];
				if (path && !isNullDevice(path)) {
					results.push({ category: 'redirect', operator: '>>', path });
				}
			} else {
				// Only check > if >> did not match (negative lookahead alternative)
				const writeMatch = stage.match(/^\s*(.*?)\s*>(?!>)(\s*)(\S+)\s*$/);
				if (writeMatch) {
					const path = writeMatch[3];
					if (path && !isNullDevice(path)) {
						results.push({ category: 'redirect', operator: '>', path });
					}
				}
			}
		}
	}

	return results;
}

/**
 * Detect builtin writes from a simple command string (used for process substitution inner commands).
 * Parses the command string without going through bash-parser.
 */
function detectBuiltinWritesFromString(cmd: string): WriteTarget | null {
	const tokens = cmd.trim().split(/\s+/);
	if (tokens.length === 0) return null;

	const name = tokens[0].toLowerCase();
	if (BUILTIN_WRITE_COMMANDS.has(name)) {
		// Last non-flag argument is the destination
		for (let i = tokens.length - 1; i >= 1; i--) {
			if (!tokens[i].startsWith('-')) {
				return { category: 'builtin_write', operator: name, path: tokens[i] };
			}
		}
	}
	return null;
}

/** Extract the text value from an AST Word node. */
function wordText(node: unknown): string | null {
	if (!node || typeof node !== 'object') return null;
	const n = node as Record<string, unknown>;
	if (n['type'] === 'Word' && typeof n['text'] === 'string') {
		return n['text'];
	}
	return null;
}

/**
 * Recursively walk an AST node and collect all commands at the leaf level.
 * Handles: Script, Pipeline, CompoundList, LogicalExpression, Subshell, and Command nodes.
 *
 * CompoundList (from brace groups) is pushed as a node because it can carry redirections.
 * Subshell is pushed so detectRedirects can see its redirections.
 */
function collectLeafCommands(node: unknown, out: unknown[]): void {
	if (!node || typeof node !== 'object') return;
	const n = node as Record<string, unknown>;

	const type = n['type'] as string | undefined;

	switch (type) {
		case 'Script':
			if (Array.isArray(n['commands'])) {
				for (const cmd of n['commands']) {
					collectLeafCommands(cmd, out);
				}
			}
			break;

		case 'Pipeline':
		case 'Sequence':
			if (Array.isArray(n['commands'])) {
				for (const cmd of n['commands']) {
					collectLeafCommands(cmd, out);
				}
			}
			break;

		case 'CompoundList':
			// CompoundList can carry redirections; push it then recurse into commands.
			out.push(node);
			if (Array.isArray(n['commands'])) {
				for (const cmd of n['commands']) {
					collectLeafCommands(cmd, out);
				}
			}
			break;

		case 'LogicalExpression':
			if (n['left']) collectLeafCommands(n['left'], out);
			if (n['right']) collectLeafCommands(n['right'], out);
			break;

		case 'And':
		case 'Or':
			if (n['left']) collectLeafCommands(n['left'], out);
			if (n['right']) collectLeafCommands(n['right'], out);
			break;

		case 'Subshell':
			// Push subshell so its redirections are detected, then recurse into list.
			out.push(node);
			if (n['list']) collectLeafCommands(n['list'], out);
			break;

		case 'ProcessSubstitution':
			// ProcessSubstitution: >(cmd) creates a write fd, <(cmd) is read-only.
			// bash-parser currently does not emit ProcessSubstitution nodes (see line ~1508).
			// This case is kept for future bash-parser versions that may add support.
			// Currently the regex fallback in detectProcessSubstitutionWrites handles
			// process substitution detection when bash-parser fails to parse.
			// Only >(...) (Great operator) is a potential write — recurse into inner command.
			// Skip <(...) (Less operator) since it is read-only.
			{
				const op = n['op'] as Record<string, unknown> | undefined;
				if (op && typeof op === 'object') {
					const opType = (op['type'] as string | undefined)?.toUpperCase();
					if (opType === 'GREAT') {
						// >(...) is a write — recurse into the inner command
						if (n['command']) {
							collectLeafCommands(n['command'], out);
						}
					}
					// LESS operator (<) is read-only — skip entirely
				}
			}
			break;

		case 'Command':
		case 'SimpleCommand':
		default:
			out.push(node);
			break;
	}
}

/** Extract the command name from a Command/SimpleCommand AST node. */
function getCommandName(cmd: unknown): string | null {
	if (!cmd || typeof cmd !== 'object') return null;
	const c = cmd as Record<string, unknown>;
	if (typeof c['name'] === 'string') return c['name'];
	return wordText(c['name']);
}

/** Get the suffix (arguments after command name) from a command node. Returns array of word texts. */
function getSuffixWords(cmd: unknown): string[] {
	if (!cmd || typeof cmd !== 'object') return [];
	const c = cmd as Record<string, unknown>;
	const suffix = c['suffix'];
	if (!Array.isArray(suffix)) return [];
	return suffix.map((s) => wordText(s) ?? '');
}

/** Get the prefix from a command node. */
function getPrefixWords(cmd: unknown): string[] {
	if (!cmd || typeof cmd !== 'object') return [];
	const c = cmd as Record<string, unknown>;
	const prefix = c['prefix'];
	if (!Array.isArray(prefix)) return [];
	return prefix.map((p) => wordText(p) ?? '');
}

/**
 * Get redirections array from a command node.
 * Redirections can be:
 *  1. In a dedicated `redirections` property (compound commands like Subshell)
 *  2. Inline in `suffix` array (simple commands like `echo foo > bar`)
 *  3. Inline in `prefix` array
 */
function getRedirections(cmd: unknown): unknown[] {
	if (!cmd || typeof cmd !== 'object') return [];
	const c = cmd as Record<string, unknown>;

	// Dedicated redirections array (compound commands)
	if (Array.isArray(c['redirections'])) {
		return c['redirections'] as unknown[];
	}

	// Collect Redirect nodes from suffix and prefix arrays (simple commands)
	const results: unknown[] = [];
	const suffix = c['suffix'];
	const prefix = c['prefix'];

	if (Array.isArray(suffix)) {
		for (const item of suffix) {
			if (isRedirectNode(item)) results.push(item);
		}
	}
	if (Array.isArray(prefix)) {
		for (const item of prefix) {
			if (isRedirectNode(item)) results.push(item);
		}
	}

	return results;
}

/** Check if a node is a Redirect node. */
function isRedirectNode(node: unknown): boolean {
	return !!(
		node &&
		typeof node === 'object' &&
		(node as Record<string, unknown>)['type'] === 'Redirect'
	);
}

/**
 * Convert an operator token to a human-readable string.
 * Note: bash-parser uses lowercase token names (e.g. 'great', 'dgreat').
 */
function operatorLabel(op: unknown): string {
	if (!op || typeof op !== 'object') return 'unknown';
	const o = op as Record<string, unknown>;
	const opType = (o['type'] as string | undefined)?.toUpperCase();
	switch (opType) {
		case 'GREAT':
			return '>';
		case 'DGREAT':
			return '>>';
		case 'CLOBBER':
			return '>|';
		case 'LESS':
			return '<';
		case 'DLESS':
			return '<<';
		case 'DLESSDASH':
			return '<<-';
		case 'LESSAND':
			return '<&';
		case 'GREATAND':
			return '>&';
		case 'LESSGREAT':
			return '<>';
		default:
			return opType || 'unknown';
	}
}

/** Extract path from a redirect file node, or null if it cannot be determined. */
function extractRedirectPath(fileNode: unknown): string | null {
	const text = wordText(fileNode);
	if (!text) return null;
	return text;
}

/** Check if a path is a null/sink device (not a real write target). */
function isNullDevice(path: string): boolean {
	return (
		path === '/dev/null' || path === '/dev/zero' || path === '/dev/urandom'
	);
}

/** Check if a string is purely numeric (used to filter truncate size args). */
function isNumeric(s: string): boolean {
	return /^\d+$/.test(s);
}

// ---------------------------------------------------------------------------
// Detection functions per category
// ---------------------------------------------------------------------------

/**
 * Detect write-effect redirections on a command (>, >>, <<, etc.).
 * Handles:
 *  1. Redirect nodes in the dedicated `redirections` array (compound commands)
 *  2. Redirect nodes inline in `suffix`/`prefix` arrays (simple commands)
 *  3. Here-doc markers (dless/dlessdash Word tokens in suffix — bash-parser
 *     represents `cmd << MARKER` as a Word in suffix, not a Redirect node)
 */
function detectRedirects(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];

	// Detect here-doc markers FIRST (they appear before redirect in suffix for `cmd << EOF > out.txt`)
	results.push(...detectHereDocMarkers(cmd));

	const redirections = getRedirections(cmd);

	for (const redirect of redirections) {
		if (!redirect || typeof redirect !== 'object') continue;
		const r = redirect as Record<string, unknown>;
		const opNode = r['op'];
		if (!opNode || typeof opNode !== 'object') continue;

		const opType = (
			(opNode as Record<string, unknown>)['type'] as string | undefined
		)?.toUpperCase();

		if (!opType || !REDIRECT_ALL_WRITE_TOKENS.has(opType)) continue;

		const fileNode = r['file'];
		const path = extractRedirectPath(fileNode);
		const opLabel = operatorLabel(opNode);

		if (REDIRECT_WRITE_TOKENS.has(opType)) {
			results.push({ category: 'redirect', operator: opLabel, path });
		} else if (REDIRECT_HERE_TOKENS.has(opType)) {
			results.push({ category: 'here_doc', operator: opLabel, path });
		}
	}

	return results;
}

/**
 * Detect here-doc markers that appear as Word tokens with type 'dless' or 'dlessdash'
 * in the suffix of a command (inline form, not a separate Redirect node).
 */
function detectHereDocMarkers(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	if (!cmd || typeof cmd !== 'object') return results;
	const c = cmd as Record<string, unknown>;

	const suffix = c['suffix'];
	if (!Array.isArray(suffix)) return results;

	for (const item of suffix) {
		if (!item || typeof item !== 'object') continue;
		const n = item as Record<string, unknown>;
		// Here-doc marker: type is 'dless' or 'dlessdash', text is '<<' or '<<-'
		const type = (n['type'] as string | undefined)?.toLowerCase();
		if (type === 'dless' || type === 'dlessdash') {
			const text = n['text'] as string | undefined;
			results.push({
				category: 'here_doc',
				operator: text === '<<-' ? '<<-' : '<<',
				path: null, // marker is not a file path
			});
		}
	}

	return results;
}

/** Detect builtin write commands: cp, mv, install, ln, truncate, dd. */
function detectBuiltinWrites(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const name = getCommandName(cmd);
	if (!name) return results;

	const lowerName = name.toLowerCase();

	// dd with of= flag
	if (lowerName === 'dd') {
		const suffixWords = getSuffixWords(cmd);
		for (const word of suffixWords) {
			if (word.startsWith('of=')) {
				const path = word.slice(3);
				if (path && !isNullDevice(path)) {
					results.push({ category: 'builtin_write', operator: 'dd of=', path });
				}
			}
		}
		return results;
	}

	if (!BUILTIN_WRITE_COMMANDS.has(lowerName)) return results;

	const suffixWords = getSuffixWords(cmd);

	if (lowerName === 'truncate') {
		// find first word that doesn't start with - and isn't a pure numeric size
		for (const word of suffixWords) {
			if (!word.startsWith('-') && !isNumeric(word)) {
				results.push({
					category: 'builtin_write',
					operator: 'truncate',
					path: word,
				});
				break;
			}
		}
	} else {
		// cp, mv, install, ln — last non-flag argument is the destination (written file)
		for (let i = suffixWords.length - 1; i >= 0; i--) {
			const word = suffixWords[i];
			if (!word.startsWith('-')) {
				results.push({ category: 'builtin_write', operator: name, path: word });
				break;
			}
		}
	}

	return results;
}

/** Detect in-place editing: sed -i, perl -i, awk -i. */
function detectInplaceEdit(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const name = getCommandName(cmd);
	if (!name) return results;

	const lowerName = name.toLowerCase();
	if (!INPLACE_EDIT_COMMANDS.has(lowerName)) return [];

	const suffixWords = getSuffixWords(cmd);

	// Look for -i flag
	const hasInplaceFlag = suffixWords.some((word) => {
		if (lowerName === 'sed') return word.startsWith('-i') && word.length > 1;
		return word === '-i' || word.startsWith('-i');
	});

	if (!hasInplaceFlag) return [];

	// Find the file argument — take the LAST non-flag, non-script word
	// This handles: cmd -i file.txt (file is last)
	// And: cmd -i -pe "script" file.txt (file is last after skipping flags and script)
	const scriptPattern = /^[ssy]\/.*\/[gim]*$/;
	const quotedScriptPattern = /^["'].*["']$/; // strings like "s/foo/bar/" or 'foo'
	// Flags that consume the next word as an argument
	const flagArgs = new Set(['-e', '-E', '-f', '-i']);
	const combinedFlagArgs = /^-[paaneA]+[eEf]/; // e.g., -pe, -ne, -ae, -aE, -if
	// sed -i[suffix] where suffix is backup extension (e.g., -ibak) — also consumes next word
	const sedInplaceSuffix = /^-i[a-z]+/i; // e.g., -ibak, -i.bak
	const skipIndices = new Set<number>();
	for (let i = 0; i < suffixWords.length; i++) {
		const word = suffixWords[i];
		if (word.startsWith('-')) {
			// Check if this flag consumes the next word as argument
			if (
				flagArgs.has(word) ||
				combinedFlagArgs.test(word) ||
				sedInplaceSuffix.test(word)
			) {
				skipIndices.add(i);
				if (i + 1 < suffixWords.length) skipIndices.add(i + 1);
			}
		} else if (scriptPattern.test(word) || quotedScriptPattern.test(word)) {
			// This looks like a script, skip it
			skipIndices.add(i);
		}
	}

	// Find the first word that is NOT in skipIndices (the first file argument)
	const candidates = suffixWords
		.map((word, i) => ({ word, i }))
		.filter(({ i }) => !skipIndices.has(i));

	if (candidates.length > 0) {
		const file = candidates[0].word;
		results.push({
			category: 'inplace_edit',
			operator: `${name} -i`,
			path: file,
		});
	}

	return results;
}

/**
 * Detect interpreter eval: python -c, node -e, bun -e, ruby -e, perl -e, php -r.
 * These are flagged as potential write effects because inline code can write files.
 */
function detectInterpreterEval(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const name = getCommandName(cmd);
	if (!name) return results;

	const lowerName = name.toLowerCase();
	if (!INTERPRETER_EVAL_COMMANDS.has(lowerName)) return [];

	const suffixWords = getSuffixWords(cmd);

	const evalFlags: Record<string, string[]> = {
		python: ['-c', '-m'],
		python3: ['-c', '-m'],
		python2: ['-c', '-m'],
		node: ['-e', '-p', '-pe'],
		bun: ['-e', '-p', '-pe'],
		ruby: ['-e'],
		perl: ['-e', '-E'],
		php: ['-r', '-R', '-F'],
	};

	const relevantFlags = evalFlags[lowerName] ?? [];
	const hasEvalFlag = suffixWords.some((word) =>
		relevantFlags.some((f) => word === f || word.startsWith(`${f}=`)),
	);

	if (!hasEvalFlag) return [];

	// Interpreter eval is a write effect even without a specific file target
	results.push({
		category: 'interpreter_eval',
		operator: `${name} [eval]`,
		path: null,
	});

	return results;
}

/** Detect network downloaders: curl -o, wget -O, scp. */
function detectNetworkDownloaders(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const name = getCommandName(cmd);
	if (!name) return results;

	const lowerName = name.toLowerCase();
	if (!NETWORK_DOWNLOAD_COMMANDS.has(lowerName)) return [];

	const suffixWords = getSuffixWords(cmd);

	if (lowerName === 'curl') {
		for (let i = 0; i < suffixWords.length; i++) {
			const word = suffixWords[i];
			if (word === '-o' && i + 1 < suffixWords.length) {
				const path = suffixWords[i + 1];
				if (!path.startsWith('-')) {
					results.push({
						category: 'network_download',
						operator: 'curl -o',
						path,
					});
				}
			} else if (word.startsWith('-o') && word.length > 2) {
				results.push({
					category: 'network_download',
					operator: 'curl -o',
					path: word.slice(2),
				});
			}
		}
	} else if (lowerName === 'wget') {
		for (let i = 0; i < suffixWords.length; i++) {
			const word = suffixWords[i];
			if (word === '-O' && i + 1 < suffixWords.length) {
				const path = suffixWords[i + 1];
				if (!path.startsWith('-')) {
					results.push({
						category: 'network_download',
						operator: 'wget -O',
						path,
					});
				}
			} else if (word.startsWith('-O') && word.length > 2) {
				results.push({
					category: 'network_download',
					operator: 'wget -O',
					path: word.slice(2),
				});
			}
		}
	} else if (lowerName === 'scp') {
		// scp user@host:path local_path — flag the last path-like argument
		for (let i = suffixWords.length - 1; i >= 0; i--) {
			const word = suffixWords[i];
			if (
				!word.startsWith('-') &&
				(word.includes(':') || word.startsWith('/') || word.startsWith('.'))
			) {
				results.push({
					category: 'network_download',
					operator: 'scp',
					path: word,
				});
				break;
			}
		}
	}

	return results;
}

/** Detect archive extraction: tar -x, unzip, gunzip. */
function detectArchiveExtract(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const name = getCommandName(cmd);
	if (!name) return results;

	const lowerName = name.toLowerCase();
	if (!ARCHIVE_EXTRACT_COMMANDS.has(lowerName)) return [];

	const suffixWords = getSuffixWords(cmd);

	if (lowerName === 'tar') {
		// tar extraction: flag contains 'x' (--extract / -x / -xz / -xvf, etc.)
		const hasExtractFlag = suffixWords.some((word) => {
			if (word === '--extract' || word === '--get') return true;
			if (word.startsWith('-') && word.includes('x')) return true;
			return false;
		});
		if (hasExtractFlag) {
			// Find archive name: last non-flag arg OR --file=VALUE
			for (let i = suffixWords.length - 1; i >= 0; i--) {
				const word = suffixWords[i];
				if (!word.startsWith('-')) {
					results.push({
						category: 'archive_extract',
						operator: 'tar -x',
						path: word,
					});
					break;
				}
				if (word.startsWith('--file=') && word.length > 7) {
					results.push({
						category: 'archive_extract',
						operator: 'tar -x',
						path: word.slice(7),
					});
					break;
				}
			}
		}
	} else if (lowerName === 'unzip') {
		// Flag the archive name (last non-flag arg)
		for (let i = suffixWords.length - 1; i >= 0; i--) {
			const word = suffixWords[i];
			if (!word.startsWith('-')) {
				results.push({
					category: 'archive_extract',
					operator: 'unzip',
					path: word,
				});
				break;
			}
		}
	} else if (
		lowerName === 'gunzip' ||
		lowerName === 'gzip' ||
		lowerName === 'bzip2' ||
		lowerName === 'xz' ||
		lowerName === '7z' ||
		lowerName === 'rar'
	) {
		const hasDecompressFlag =
			suffixWords.includes('-d') || suffixWords.includes('--decompress');
		if (hasDecompressFlag || lowerName === 'gunzip') {
			for (let i = suffixWords.length - 1; i >= 0; i--) {
				const word = suffixWords[i];
				if (!word.startsWith('-')) {
					results.push({
						category: 'archive_extract',
						operator: `${name} [decompress]`,
						path: word,
					});
					break;
				}
			}
		}
	}

	return results;
}

/** Detect git destructive operations: git checkout --, git restore, git reset --hard, git clean -fd. */
function detectGitDestructive(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const name = getCommandName(cmd);
	if (!name) return results;

	const lowerName = name.toLowerCase();
	if (lowerName !== GIT_COMMAND) return [];

	const suffixWords = getSuffixWords(cmd);
	if (suffixWords.length === 0) return [];

	const first = suffixWords[0].toLowerCase();

	if (first === 'checkout') {
		// git checkout -- <path> OR git checkout -- .
		const dashDashIdx = suffixWords.indexOf('--');
		if (dashDashIdx !== -1 && dashDashIdx + 1 < suffixWords.length) {
			const path = suffixWords[dashDashIdx + 1];
			const op = path === '.' ? 'git checkout -- .' : 'git checkout --';
			results.push({ category: 'git_destructive', operator: op, path });
		}
	} else if (first === 'restore') {
		// git restore [--hard] [--force] <path>
		const hasHard = suffixWords.some(
			(w) =>
				w === '--hard' || w === '-H' || (w.startsWith('-') && w.includes('H')),
		);
		const hasForce = suffixWords.some(
			(w) =>
				w === '--force' || w === '-f' || (w.startsWith('-') && w.includes('f')),
		);
		if (hasHard || hasForce) {
			const dashDashIdx = suffixWords.indexOf('--');
			if (dashDashIdx !== -1 && dashDashIdx + 1 < suffixWords.length) {
				results.push({
					category: 'git_destructive',
					operator: 'git restore',
					path: suffixWords[dashDashIdx + 1],
				});
			} else {
				// git restore without path = whole repo
				results.push({
					category: 'git_destructive',
					operator: 'git restore',
					path: null,
				});
			}
		}
	} else if (first === 'reset') {
		// git reset --hard OR git reset --hard HEAD
		const hasHard = suffixWords.some(
			(w) =>
				w === '--hard' || w === '-H' || (w.startsWith('-') && w.includes('H')),
		);
		if (hasHard) {
			results.push({
				category: 'git_destructive',
				operator: 'git reset --hard',
				path: null,
			});
		}
	} else if (first === 'clean') {
		// git clean -fd — combined flags like -fd, -f -d, --force -d
		// For combined flags, check if the flag string CONTAINS the flag letter, not just startsWith
		// Skip if -n/--dry-run is present
		const hasDryRun = suffixWords.some(
			(w) =>
				w === '-n' ||
				w === '--dry-run' ||
				(w.startsWith('-') && w.includes('n')),
		);
		if (hasDryRun) return results;

		const hasForce = suffixWords.some(
			(w) =>
				w === '-f' || w === '--force' || (w.startsWith('-') && w.includes('f')),
		);
		const hasDir = suffixWords.some(
			(w) =>
				w === '-d' || w === '--dir' || (w.startsWith('-') && w.includes('d')),
		);
		if (hasForce && hasDir) {
			results.push({
				category: 'git_destructive',
				operator: 'git clean -fd',
				path: null,
			});
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Windows shell detection — regex heuristics
// ---------------------------------------------------------------------------

/**
 * Split a Windows command string into individual commands by pipe (|) and
 * logical separators (&&, ||). Does not split on && inside quoted strings.
 */
function splitWindowsCommands(command: string): string[] {
	const commands: string[] = [];
	let current = '';
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let parenDepth = 0;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
		} else if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
		} else if (ch === '(' && !inSingleQuote && !inDoubleQuote) {
			parenDepth++;
		} else if (ch === ')' && !inSingleQuote && !inDoubleQuote) {
			parenDepth--;
		}

		// Split on | (pipe) when not in quotes or parens
		if (ch === '|' && !inSingleQuote && !inDoubleQuote && parenDepth === 0) {
			if (current.trim()) commands.push(current.trim());
			current = '';
			continue;
		}

		// Split on && or || when not in quotes or parens
		if (
			(ch === '&' || ch === '|') &&
			i + 1 < command.length &&
			command[i + 1] === ch &&
			!inSingleQuote &&
			!inDoubleQuote &&
			parenDepth === 0
		) {
			if (current.trim()) commands.push(current.trim());
			commands.push(ch === '&' ? '&&' : '||');
			current = '';
			i++; // skip next char
			continue;
		}

		// Split on single & when not in quotes or parens and not part of &&
		if (ch === '&' && !inSingleQuote && !inDoubleQuote && parenDepth === 0) {
			// Check this is NOT the first char of && (already handled above)
			if (!(i + 1 < command.length && command[i + 1] === '&')) {
				if (current.trim()) commands.push(current.trim());
				current = '';
				continue;
			}
		}

		current += ch;
	}

	if (current.trim()) commands.push(current.trim());
	return commands.filter((c) => c !== '&&' && c !== '||');
}

// ---------------------------------------------------------------------------
// PowerShell detection
// ---------------------------------------------------------------------------

/** PowerShell cmdlets that write to files. */
const PS_WRITE_CMDLETS = new Set([
	'Out-File',
	'Set-Content',
	'Add-Content',
	'Clear-Content',
	'Copy-Item',
	'Move-Item',
	'Remove-Item',
	'Invoke-WebRequest',
	'Start-Process',
]);

/** PowerShell aliases that map to write operations. */
const PS_WRITE_ALIASES = new Set(['echo', 'write']);

/**
 * Detect write operations in a single PowerShell command string using regex.
 * Handles cmdlets, aliases, and redirection operators.
 */
function detectPowerShellWrites(command: string): WriteTarget[] {
	const results: WriteTarget[] = [];
	const trimmed = command.trim();
	if (!trimmed) return results;

	// Strip -Command wrapper to get inner PowerShell command
	// Handle: powershell -Command "...", powershell -C "..."
	let innerCommand = trimmed;
	const cmdMatch = trimmed.match(
		/^(?:powershell|pwsh)\s+(?:-Command|-C)\s+(.*)$/i,
	);
	if (cmdMatch) {
		innerCommand = cmdMatch[1].trim();
		// Strip outer quotes if present
		if (
			(innerCommand.startsWith('"') && innerCommand.endsWith('"')) ||
			(innerCommand.startsWith("'") && innerCommand.endsWith("'"))
		) {
			innerCommand = innerCommand.slice(1, -1);
		}
	}

	// Detect redirections: > and >> (PowerShell uses same operators)
	// Match > or >> that is NOT preceded by a digit (not fd redirect like 2>)
	const redirectMatch = innerCommand.match(/^(.*?)\s+((?:>){1,2})\s*(\S+)$/);
	if (redirectMatch) {
		// Check if this looks like an fd redirect pattern (cmd 2>&1)
		const beforeRedirect = redirectMatch[1];
		const op = redirectMatch[2];
		const path = redirectMatch[3];
		const fdRedirectPattern = /\d>\s*$|\s\d>&$/;
		if (!fdRedirectPattern.test(beforeRedirect + ' ' + op)) {
			results.push({ category: 'redirect', operator: op, path });
		}
	}

	// Also detect leading redirect (e.g., " > out.txt" at start — unusual but possible)
	const leadingRedirect = innerCommand.match(/^((?:>){1,2})\s+(\S+)$/);
	if (leadingRedirect) {
		results.push({
			category: 'redirect',
			operator: leadingRedirect[1],
			path: leadingRedirect[2],
		});
	}

	// Start-Process is handled by detectInteractiveSession — do not double-detect here

	// Detect Invoke-WebRequest (or its curl alias) with -OutFile or -o
	const iwrMatch = trimmed.match(
		/^(?:Invoke-WebRequest|curl)\s.*?(?:-OutFile\s+(\S+)|-o\s+(\S+))/i,
	);
	if (iwrMatch) {
		const path = iwrMatch[1] || iwrMatch[2];
		if (path) {
			results.push({
				category: 'network_download',
				operator: 'Invoke-WebRequest -OutFile',
				path,
			});
		}
	}

	// Detect file-writing cmdlets: Out-File, Set-Content, Add-Content, Clear-Content
	function detectPsContentCmdlet(cmd: string): WriteTarget | null {
		const cmdletMatch = cmd.match(
			/^(Out-File|Set-Content|Add-Content|Clear-Content)\b/i,
		);
		if (!cmdletMatch) return null;
		const cmdletName = cmdletMatch[1];
		const rest = cmd.slice(cmdletMatch[0].length).trim();

		// Strategy:
		// 1. First try to extract path from -Path, -FilePath, or -LiteralPath flags explicitly
		// 2. Fall back to first non-flag positional argument
		// 3. Strip surrounding quotes from extracted path

		// Match -Path <value>, -FilePath <value>, -LiteralPath <value> (value may be quoted)
		// Quoted strings must be matched BEFORE \S+ to handle paths with spaces correctly
		const pathFlagMatch = rest.match(
			/(?:-Path|-FilePath|-LiteralPath)\s+("([^"]+)"|'([^']+)'|(\S+))/i,
		);
		if (pathFlagMatch) {
			const path =
				pathFlagMatch[2] ?? pathFlagMatch[3] ?? pathFlagMatch[4] ?? '';
			return { category: 'redirect', operator: cmdletName, path };
		}

		// No explicit path flag — fall back to first non-flag positional argument
		// Tokens: quoted strings, words not starting with -, or flags
		const tokens = rest.match(/(?:[^\s"-]+|"[^"]*"|'[^']*'|-[^\s]+)/g) ?? [];
		for (const token of tokens) {
			// Skip flags (tokens starting with -)
			if (token.startsWith('-')) continue;
			// This is a positional argument — treat it as the path
			const path = token.replace(/^["']|["']$/g, '');
			return { category: 'redirect', operator: cmdletName, path };
		}

		return null;
	}

	const contentResult = detectPsContentCmdlet(innerCommand);
	if (contentResult) {
		results.push(contentResult);
	}

	// Also detect content cmdlets that appear AFTER a pipe
	// e.g., "echo hello | Out-File path" or "echo data | Set-Content file.txt"
	const pipeContentMatch = innerCommand.match(
		/\|\s*(Out-File|Set-Content|Add-Content|Clear-Content)\b\s*(.*)$/i,
	);
	if (pipeContentMatch) {
		const cmdletName = pipeContentMatch[1];
		const afterCmdlet = pipeContentMatch[2].trim();
		// Extract path: first non-flag token
		const tokens =
			afterCmdlet.match(/(?:[^\s"-]+|"[^"]*"|'[^']*'|-[^\s]+)/g) ?? [];
		for (const token of tokens) {
			if (token.startsWith('-')) continue;
			const path = token.replace(/^["']|["']$/g, '');
			if (path) {
				results.push({ category: 'redirect', operator: cmdletName, path });
				break;
			}
		}
	}

	// Detect Copy-Item, Move-Item, Remove-Item (file-manipulation cmdlets)
	// Destination is the LAST positional argument (not the first)
	// Handle: Copy-Item src dst, Copy-Item -Path src -Destination dst, Copy-Item -Recurse src dst
	function detectPsFileOp(cmd: string): WriteTarget | null {
		const opMatch = cmd.match(/^(Copy-Item|Move-Item|Remove-Item)\b/i);
		if (!opMatch) return null;
		const cmdletName = opMatch[1];
		const rest = cmd.slice(opMatch[0].length).trim();

		// Check for -Destination flag first (takes precedence)
		const destFlagMatch = rest.match(/-Destination\s+(\S+|"[^"]+"|'[^']+')/i);
		if (destFlagMatch) {
			const path = destFlagMatch[1].replace(/^["']|["']$/g, '');
			return { category: 'builtin_write', operator: cmdletName, path };
		}

		// Collect all positional arguments (words not starting with -)
		// Also track the VALUE of -Path/-LiteralPath since that IS the path for file ops
		const tokens: string[] = [];
		// Flags that take a value (next non-flag token is the value)
		const flagTakingValue = new Set([
			'-Path',
			'-LiteralPath',
			'-Exclude',
			'-Include',
			'-Filter',
		]);
		// Flags that are standalone switches (don't consume next token)
		const switchFlags = new Set([
			'-Recurse',
			'-Force',
			'-Confirm',
			'-WhatIf',
			'-PassThru',
			'-Verbose',
			'-Debug',
		]);
		const parts = rest.match(/(?:[^\s"-]+|"[^"]*"|'[^']*'|-[^\s]+)/g) ?? [];
		let i = 0;
		while (i < parts.length) {
			const part = parts[i];
			if (flagTakingValue.has(part) && i + 1 < parts.length) {
				// Flag takes value — capture the value as a potential path
				const value = parts[i + 1];
				if (!value.startsWith('-')) {
					tokens.push(value);
				}
				i += 2; // skip flag and its value
			} else if (switchFlags.has(part)) {
				i++; // skip flag only
			} else if (part.startsWith('-')) {
				i++; // skip unknown flag
			} else {
				tokens.push(part);
				i++;
			}
		}

		// Destination is the last positional argument
		if (tokens.length >= 2) {
			const path = tokens[tokens.length - 1].replace(/^["']|["']$/g, '');
			return { category: 'builtin_write', operator: cmdletName, path };
		} else if (tokens.length === 1) {
			// Single arg — could be the destination if no source given (e.g., Remove-Item dir)
			const path = tokens[0].replace(/^["']|["']$/g, '');
			return { category: 'builtin_write', operator: cmdletName, path };
		}

		return null;
	}

	const fileOp = detectPsFileOp(innerCommand);
	if (fileOp) {
		results.push(fileOp);
	}

	// Also detect file operations that appear AFTER a pipe
	// e.g., "Get-Content file.txt | Copy-Item -Destination dest.txt"
	const pipeFileOpMatch = innerCommand.match(
		/\|\s*(Copy-Item|Move-Item)\b\s*(.*)$/i,
	);
	if (pipeFileOpMatch) {
		const cmdletName = pipeFileOpMatch[1];
		const afterCmdlet = pipeFileOpMatch[2].trim();
		// Extract destination from -Destination flag or last positional arg
		const destFlagMatch = afterCmdlet.match(
			/-Destination\s+(\S+|"[^"]+"|'[^']+')/i,
		);
		if (destFlagMatch) {
			const path = destFlagMatch[1].replace(/^["']|["']$/g, '');
			results.push({ category: 'builtin_write', operator: cmdletName, path });
		} else {
			// Last non-flag token as destination
			const tokens =
				afterCmdlet.match(/(?:[^\s"-]+|"[^"]*"|'[^']*'|-[^\s]+)/g) ?? [];
			const nonFlagTokens = tokens.filter(
				(t) => !t.startsWith('-') && t.length > 0,
			);
			if (nonFlagTokens.length > 0) {
				const path = nonFlagTokens[nonFlagTokens.length - 1].replace(
					/^["']|["']$/g,
					'',
				);
				results.push({ category: 'builtin_write', operator: cmdletName, path });
			}
		}
	}

	// Detect echo/write aliases — if followed by redirection, flag as write
	// e.g., "echo hello > file.txt" or "write output >> log.txt"
	const aliasRedirectMatch = trimmed.match(
		/^(echo|write)\s+(\S+.*?)\s*(?:>|\s{2,})/i,
	);
	if (aliasRedirectMatch) {
		// Look for a redirect in the command
		const aliasPart = aliasRedirectMatch[0];
		const afterAlias = trimmed.slice(aliasRedirectMatch[0].length);
		const fullRedirectMatch = trimmed.match(/((?:>){1,2})\s*(\S+)$/);
		if (fullRedirectMatch) {
			results.push({
				category: 'redirect',
				operator: fullRedirectMatch[1],
				path: fullRedirectMatch[2],
			});
		}
	}

	// Detect bare echo/write with redirect (e.g., 'echo foo > bar')
	const bareAliasMatch = trimmed.match(
		/^(echo|write)\s+.*?\s+((?:>){1,2})\s*(\S+)$/i,
	);
	if (bareAliasMatch) {
		results.push({
			category: 'redirect',
			operator: bareAliasMatch[2],
			path: bareAliasMatch[3],
		});
	}

	return results;
}

// ---------------------------------------------------------------------------
// cmd.exe detection
// ---------------------------------------------------------------------------

/** cmd.exe builtins that write to files. */
const CMD_WRITE_BUILTINS = new Set([
	'copy',
	'move',
	'type',
	'del',
	'rd',
	'md',
	'ren',
]);

/**
 * Detect write operations in a single cmd.exe command string using regex.
 * Handles builtins and redirection operators.
 */
function detectCmdWrites(command: string): WriteTarget[] {
	const results: WriteTarget[] = [];
	const trimmed = command.trim();
	if (!trimmed) return results;

	// Strip cmd.exe wrapper to get inner command
	// Handle: cmd /c "...", cmd /k "...", cmd /c "copy src dst", cmd.exe /c "..."
	let innerCommand = trimmed;
	const cmdWrapperMatch = trimmed.match(/^cmd(?:\.exe)?\s+\/[ck]\s+(.*)$/i);
	if (cmdWrapperMatch) {
		innerCommand = cmdWrapperMatch[1].trim();
		// Strip outer quotes if present (handles cmd /c "copy file.txt dest.txt")
		if (
			(innerCommand.startsWith('"') && innerCommand.endsWith('"')) ||
			(innerCommand.startsWith("'") && innerCommand.endsWith("'"))
		) {
			innerCommand = innerCommand.slice(1, -1);
		}
	}

	// Detect redirections: > and >>
	// Match > or >> at the end of the command (with possible preceding content)
	// Avoid matching things like "2>&1" (fd redirect)
	const redirectMatch = innerCommand.match(/^(.*?)\s+((?:>){1,2})\s*(\S+)$/);
	if (redirectMatch) {
		const beforeRedirect = redirectMatch[1];
		const op = redirectMatch[2];
		const path = redirectMatch[3];
		// Skip fd redirects like "2>&1" or "cmd 2>&1"
		const fdRedirectPattern = /\d>&?$/;
		if (!fdRedirectPattern.test(beforeRedirect)) {
			results.push({ category: 'redirect', operator: op, path });
		}
	}

	// Also check for leading redirect
	const leadingRedirect = innerCommand.match(/^((?:>){1,2})\s+(\S+)$/);
	if (leadingRedirect) {
		results.push({
			category: 'redirect',
			operator: leadingRedirect[1],
			path: leadingRedirect[2],
		});
	}

	// Detect copy builtin: copy source dest (handles if exist pattern)
	function detectCmdCopy(cmd: string): WriteTarget | null {
		// Direct: copy src dest
		const directMatch = cmd.match(
			/^copy\s+(\S+|"[^"]+"|'[^']+')\s+(\S+|"[^"]+"|'[^']+')/i,
		);
		if (directMatch) {
			const dest = directMatch[2].replace(/^["']|["']$/g, '');
			return { category: 'builtin_write', operator: 'copy', path: dest };
		}
		// if exist pattern: if exist <file> copy src dest
		const ifExistMatch = cmd.match(
			/if\s+exist\s+\S+.*?copy\s+(\S+|"[^"]+"|'[^']+')\s+(\S+|"[^"]+"|'[^']+')/i,
		);
		if (ifExistMatch) {
			const dest = ifExistMatch[2].replace(/^["']|["']$/g, '');
			return { category: 'builtin_write', operator: 'copy', path: dest };
		}
		return null;
	}

	// Detect move builtin: move source dest
	function detectCmdMove(cmd: string): WriteTarget | null {
		const directMatch = cmd.match(
			/^move\s+(\S+|"[^"]+"|'[^']+')\s+(\S+|"[^"]+"|'[^']+')/i,
		);
		if (directMatch) {
			const dest = directMatch[2].replace(/^["']|["']$/g, '');
			return { category: 'builtin_write', operator: 'move', path: dest };
		}
		// if exist pattern
		const ifExistMatch = cmd.match(
			/if\s+exist\s+\S+.*?move\s+(\S+|"[^"]+"|'[^']+')\s+(\S+|"[^"]+"|'[^']+')/i,
		);
		if (ifExistMatch) {
			const dest = ifExistMatch[2].replace(/^["']|["']$/g, '');
			return { category: 'builtin_write', operator: 'move', path: dest };
		}
		return null;
	}

	const copyResult = detectCmdCopy(innerCommand);
	if (copyResult) results.push(copyResult);

	const moveResult = detectCmdMove(innerCommand);
	if (moveResult) results.push(moveResult);

	// Detect ren builtin: ren oldname newname
	const renMatch = innerCommand.match(
		/^ren\s+(\S+|"[^"]+"|'[^']+')\s+(\S+|"[^"]+"|'[^']+')/i,
	);
	if (renMatch) {
		const dest = (renMatch[2] || '').replace(/^["']|["']$/g, '');
		if (dest) {
			results.push({ category: 'builtin_write', operator: 'ren', path: dest });
		}
	}

	// Detect del builtin: del file (handles flags like /f /q before path)
	function detectCmdDel(cmd: string): WriteTarget | null {
		const delMatch = cmd.match(/^del\s+/i);
		if (!delMatch) return null;
		const rest = cmd.slice(delMatch[0].length).trim();
		// Split into tokens, then skip any token starting with /
		const rawTokens = rest.match(/(\/?[^\s]+|"[^"]*"|'[^']*')/g) ?? [];
		const tokens = rawTokens.filter((t) => !t.startsWith('/'));
		if (tokens.length > 0) {
			const path = tokens[0].replace(/^["']|["']$/g, '');
			return { category: 'builtin_write', operator: 'del', path };
		}
		return null;
	}

	const delResult = detectCmdDel(innerCommand);
	if (delResult) {
		results.push(delResult);
	}

	// Detect type builtin: type file (displays file content — read, not write, but
	// we note it for completeness; type itself is read-only)
	// Note: type is read-only, so we don't flag it as write

	// Detect rd (remove directory): rd /s /q path
	const rdMatch = innerCommand.match(/^rd\s+(?:\/s\s+|\/q\s+)*(\S+)/i);
	if (rdMatch) {
		const path = rdMatch[1].replace(/^["']|["']$/g, '');
		if (!path.startsWith('/')) {
			results.push({ category: 'builtin_write', operator: 'rd', path });
		}
	}

	// Detect md (make directory): md path
	const mdMatch = trimmed.match(/^md\s+(\S+)/i);
	if (mdMatch) {
		const path = mdMatch[1].replace(/^["']|["']$/g, '');
		if (!path.startsWith('/')) {
			results.push({ category: 'builtin_write', operator: 'md', path });
		}
	}

	// Detect echo with redirect: echo text > file or echo text >> file
	const echoMatch = trimmed.match(/^echo\s+(\S+.*?)\s+((?:>){1,2})\s*(\S+)$/i);
	if (echoMatch) {
		results.push({
			category: 'redirect',
			operator: echoMatch[2],
			path: echoMatch[3],
		});
	}

	// Detect echo. > file (echo. is a cmd builtin for blank line)
	const echoDotMatch = trimmed.match(/^echo\.\s+((?:>){1,2})\s*(\S+)$/i);
	if (echoDotMatch) {
		results.push({
			category: 'redirect',
			operator: echoDotMatch[1],
			path: echoDotMatch[2],
		});
	}

	// Detect set with redirect: set VAR=value > file
	const setMatch = trimmed.match(
		/^set\s+\S+\s*=\s*\S*\s*((?:>){1,2})\s*(\S+)$/i,
	);
	if (setMatch) {
		results.push({
			category: 'redirect',
			operator: setMatch[1],
			path: setMatch[2],
		});
	}

	return results;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Interactive / session tool detection
// ---------------------------------------------------------------------------

/**
 * Detect interactive/session tools that should be denied regardless of scope.
 *
 * These tools create persistent sessions or run commands repeatedly in a way
 * that is inherently open-ended and cannot be bounded safely.
 *
 * @param command - A shell command string
 * @param shell - The shell type: 'posix', 'powershell', or 'cmd'
 * @returns true if the command uses an interactive/session tool
 */
export function detectInteractiveSession(
	command: string,
	shell: 'posix' | 'powershell' | 'cmd',
): boolean {
	if (!command || typeof command !== 'string') return false;

	const trimmed = command.trim();

	if (shell === 'posix') {
		const lower = trimmed.toLowerCase();
		// watch — runs command repeatedly (infinite loop by default)
		if (/^watch(\s|$)/.test(lower)) return true;
		// screen — terminal multiplexer, creates persistent session
		if (/^screen(\s|$)/.test(lower)) return true;
		// tmux: deny if bare (starts tmux server) or new-session subcommand
		// Allow: attach-session, list-sessions, kill-session, etc.
		if (/^tmux(\s+new-session(\s+.*)?)?$/.test(lower)) return true;
	} else if (shell === 'powershell') {
		// Start-Process — launches new process, can create persistent sessions
		if (/^Start-Process\s/i.test(trimmed)) return true;
	}

	return false;
}

/**
 * Parse a POSIX shell command and detect all file-system write operations.
 *
 * Detects:
 * - Redirection operators: >, >>, >|, <<, <<- (here-docs)
 * - Write-effect builtins: cp, mv, install, ln, truncate, dd (of=)
 * - In-place editors: sed -i, perl -i, awk -i
 * - Interpreter eval: python -c/-m, node -e, bun -e, ruby -e, perl -e, php -r
 * - Network downloaders: curl -o, wget -O, scp
 * - Archive extraction: tar -x, unzip, gunzip
 * - Git destructive: git checkout --, git restore, git reset --hard, git clean -fd
 *
 * @param command - A POSIX shell command string
 * @returns WriteAnalysis with array of detected write targets; hasWrites is false when array is empty
 */
export function detectPosixWrites(command: string): WriteAnalysis {
	if (!command || typeof command !== 'string') {
		return { writes: [], hasWrites: false };
	}

	let ast: unknown;
	let parseFailed = false;
	try {
		ast = parse(command, { mode: 'posix' });
	} catch {
		// Parser failed — treat as parse error (fail-closed)
		parseFailed = true;
	}

	const allWrites: WriteTarget[] = [];

	if (!parseFailed && ast && typeof ast === 'object') {
		const leafCommands: unknown[] = [];
		collectLeafCommands(ast, leafCommands);

		for (const cmd of leafCommands) {
			// Redirections (>, >>, <<, etc.) on any command
			allWrites.push(...detectRedirects(cmd));
			// Builtin writes
			allWrites.push(...detectBuiltinWrites(cmd));
			// In-place editors
			allWrites.push(...detectInplaceEdit(cmd));
			// Interpreter evals
			allWrites.push(...detectInterpreterEval(cmd));
			// Network downloaders
			allWrites.push(...detectNetworkDownloaders(cmd));
			// Archive extraction
			allWrites.push(...detectArchiveExtract(cmd));
			// Git destructive
			allWrites.push(...detectGitDestructive(cmd));
		}
	}

	// If parse failed, try regex-based process substitution detection.
	// This catches commands like `tee >(cat > file.txt)` which bash-parser cannot parse.
	if (parseFailed) {
		const procSubWrites = detectProcessSubstitutionWrites(command);
		allWrites.push(...procSubWrites);
	}

	// Deduplicate by (category, operator, path) to avoid double-counting
	const seen = new Set<string>();
	const writes = allWrites.filter((wt) => {
		const key = `${wt.category}|${wt.operator}|${wt.path ?? 'null'}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	return {
		writes,
		hasWrites: writes.length > 0,
		parseError: parseFailed && writes.length === 0 ? true : undefined,
	};
}

/**
 * Parse a Windows shell command (PowerShell or cmd.exe) and detect all
 * file-system write operations using regex heuristics.
 *
 * Detects:
 * - Redirection operators: >, >>
 * - PowerShell cmdlets: Out-File, Set-Content, Add-Content, Clear-Content,
 *   Copy-Item, Move-Item, Remove-Item, Invoke-WebRequest (-OutFile), Start-Process
 * - PowerShell aliases: echo, write (when used with redirection)
 * - cmd.exe builtins: copy, move, ren, del, rd, md
 * - cmd.exe redirections: >, >>
 * - cmd.exe echo/set with redirection
 *
 * @param command - A Windows shell command string
 * @param shell - Either 'powershell' or 'cmd'
 * @returns WriteAnalysis with array of detected write targets; hasWrites is false when array is empty
 */
export function detectWindowsWrites(
	command: string,
	shell: 'powershell' | 'cmd',
): WriteAnalysis {
	if (!command || typeof command !== 'string') {
		return { writes: [], hasWrites: false };
	}

	try {
		// Split compound commands (pipelines, &&, ||)
		const subCommands = splitWindowsCommands(command);
		const allWrites: WriteTarget[] = [];

		for (const subCmd of subCommands) {
			const writes =
				shell === 'powershell'
					? detectPowerShellWrites(subCmd)
					: detectCmdWrites(subCmd);
			allWrites.push(...writes);
		}

		// Deduplicate by (category, operator, path)
		const seen = new Set<string>();
		const writes = allWrites.filter((wt) => {
			const key = `${wt.category}|${wt.operator}|${wt.path ?? 'null'}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

		return { writes, hasWrites: writes.length > 0 };
	} catch {
		return { writes: [], hasWrites: false, parseError: true };
	}
}

// ---------------------------------------------------------------------------
// Path resolution for write targets
// ---------------------------------------------------------------------------

/**
 * Returns true if the path string contains dynamic elements that cannot be
 * statically resolved: environment variables ($VAR or ${VAR}) or command
 * substitution ($(cmd) or `cmd`).
 */
function isDynamicPath(pathText: string | null): boolean {
	if (pathText === null || pathText === undefined) return false;
	// $VAR or ${VAR}
	if (/\$[A-Za-z_][A-Za-z0-9_]*/.test(pathText)) return true;
	if (/\$\{[^}]+\}/.test(pathText)) return true;
	// $(cmd)
	if (/\$\([^)]+\)/.test(pathText)) return true;
	// `cmd` (backtick command substitution)
	if (/`[^`]+`/.test(pathText)) return true;
	return false;
}

/**
 * Resolve a single path against a cwd using POSIX semantics (path.posix.resolve).
 * Returns null if path is null or contains dynamic elements.
 *
 * NOTE: This function expects cwd to be a POSIX-style absolute path (forward slashes,
 * no drive letter). On Windows, callers must normalize the cwd to POSIX format
 * (e.g., C:\Users\foo → /c/Users/foo) before calling this function, or use
 * path.posix.resolve with a POSIX-normalized cwd.
 */
function resolvePath(pathText: string | null, cwd: string): string | null {
	if (pathText === null) return null;
	if (isDynamicPath(pathText)) return null;
	// Use platform-appropriate resolution: Windows paths (drive letter or backslash)
	// need win32 resolution; POSIX paths use posix resolution.
	const isWindowsPath = /^[a-zA-Z]:[\\\\/]/.test(cwd) || cwd.includes('\\');
	if (isWindowsPath) {
		return path.win32.resolve(cwd, pathText);
	}
	return path.posix.resolve(cwd, pathText);
}

/**
 * Check if a node is a Command or SimpleCommand with name 'cd' and extract its target.
 */
function getCdTarget(cmd: unknown): string | null {
	if (!cmd || typeof cmd !== 'object') return null;
	const c = cmd as Record<string, unknown>;
	const nodeType = c['type'] as string;
	if (nodeType !== 'SimpleCommand' && nodeType !== 'Command') return null;
	const name = c['name'];
	if (!name || typeof name !== 'object') return null;
	const n = name as Record<string, unknown>;
	if ((n['type'] as string) !== 'Word') return null;
	const text = n['text'] as string;
	if (text !== 'cd') return null;
	// Get the first suffix word (the directory target)
	const suffix = c['suffix'] as unknown[] | undefined;
	if (!Array.isArray(suffix) || suffix.length === 0) return null;
	const first = suffix[0];
	if (!first || typeof first !== 'object') return null;
	const firstWord = first as Record<string, unknown>;
	if ((firstWord['type'] as string) !== 'Word') return null;
	const target = firstWord['text'] as string;
	// Ignore special cd targets
	if (target === '-' || target === '~' || target === '~' + '/') return null;
	return target;
}

/**
 * Collect all write targets from a command node, including their context cwd,
 * in the same order as `collectLeafCommands` traversal.
 *
 * Returns pairs of (write target, context cwd) for path resolution.
 */
interface WriteWithNode {
	write: WriteTarget;
	context: string;
}

/**
 * Walk a node and collect writes with their source nodes, in the same order
 * as `collectLeafCommands` so we can match writes by position.
 */
function collectWritesWithNodes(
	node: unknown,
	out: WriteWithNode[],
	cwdStack: string[],
): void {
	if (!node || typeof node !== 'object') return;
	const n = node as Record<string, unknown>;
	const type = n['type'] as string | undefined;

	switch (type) {
		case 'Script': {
			const globalCwd = cwdStack[0] ?? '/';
			if (Array.isArray(n['commands'])) {
				for (const cmd of n['commands']) {
					collectWritesWithNodes(cmd, out, cwdStack);
				}
			}
			break;
		}

		case 'Subshell': {
			// POSIX subshell: (...) spawns a child shell process. Any cd inside only
			// affects the child's cwd — the parent's cwdStack is unchanged.
			const effectiveCwd = cwdStack[0] ?? '/';

			// Collect writes from the subshell's redirections (if redirect is ON the subshell)
			const subshellRedirs = n['redirections'] as unknown[] | undefined;
			if (Array.isArray(subshellRedirs)) {
				for (const redirect of subshellRedirs) {
					const writesFromRedirect = getWritesFromRedirectNode(
						redirect,
						effectiveCwd,
					);
					for (const w of writesFromRedirect) {
						out.push({ write: w, context: effectiveCwd });
					}
				}
			}

			// Recurse into the subshell's list with a COPY of the stack so
			// cd mutations inside the subshell do not leak to the parent.
			if (n['list']) {
				const subStack = [...cwdStack];
				collectWritesWithNodes(n['list'], out, subStack);
			}
			break;
		}

		case 'CompoundList': {
			// Process each command in sequence, updating context as we go
			if (Array.isArray(n['commands'])) {
				// Track the current stack across iterations; starts as cwdStack,
				// but after a cd mutation, subsequent commands must use the mutated stack
				const currentStack = cwdStack;
				for (const cmd of n['commands']) {
					// Check for cd command to update context
					const cdTarget = getCdTarget(cmd);
					if (cdTarget) {
						// Resolve relative cd target against current effective cwd
						currentStack[0] = path.posix.resolve(
							currentStack[0] ?? '/',
							cdTarget,
						);
						collectWritesWithNodes(cmd, out, currentStack);
					} else {
						// Use the current (possibly mutated) stack so cd changes propagate
						collectWritesWithNodes(cmd, out, currentStack);
					}
				}
			}
			break;
		}

		case 'Pipeline':
		case 'Sequence': {
			if (Array.isArray(n['commands'])) {
				for (const cmd of n['commands']) {
					collectWritesWithNodes(cmd, out, cwdStack);
				}
			}
			break;
		}

		case 'LogicalExpression': {
			// LogicalExpression (&& or ||) — same semantics as And/Or
			// Process left first (may modify cwd via cd)
			// IMPORTANT: Use cwdStack directly, not a copy, so cd mutations propagate
			if (n['left']) {
				collectWritesWithNodes(n['left'], out, cwdStack);
				// Capture the context AFTER left has been processed (cd may have modified it)
				const leftContext = cwdStack[0] ?? '/';
				// Process right with potentially updated context from left
				if (n['right']) {
					// Use a single-element stack for right; leftContext is the only cwd needed
					const rightStack = [leftContext];
					collectWritesWithNodes(n['right'], out, rightStack);
				}
			}
			break;
		}

		case 'And':
		case 'Or': {
			// Process left first (may modify cwd via cd)
			// IMPORTANT: Use cwdStack directly, not a copy, so cd mutations propagate
			if (n['left']) {
				collectWritesWithNodes(n['left'], out, cwdStack);
				const leftContext = cwdStack[0] ?? '/';
				// Process right with potentially updated context from left
				if (n['right']) {
					// Use a single-element stack for right; leftContext is the only cwd needed
					const rightStack = [leftContext];
					collectWritesWithNodes(n['right'], out, rightStack);
				}
			}
			break;
		}

		case 'Command':
		case 'SimpleCommand': {
			const effectiveCwd = cwdStack[0] ?? '/';

			// Check for cd command
			const cdTarget = getCdTarget(node);
			if (cdTarget) {
				// Resolve relative cd target against current effective cwd
				cwdStack[0] = path.posix.resolve(cwdStack[0] ?? '/', cdTarget);
				return;
			}

			// Collect writes from this command's redirections
			const writesFromRedirs = getWritesFromCommandRedirs(node, effectiveCwd);
			for (const w of writesFromRedirs) {
				out.push({ write: w, context: effectiveCwd });
			}

			// Collect writes from builtin commands, inplace editors, etc.
			const builtinWrites = detectBuiltinWrites(node);
			for (const w of builtinWrites) {
				out.push({ write: w, context: effectiveCwd });
			}

			const inplaceWrites = detectInplaceEdit(node);
			for (const w of inplaceWrites) {
				out.push({ write: w, context: effectiveCwd });
			}

			const interpreterWrites = detectInterpreterEval(node);
			for (const w of interpreterWrites) {
				out.push({ write: w, context: effectiveCwd });
			}

			const networkWrites = detectNetworkDownloaders(node);
			for (const w of networkWrites) {
				out.push({ write: w, context: effectiveCwd });
			}

			const archiveWrites = detectArchiveExtract(node);
			for (const w of archiveWrites) {
				out.push({ write: w, context: effectiveCwd });
			}

			const gitWrites = detectGitDestructive(node);
			for (const w of gitWrites) {
				out.push({ write: w, context: effectiveCwd });
			}

			break;
		}
	}
}

/**
 * Extract write targets from a redirect node, resolving against the given context.
 */
function getWritesFromRedirectNode(
	redirect: unknown,
	_context: string,
): WriteTarget[] {
	if (!redirect || typeof redirect !== 'object') return [];
	const r = redirect as Record<string, unknown>;
	const opNode = r['op'];
	if (!opNode || typeof opNode !== 'object') return [];

	const opType = (
		(opNode as Record<string, unknown>)['type'] as string | undefined
	)?.toUpperCase();
	if (!opType || !REDIRECT_ALL_WRITE_TOKENS.has(opType)) return [];

	const fileNode = r['file'];
	const path = extractRedirectPath(fileNode);
	const opLabel = operatorLabel(opNode);

	if (REDIRECT_WRITE_TOKENS.has(opType)) {
		return [{ category: 'redirect', operator: opLabel, path }];
	} else if (REDIRECT_HERE_TOKENS.has(opType)) {
		return [{ category: 'here_doc', operator: opLabel, path }];
	}
	return [];
}

/**
 * Extract write targets from a command node's redirections (suffix/prefix arrays).
 */
function getWritesFromCommandRedirs(
	cmd: unknown,
	context: string,
): WriteTarget[] {
	if (!cmd || typeof cmd !== 'object') return [];
	const c = cmd as Record<string, unknown>;
	const results: WriteTarget[] = [];

	// Also detect here-doc markers first
	results.push(...detectHereDocMarkers(cmd));

	const suffix = c['suffix'];
	const prefix = c['prefix'];

	if (Array.isArray(suffix)) {
		for (const item of suffix) {
			if (isRedirectNode(item)) {
				const writes = getWritesFromRedirectNode(item, context);
				results.push(...writes);
			}
		}
	}
	if (Array.isArray(prefix)) {
		for (const item of prefix) {
			if (isRedirectNode(item)) {
				const writes = getWritesFromRedirectNode(item, context);
				results.push(...writes);
			}
		}
	}

	return results;
}

/**
 * Resolve write targets from a POSIX shell command against a given cwd,
 * tracking directory changes through subshell `cd` commands.
 *
 * This function is pure: it does not modify any external state.
 *
 * @param command - A POSIX shell command string (e.g., "(cd /tmp && echo x > file)")
 * @param cwd - The starting current working directory (e.g., "/home/user")
 * @returns Array of ResolvedWriteTarget with resolved absolute paths
 */
export function resolveWriteTargets(
	command: string,
	writes: WriteTarget[],
	cwd: string,
): ResolvedWriteTarget[] {
	if (!writes || writes.length === 0) return [];
	if (!command || typeof command !== 'string') {
		// Fall back to resolving against provided cwd without subshell tracking
		return writes.map((original) => ({
			original,
			resolvedPath: resolvePath(original.path, cwd),
			resolved: original.path !== null && !isDynamicPath(original.path),
		}));
	}

	let ast: unknown;
	try {
		ast = parse(command, { mode: 'posix' });
	} catch {
		ast = null;
	}
	if (!ast || typeof ast !== 'object') {
		return writes.map((original) => ({
			original,
			resolvedPath: resolvePath(original.path, cwd),
			resolved: original.path !== null && !isDynamicPath(original.path),
		}));
	}

	// Walk the AST and collect writes WITH their context nodes, in order
	const cwdStack = [cwd];
	const writesWithNodes: WriteWithNode[] = [];
	collectWritesWithNodes(ast, writesWithNodes, cwdStack);

	// Deduplicate writes the same way detectPosixWrites does
	const seen = new Set<string>();
	const deduplicated = writesWithNodes.filter((wwn) => {
		const key = `${wwn.write.category}|${wwn.write.operator}|${wwn.write.path ?? 'null'}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	// Build a map from WriteTarget to its resolved path, using the context from each write
	const resolvedMap = new Map<
		string,
		{ resolvedPath: string | null; resolved: boolean }
	>();

	for (const { write, context } of deduplicated) {
		const resolvedPath = resolvePath(write.path, context);
		const resolved = write.path !== null && !isDynamicPath(write.path);
		const key = `${write.category}|${write.operator}|${write.path ?? 'null'}`;
		resolvedMap.set(key, { resolvedPath, resolved });
	}

	// Map the input writes to their resolved paths
	return writes.map((original) => {
		const key = `${original.category}|${original.operator}|${original.path ?? 'null'}`;
		const resolved = resolvedMap.get(key);
		if (resolved) {
			return {
				original,
				resolvedPath: resolved.resolvedPath,
				resolved: resolved.resolved,
			};
		}
		// Fallback: couldn't find this write in the detected set
		return {
			original,
			resolvedPath: resolvePath(original.path, cwd),
			resolved: original.path !== null && !isDynamicPath(original.path),
		};
	});
}
