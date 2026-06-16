import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	appendRejectedSkillEdit,
	evaluateSkillChange,
	isRejectedSkillContent,
	rejectedEditsPath,
} from '../../../src/services/skill-evaluator';

let tmp: string;
const itSymlink = process.platform === 'win32' ? it.skip : it;

beforeEach(() => {
	tmp = mkdtempSync(path.join(tmpdir(), 'skill-evaluator-'));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeEval(slug: string, name: string, body: unknown): void {
	const dir = path.join(tmp, '.swarm', 'skills', 'evals', slug);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, name), JSON.stringify(body), 'utf-8');
}

describe('evaluateSkillChange', () => {
	it('passes unevaluated when no eval set exists', async () => {
		const result = await evaluateSkillChange({
			directory: tmp,
			slug: 'missing-evals',
			candidateContent: '# Candidate',
			operation: 'test',
		});

		expect(result.passed).toBe(true);
		expect(result.status).toBe('unevaluated');
		expect(result.reason).toContain('no eval set');
	});

	it('passes a new skill only when every eval case is satisfied', async () => {
		writeEval('scope-skill', 'cases.json', {
			cases: [
				{
					id: 'required',
					required_phrases: ['call declare_scope'],
					forbidden_phrases: ['skip scope declaration'],
				},
			],
		});

		const result = await evaluateSkillChange({
			directory: tmp,
			slug: 'scope-skill',
			candidateContent: 'Required Procedure: call declare_scope before work.',
			operation: 'test',
		});

		expect(result.passed).toBe(true);
		expect(result.status).toBe('passed');
		expect(result.caseCount).toBe(1);
		expect(result.candidateScore).toBe(1);
	});

	it('rejects a candidate that contains a forbidden phrase (score zeroed)', async () => {
		writeEval('forbidden-skill', 'cases.json', {
			cases: [
				{
					id: 'no-forbidden',
					required_phrases: ['call declare_scope'],
					forbidden_phrases: ['skip scope declaration'],
				},
			],
		});

		const result = await evaluateSkillChange({
			directory: tmp,
			slug: 'forbidden-skill',
			candidateContent:
				'Required Procedure: call declare_scope. But skip scope declaration.',
			operation: 'test',
		});

		expect(result.passed).toBe(false);
		expect(result.status).toBe('rejected');
	});

	it('rejects an incumbent rewrite that is not a strict improvement', async () => {
		writeEval('scope-skill', 'cases.json', {
			required_phrases: ['call declare_scope'],
		});

		const result = await evaluateSkillChange({
			directory: tmp,
			slug: 'scope-skill',
			candidateContent: 'call declare_scope',
			incumbentContent: 'call declare_scope',
			operation: 'skill_regenerate',
		});

		expect(result.passed).toBe(false);
		expect(result.status).toBe('rejected');
		expect(result.reason).toContain('strictly improve');
	});

	it('rejects aggregate improvements that regress an individual eval case', async () => {
		writeEval('scope-skill', 'cases.json', {
			cases: [
				{
					id: 'preserve-existing',
					required_phrases: ['preserve alpha', 'preserve beta'],
				},
				{
					id: 'add-new',
					required_phrases: ['add gamma', 'add delta'],
				},
			],
		});

		const result = await evaluateSkillChange({
			directory: tmp,
			slug: 'scope-skill',
			candidateContent: 'preserve alpha. add gamma. add delta.',
			incumbentContent: 'preserve alpha. preserve beta.',
			operation: 'skill_regenerate',
		});

		expect(result.passed).toBe(false);
		expect(result.status).toBe('rejected');
		const regressed = result.caseResults.find(
			(entry) => entry.id === 'preserve-existing',
		);
		expect(regressed!.candidateScore).toBeLessThan(regressed!.incumbentScore);
	});

	it('records rejected edits in a bounded JSONL buffer', async () => {
		writeEval('scope-skill', 'cases.json', {
			required_phrases: ['call declare_scope'],
		});
		const req = {
			directory: tmp,
			slug: 'scope-skill',
			candidateContent: 'missing the rule',
			incumbentContent: 'call declare_scope',
			operation: 'skill_regenerate',
		};
		const result = await evaluateSkillChange(req);

		await appendRejectedSkillEdit(req, result);

		const file = rejectedEditsPath(tmp);
		expect(existsSync(file)).toBe(true);
		const record = JSON.parse(readFileSync(file, 'utf-8').trim());
		expect(record.slug).toBe('scope-skill');
		expect(record.operation).toBe('skill_regenerate');
		expect(record.candidateHash).toBeString();
		expect(record.candidateNormalizedHash).toBeString();
		expect(record.evalFiles[0]).toContain(
			'.swarm/skills/evals/scope-skill/cases.json',
		);
	});

	it('detects previously rejected equivalent content by normalized hash', async () => {
		writeEval('scope-skill', 'cases.json', {
			required_phrases: ['call declare_scope'],
		});
		const req = {
			directory: tmp,
			slug: 'scope-skill',
			candidateContent: 'Missing   the\nrule',
			incumbentContent: 'call declare_scope',
			operation: 'skill_regenerate',
		};
		const result = await evaluateSkillChange(req);
		await appendRejectedSkillEdit(req, result);

		await expect(
			isRejectedSkillContent(tmp, 'scope-skill', 'missing the rule'),
		).resolves.toBe(true);
		await expect(
			isRejectedSkillContent(tmp, 'other-skill', 'missing the rule'),
		).resolves.toBe(false);
	});

	it('fails closed on malformed eval fixtures', async () => {
		const dir = path.join(tmp, '.swarm', 'skills', 'evals', 'bad-skill');
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'bad.json'), '{not-json', 'utf-8');

		const result = await evaluateSkillChange({
			directory: tmp,
			slug: 'bad-skill',
			candidateContent: '# Candidate',
			operation: 'test',
		});

		expect(result.passed).toBe(false);
		expect(result.status).toBe('invalid_eval_set');
	});

	it('fails closed when an eval fixture exceeds 64KB', async () => {
		const dir = path.join(tmp, '.swarm', 'skills', 'evals', 'oversized-skill');
		mkdirSync(dir, { recursive: true });
		const largePhrase = 'x'.repeat(70 * 1024);
		writeFileSync(
			path.join(dir, 'large.json'),
			JSON.stringify({
				cases: [
					{
						id: 'oversized',
						required_phrases: [largePhrase],
					},
				],
			}),
			'utf-8',
		);

		const result = await evaluateSkillChange({
			directory: tmp,
			slug: 'oversized-skill',
			candidateContent: '# Candidate',
			operation: 'test',
		});

		expect(result.passed).toBe(false);
		expect(result.status).toBe('invalid_eval_set');
	});

	itSymlink(
		'fails closed when an eval fixture symlink escapes the eval root',
		async () => {
			const dir = path.join(tmp, '.swarm', 'skills', 'evals', 'linked-skill');
			mkdirSync(dir, { recursive: true });
			const outside = path.join(tmp, 'outside-case.json');
			writeFileSync(
				outside,
				JSON.stringify({ required_phrases: ['outside phrase'] }),
				'utf-8',
			);
			symlinkSync(outside, path.join(dir, 'case.json'), 'file');

			const result = await evaluateSkillChange({
				directory: tmp,
				slug: 'linked-skill',
				candidateContent: 'outside phrase',
				operation: 'test',
			});

			expect(result.passed).toBe(false);
			expect(result.status).toBe('invalid_eval_set');
			expect(result.reason).toContain('escaped root');
		},
	);
});
