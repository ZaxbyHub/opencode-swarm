import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_internals,
	type DriftFinding,
	detectDuplicateSlugs,
	detectPackageJsonFilesDuplicates,
} from '../../../scripts/drift-check';

function assertShape(f: DriftFinding): void {
	expect(f).toHaveProperty('category');
	expect(f).toHaveProperty('severity');
	expect(f.message).toBeString();
	expect(['error', 'warning', 'notice']).toContain(f.severity);
	expect(f.category).toBeString();
}

describe('detectPackageJsonFilesDuplicates', () => {
	test('returns 0 findings on clean real repo', () => {
		expect(detectPackageJsonFilesDuplicates()).toBeEmpty();
	});

	test('detects duplicate .opencode/skills/ entries via temp package.json', () => {
		const tmpRoot = mkdtempSync(join(tmpdir(), 'drift-pkg-'));
		try {
			writeFileSync(
				join(tmpRoot, 'package.json'),
				JSON.stringify({
					files: [
						'.opencode/skills/foo/',
						'.opencode/skills/foo/',
						'.opencode/skills/bar/',
					],
				}),
			);
			const findings = detectPackageJsonFilesDuplicates(tmpRoot);
			expect(findings).toHaveLength(1);
			expect(findings[0].severity).toBe('error');
			expect(findings[0].file).toBe('package.json');
			expect(findings[0].message).toContain('foo');
			assertShape(findings[0]);
		} finally {
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	test('returns 0 findings when no duplicates in files array', () => {
		const tmpRoot = mkdtempSync(join(tmpdir(), 'drift-pkg-'));
		try {
			writeFileSync(
				join(tmpRoot, 'package.json'),
				JSON.stringify({
					files: ['.opencode/skills/foo/', '.opencode/skills/bar/'],
				}),
			);
			expect(detectPackageJsonFilesDuplicates(tmpRoot)).toBeEmpty();
		} finally {
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	test('returns 0 findings when files array is absent', () => {
		const tmpRoot = mkdtempSync(join(tmpdir(), 'drift-pkg-'));
		try {
			writeFileSync(join(tmpRoot, 'package.json'), JSON.stringify({}));
			expect(detectPackageJsonFilesDuplicates(tmpRoot)).toBeEmpty();
		} finally {
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});

describe('detectDuplicateSlugs', () => {
	test('returns 0 findings on clean real repo', () => {
		expect(detectDuplicateSlugs()).toBeEmpty();
	});

	test('any returned finding has correct DriftFinding shape', () => {
		for (const f of detectDuplicateSlugs()) assertShape(f);
	});

	test('detects a slug duplicated across two contract arrays via _internals', () => {
		const mockContract = {
			slug: 'test-duplicate-slug',
			opencodePath: '.opencode/skills/test-duplicate-slug/SKILL.md',
			claudePath: '.claude/skills/test-duplicate-slug/SKILL.md',
			canonical: '.opencode' as const,
		};

		// Same slug appears in both mirrored and divergent arrays.
		const findings = _internals._checkDuplicateSlugsFromArrays(
			[mockContract], // mirrored
			[mockContract], // divergent
			[], // adapter
			[], // opencodeOnly
			[], // additional
		);

		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe('error');
		expect(findings[0].message).toContain('test-duplicate-slug');
		assertShape(findings[0]);
	});
});
