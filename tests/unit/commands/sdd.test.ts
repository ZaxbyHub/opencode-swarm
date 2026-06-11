import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	handleSddProjectCommand,
	handleSddStatusCommand,
	handleSddValidateCommand,
} from '../../../src/commands/sdd';

let tempDir: string;

function write(relPath: string, content: string): void {
	const abs = path.join(tempDir, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
	tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cmd-')));
	write(
		path.join('openspec', 'specs', 'auth', 'spec.md'),
		'## Requirements\n### Requirement: Login\nThe system MUST let users sign in.\n#### Scenario: Successful login\n- **WHEN** the user submits valid credentials\n- **THEN** the system signs them in.\n',
	);
	write(
		path.join('openspec', 'changes', 'add-reset', 'proposal.md'),
		'# Add reset\n',
	);
	write(
		path.join('openspec', 'changes', 'add-reset', 'tasks.md'),
		'- [ ] Implement reset\n',
	);
	write(
		path.join('openspec', 'changes', 'add-reset', 'specs', 'auth', 'spec.md'),
		'## ADDED Requirements\n### Requirement: Reset\nThe system SHOULD reset passwords.\n#### Scenario: Successful reset\n- **WHEN** the user requests reset\n- **THEN** the system sends reset instructions.\n',
	);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('/swarm sdd command handlers', () => {
	test('status reports provider and changes as markdown', async () => {
		const out = await handleSddStatusCommand(tempDir, []);

		expect(out).toContain('## SDD Status');
		expect(out).toContain('Provider: openspec_projection');
		expect(out).toContain('add-reset');
	});

	test('status supports json output', async () => {
		const out = await handleSddStatusCommand(tempDir, ['--json']);
		const parsed = JSON.parse(out);

		expect(parsed.provider).toBe('openspec_projection');
		expect(parsed.changes[0].id).toBe('add-reset');
	});

	test('validate returns valid projection metadata', async () => {
		const out = await handleSddValidateCommand(tempDir, ['--json']);
		const parsed = JSON.parse(out);

		expect(parsed.valid).toBe(true);
		expect(parsed.sourcePaths).toContain('openspec/specs/auth/spec.md');
		expect(parsed.sourcePaths).toContain(
			'openspec/changes/add-reset/specs/auth/spec.md',
		);
	});

	test('validate fails when OpenSpec files contain no parsable requirements', async () => {
		fs.rmSync(path.join(tempDir, 'openspec'), { recursive: true, force: true });
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'# Auth\n\n## Requirements\n#### Scenario: Missing requirement\n- **WHEN** something happens\n- **THEN** no requirement is defined.\n',
		);

		const out = await handleSddValidateCommand(tempDir, ['--json']);
		const parsed = JSON.parse(out);

		expect(parsed.valid).toBe(false);
		expect(parsed.errors).toContain(
			'No parsable OpenSpec requirements found in source artifacts.',
		);
	});

	test('validate rejects unsafe change ids', async () => {
		const out = await handleSddValidateCommand(tempDir, [
			'--change',
			'../escape',
		]);

		expect(out).toContain('Error:');
		expect(out).toContain('--change must be a single OpenSpec change id');
	});

	test('project dry-run previews without writing .swarm/spec.md', async () => {
		const out = await handleSddProjectCommand(tempDir, ['--dry-run']);

		expect(out).toContain('SDD projection preview');
		expect(fs.existsSync(path.join(tempDir, '.swarm', 'spec.md'))).toBe(false);
	});

	test('project materializes .swarm/spec.md', async () => {
		const out = await handleSddProjectCommand(tempDir, []);
		const spec = fs.readFileSync(
			path.join(tempDir, '.swarm', 'spec.md'),
			'utf-8',
		);

		expect(out).toContain('SDD projection written');
		expect(spec).toContain('Effective SDD Projection');
		expect(spec).toContain('FR-001: The system MUST let users sign in.');
	});
});
