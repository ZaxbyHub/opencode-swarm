import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	handleSddProjectCommand,
	handleSddStatusCommand,
	handleSddValidateCommand,
} from '../../../src/commands/sdd';
import { writeSpeckitFixture } from '../../helpers/speckit-fixture';

const { parseArgs } = _test_exports;

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

// ---------------------------------------------------------------------------
// parseArgs — new flags (task 2.2)
// ---------------------------------------------------------------------------
describe('parseArgs — --source and --feature flags', () => {
	test('accepts valid --source swarm', () => {
		const result = parseArgs(['--source', 'swarm']);
		expect(result.error).toBeUndefined();
		expect(result.source).toBe('swarm');
	});

	test('accepts valid --source openspec', () => {
		const result = parseArgs(['--source', 'openspec']);
		expect(result.error).toBeUndefined();
		expect(result.source).toBe('openspec');
	});

	test('accepts valid --source speckit', () => {
		const result = parseArgs(['--source', 'speckit']);
		expect(result.error).toBeUndefined();
		expect(result.source).toBe('speckit');
	});

	test('rejects invalid --source value with the valid set listed', () => {
		const result = parseArgs(['--source', 'bogus']);
		expect(result.error).toBeDefined();
		expect(result.error).toContain('swarm');
		expect(result.error).toContain('openspec');
		expect(result.error).toContain('speckit');
		expect(result.error).toContain('"bogus"');
	});

	test('rejects --source with no value', () => {
		const result = parseArgs(['--source']);
		expect(result.error).toBeDefined();
		expect(result.error).toContain('--source requires a value');
	});

	test('accepts a valid safe --feature value', () => {
		const result = parseArgs(['--feature', '001-auth-service']);
		expect(result.error).toBeUndefined();
		expect(result.feature).toBe('001-auth-service');
	});

	test('rejects --feature with a path separator (same check as --change)', () => {
		const result = parseArgs(['--feature', '001/escape']);
		expect(result.error).toBeDefined();
		expect(result.error).toContain('--feature must be a single Spec-Kit feature directory name');
	});

	test('rejects --feature with a traversal sequence (same check as --change)', () => {
		const result = parseArgs(['--feature', '../traverse']);
		expect(result.error).toBeDefined();
		expect(result.error).toContain('--feature must be a single Spec-Kit feature directory name');
	});

	test('rejects --feature with bracket characters (same check as --change)', () => {
		const result = parseArgs(['--feature', 'bad[value]']);
		expect(result.error).toBeDefined();
		expect(result.error).toContain('--feature must be a single Spec-Kit feature directory name');
	});

	test('rejects --feature with no value', () => {
		const result = parseArgs(['--feature']);
		expect(result.error).toBeDefined();
		expect(result.error).toContain('--feature requires a value');
	});

	test('accepts --source and --feature together', () => {
		const result = parseArgs(['--source', 'speckit', '--feature', '001-auth']);
		expect(result.error).toBeUndefined();
		expect(result.source).toBe('speckit');
		expect(result.feature).toBe('001-auth');
	});
});

// ---------------------------------------------------------------------------
// Spec-Kit command integration tests (task 2.2 — FR-001, FR-008, FR-009, FR-010)
// ---------------------------------------------------------------------------
describe('/swarm sdd command handlers — Spec-Kit', () => {
	// Each test in this group uses a SEPARATE tempDir that starts clean (no OpenSpec).
	let skDir: string;

	beforeEach(() => {
		skDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-sk-')),
		);
	});

	afterEach(() => {
		fs.rmSync(skDir, { recursive: true, force: true });
	});

	// FR-001 / SC-006: status on a Spec-Kit-only repo names the provider + features.
	test('status on a single-feature Spec-Kit repo reports Spec-Kit provider and feature (FR-001)', async () => {
		writeSpeckitFixture(skDir, { variant: 'single-explicit-fr' });

		const out = await handleSddStatusCommand(skDir, []);

		expect(out).toContain('## SDD Status');
		// Spec-Kit section must appear with the feature listed.
		expect(out).toContain('Spec-Kit provider: detected');
		expect(out).toContain('001-auth-service');
	});

	// status --json includes speckit detection data.
	test('status --json includes speckit field with features list', async () => {
		writeSpeckitFixture(skDir, { variant: 'single-explicit-fr' });

		const out = await handleSddStatusCommand(skDir, ['--json']);
		const parsed = JSON.parse(out);

		expect(parsed.speckit).toBeDefined();
		expect(parsed.speckit.markerPresent).toBe(true);
		expect(parsed.speckit.features).toHaveLength(1);
		expect(parsed.speckit.features[0].featureId).toBe('001-auth-service');
	});

	// SC-001 / FR-002: project on a single-feature Spec-Kit repo writes a valid .swarm/spec.md.
	test('project on a single-feature Spec-Kit repo materializes .swarm/spec.md (SC-001)', async () => {
		writeSpeckitFixture(skDir, { variant: 'single-explicit-fr' });

		const out = await handleSddProjectCommand(skDir, []);
		const spec = fs.readFileSync(
			path.join(skDir, '.swarm', 'spec.md'),
			'utf-8',
		);

		expect(out).toContain('SDD projection written');
		expect(spec).toContain('Effective SDD Projection');
		// FR-003: original FR-### ids are preserved.
		expect(spec).toContain('**FR-001**');
		expect(spec).toContain('**FR-002**');
		expect(spec).toContain('**FR-003**');
	});

	// SC-005 / FR-009 / FR-010: multi-source-no-source → error naming both + --source.
	test('status with both openspec and speckit and no --source errors naming both sources (FR-010)', async () => {
		// Write both sources.
		writeSpeckitFixture(skDir, { variant: 'single-explicit-fr' });
		fs.mkdirSync(path.join(skDir, 'openspec', 'specs', 'auth'), { recursive: true });
		fs.writeFileSync(
			path.join(skDir, 'openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow login.\n',
			'utf-8',
		);

		const out = await handleSddStatusCommand(skDir, []);

		expect(out).toContain('Error:');
		expect(out.toLowerCase()).toContain('openspec');
		expect(out.toLowerCase()).toContain('speckit');
		expect(out).toContain('--source');
	});

	// FR-009: an explicit --source must win on a both-present repo — status must
	// report that provider and must NOT leak the resolver's ambiguity console.warn.
	test('status --source openspec on a both-present repo honors the selection and emits no warning (FR-009)', async () => {
		writeSpeckitFixture(skDir, { variant: 'single-explicit-fr' });
		fs.mkdirSync(path.join(skDir, 'openspec', 'specs', 'auth'), { recursive: true });
		fs.writeFileSync(
			path.join(skDir, 'openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow login.\n',
			'utf-8',
		);

		const original = console.warn;
		const warnMessages: string[] = [];
		console.warn = (...a: unknown[]) => {
			warnMessages.push(a.map(String).join(' '));
		};
		let out: string;
		try {
			out = await handleSddStatusCommand(skDir, ['--source', 'openspec']);
		} finally {
			console.warn = original;
		}

		expect(out).toContain('Provider: openspec_projection');
		expect(out).not.toContain('Provider: none');
		expect(warnMessages).toEqual([]);
	});

	test('project with both openspec and speckit and no --source errors naming both sources (FR-010)', async () => {
		writeSpeckitFixture(skDir, { variant: 'single-explicit-fr' });
		fs.mkdirSync(path.join(skDir, 'openspec', 'specs', 'auth'), { recursive: true });
		fs.writeFileSync(
			path.join(skDir, 'openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow login.\n',
			'utf-8',
		);

		const out = await handleSddProjectCommand(skDir, []);

		expect(out).toContain('Error:');
		expect(out.toLowerCase()).toContain('openspec');
		expect(out.toLowerCase()).toContain('speckit');
		expect(out).toContain('--source');
	});

	// SC-009 / FR-008: multi-feature-no-feature → error naming features + --feature.
	test('project with multi-feature Spec-Kit and no --feature errors naming features (FR-008)', async () => {
		writeSpeckitFixture(skDir, { variant: 'multi-feature' });

		const out = await handleSddProjectCommand(skDir, []);

		expect(out).toContain('Error:');
		expect(out).toContain('001-alpha');
		expect(out).toContain('002-beta');
		expect(out).toContain('--feature');
	});

	// --source speckit selects speckit when openspec is also present (SC-005).
	test('project --source speckit selects speckit when openspec also present (SC-005)', async () => {
		writeSpeckitFixture(skDir, { variant: 'single-explicit-fr' });
		fs.mkdirSync(path.join(skDir, 'openspec', 'specs', 'auth'), { recursive: true });
		fs.writeFileSync(
			path.join(skDir, 'openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow login.\n',
			'utf-8',
		);

		const out = await handleSddProjectCommand(skDir, ['--source', 'speckit']);
		const spec = fs.readFileSync(
			path.join(skDir, '.swarm', 'spec.md'),
			'utf-8',
		);

		expect(out).toContain('SDD projection written');
		// Content must be from the Spec-Kit feature (has bold FR markers), not OpenSpec.
		expect(spec).toContain('**FR-001**');
		// Source path must be specs/... (speckit), not openspec/...
		expect(spec).toContain('specs/001-auth-service/spec.md');
		expect(spec).not.toContain('openspec/');
	});

	// SC-009 / FR-008: --feature selects the correct feature in a multi-feature repo.
	test('project --feature selects the correct feature in a multi-feature Spec-Kit repo (SC-009)', async () => {
		writeSpeckitFixture(skDir, { variant: 'multi-feature' });

		const out = await handleSddProjectCommand(skDir, ['--feature', '002-beta']);
		const spec = fs.readFileSync(
			path.join(skDir, '.swarm', 'spec.md'),
			'utf-8',
		);

		expect(out).toContain('SDD projection written');
		expect(spec).toContain('beta capability');
		expect(spec).not.toContain('alpha');
		expect(spec).toContain('specs/002-beta/spec.md');
	});

	// FR-008: --feature against a non-speckit source errors.
	test('project --feature with --source openspec errors (--feature only valid with speckit)', async () => {
		const out = await handleSddProjectCommand(skDir, [
			'--source',
			'openspec',
			'--feature',
			'001-auth',
		]);

		expect(out).toContain('Error:');
		expect(out).toContain('--feature is only valid with --source speckit');
	});

	// FR-012: detected-but-empty Spec-Kit source errors clearly.
	test('project on empty-specify Spec-Kit (no feature dirs) errors with detected-but-empty message (FR-012)', async () => {
		writeSpeckitFixture(skDir, { variant: 'empty-specify' });

		// empty-specify with --source speckit → 'empty' resolution kind
		const out = await handleSddProjectCommand(skDir, ['--source', 'speckit']);

		expect(out).toContain('Error:');
		expect(out.toLowerCase()).toContain('.specify/');
		expect(out.toLowerCase()).toContain('no feature');
	});

	// FR-012 auto-detect: no --source, empty .specify/ and no OpenSpec → detected-but-empty (not "no OpenSpec provider").
	test('project auto-detect on empty-specify with no openspec errors with Spec-Kit empty message (FR-012)', async () => {
		writeSpeckitFixture(skDir, { variant: 'empty-specify' });
		// Explicitly no OpenSpec layout written — skDir starts clean.

		const out = await handleSddProjectCommand(skDir, []);

		expect(out).toContain('Error:');
		// Must report the Spec-Kit empty condition, not the OpenSpec "no projection" message.
		expect(out.toLowerCase()).toContain('.specify/');
		expect(out.toLowerCase()).toContain('no feature');
		expect(out).not.toContain('no valid OpenSpec-compatible projection');
	});

	// FR-013: zero-requirements feature errors with the accurate reason.
	test('project on zero-fr Spec-Kit feature errors with zero-requirements reason (FR-013)', async () => {
		writeSpeckitFixture(skDir, { variant: 'zero-fr' });

		const out = await handleSddProjectCommand(skDir, []);

		expect(out).toContain('Error:');
		expect(out).toContain('no parsable functional requirements');
	});

	// OpenSpec byte-identity guard (FR-011): project with no speckit present is unchanged.
	test('project with no .specify/ present uses OpenSpec path byte-identically (FR-011)', async () => {
		// tempDir already has an OpenSpec layout from the outer beforeEach but we are
		// using skDir here (clean).  Write an OpenSpec layout into skDir directly.
		const openspecContent =
			'## Requirements\n### Requirement: Login\nThe system MUST allow login.\n';
		fs.mkdirSync(path.join(skDir, 'openspec', 'specs', 'auth'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(skDir, 'openspec', 'specs', 'auth', 'spec.md'),
			openspecContent,
			'utf-8',
		);

		const out = await handleSddProjectCommand(skDir, []);

		// Must follow the OpenSpec path and produce the OpenSpec error message format.
		expect(out).toContain('SDD projection written');
		const spec = fs.readFileSync(
			path.join(skDir, '.swarm', 'spec.md'),
			'utf-8',
		);
		expect(spec).toContain('Effective SDD Projection');
		// OpenSpec projection line (not Spec-Kit).
		expect(spec).toContain('openspec/specs/auth/spec.md');
	});
});

// ---------------------------------------------------------------------------
// /swarm sdd validate — Spec-Kit routing (task 2.3, FR-007, FR-013)
// ---------------------------------------------------------------------------
describe('/swarm sdd validate — Spec-Kit (task 2.3)', () => {
	let skDir: string;

	beforeEach(() => {
		skDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-sk-validate-')),
		);
	});

	afterEach(() => {
		fs.rmSync(skDir, { recursive: true, force: true });
	});

	// SC-007 (partial): valid single-feature Spec-Kit → provider is speckit_projection, no errors.
	test('validate on valid single-feature Spec-Kit repo reports provider speckit_projection and no errors (SC-007)', async () => {
		writeSpeckitFixture(skDir, { variant: 'single-explicit-fr' });

		const out = await handleSddValidateCommand(skDir, ['--json']);
		const parsed = JSON.parse(out);

		expect(parsed.valid).toBe(true);
		expect(parsed.provider).toBe('speckit_projection');
		expect(parsed.errors).toHaveLength(0);
		expect(parsed.sourcePaths.length).toBeGreaterThan(0);
	});

	// SC-007: malformed fixture → both missing Success Criteria AND T001 no-[US#] named.
	test('validate on malformed Spec-Kit fixture reports missing Success Criteria and T001 [US#] problem (SC-007)', async () => {
		writeSpeckitFixture(skDir, { variant: 'malformed' });

		const out = await handleSddValidateCommand(skDir, ['--json']);
		const parsed = JSON.parse(out);

		expect(parsed.valid).toBe(false);
		expect(parsed.provider).toBe('speckit_projection');
		// Missing section must be named.
		expect(parsed.errors.some((e: string) => e.includes('## Success Criteria'))).toBe(true);
		// T001 with no [US#] must be named.
		expect(parsed.errors.some((e: string) => e.includes('T001'))).toBe(true);
		// T002 (which has [US1]) must NOT be flagged.
		expect(parsed.errors.some((e: string) => e.includes('T002'))).toBe(false);
	});

	// SC-010 (partial) / FR-013: zero-fr fixture → zero-requirements problem surface.
	test('validate on zero-fr Spec-Kit fixture reports zero-requirements problem (FR-013)', async () => {
		writeSpeckitFixture(skDir, { variant: 'zero-fr' });

		const out = await handleSddValidateCommand(skDir, ['--json']);
		const parsed = JSON.parse(out);

		expect(parsed.valid).toBe(false);
		expect(parsed.provider).toBe('speckit_projection');
		expect(
			parsed.errors.some((e: string) =>
				e.toLowerCase().includes('no parsable functional requirements'),
			),
		).toBe(true);
	});

	// FR-007 read-only proof: command-level — no file modified, no .swarm/spec.md created.
	test('READ-ONLY proof: validate command does not modify any Spec-Kit artifact (FR-007)', async () => {
		writeSpeckitFixture(skDir, { variant: 'malformed' });

		const specPath = path.join(skDir, 'specs', '001-broken-feature', 'spec.md');
		const tasksPath = path.join(
			skDir,
			'specs',
			'001-broken-feature',
			'tasks.md',
		);
		const specBefore = fs.readFileSync(specPath, 'utf-8');
		const tasksBefore = fs.readFileSync(tasksPath, 'utf-8');

		await handleSddValidateCommand(skDir, []);

		// Artifact bytes must be byte-for-byte identical.
		expect(fs.readFileSync(specPath, 'utf-8')).toBe(specBefore);
		expect(fs.readFileSync(tasksPath, 'utf-8')).toBe(tasksBefore);
		// The command must NOT have written a projection (.swarm/spec.md must not exist).
		expect(fs.existsSync(path.join(skDir, '.swarm', 'spec.md'))).toBe(false);
	});

	// Regression guard: existing OpenSpec validate tests are not disturbed.
	// (Those tests live in the outer describe block above and are not duplicated here.)

	// FR-009/010: both sources, no --source → clear error naming both (same path as project).
	test('validate with both openspec and speckit and no --source errors naming both sources (FR-010)', async () => {
		writeSpeckitFixture(skDir, { variant: 'single-explicit-fr' });
		fs.mkdirSync(path.join(skDir, 'openspec', 'specs', 'auth'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(skDir, 'openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow login.\n',
			'utf-8',
		);

		const out = await handleSddValidateCommand(skDir, []);

		expect(out).toContain('Error:');
		expect(out.toLowerCase()).toContain('openspec');
		expect(out.toLowerCase()).toContain('speckit');
		expect(out).toContain('--source');
	});

	// Validate non-Markdown output (human-readable path, not --json).
	test('validate on valid single-feature Spec-Kit reports provider in human-readable output', async () => {
		writeSpeckitFixture(skDir, { variant: 'single-explicit-fr' });

		const out = await handleSddValidateCommand(skDir, []);

		expect(out).toContain('SDD validation: valid');
		expect(out).toContain('Provider: speckit_projection');
	});
});
