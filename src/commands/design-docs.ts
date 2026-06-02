/**
 * Handle /swarm design-docs command (issue #1080).
 * Sanitizes the description, parses flags, and emits a DESIGN_DOCS mode signal
 * that routes the architect into the design-doc generation/sync workflow.
 */

import { loadPluginConfigWithMeta } from '../config';

const MAX_DESC_LEN = 2000;

const USAGE = `Usage: /swarm design-docs <description> [--out <dir>] [--lang <name>] [--update]

Generate or sync language-agnostic design docs for the project under build:
  <out>/domain.md, <out>/technical-spec.md, <out>/behavior-spec.md,
  <out>/reference/{reference-impl,idiom-notes}.md, <out>/reference/traceability.json

Requires design_docs.enabled: true in opencode-swarm.json.

Examples:
  /swarm design-docs "terminal GitHub PR client"
  /swarm design-docs auth-service --lang rust
  /swarm design docs --update --out design

Flags:
  --out <dir>     output directory (default "docs")
  --lang <name>   target language for the reference/ docs (default: inferred)
  --update        sync existing docs to current code/spec instead of generating fresh`;

function sanitizeDescription(raw: string): string {
	const collapsed = raw.replace(/\s+/g, ' ').trim();
	// Strip complete [MODE: ...] blocks (have a closing bracket).
	const stripped1 = collapsed.replace(/\[\s*MODE\s*:[^\]]*\]/gi, '');
	// Strip any remaining incomplete [MODE: prefix (no closing bracket).
	// Without this, "abc [MODE: EXECUTE" would survive the first pass and be
	// interpolated into the header where the architect's mode parser could
	// pick it up as a second routing signal (privilege confusion).
	const stripped2 = stripped1.replace(/\[\s*MODE\s*:.*$/gi, '');
	const normalized = stripped2.replace(/\s+/g, ' ').trim();
	if (normalized.length <= MAX_DESC_LEN) return normalized;
	return `${normalized.slice(0, MAX_DESC_LEN)}…`;
}

/**
 * Flag values (`--out`, `--lang`) are interpolated INSIDE the `[MODE: ...]`
 * header, before the closing `]`. A value containing `]`, `[`, or whitespace
 * could close the header early and inject a second forged MODE block that the
 * architect's prompt-level parser would honor (privilege confusion). Reject any
 * value that is not a single clean token. Returns null when unsafe.
 */
function cleanFlagValue(raw: string): string | null {
	if (raw.includes('[') || raw.includes(']') || /\s/.test(raw)) return null;
	if (/\[\s*MODE\s*:/i.test(raw)) return null;
	return raw;
}

interface ParsedArgs {
	out: string;
	lang: string;
	update: boolean;
	rest: string[];
	error?: string;
}

function parseArgs(args: string[]): ParsedArgs {
	const result: ParsedArgs = {
		out: 'docs',
		lang: 'auto',
		update: false,
		rest: [],
	};

	let i = 0;
	while (i < args.length) {
		const token = args[i];

		if (token === '--out') {
			// Guard against consuming the next flag as the value (e.g. `--out --lang`).
			if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
				return { ...result, error: `Flag "${token}" requires a value` };
			}
			const value = args[++i];
			const clean = cleanFlagValue(value);
			// Reject injection chars AND path traversal / absolute paths.
			if (
				clean === null ||
				value.includes('..') ||
				value.startsWith('/') ||
				value.startsWith('\\') ||
				/^[A-Za-z]:/.test(value)
			) {
				return {
					...result,
					error: `Invalid --out value "${value}". Must be a project-relative directory with no brackets or spaces.`,
				};
			}
			const trimmed = clean.replace(/[/\\]+$/, '');
			if (!trimmed || trimmed === '.') {
				return {
					...result,
					error: `Invalid --out value "${value}". Must name a non-empty subdirectory.`,
				};
			}
			result.out = trimmed;
		} else if (token === '--lang') {
			if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
				return { ...result, error: `Flag "${token}" requires a value` };
			}
			const value = args[++i];
			const clean = cleanFlagValue(value);
			if (clean === null) {
				return {
					...result,
					error: `Invalid --lang value "${value}". Must be a single token with no brackets or spaces.`,
				};
			}
			result.lang = clean;
		} else if (token === '--update') {
			result.update = true;
		} else if (token.startsWith('--')) {
			return { ...result, error: `Unknown flag "${token}"` };
		} else {
			result.rest.push(token);
		}
		i++;
	}

	return result;
}

export async function handleDesignDocsCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseArgs(args);

	if (parsed.error) {
		return `Error: ${parsed.error}\n\n${USAGE}`;
	}

	// Opt-in gate: the docs_design agent is registered only when
	// design_docs.enabled === true. Emitting the MODE signal while disabled would
	// route the architect to dispatch an unregistered agent. Fail fast instead.
	try {
		const { config } = loadPluginConfigWithMeta(directory);
		if (config.design_docs?.enabled !== true) {
			return (
				'Error: design docs are disabled. Set `design_docs.enabled: true` in ' +
				'opencode-swarm.json to enable the docs_design agent and this command.\n\n' +
				USAGE
			);
		}
	} catch (configErr) {
		// If config cannot be loaded, fall through — the architect MODE protocol
		// also checks registration and stops if docs_design is unavailable.
		// Emit a warning so the UX is not silent (F-15 / PR #1096 follow-up).
		console.warn(
			`[design-docs] Could not read opencode-swarm.json (${String(configErr)}). ` +
				'Falling through — the architect will abort if docs_design is not registered.',
		);
	}

	const description = sanitizeDescription(parsed.rest.join(' '));

	// A description is required for a fresh generate; an --update may omit it
	// (the architect re-reads the existing docs + spec).
	if (!description && !parsed.update) {
		return USAGE;
	}

	const header = `[MODE: DESIGN_DOCS out=${parsed.out} lang=${parsed.lang} update=${parsed.update}] ${description}`;

	return header.trimEnd();
}
