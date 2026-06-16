import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildOpenSpecProjectionSync,
	loadSddStatusSync,
	readEffectiveSpecSync,
	writeProjectedSpecSync,
} from './effective-spec';

let tempDir: string;

function write(relPath: string, content: string): void {
	const abs = path.join(tempDir, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-effective-spec-')),
	);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('effective spec provider', () => {
	test('prefers .swarm/spec.md when it exists', () => {
		write(
			path.join('.swarm', 'spec.md'),
			'# Specification: Swarm Canonical\n\n## Requirements\n- FR-001 MUST use the existing Swarm spec.\n',
		);
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST support login.\n#### Scenario: Successful login\n- **WHEN** the user submits valid credentials\n- **THEN** the system signs them in.\n',
		);

		const spec = readEffectiveSpecSync(tempDir);

		expect(spec?.source).toBe('swarm');
		expect(spec?.content).toContain('Swarm Canonical');
		expect(spec?.sourcePaths).toEqual(['.swarm/spec.md']);
	});

	test('builds a Swarm-compatible projection from OpenSpec current specs and changes', () => {
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'# Auth\n\n## Requirements\n### Requirement: Login\nThe system MUST allow users to sign in.\n#### Scenario: Successful login\n- **WHEN** the user submits valid credentials\n- **THEN** the system signs them in.\n',
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
			'## ADDED Requirements\n### Requirement: Password reset\nThe system SHOULD let users reset forgotten passwords.\n#### Scenario: Successful reset\n- **WHEN** the user requests a reset\n- **THEN** the system sends reset instructions.\n',
		);

		const spec = buildOpenSpecProjectionSync(tempDir);

		expect(spec?.source).toBe('openspec_projection');
		expect(spec?.content).toContain(
			'# Specification: Effective SDD Projection',
		);
		expect(spec?.content).toContain(
			'FR-001: The system MUST allow users to sign in.',
		);
		expect(spec?.content).toContain(
			'FR-002: The system SHOULD let users reset forgotten passwords.',
		);
		expect(spec?.sourcePaths).toEqual([
			'openspec/specs/auth/spec.md',
			'openspec/changes/add-reset/specs/auth/spec.md',
		]);
	});

	test('status reports missing change artifacts without treating tasks as plan state', () => {
		write(
			path.join('openspec', 'changes', 'add-reset', 'specs', 'auth', 'spec.md'),
			'## ADDED Requirements\n### Requirement: Password reset\nThe system MUST reset passwords.\n#### Scenario: Successful reset\n- **WHEN** the user requests a reset\n- **THEN** the system resets the password.\n',
		);

		const status = loadSddStatusSync(tempDir);

		expect(status.provider).toBe('openspec_projection');
		expect(status.changes).toHaveLength(1);
		expect(status.warnings).toContain(
			'Change add-reset is missing proposal.md.',
		);
		expect(status.warnings).toContain(
			'Change add-reset is missing tasks.md; tasks remain proposal input, not plan state.',
		);
	});

	test('materializes projection atomically and archives an existing spec', () => {
		write(
			path.join('.swarm', 'spec.md'),
			'# Specification: Old\n\n## Requirements\n- FR-001 MUST be archived.\n',
		);
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow login.\n#### Scenario: Successful login\n- **WHEN** the user logs in\n- **THEN** the system authenticates the user.\n',
		);

		const result = writeProjectedSpecSync(tempDir);
		const written = fs.readFileSync(
			path.join(tempDir, '.swarm', 'spec.md'),
			'utf-8',
		);

		expect(result.written).toBe(true);
		expect(result.archivePath).toBeDefined();
		expect(written).toContain('Effective SDD Projection');
		expect(written).toContain('FR-001: The system MUST allow login.');
		expect(fs.existsSync(result.archivePath!)).toBe(true);
	});

	test('does not build a projection when OpenSpec artifacts contain no parsable requirements', () => {
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'# Auth\n\n## Requirements\n#### Scenario: Missing requirement\n- **WHEN** something happens\n- **THEN** nothing useful is specified.\n',
		);

		const spec = buildOpenSpecProjectionSync(tempDir);

		expect(spec).toBeNull();
	});
});
