/**
 * Self-test for tests/helpers/speckit-fixture.ts (task 1.1, issue #1228).
 *
 * Verifies that writeSpeckitFixture correctly writes all six fixture variants
 * and that the descriptor paths resolve to files with the expected content.
 * Assertions are content-based (not just "file exists") to catch content bugs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeSpeckitFixture } from './speckit-fixture';

// ---------------------------------------------------------------------------
// Temp-dir lifecycle — mirrors effective-spec.test.ts convention
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'speckit-fixture-test-')),
	);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function readFile(absPath: string): string {
	return fs.readFileSync(absPath, 'utf-8');
}

// ---------------------------------------------------------------------------
// Variant 1 — single-explicit-fr
// ---------------------------------------------------------------------------

describe('writeSpeckitFixture — single-explicit-fr', () => {
	test('writes .specify/memory/constitution.md', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
		const constitutionPath = path.join(
			d.specifyDir,
			'memory',
			'constitution.md',
		);
		expect(fs.existsSync(constitutionPath)).toBe(true);
		expect(readFile(constitutionPath)).toContain('Spec-Kit');
	});

	test('descriptor has exactly one feature dir', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
		expect(d.featureDirs).toHaveLength(1);
		expect(d.specPaths).toHaveLength(1);
		expect(d.tasksPaths).toHaveLength(1);
	});

	test('feature dir is named 001-auth-service', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
		expect(path.basename(d.featureDirs[0]!)).toBe('001-auth-service');
	});

	test('spec.md exists and contains ## Functional Requirements section', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
		expect(fs.existsSync(d.specPaths[0]!)).toBe(true);
		expect(readFile(d.specPaths[0]!)).toContain('## Functional Requirements');
	});

	test('spec.md contains ## User Scenarios & Testing section', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
		expect(readFile(d.specPaths[0]!)).toContain('## User Scenarios & Testing');
	});

	test('spec.md contains ## Success Criteria section', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
		expect(readFile(d.specPaths[0]!)).toContain('## Success Criteria');
	});

	test('spec.md contains explicit FR-### ids in Spec-Kit bold form', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
		const content = readFile(d.specPaths[0]!);
		expect(content).toContain('**FR-001**');
		expect(content).toContain('**FR-002**');
		expect(content).toContain('**FR-003**');
	});

	test('spec.md contains obligation keywords', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
		const content = readFile(d.specPaths[0]!);
		expect(content).toMatch(/\b(MUST|SHALL|SHOULD|MAY)\b/);
	});

	test('tasks.md exists and contains a Spec-Kit task with literal [P] parallelizable marker and [US#] reference', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
		expect(fs.existsSync(d.tasksPaths[0]!)).toBe(true);
		const content = readFile(d.tasksPaths[0]!);
		expect(content).toContain('- [ ] T001');
		// [P] is the literal parallelizable flag — NOT [P1] or [P2]
		expect(content).toMatch(/- \[ \] T\d{3} \[P\] /);
		expect(content).toContain('[US1]');
	});

	test('descriptor paths are absolute and under the temp dir', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
		expect(path.isAbsolute(d.specifyDir)).toBe(true);
		expect(path.isAbsolute(d.featureDirs[0]!)).toBe(true);
		expect(d.specifyDir.startsWith(tempDir)).toBe(true);
		expect(d.featureDirs[0]!.startsWith(tempDir)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Variant 2 — single-idless-requirements
// ---------------------------------------------------------------------------

describe('writeSpeckitFixture — single-idless-requirements', () => {
	test('descriptor has exactly one feature dir', () => {
		const d = writeSpeckitFixture(tempDir, {
			variant: 'single-idless-requirements',
		});
		expect(d.featureDirs).toHaveLength(1);
	});

	test('spec.md has no FR-### ids at all (any form)', () => {
		const d = writeSpeckitFixture(tempDir, {
			variant: 'single-idless-requirements',
		});
		const content = readFile(d.specPaths[0]!);
		// There must be NO FR-### token in any form — the FR-004 synthesis path
		// depends on this variant being genuinely id-less.
		expect(content).not.toMatch(/\bFR-\d{3}\b/);
	});

	test('spec.md still contains obligation keywords (MUST/SHALL/SHOULD)', () => {
		const d = writeSpeckitFixture(tempDir, {
			variant: 'single-idless-requirements',
		});
		const content = readFile(d.specPaths[0]!);
		expect(content).toMatch(/\b(MUST|SHALL|SHOULD)\b/);
	});

	test('spec.md has all three required Spec-Kit sections', () => {
		const d = writeSpeckitFixture(tempDir, {
			variant: 'single-idless-requirements',
		});
		const content = readFile(d.specPaths[0]!);
		expect(content).toContain('## Functional Requirements');
		expect(content).toContain('## User Scenarios & Testing');
		expect(content).toContain('## Success Criteria');
	});

	test('has at least two obligation bullets so synthesis ordering can be tested', () => {
		const d = writeSpeckitFixture(tempDir, {
			variant: 'single-idless-requirements',
		});
		const content = readFile(d.specPaths[0]!);
		// Each obligation bullet starts with "- System"
		const bullets = content
			.split('\n')
			.filter((line) => /^- System\s+(MUST|SHALL|SHOULD)/.test(line));
		expect(bullets.length).toBeGreaterThanOrEqual(2);
	});
});

// ---------------------------------------------------------------------------
// Variant 3 — multi-feature
// ---------------------------------------------------------------------------

describe('writeSpeckitFixture — multi-feature', () => {
	test('descriptor has exactly two feature dirs', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'multi-feature' });
		expect(d.featureDirs).toHaveLength(2);
		expect(d.specPaths).toHaveLength(2);
		expect(d.tasksPaths).toHaveLength(2);
	});

	test('feature dirs are sorted: 001-alpha before 002-beta', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'multi-feature' });
		expect(path.basename(d.featureDirs[0]!)).toBe('001-alpha');
		expect(path.basename(d.featureDirs[1]!)).toBe('002-beta');
	});

	test('both spec.md files exist on disk', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'multi-feature' });
		expect(fs.existsSync(d.specPaths[0]!)).toBe(true);
		expect(fs.existsSync(d.specPaths[1]!)).toBe(true);
	});

	test('both features restart at FR-001 (per-feature numbering)', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'multi-feature' });
		const alphaContent = readFile(d.specPaths[0]!);
		const betaContent = readFile(d.specPaths[1]!);
		// Both contain FR-001 — this is the cross-feature collision Follow-up A must resolve
		expect(alphaContent).toContain('**FR-001**');
		expect(betaContent).toContain('**FR-001**');
	});

	test('both tasks.md files exist', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'multi-feature' });
		expect(fs.existsSync(d.tasksPaths[0]!)).toBe(true);
		expect(fs.existsSync(d.tasksPaths[1]!)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Variant 4 — empty-specify
// ---------------------------------------------------------------------------

describe('writeSpeckitFixture — empty-specify', () => {
	test('descriptor has empty feature arrays', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'empty-specify' });
		expect(d.featureDirs).toHaveLength(0);
		expect(d.specPaths).toHaveLength(0);
		expect(d.tasksPaths).toHaveLength(0);
	});

	test('.specify/memory/constitution.md is still written', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'empty-specify' });
		const constitutionPath = path.join(
			d.specifyDir,
			'memory',
			'constitution.md',
		);
		expect(fs.existsSync(constitutionPath)).toBe(true);
	});

	test('no specs/ directory is created', () => {
		writeSpeckitFixture(tempDir, { variant: 'empty-specify' });
		expect(fs.existsSync(path.join(tempDir, 'specs'))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Variant 5 — zero-fr
// ---------------------------------------------------------------------------

describe('writeSpeckitFixture — zero-fr', () => {
	test('descriptor has exactly one feature dir', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'zero-fr' });
		expect(d.featureDirs).toHaveLength(1);
	});

	test('spec.md contains ## Functional Requirements section', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'zero-fr' });
		expect(readFile(d.specPaths[0]!)).toContain('## Functional Requirements');
	});

	test('spec.md has NO **FR-###** bold ids', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'zero-fr' });
		expect(readFile(d.specPaths[0]!)).not.toMatch(/\*\*FR-\d{3}\*\*/);
	});

	test('spec.md has no plain FR-### ids either', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'zero-fr' });
		expect(readFile(d.specPaths[0]!)).not.toMatch(/\bFR-\d{3}\b/);
	});

	test('spec.md has all three required Spec-Kit headings', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'zero-fr' });
		const content = readFile(d.specPaths[0]!);
		expect(content).toContain('## Functional Requirements');
		expect(content).toContain('## User Scenarios & Testing');
		expect(content).toContain('## Success Criteria');
	});
});

// ---------------------------------------------------------------------------
// Variant 6 — malformed
// ---------------------------------------------------------------------------

describe('writeSpeckitFixture — malformed', () => {
	test('descriptor has exactly one feature dir', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'malformed' });
		expect(d.featureDirs).toHaveLength(1);
	});

	test('spec.md has a valid FR requirement (so it is not a zero-fr)', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'malformed' });
		expect(readFile(d.specPaths[0]!)).toContain('**FR-001**');
	});

	test('spec.md is MISSING the ## Success Criteria section', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'malformed' });
		expect(readFile(d.specPaths[0]!)).not.toContain('## Success Criteria');
	});

	test('spec.md still has ## Functional Requirements and ## User Scenarios & Testing', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'malformed' });
		const content = readFile(d.specPaths[0]!);
		expect(content).toContain('## Functional Requirements');
		expect(content).toContain('## User Scenarios & Testing');
	});

	test('tasks.md contains a task with NO [US#] reference (T001) — T001 keeps [P] so validator must key on missing story reference specifically', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'malformed' });
		const content = readFile(d.tasksPaths[0]!);
		// T001 has [P] (parallelizable flag) but deliberately has no [US#] reference
		const t001Line = content.split('\n').find((l) => l.includes('T001'));
		expect(t001Line).toBeDefined();
		expect(t001Line).toContain('[P]'); // has the parallelizable flag
		expect(t001Line).not.toMatch(/\[US\d+\]/); // but no story/requirement reference
	});

	test('tasks.md contains a valid task (T002) to distinguish which is flagged', () => {
		const d = writeSpeckitFixture(tempDir, { variant: 'malformed' });
		const content = readFile(d.tasksPaths[0]!);
		const t002Line = content.split('\n').find((l) => l.includes('T002'));
		expect(t002Line).toBeDefined();
		expect(t002Line).toMatch(/\[US\d+\]/);
	});
});

// ---------------------------------------------------------------------------
// Cross-variant invariants
// ---------------------------------------------------------------------------

describe('writeSpeckitFixture — cross-variant invariants', () => {
	const variants = [
		'single-explicit-fr',
		'single-idless-requirements',
		'multi-feature',
		'empty-specify',
		'zero-fr',
		'malformed',
	] as const;

	for (const variant of variants) {
		test(`variant "${variant}" — .specify/ is always written`, () => {
			const d = writeSpeckitFixture(tempDir, { variant });
			expect(fs.existsSync(d.specifyDir)).toBe(true);
			expect(
				fs.existsSync(path.join(d.specifyDir, 'memory', 'constitution.md')),
			).toBe(true);
		});

		test(`variant "${variant}" — descriptor paths are absolute`, () => {
			const d = writeSpeckitFixture(tempDir, { variant });
			expect(path.isAbsolute(d.specifyDir)).toBe(true);
			for (const p of [...d.featureDirs, ...d.specPaths, ...d.tasksPaths]) {
				expect(path.isAbsolute(p)).toBe(true);
			}
		});

		test(`variant "${variant}" — all descriptor paths are under tempDir`, () => {
			const d = writeSpeckitFixture(tempDir, { variant });
			const allPaths = [
				d.specifyDir,
				...d.featureDirs,
				...d.specPaths,
				...d.tasksPaths,
			];
			for (const p of allPaths) {
				expect(p.startsWith(tempDir)).toBe(true);
			}
		});

		test(`variant "${variant}" — featureDirs, specPaths, tasksPaths have equal length`, () => {
			const d = writeSpeckitFixture(tempDir, { variant });
			expect(d.specPaths.length).toBe(d.featureDirs.length);
			expect(d.tasksPaths.length).toBe(d.featureDirs.length);
		});
	}
});
