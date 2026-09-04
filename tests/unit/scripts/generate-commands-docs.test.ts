import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	buildCommandsDoc,
	COMMANDS_DOC_RELATIVE_PATH,
	checkCommandsDoc,
	HIDDEN_COMMAND_KEYS,
} from '../../../scripts/generate-commands-docs';
import type { CommandEntry } from '../../../src/commands/registry';
import { COMMAND_REGISTRY } from '../../../src/commands/registry';

/**
 * Issue #2493 obligation 4 (source #1648) — docs/commands.md is generated
 * from COMMAND_REGISTRY by scripts/generate-commands-docs.ts. These tests are
 * the merge-blocking drift gate: the committed page must match regeneration
 * byte-for-byte, hidden compatibility aliases must stay out of the reference,
 * the human-only escape hatches must stay documented, and the turbo entry
 * must carry the full six-keyword argument set the registry declares.
 */

const DOC_PATH = join(import.meta.dir, '../../../', COMMANDS_DOC_RELATIVE_PATH);

function committedDoc(): string {
	return readFileSync(DOC_PATH, 'utf-8').replace(/\r\n/g, '\n');
}

/** All ``### /swarm <key>`` command headings in the document. */
function topLevelCommandHeadings(doc: string): Set<string> {
	const headings = new Set<string>();
	for (const match of doc.matchAll(/^### `\/swarm (.+)`$/gm)) {
		headings.add(match[1]);
	}
	return headings;
}

/** The body of one command entry: from its `###` heading to the next heading. */
function entrySection(doc: string, key: string): string {
	const heading = `### \`/swarm ${key}\`\n`;
	const start = doc.indexOf(heading);
	if (start === -1) {
		throw new Error(`expected heading "${heading.trim()}" in generated doc`);
	}
	const body = doc.slice(start + heading.length);
	const nextHeading = body.search(/^#{2,4} /m);
	return nextHeading === -1 ? body : body.slice(0, nextHeading);
}

describe('generate-commands-docs — drift gate', () => {
	test('committed docs/commands.md matches regeneration byte-for-byte (CRLF-normalized)', () => {
		expect(committedDoc()).toBe(buildCommandsDoc());
	});

	test('checkCommandsDoc passes on the committed doc and pinpoints drift on tampered content', () => {
		const committed = readFileSync(DOC_PATH, 'utf-8');
		expect(checkCommandsDoc(committed).ok).toBe(true);

		const tampered = `${buildCommandsDoc()}\nstale trailing line\n`;
		const result = checkCommandsDoc(tampered);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('stale');
		expect(result.message).toContain('first divergence at line');
		expect(result.message).toContain(
			'bun run scripts/generate-commands-docs.ts --write',
		);
	});

	test('generation is deterministic', () => {
		expect(buildCommandsDoc()).toBe(buildCommandsDoc());
	});
});

describe('generate-commands-docs — escape hatches (#2493 obligation 4)', () => {
	test('abort-pr-workflow and approve-plan-critic are documented in a dedicated Escape Hatches section', () => {
		const doc = buildCommandsDoc();
		const sectionStart = doc.indexOf('## Escape Hatches');
		expect(sectionStart).toBeGreaterThanOrEqual(0);
		const sectionEnd = doc.indexOf('\n## ', sectionStart + 1);
		const section = doc.slice(
			sectionStart,
			sectionEnd === -1 ? undefined : sectionEnd,
		);
		expect(section).toContain('### `/swarm abort-pr-workflow`');
		expect(section).toContain('### `/swarm approve-plan-critic`');
	});

	test('escape hatch entries state they are human-only restricted commands', () => {
		const doc = buildCommandsDoc();
		for (const key of ['abort-pr-workflow', 'approve-plan-critic']) {
			const section = entrySection(doc, key);
			expect(section, `escape hatch ${key}`).toContain(
				'Human-only restricted command.',
			);
			// Registry accuracy anchor: both must stay toolPolicy 'restricted'.
			const registryEntry = COMMAND_REGISTRY[
				key as keyof typeof COMMAND_REGISTRY
			] as CommandEntry;
			expect(registryEntry.toolPolicy).toBe('restricted');
		}
	});
});

describe('generate-commands-docs — hidden compatibility aliases', () => {
	test('no hidden alias appears as a "### `/swarm <key>`" heading', () => {
		const headings = topLevelCommandHeadings(buildCommandsDoc());
		const leaked = HIDDEN_COMMAND_KEYS.filter((key) => headings.has(key));
		expect(leaked, 'hidden keys that leaked into headings').toEqual([]);
	});

	test('every HIDDEN_COMMAND_KEYS entry exists in the registry (no stale hidden list)', () => {
		for (const key of HIDDEN_COMMAND_KEYS) {
			expect(
				Object.hasOwn(COMMAND_REGISTRY, key),
				`hidden key "${key}" must exist in COMMAND_REGISTRY`,
			).toBe(true);
		}
	});
});

describe('generate-commands-docs — registry coverage', () => {
	test('every non-hidden, non-subcommand registry key appears as a heading', () => {
		const headings = topLevelCommandHeadings(buildCommandsDoc());
		const missing: string[] = [];
		for (const [key, raw] of Object.entries(COMMAND_REGISTRY)) {
			const cmd = raw as CommandEntry;
			if (HIDDEN_COMMAND_KEYS.includes(key)) continue;
			if (cmd.subcommandOf) continue;
			if (!headings.has(key)) missing.push(key);
		}
		expect(missing, 'registry keys missing a "### `/swarm`" heading').toEqual(
			[],
		);
	});

	test('no command heading is rendered twice', () => {
		const matches = [
			...buildCommandsDoc().matchAll(/^### `\/swarm (.+)`$/gm),
		].map((m) => m[1]);
		expect(new Set(matches).size).toBe(matches.length);
	});
});

describe('generate-commands-docs — turbo argument drift (#1648)', () => {
	test('turbo entry documents all six argument keywords (on/off/lean/standard/epic/status)', () => {
		const doc = buildCommandsDoc();
		const section = entrySection(doc, 'turbo');
		// Exact rendered Args line — the live drift #1648 caught was the docs
		// claiming only [on|off] while the registry declares all six keywords.
		expect(section).toContain(
			'**Args:** `on, off, lean, standard, epic, status`',
		);
		expect(section).toContain('[on|off|lean|standard|epic|status]');
	});
});
