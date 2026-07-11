import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	MAX_EXPLICIT_SKILL_REFERENCES,
	MAX_PROVENANCE_SKILL_REFERENCES_PER_TRANSFORM,
	skillPropagationGateBefore,
	skillPropagationTransformScan,
	validateExplicitSkillReferencesBefore,
} from '../../../src/hooks/skill-propagation-gate';
import { withSafeTestDir } from '../../helpers/safe-test-dir';

function writeSkill(
	directory: string,
	relativePath: string,
	audience?: string,
): void {
	const fullPath = path.join(directory, relativePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	const audienceLine = audience === undefined ? '' : `audience: ${audience}\n`;
	fs.writeFileSync(
		fullPath,
		`---\nname: ${path.basename(path.dirname(fullPath))}\n${audienceLine}description: routing regression fixture\n---\n`,
		'utf-8',
	);
}

function writeLegacySkill(directory: string, relativePath: string): void {
	const fullPath = path.join(directory, relativePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, '# Legacy repository skill\n', 'utf-8');
}

function delegation(skillField?: string) {
	return {
		tool: 'Task',
		agent: 'architect',
		sessionID: 'audience-routing-session',
		args: {
			subagent_type: 'coder',
			prompt: [
				'TASK: audience-routing',
				skillField === undefined ? '' : `SKILLS: ${skillField}`,
			]
				.filter(Boolean)
				.join('\n'),
		},
	};
}

const disabledConfig = {
	enabled: false,
	enforce: false,
	audiences: ['ragappv3'],
};

const realRealpathSync = _internals.realpathSync;
const realValidateSkillReference = _internals.validateSkillReference;
const realReadSkillMetadata = _internals.readSkillMetadata;
afterEach(() => {
	_internals.realpathSync = realRealpathSync;
	_internals.validateSkillReference = realValidateSkillReference;
	_internals.readSkillMetadata = realReadSkillMetadata;
});

describe('skill audience routing — explicit reference integrity', () => {
	test('blocks an audience-mismatched explicit SKILLS reference even when propagation is disabled', async () => {
		await withSafeTestDir(async (directory) => {
			const relative = '.opencode/skills/other/SKILL.md';
			writeSkill(directory, relative, 'other-project');

			const result = await validateExplicitSkillReferencesBefore(
				directory,
				delegation(`file:${relative}`),
				disabledConfig,
			);

			expect(result.blocked).toBe(true);
			expect(result.reason).toContain('audience');
		});
	});

	test('allows a valid matching explicit reference when propagation is disabled', async () => {
		await withSafeTestDir(async (directory) => {
			const relative = '.opencode/skills/rag-tests/SKILL.md';
			writeSkill(directory, relative, 'ragappv3');

			const result = await validateExplicitSkillReferencesBefore(
				directory,
				delegation(`file:${relative}`),
				disabledConfig,
			);

			expect(result).toEqual({
				blocked: false,
				reason: null,
				validatedSkillPaths: [relative],
			});
		});
	});

	test('allows a frontmatter-less legacy explicit reference as audience match-all', async () => {
		await withSafeTestDir(async (directory) => {
			const relative = '.opencode/skills/legacy/SKILL.md';
			writeLegacySkill(directory, relative);

			const result = await validateExplicitSkillReferencesBefore(
				directory,
				delegation(`file:${relative}`),
				disabledConfig,
			);

			expect(result).toEqual({
				blocked: false,
				reason: null,
				validatedSkillPaths: [relative],
			});
		});
	});

	test('rejects malformed frontmatter on an explicit reference', async () => {
		await withSafeTestDir(async (directory) => {
			const relative = '.opencode/skills/malformed/SKILL.md';
			const fullPath = path.join(directory, relative);
			fs.mkdirSync(path.dirname(fullPath), { recursive: true });
			fs.writeFileSync(fullPath, '---\nname: malformed\n', 'utf-8');

			const result = await validateExplicitSkillReferencesBefore(
				directory,
				delegation(`file:${relative}`),
				disabledConfig,
			);

			expect(result.blocked).toBe(true);
			expect(result.reason).toContain('frontmatter is invalid');
		});
	});

	test('reads frontmatter through the already-contained realpath', async () => {
		await withSafeTestDir(async (directory) => {
			const lexical = '.opencode/skills/lexical/SKILL.md';
			const validated = '.opencode/skills/validated/SKILL.md';
			writeSkill(directory, lexical, 'other-project');
			writeSkill(directory, validated, 'ragappv3');
			const lexicalAbsolute = path.resolve(directory, lexical);
			const validatedAbsolute = path.resolve(directory, validated);

			_internals.realpathSync = ((candidate: fs.PathLike) => {
				if (path.resolve(String(candidate)) === lexicalAbsolute) {
					return validatedAbsolute;
				}
				return realRealpathSync(candidate);
			}) as typeof fs.realpathSync;

			const result = await validateExplicitSkillReferencesBefore(
				directory,
				delegation(`file:${lexical}`),
				disabledConfig,
			);

			expect(result).toEqual({
				blocked: false,
				reason: null,
				validatedSkillPaths: [lexical],
			});
		});
	});

	test('blocks missing and traversal explicit references before delegation', async () => {
		await withSafeTestDir(async (directory) => {
			const missing = await validateExplicitSkillReferencesBefore(
				directory,
				delegation('file:.opencode/skills/missing/SKILL.md'),
				disabledConfig,
			);
			const traversal = await validateExplicitSkillReferencesBefore(
				directory,
				delegation('file:../outside/SKILL.md'),
				disabledConfig,
			);

			expect(missing.blocked).toBe(true);
			expect(traversal.blocked).toBe(true);
		});
	});

	test('does nothing for a missing SKILLS field when propagation is disabled', async () => {
		await withSafeTestDir(async (directory) => {
			const integrity = await validateExplicitSkillReferencesBefore(
				directory,
				delegation(),
				disabledConfig,
			);
			const propagation = await skillPropagationGateBefore(
				directory,
				delegation(),
				disabledConfig,
			);

			expect(integrity).toEqual({ blocked: false, reason: null });
			expect(propagation).toEqual({
				blocked: false,
				reason: null,
				recommendedSkills: undefined,
			});
		});
	});

	test('preserves the inline skill-body recovery contract', async () => {
		await withSafeTestDir(async (directory) => {
			const result = await validateExplicitSkillReferencesBefore(
				directory,
				delegation('Follow these inline rules: run the focused test first.'),
				disabledConfig,
			);

			expect(result).toEqual({
				blocked: false,
				reason: null,
				validatedSkillPaths: [],
			});
		});
	});

	test('blocks over-limit explicit lists before any filesystem validation', async () => {
		await withSafeTestDir(async (directory) => {
			let validationCalls = 0;
			_internals.validateSkillReference = ((...args) => {
				validationCalls += 1;
				return realValidateSkillReference(...args);
			}) as typeof realValidateSkillReference;
			const references = Array.from(
				{ length: MAX_EXPLICIT_SKILL_REFERENCES + 1 },
				() => 'file:.opencode/skills/example/SKILL.md',
			).join(',');

			const result = await validateExplicitSkillReferencesBefore(
				directory,
				delegation(references),
				disabledConfig,
			);

			expect(result.blocked).toBe(true);
			expect(result.reason).toContain('maximum');
			expect(validationCalls).toBe(0);
		});
	});
});

describe('skill audience routing — provenance validation bounds', () => {
	test('caps synchronous provenance validation across the whole transform', async () => {
		await withSafeTestDir(async (directory) => {
			let validationCalls = 0;
			_internals.validateSkillReference = (() => {
				validationCalls += 1;
				return { valid: false, reason: 'fixture' };
			}) as typeof realValidateSkillReference;
			const provenanceLines = Array.from(
				{ length: MAX_PROVENANCE_SKILL_REFERENCES_PER_TRANSFORM + 20 },
				(_, index) =>
					`SKILLS_USED_BY_CODER: file:.opencode/skills/skill-${index}/SKILL.md`,
			).join('\n');

			await skillPropagationTransformScan(
				directory,
				{
					messages: [
						{
							info: { role: 'assistant', agent: 'reviewer' },
							parts: [
								{
									type: 'text',
									text: `${provenanceLines}\nSKILL_COMPLIANCE: COMPLIANT`,
								},
							],
						},
					] as Parameters<typeof skillPropagationTransformScan>[1]['messages'],
				},
				'provenance-bound-session',
				disabledConfig,
			);

			expect(validationCalls).toBe(
				MAX_PROVENANCE_SKILL_REFERENCES_PER_TRANSFORM,
			);
		});
	});
});

describe('skill audience routing — automatic and companion candidates', () => {
	test('parses each discovered skill metadata once per delegation', async () => {
		await withSafeTestDir(async (directory) => {
			writeSkill(directory, '.opencode/skills/one/SKILL.md', 'ragappv3');
			writeSkill(directory, '.opencode/skills/two/SKILL.md', 'ragappv3');
			let metadataReads = 0;
			_internals.readSkillMetadata = (skillPath, root) => {
				metadataReads += 1;
				return realReadSkillMetadata(skillPath, root);
			};

			await skillPropagationGateBefore(directory, delegation(), {
				enabled: true,
				enforce: false,
				audiences: ['ragappv3'],
			});

			expect(metadataReads).toBe(2);
		});
	});

	test('recommends a frontmatter-less legacy discovered skill', async () => {
		await withSafeTestDir(async (directory) => {
			const legacy = '.opencode/skills/legacy/SKILL.md';
			writeLegacySkill(directory, legacy);

			const result = await skillPropagationGateBefore(directory, delegation(), {
				enabled: true,
				enforce: false,
				audiences: ['ragappv3'],
			});

			expect(
				result.recommendedSkills?.map((entry) => entry.skillPath),
			).toContain(legacy);
		});
	});

	test('filters mismatched discovered and companion-routed skills before recommendation', async () => {
		await withSafeTestDir(async (directory) => {
			const matching = '.opencode/skills/rag-tests/SKILL.md';
			const mismatched = '.opencode/skills/other-tests/SKILL.md';
			writeSkill(directory, matching, 'ragappv3');
			writeSkill(directory, mismatched, 'other-project');

			const routingPath = path.join(
				directory,
				'.opencode',
				'skill-routing.yaml',
			);
			fs.writeFileSync(
				routingPath,
				`routing:\n  coder:\n    - path: ${mismatched}\n`,
				'utf-8',
			);

			const result = await skillPropagationGateBefore(directory, delegation(), {
				enabled: true,
				enforce: false,
				audiences: ['ragappv3'],
			});
			const paths = result.recommendedSkills?.map((entry) => entry.skillPath);

			expect(paths).toContain(matching);
			expect(paths).not.toContain(mismatched);
		});
	});

	test('rejects malformed and realpath-escaping discovered skills before recommendation', async () => {
		await withSafeTestDir(async (directory) => {
			const matching = '.opencode/skills/rag-tests/SKILL.md';
			const malformed = '.opencode/skills/truncated/SKILL.md';
			const escaping = '.opencode/skills/escaping/SKILL.md';
			writeSkill(directory, matching, 'ragappv3');
			writeSkill(directory, escaping, 'ragappv3');
			fs.mkdirSync(path.dirname(path.join(directory, malformed)), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(directory, malformed),
				'---\nname: truncated\naudience: other-project\n',
				'utf-8',
			);

			const escapingAbsolute = path.resolve(directory, escaping);
			_internals.realpathSync = ((candidate: fs.PathLike) => {
				if (path.resolve(String(candidate)) === escapingAbsolute) {
					return path.join(path.dirname(directory), 'outside', 'SKILL.md');
				}
				return realRealpathSync(candidate);
			}) as typeof fs.realpathSync;

			const result = await skillPropagationGateBefore(directory, delegation(), {
				enabled: true,
				enforce: false,
				audiences: ['ragappv3'],
			});
			const paths = result.recommendedSkills?.map((entry) => entry.skillPath);

			expect(paths).toContain(matching);
			expect(paths).not.toContain(malformed);
			expect(paths).not.toContain(escaping);
		});
	});
});
