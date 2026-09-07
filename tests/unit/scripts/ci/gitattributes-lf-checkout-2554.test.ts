import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const ATTRIBUTES_PATH = join(REPO_ROOT, '.gitattributes');
const CI_PARSER_TEST_PATH = join(
	REPO_ROOT,
	'tests',
	'unit',
	'scripts',
	'ci',
	'ci-yml-integration.test.ts',
);
const GITATTRIBUTES_PREFIX = '* text=auto eol=lf';
const BOM_HEX = 'efbbbf';

let checkoutRoot = '';

/**
 * Run Git with an explicit working directory and bounded, non-interactive I/O.
 * Synchronous execution is intentional here: each test needs a fully
 * materialized checkout before it can inspect the resulting line endings.
 */
function runGit(args: string[], cwd: string): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: 4 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 30_000,
	});
}

function countCarriageReturns(bytes: Uint8Array): number {
	let count = 0;
	for (const byte of bytes) {
		if (byte === 0x0d) count += 1;
	}
	return count;
}

function lsFilesEol(cwd: string, paths: string[]): string[] {
	return runGit(['ls-files', '--eol', '--', ...paths], cwd)
		.trim()
		.split(/\r?\n/)
		.filter(Boolean);
}

function eolRecord(records: string[], relativePath: string): string {
	const record = records.find((line) => line.trimEnd().endsWith(relativePath));
	if (!record) throw new Error(`missing git eol record for ${relativePath}`);
	return record;
}

beforeAll(() => {
	checkoutRoot = realpathSync(
		mkdtempSync(join(realpathSync(tmpdir()), 'opencode-swarm-2554-')),
	);
	const clonePath = join(checkoutRoot, 'repo');

	// A local no-checkout clone makes the test independent of network access and
	// ensures the checkout conversion is driven by the committed attributes
	// blob, not by the source worktree's existing files.
	runGit(
		[
			'-c',
			'safe.directory=*',
			'clone',
			'--no-checkout',
			'--local',
			'--no-hardlinks',
			REPO_ROOT,
			clonePath,
		],
		REPO_ROOT,
	);
	runGit(['config', 'core.autocrlf', 'true'], clonePath);
	runGit(['checkout', '--force', '--detach', 'HEAD'], clonePath);
});

afterAll(() => {
	if (!checkoutRoot) return;
	const realTempRoot = realpathSync(tmpdir());
	if (
		dirname(checkoutRoot) !== realTempRoot ||
		!basename(checkoutRoot).startsWith('opencode-swarm-2554-')
	) {
		throw new Error(
			`refusing to remove unexpected checkout root: ${checkoutRoot}`,
		);
	}
	rmSync(checkoutRoot, { force: true, recursive: true });
});

describe('repository LF checkout contract — regression #2554', () => {
	test('AC1: committed .gitattributes starts with the wildcard rule, without a BOM', () => {
		const bytes = readFileSync(ATTRIBUTES_PATH);

		expect(bytes.subarray(0, 3).toString('hex')).not.toBe(BOM_HEX);
		expect(
			bytes
				.subarray(0, Buffer.byteLength(GITATTRIBUTES_PREFIX))
				.toString('utf8'),
		).toBe(GITATTRIBUTES_PREFIX);
	});

	test('AC2: core.autocrlf=true fresh checkout keeps workflow YAML as LF', () => {
		const workflowBytes = readFileSync(
			join(checkoutRoot, 'repo', '.github', 'workflows', 'ci.yml'),
		);
		const records = lsFilesEol(join(checkoutRoot, 'repo'), [
			'.github/workflows/ci.yml',
		]);

		expect(countCarriageReturns(workflowBytes)).toBe(0);
		expect(eolRecord(records, '.github/workflows/ci.yml')).toMatch(
			/^i\/lf\s+w\/lf\s+attr\/text=auto eol=lf\s+\.github\/workflows\/ci\.yml$/,
		);
	});

	test('AC3: explicit TypeScript, JavaScript, declaration, JSON, and Markdown LF rules remain effective', () => {
		const attributes = readFileSync(ATTRIBUTES_PATH, 'utf8').replace(
			/\r\n/g,
			'\n',
		);
		for (const rule of [
			'*.ts text eol=lf',
			'*.js text eol=lf',
			'*.d.ts text eol=lf',
			'*.json text eol=lf',
			'*.md text eol=lf',
		]) {
			expect(attributes.split('\n')).toContain(rule);
		}

		const representatives = [
			'tests/unit/scripts/ci/ci-yml-integration.test.ts',
			'scripts/swarm-model/src/ui.js',
			'src/types/bash-parser.d.ts',
			'package.json',
			'README.md',
		];
		const records = lsFilesEol(join(checkoutRoot, 'repo'), representatives);
		for (const relativePath of representatives) {
			expect(eolRecord(records, relativePath)).toMatch(
				/^i\/lf\s+w\/lf\s+attr\/text eol=lf\s+/,
			);
		}
	});

	test('AC4: existing CI parser tests retain their CRLF normalization defense', () => {
		const parserSource = readFileSync(CI_PARSER_TEST_PATH, 'utf8');
		expect(parserSource).toContain("replace(/\\r\\n/g, '\\n')");

		const syntheticCrLf = 'jobs:\r\n  quality:\r\n    steps:\r\n';
		expect(syntheticCrLf.replace(/\r\n/g, '\n')).toBe(
			'jobs:\n  quality:\n    steps:\n',
		);
	});
});
