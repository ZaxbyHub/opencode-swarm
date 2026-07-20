#!/usr/bin/env bun
/**
 * Sync the canonical QA-gate dialogue body into the three MODE skills.
 *
 * Reads `references/qa-gate-gates-body.md` and replaces the content between
 * `<!-- BEGIN QA_GATE_BODY -->` and `<!-- END QA_GATE_BODY -->` markers in each
 * of the 6 mirror files (3 MODE skills × 2 mirror trees). Writes both mirrors
 * byte-identical. Errors if a marker is missing. Idempotent.
 *
 * Usage:
 *   bun run scripts/sync-qa-gate-skills.ts
 */

import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

const BEGIN_MARKER = "<!-- BEGIN QA_GATE_BODY -->";
const END_MARKER = "<!-- END QA_GATE_BODY -->";

const SKILL_PAIRS = [
	{ name: "brainstorm", paths: [".claude/skills/brainstorm/SKILL.md", ".opencode/skills/brainstorm/SKILL.md"] },
	{ name: "specify", paths: [".claude/skills/specify/SKILL.md", ".opencode/skills/specify/SKILL.md"] },
	{ name: "plan", paths: [".claude/skills/plan/SKILL.md", ".opencode/skills/plan/SKILL.md"] },
] as const;

async function readBody(repoRoot: string): Promise<string> {
	const bodyPath = path.join(repoRoot, "references", "qa-gate-gates-body.md");
	const raw = await readFile(bodyPath, "utf-8");
	// Strip a single trailing newline so the inlined block has clean boundaries.
	return raw.replace(/\n$/, "");
}

function replaceMarkerBlock(content: string, body: string): string {
	if (!content.includes(BEGIN_MARKER) || !content.includes(END_MARKER)) {
		throw new Error(
			`Missing QA_GATE_BODY markers. Both ${BEGIN_MARKER} and ${END_MARKER} must appear in the file.`,
		);
	}
	const replacement = `${BEGIN_MARKER}\n\n${body}\n\n${END_MARKER}`;
	const re = new RegExp(`${BEGIN_MARKER}[\\s\\S]*?${END_MARKER}`, "g");
	return content.replace(re, replacement);
}

async function processFile(skillPath: string, body: string, repoRoot: string): Promise<string> {
	const absPath = path.join(repoRoot, skillPath);
	const before = await readFile(absPath, "utf-8");
	const after = replaceMarkerBlock(before, body);
	if (after === before) {
		// Idempotent: nothing changed.
		return before;
	}
	await writeFile(absPath, after, "utf-8");
	return after;
}

function bytesAreIdentical(a: string, b: string): boolean {
	return a === b;
}

async function main(): Promise<void> {
	const repoRoot = process.cwd();
	const body = await readBody(repoRoot);

	for (const pair of SKILL_PAIRS) {
		const rendered = await Promise.all(
			pair.paths.map((p) => processFile(p, body, repoRoot)),
		);
		if (!bytesAreIdentical(rendered[0], rendered[1])) {
			throw new Error(
				`Mirror files for ${pair.name} diverged after sync: ${pair.paths[0]} vs ${pair.paths[1]}. Edit them by hand to restore byte-identity, then re-run.`,
			);
		}
		console.log(`[sync-qa-gate-skills] synced ${pair.name} (${pair.paths.length} mirror files)`);
	}
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[sync-qa-gate-skills] ${message}`);
	process.exit(1);
});
