import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');

function read(relativePath: string): string {
	return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

const ONBOARDING_DOCS = [
	'README.md',
	'docs/getting-started.md',
	'docs/configuration.md',
	'docs/installation.md',
	'docs/installation-linux-docker.md',
	'docs/installation-llm-operator.md',
	'docs/examples/web-app.md',
	'docs/commands.md',
	'docs/index.md',
];

describe('onboarding documentation drift guards', () => {
	test('new-user docs do not claim architect auto-selection', () => {
		const combined = ONBOARDING_DOCS.map(read).join('\n');
		expect(combined).not.toMatch(/auto-selects? the architect/i);
		expect(combined).not.toMatch(/architect is auto-selected/i);
		expect(combined).not.toMatch(/Selects the Swarm architect as the default/i);
	});

	test('new-user model examples avoid known stale or private provider traps', () => {
		const combined = ONBOARDING_DOCS.map(read).join('\n');
		expect(combined).not.toContain('opencode/gpt-5-nano');
		expect(combined).not.toContain('opencode/trinity-large-preview-free');
		expect(combined).not.toMatch(/"model":\s*"grove-openai\//);
	});

	test('command docs avoid hard-coded stale command counts and versions', () => {
		const combined = [
			read('README.md'),
			read('docs/getting-started.md'),
			read('docs/examples/web-app.md'),
			read('docs/commands.md'),
			read('docs/index.md'),
		].join('\n');

		expect(combined).not.toMatch(/all\s+4[13]\s+[`/"]?\/swarm/i);
		expect(combined).not.toContain('v6.81.0');
		expect(combined).toContain('full command reference');
	});

	test('docs index points at the newest local release note', () => {
		const releaseNames = fs
			.readdirSync(path.join(ROOT, 'docs', 'releases'))
			.filter((name) => /^v\d+\.\d+\.\d+\.md$/.test(name))
			.sort((a, b) =>
				a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
			);
		const newest = releaseNames.at(-1);
		expect(newest).toBeDefined();

		const version = newest!.replace(/\.md$/, '');
		const index = read('docs/index.md');
		expect(index).toContain(`[${version}](releases/${newest})`);
		expect(index).toContain(
			`${version}](releases/${newest}) | Latest documented release`,
		);
	});
});
