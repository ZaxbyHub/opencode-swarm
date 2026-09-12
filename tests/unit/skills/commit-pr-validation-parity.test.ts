/**
 * commit-pr validation parity (issue #2131 finding 4c).
 *
 * The list of validation commands the commit-pr skill teaches is DERIVED from
 * the blocking CI workflow rather than frozen here: this test parses the
 * `quality` job of `.github/workflows/ci.yml`, maps each blocking quality
 * command to the string the skill must contain, and fails when CI grows a
 * quality step the skill does not teach (or whose mapping is missing). The
 * mapping is explicit so a rename in CI produces a loud, actionable failure
 * instead of silent drift behind blocking CI.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMMIT_PR_SKILL_PATH = join(
	import.meta.dir,
	'../../../.claude/skills/commit-pr/SKILL.md',
);
const CI_WORKFLOW_PATH = join(
	import.meta.dir,
	'../../../.github/workflows/ci.yml',
);

/**
 * CI quality-job command → the string the commit-pr SKILL.md must contain.
 * When CI adds or renames a quality step, update BOTH the skill and this
 * mapping in the same PR — that is the reconciliation mechanism.
 */
const CI_COMMAND_TO_SKILL_STRING: Record<string, string> = {
	'if [[ "${{ needs.detect-release.result }}" != "success" || "${{ needs.release-owner-guard.result }}" != "success" ]]; then && echo "::error::required dependency failed: detect-release=${{ needs.detect-release.result }}, release-owner-guard=${{ needs.release-owner-guard.result }}" && exit 1 && fi':
		'if [[ "${{ needs.detect-release.result }}" != "success" || "${{ needs.release-owner-guard.result }}" != "success" ]]; then',
	'bun run typecheck': 'bun run typecheck',
	'bunx biome ci .': 'bun run lint:ci',
	'bun run scripts/check-tool-registration.ts':
		'bun run scripts/check-tool-registration.ts',
	'bun run check:runtime-src-refs': 'bun run check:runtime-src-refs',
	'bun run check:events': 'bun run check:events',
	'bun run check:retention': 'bun run check:retention',
	'bun run check:registry-citations': 'bun run check:registry-citations',
	'bun run check:core-events': 'bun run check:core-events',
	'bun run check:shell-audit': 'bun run check:shell-audit',
	'bun run check:trajectory-store': 'bun run check:trajectory-store',
	'bun run check:mock-cleanup': 'bun run check:mock-cleanup',
	'bun run check:invariants': 'bun run check:invariants',
	'bun run check:cross-contamination': 'bun run check:cross-contamination',
	'bun run check:test-clock': 'bun run check:test-clock',
	'bun run check:test-tmpdir': 'bun run check:test-tmpdir',
	'bun run check:bash-portability': 'bun run check:bash-portability',
	'bun run check:test-file-cap': 'bun run check:test-file-cap',
	'bun run check:pending-fragment': 'bun run check:pending-fragment',
	'bun run check:gate-portability': 'bun run check:gate-portability',
	'bun run check:bare-spawn': 'bun run check:bare-spawn',
	'bun run check:error-channel-discard': 'bun run check:error-channel-discard',
	'bun run check:path-identity': 'bun run check:path-identity',
	'bun run check:token-formula': 'bun run check:token-formula',
	'cd scripts/swarm-model && node --test':
		'(cd scripts/swarm-model && node --test)',
};

/** Environment-setup commands in the quality job that are not quality gates. */
const NON_QUALITY_SETUP_COMMANDS = new Set(['bun install --frozen-lockfile']);

/** YAML block-scalar indicators are syntax, not shell commands. */
const YAML_BLOCK_SCALAR_MARKER = /^[|>][+-]?$/;

/** Extract the `run:` commands of the CI `quality` job. */
function qualityJobCommands(
	workflow = readFileSync(CI_WORKFLOW_PATH, 'utf-8'),
): string[] {
	const qualityStart = workflow.indexOf('  quality:');
	if (qualityStart === -1) {
		throw new Error('CI workflow no longer defines a quality job');
	}
	// The next TOP-LEVEL job key (exactly two spaces of indent).
	const nextJobMatch = /\n {2}[a-z][a-z0-9-]*:/.exec(
		workflow.slice(qualityStart + 10),
	);
	const jobBlock = workflow.slice(
		qualityStart,
		nextJobMatch ? qualityStart + 10 + nextJobMatch.index : undefined,
	);
	const commands: string[] = [];
	const lines = jobBlock.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index].match(/^(\s+)run:\s*(.+)$/);
		if (!match) continue;
		let command = match[2].trim();
		if (YAML_BLOCK_SCALAR_MARKER.test(command)) {
			const runIndent = match[1].length;
			const body: string[] = [];
			while (index + 1 < lines.length) {
				const next = lines[index + 1];
				if (next.trim() !== '' && next.match(/^\s*/)?.[0].length <= runIndent) {
					break;
				}
				index += 1;
				if (next.trim() !== '') body.push(next.trim());
			}
			command = body.join(' && ');
		}
		command = command.replace(/^["']|["']$/g, '');
		// Normalize the `chmod +x X && bash X` wrapper to the bare script call.
		command = command.replace(/^chmod \+x \S+ && /, '');
		if (NON_QUALITY_SETUP_COMMANDS.has(command)) continue;
		if (YAML_BLOCK_SCALAR_MARKER.test(command)) continue;
		commands.push(command);
	}
	return commands;
}

describe('commit-pr validation suite parity (issue #2131 4c)', () => {
	test('every blocking CI quality command is taught by the commit-pr skill', () => {
		const skill = readFileSync(COMMIT_PR_SKILL_PATH, 'utf-8');
		const commands = qualityJobCommands();
		expect(commands.length).toBeGreaterThanOrEqual(
			Object.keys(CI_COMMAND_TO_SKILL_STRING).length,
		);
		for (const command of commands) {
			const skillString = CI_COMMAND_TO_SKILL_STRING[command];
			if (skillString === undefined) {
				throw new Error(
					`CI quality job gained the command "${command}" with no skill parity mapping. Add it to .claude/skills/commit-pr/SKILL.md Tier 1 AND to CI_COMMAND_TO_SKILL_STRING in this test (issue #2131 finding 4c).`,
				);
			}
			expect(skill).toContain(skillString);
		}
	});

	test('the skill also teaches the package smoke check (package-check CI job)', () => {
		const skill = readFileSync(COMMIT_PR_SKILL_PATH, 'utf-8');
		expect(skill).toContain('bun run package:smoke');
	});

	test('indented YAML block-scalar run bodies remain in the parity surface', () => {
		const source = readFileSync(CI_WORKFLOW_PATH, 'utf-8');
		const blockScalar = source.replace(
			'run: cd scripts/swarm-model && node --test',
			'run: |\n          cd scripts/swarm-model\n          node --test',
		);
		expect(blockScalar).not.toBe(source);
		expect(qualityJobCommands(blockScalar)).toContain(
			'cd scripts/swarm-model && node --test',
		);
	});

	test('the skill never broad-deletes evidence JSON (issue #2131 4a)', () => {
		const skill = readFileSync(COMMIT_PR_SKILL_PATH, 'utf-8');
		expect(skill).not.toContain('rm -f .swarm/evidence/*.json');
		expect(skill).toContain('publication-evidence.json');
	});
});
