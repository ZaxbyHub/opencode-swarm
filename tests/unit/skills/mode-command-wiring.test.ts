/**
 * Single-source-of-truth enforcement for signal-triggered skill commands.
 *
 * A "/swarm <cmd>" that drives the architect into a skill-backed mode has SEVEN
 * surfaces that must stay in sync (handler emits `[MODE: X ...]`, registry entry,
 * TUI shortcut, master /swarm description, architect `### MODE: X` section, and
 * the `.opencode` + `.claude` skill bodies). Historically these drifted: a skill
 * could exist with no command wiring (swarm-pr-feedback), or a handler could emit
 * a signal with no architect section. The shortcut/registry halves are guarded by
 * registration-parity.test.ts and registry-type.test.ts; the mirror halves by
 * skill-mirrors.test.ts. This file closes the remaining gaps:
 *
 *   1. every command handler that emits `[MODE: X ...]` has a `### MODE: X`
 *      section in architect.ts (or is an explicitly-allowlisted signal that
 *      targets a non-architect agent, e.g. ANALYZE → critic);
 *   2. every skill under .opencode/skills (other than support/propagation skills)
 *      is referenced by an architect MODE section — i.e. no orphaned skills;
 *   3. every architect skill reference resolves to an existing .opencode AND
 *      .claude file.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const architectSource = readFileSync(
	join(ROOT, 'src/agents/architect.ts'),
	'utf-8',
);

/**
 * Skills under .opencode/skills that are NOT architect MODE skills — they are
 * propagation/support skills injected into delegations, not launched as a mode.
 * They legitimately have no `### MODE:` section.
 */
const NON_COMMAND_SKILLS = new Set([
	'engineering-conventions',
	'running-tests',
	'writing-tests',
	'generated',
]);

/**
 * Mode signals emitted by command handlers that intentionally have no
 * `### MODE:` section in the architect prompt because they target a different
 * agent. ANALYZE drives the critic, not the architect.
 */
const KNOWN_SIGNAL_MODES_WITHOUT_ARCHITECT_SECTION = new Set(['ANALYZE']);

/** Command-layer files that are not mode-emitting handlers (utils/registry). */
const NON_HANDLER_COMMAND_FILES = new Set([
	'index.ts',
	'command-dispatch.ts',
	'command-names.ts',
	'conflict-registry.ts',
	'pr-ref.ts',
	'registry.ts',
	'tool-policy.ts',
]);

function collectEmittedModes(): Set<string> {
	const dir = join(ROOT, 'src/commands');
	const modes = new Set<string>();
	for (const file of readdirSync(dir)) {
		if (!file.endsWith('.ts')) continue;
		if (file.endsWith('.test.ts')) continue;
		if (NON_HANDLER_COMMAND_FILES.has(file)) continue;
		const src = readFileSync(join(dir, file), 'utf-8');
		for (const m of src.matchAll(/\[MODE:\s*([A-Z][A-Z0-9_-]*)/g)) {
			modes.add(m[1]);
		}
	}
	return modes;
}

function architectSkillSlugs(): string[] {
	return [
		...architectSource.matchAll(
			/file:\.opencode\/skills\/([^/\s`]+)\/SKILL\.md/g,
		),
	].map((m) => m[1]);
}

describe('signal-triggered command wiring parity (drift prevention)', () => {
	it('every [MODE: X] emitted by a handler has a ### MODE: X section in architect.ts', () => {
		const emitted = collectEmittedModes();
		const missing: string[] = [];
		for (const mode of emitted) {
			if (KNOWN_SIGNAL_MODES_WITHOUT_ARCHITECT_SECTION.has(mode)) continue;
			if (!architectSource.includes(`### MODE: ${mode}`)) {
				missing.push(mode);
			}
		}
		expect(
			missing,
			`Command handlers emit these MODE signals with no matching "### MODE:" section in architect.ts: ${missing.join(', ')}. Add the section (and skill) or, for a signal that targets a non-architect agent, add it to KNOWN_SIGNAL_MODES_WITHOUT_ARCHITECT_SECTION.`,
		).toEqual([]);
	});

	it('no orphaned skills: every .opencode MODE skill is referenced by architect.ts', () => {
		const skillsDir = join(ROOT, '.opencode/skills');
		const referenced = new Set(architectSkillSlugs());
		const orphans: string[] = [];
		for (const entry of readdirSync(skillsDir)) {
			if (NON_COMMAND_SKILLS.has(entry)) continue;
			const skillFile = join(skillsDir, entry, 'SKILL.md');
			if (!statSync(join(skillsDir, entry)).isDirectory()) continue;
			if (!existsSync(skillFile)) continue;
			if (!referenced.has(entry)) orphans.push(entry);
		}
		expect(
			orphans,
			`These .opencode/skills have a SKILL.md but are not loaded by any architect "### MODE:" section: ${orphans.join(', ')}. Wire a command + MODE section, or add to NON_COMMAND_SKILLS if it is a support/propagation skill.`,
		).toEqual([]);
	});

	it('every architect skill reference resolves to an existing .opencode and .claude file', () => {
		const dangling: string[] = [];
		for (const slug of new Set(architectSkillSlugs())) {
			if (!existsSync(join(ROOT, '.opencode/skills', slug, 'SKILL.md'))) {
				dangling.push(`.opencode/skills/${slug}/SKILL.md`);
			}
			if (!existsSync(join(ROOT, '.claude/skills', slug, 'SKILL.md'))) {
				dangling.push(`.claude/skills/${slug}/SKILL.md`);
			}
		}
		expect(
			dangling,
			`architect.ts references skill files that do not exist: ${dangling.join(', ')}`,
		).toEqual([]);
	});
});

describe('swarm-pr-feedback is fully wired (regression for the orphaned-skill bug)', () => {
	it('handler emits [MODE: PR_FEEDBACK] and architect has the section + skill ref', () => {
		const handler = readFileSync(
			join(ROOT, 'src/commands/pr-feedback.ts'),
			'utf-8',
		);
		expect(handler).toContain('[MODE: PR_FEEDBACK]');
		expect(architectSource).toContain('### MODE: PR_FEEDBACK');
		expect(architectSource).toContain(
			'file:.opencode/skills/swarm-pr-feedback/SKILL.md',
		);
	});

	it('is registered in the command registry and the TUI shortcut list', () => {
		const registry = readFileSync(
			join(ROOT, 'src/commands/registry.ts'),
			'utf-8',
		);
		const index = readFileSync(join(ROOT, 'src/index.ts'), 'utf-8');
		expect(registry).toContain("'pr-feedback': {");
		expect(index).toContain("'swarm-pr-feedback': {");
	});
});
