#!/usr/bin/env bun
/**
 * Pending release-fragment gate (8.x `next` line).
 *
 * Enforces the fragment mandate for this branch:
 *
 *   "Every user-visible PR ships a `docs/releases/pending/<unique-slug>.md`
 *    fragment — the aggregated text is the only narrative future users
 *    will see."
 *
 * Ported from the main line's `scripts/check-pending-fragment.ts` trimmed
 * to the surface this branch wires (issue #3228): the pure classifier in
 * `scripts/user-visible-paths.ts` plus the `--print-requirement` CLI the
 * `fragment-gate.yml` workflow consumes. The workflow computes the git
 * diff and owns exit-code mapping; this script only classifies.
 *
 * Verdict line (exactly one line on stdout):
 *   required=<true|false> satisfied=<true|false>
 *
 * Exit codes (main-line contract): 0 = verdict printed and not a
 * violation; 1 = violation (`required=true satisfied=false` — a bun crash
 * also exits 1, so the WORKFLOW distinguishes crash vs violation by the
 * verdict line); 2 = usage/transport error (unusable — workflows must
 * fail closed on it, never treat it as "no fragment required").
 *
 * Transports (issue #3290 parity): `--paths-format newline|nul|jsonl`.
 *   - `nul` matches `git diff -z` output verbatim (a line-delimited
 *     transport cannot represent a path containing a newline);
 *   - `jsonl` carries one JSON-encoded path string per line (handles
 *     every character by construction);
 *   - `newline` is the legacy form kept for interactive use.
 */

import { readFileSync } from 'node:fs';
import { evaluateRequirement } from './user-visible-paths';

type PathsFormat = 'newline' | 'nul' | 'jsonl';

interface ParsedArgs {
	format: PathsFormat;
	changedFile: string | null;
	addedFile: string | null;
	addedInline: string[];
}

function usage(message: string): never {
	console.error(
		`[check-pending-fragment] ${message} (usage: --print-requirement [--paths-format newline|nul|jsonl] [--changed-file <path> | changed paths on stdin] [--added <path>]... | [--added-file <path>])`,
	);
	process.exit(2);
}

function parseFormat(value: string | undefined): PathsFormat {
	if (value === undefined) return 'newline';
	if (value === 'newline' || value === 'nul' || value === 'jsonl') return value;
	usage(`unknown --paths-format: ${value}`);
}

function decodeList(buffer: Buffer, format: PathsFormat): string[] {
	switch (format) {
		case 'nul':
			return buffer
				.toString('utf8')
				.split('\0')
				.filter((entry) => entry !== '');
		case 'jsonl':
			return buffer
				.toString('utf8')
				.split('\n')
				.filter((line) => line.trim() !== '')
				.map((line) => {
					try {
						const parsed = JSON.parse(line);
						if (typeof parsed !== 'string') {
							throw new Error('not a string');
						}
						return parsed;
					} catch {
						// A garbage line must never read as an empty list (fail
						// closed): surface it as an unusable transport error.
						usage(`--paths-format jsonl line is not a JSON string: ${line.slice(0, 80)}`);
					}
				});
		case 'newline':
		default:
			return buffer
				.toString('utf8')
				.split('\n')
				.filter((entry) => entry !== '');
	}
}

function parseArgs(args: string[]): ParsedArgs & { formatExplicit: boolean } {
	const parsed: ParsedArgs & { formatExplicit: boolean } = {
		format: 'newline',
		changedFile: null,
		addedFile: null,
		addedInline: [],
		formatExplicit: false,
	};
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === '--paths-format') {
			if (i + 1 >= args.length) usage('--paths-format requires a value');
			parsed.format = parseFormat(args[i + 1]);
			parsed.formatExplicit = true;
			i += 2;
		} else if (arg === '--changed-file') {
			if (i + 1 >= args.length) usage('--changed-file requires a value');
			if (parsed.changedFile) usage('--changed-file given twice');
			parsed.changedFile = args[i + 1];
			i += 2;
		} else if (arg === '--added-file') {
			if (i + 1 >= args.length) usage('--added-file requires a value');
			if (parsed.addedFile) usage('--added-file given twice');
			if (parsed.addedInline.length > 0) {
				usage('--added-file together with --added is a usage error (both name the ADDED list — ambiguity is refused)');
			}
			parsed.addedFile = args[i + 1];
			i += 2;
		} else if (arg === '--added') {
			if (i + 1 >= args.length) usage('--added requires a value');
			if (parsed.addedFile) {
				usage('--added together with --added-file is a usage error (both name the ADDED list — ambiguity is refused)');
			}
			parsed.addedInline.push(args[i + 1]);
			i += 2;
		} else {
			usage(`unknown argument: ${arg}`);
		}
	}
	return parsed;
}

function printRequirement(args: string[]): number {
	const parsed = parseArgs(args);
	// Fail closed when file lists are supplied without an explicit framing
	// (main-line parity): an implicit newline default would mis-decode a
	// NUL-framed list into one garbage path and read as `required=false`.
	if ((parsed.changedFile !== null || parsed.addedFile !== null) && !parsed.formatExplicit) {
		usage('--paths-format is required when a file list is supplied (an implicit framing can mis-decode the transport)');
	}
	let changedBuffer: Buffer;
	try {
		changedBuffer = parsed.changedFile
			? readFileSync(parsed.changedFile)
			: readFileSync(0); // stdin
	} catch (error) {
		console.error(`[check-pending-fragment] cannot read changed list: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	let addedBuffer: Buffer | null = null;
	if (parsed.addedFile) {
		try {
			addedBuffer = readFileSync(parsed.addedFile);
		} catch (error) {
			console.error(`[check-pending-fragment] cannot read added list: ${error instanceof Error ? error.message : String(error)}`);
			return 2;
		}
	}
	const changed = decodeList(changedBuffer, parsed.format);
	const added = addedBuffer
		? decodeList(addedBuffer, parsed.format)
		: parsed.addedInline;
	const verdict = evaluateRequirement(changed, added);
	console.log(`required=${verdict.required} satisfied=${verdict.satisfied}`);
	// Main-line contract: exit 1 on an unsatisfied requirement (the
	// workflow's verdict mapping keys on this); exit 0 for every printed
	// verdict that is not a violation; exit 2 for unusable transports.
	return verdict.required && !verdict.satisfied ? 1 : 0;
}

// Entry: only the print-requirement probe exists on this branch (the
// workflow owns diff computation and exit-code mapping).
if (process.argv[2] === '--print-requirement') {
	process.exitCode = printRequirement(process.argv.slice(3));
} else {
	usage('first argument must be --print-requirement');
}
