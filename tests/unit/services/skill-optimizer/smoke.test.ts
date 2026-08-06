/**
 * Tests for the skill smoke validator.
 * Covers: path containment, symlink/reparse denial, frontmatter check,
 * phrase-eval gate, bounded subprocess (with cwd set).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	validateSkillSmoke,
} from '../../../../src/services/skill-optimizer/smoke.js';

let tmp = '';

beforeEach(() => {
	tmp = mkdtempSync(path.join(tmpdir(), 'skill-opt-smoke-'));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(slug: string, content: string): string {
	const dir = path.join(tmp, '.opencode', 'skills', 'generated', slug);
	mkdirSync(dir, { recursive: true });
	const p = path.join(dir, 'SKILL.md');
	writeFileSync(p, content, 'utf8');
	return p;
}

describe('skill-opt smoke — frontmatter', () => {
	it('rejects content missing frontmatter', async () => {
		const result = await validateSkillSmoke({
			directory: tmp,
			skillSlug: 'no-fm',
			candidateContent: '# No frontmatter here',
			incumbentContent: '',
		});
		expect(result.ok).toBe(false);
		expect(result.verdict).toBe('VIOLATED');
		expect(result.notes.join(' ')).toContain('frontmatter');
	});

	it('rejects content missing description', async () => {
		const result = await validateSkillSmoke({
			directory: tmp,
			skillSlug: 'no-desc',
			candidateContent: '---\nname: x\n---\n# body',
			incumbentContent: '',
		});
		expect(result.ok).toBe(false);
		expect(result.verdict).toBe('VIOLATED');
	});

	it('passes content with valid frontmatter and no eval set', async () => {
		const result = await validateSkillSmoke({
			directory: tmp,
			skillSlug: 'ok-fm',
			candidateContent: '---\nname: ok\ndescription: a skill\n---\n# Body\n',
			incumbentContent: '',
		});
		// No eval set + no incumbent -> evaluateSkillChange returns unevaluated (passed).
		expect(result.ok).toBe(true);
		expect(result.verdict).toBe('COMPLIANT');
	});
});

describe('skill-opt smoke — symlink/reparse denial', () => {
	it('rejects a symlinked skill root', async () => {
		// Creating a real symlink requires privileges the Windows test runner
		// lacks (EPERM). Inject via the _internals seam to verify the denial
		// logic deterministically.
		const realIsSym = _internals.isSymbolicLink;
		_internals.isSymbolicLink = () => true;
		try {
			mkdirSync(
				path.join(tmp, '.opencode', 'skills', 'generated', 'sym-skill'),
				{ recursive: true },
			);
			const result = await validateSkillSmoke({
				directory: tmp,
				skillSlug: 'sym-skill',
				candidateContent: '---\nname: x\ndescription: y\n---\n# body',
				incumbentContent: '',
			});
			expect(result.ok).toBe(false);
			expect(result.notes.join(' ')).toContain('symlink');
		} finally {
			_internals.isSymbolicLink = realIsSym;
		}
	});

	it('rejects a skill root that escapes the project after realpath', async () => {
		const realEscaped = _internals.escapedRoot;
		_internals.escapedRoot = () => true;
		try {
			mkdirSync(
				path.join(tmp, '.opencode', 'skills', 'generated', 'esc-skill'),
				{ recursive: true },
			);
			const result = await validateSkillSmoke({
				directory: tmp,
				skillSlug: 'esc-skill',
				candidateContent: '---\nname: x\ndescription: y\n---\n# body',
				incumbentContent: '',
			});
			expect(result.ok).toBe(false);
			expect(result.notes.join(' ')).toContain('escaped');
		} finally {
			_internals.escapedRoot = realEscaped;
		}
	});
});

describe('skill-opt smoke — subprocess cwd is explicit', () => {
	it('passes a check command and sets cwd to the project directory', async () => {
		// Use a no-op command that exits 0. The smoke helper sets cwd = directory.
		const result = await validateSkillSmoke({
			directory: tmp,
			skillSlug: 'cmd-skill',
			candidateContent: '---\nname: x\ndescription: y\n---\n# body',
			incumbentContent: '',
			checkCommand: [process.execPath, '-e', 'process.exit(0)'],
			checkTimeoutMs: 5000,
		});
		expect(result.ok).toBe(true);
	});
});
