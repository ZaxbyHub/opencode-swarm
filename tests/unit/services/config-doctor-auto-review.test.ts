import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPluginConfig } from '../../../src/config/loader';
import { runConfigDoctor } from '../../../src/services/config-doctor';

let projectDir: string;
let xdgDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
	projectDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-auto-review-')),
	);
	xdgDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-auto-review-xdg-')),
	);
	originalXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = xdgDir;
	fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdg;
	fs.rmSync(projectDir, { recursive: true, force: true });
	fs.rmSync(xdgDir, { recursive: true, force: true });
});

function writeAutoReview(auto_review: unknown): void {
	fs.writeFileSync(
		path.join(projectDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ auto_review }),
		'utf8',
	);
}

describe('config doctor auto-review compatibility', () => {
	test('reports gate mode without structured findings', () => {
		writeAutoReview({
			enabled: true,
			structured_findings: false,
			final_review: { mode: 'gate' },
		});
		const result = runConfigDoctor(loadPluginConfig(projectDir), projectDir);
		const finding = result.findings.find(
			(item) => item.id === 'invalid-auto-review-gate-compatibility',
		);
		expect(finding?.severity).toBe('error');
		expect(finding?.path).toBe('auto_review.structured_findings');
		expect(finding?.description).toContain('requires');
	});

	test('does not report compatible advisory or structured gate configs', () => {
		for (const autoReview of [
			{
				enabled: true,
				structured_findings: false,
				final_review: { mode: 'advisory' },
			},
			{
				enabled: true,
				structured_findings: true,
				final_review: { mode: 'gate' },
			},
		]) {
			writeAutoReview(autoReview);
			const result = runConfigDoctor(loadPluginConfig(projectDir), projectDir);
			expect(
				result.findings.some(
					(item) => item.id === 'invalid-auto-review-gate-compatibility',
				),
			).toBe(false);
		}
	});
});
