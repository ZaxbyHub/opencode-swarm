import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const CI_YML_PATH = join(REPO_ROOT, '.github/workflows/ci.yml');

// Every top-level tests/ directory that currently contains test files must be
// listed here with the job that owns it. Adding a new test tree without a
// corresponding CI owner is an orphaned-corpus regression (issue #2552).
const TEST_DIRECTORY_OWNERS: Record<
	string,
	'unit' | 'integration' | 'security' | 'smoke'
> = {
	adversarial: 'unit',
	architect: 'unit',
	helpers: 'unit',
	integration: 'integration',
	security: 'security',
	smoke: 'smoke',
	tools: 'unit',
	unit: 'unit',
};

function readCiWorkflow(): string {
	return readFileSync(CI_YML_PATH, 'utf8').replace(/\r\n/g, '\n');
}

function extractJob(yml: string, job: string): string {
	const match = yml.match(
		new RegExp(
			`^ {2}${job}:[\\s\\S]*?(?=^ {2}[A-Za-z][\\w-]*:|(?![\\s\\S]))`,
			'm',
		),
	);
	return match ? match[0] : '';
}

function extractStep(yml: string, name: string): string {
	const match = yml.match(
		new RegExp(
			`^ {6}- name: ${name}[\\s\\S]*?(?=^ {6}- name:|^ {2}[A-Za-z][\\w-]*:|(?![\\s\\S]))`,
			'm',
		),
	);
	return match ? match[0] : '';
}

function hasTestFile(directory: string): boolean {
	return readdirSync(directory, { withFileTypes: true }).some((entry) => {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) return hasTestFile(entryPath);
		return entry.isFile() && entry.name.endsWith('.test.ts');
	});
}

function topLevelTestDirectories(): string[] {
	return readdirSync(join(REPO_ROOT, 'tests'), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.filter((entry) => hasTestFile(join(REPO_ROOT, 'tests', entry.name)))
		.map((entry) => entry.name)
		.sort();
}

describe('CI gate policy — Stage-D discovery anchors (issue #2552)', () => {
	const yml = readCiWorkflow();

	test('every populated top-level tests/ directory has a known CI owner or exemption', () => {
		const populatedDirectories = topLevelTestDirectories();
		const missingOwners = populatedDirectories.filter(
			(directory) => !(directory in TEST_DIRECTORY_OWNERS),
		);

		expect(missingOwners).toEqual([]);
		expect(populatedDirectories).toEqual(
			Object.keys(TEST_DIRECTORY_OWNERS).sort(),
		);
	});

	test('the owner map is backed by anchored workflow discovery commands', () => {
		const unitCollection = extractStep(yml, 'Collect and partition test files');
		const ownerSections = {
			unit: unitCollection,
			integration: extractJob(yml, 'integration'),
			security: extractJob(yml, 'security'),
			smoke: extractJob(yml, 'smoke'),
		};

		expect(unitCollection).toContain(
			"find tests/unit tests/adversarial tests/architect tests/cli tests/tools tests/helpers -name '*.test.ts' -type f",
		);
		expect(ownerSections.integration).toContain(
			"find tests/integration test -name '*.test.ts' -type f",
		);
		expect(ownerSections.security).toContain(
			'run: bun test tests/security --timeout 120000',
		);
		expect(ownerSections.smoke).toContain(
			'run: bun test tests/smoke --timeout 120000',
		);

		for (const owner of Object.values(TEST_DIRECTORY_OWNERS)) {
			expect(ownerSections[owner].length).toBeGreaterThan(0);
		}
	});

	test('unit-passed remains the required aggregate and concurrency stays non-cancelling', () => {
		const unitPassed = extractJob(yml, 'unit-passed');
		const concurrency =
			yml.match(/^concurrency:[\s\S]*?(?=^permissions:)/m)?.[0] ?? '';

		expect(unitPassed).toContain('needs: [unit]');
		expect(unitPassed).toContain('if: always()');
		expect(unitPassed).toContain('UNIT_RESULT: ${{ needs.unit.result }}');
		expect(concurrency).toContain('cancel-in-progress: false');
		expect(concurrency).not.toMatch(/cancel-in-progress:\s*true/);
	});
});
