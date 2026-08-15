/**
 * Tests for allowedMutationsFor (sdd.ts directive #2 coverage).
 *
 * Split from sdd.test.ts to satisfy FR-006 line-cap ratchet.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	allowedMutationsFor,
	handleSddStatusCommand,
} from '../../../src/commands/sdd';

describe('allowedMutationsFor', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sdd-mutations-')),
		);
		const write = (rel: string, content: string) => {
			const abs = path.join(tempDir, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, content, 'utf-8');
		};
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
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	});

	test('swarm source allows create/refine/archive mutations', () => {
		expect(allowedMutationsFor('swarm')).toEqual([
			'create',
			'refine',
			'archive',
		]);
	});

	test('openspec_projection source is read-only', () => {
		expect(allowedMutationsFor('openspec_projection')).toEqual([
			'none (read-only input; refine in the source tool)',
		]);
	});

	test('speckit_projection source is read-only', () => {
		expect(allowedMutationsFor('speckit_projection')).toEqual([
			'none (read-only input; refine in the source tool)',
		]);
	});

	test('openspec_projection and speckit_projection share the identical read-only message', () => {
		expect(allowedMutationsFor('openspec_projection')).toEqual(
			allowedMutationsFor('speckit_projection'),
		);
	});

	test('swarm mutations are strictly disjoint from projection sources', () => {
		const swarmMutations = new Set(allowedMutationsFor('swarm'));
		for (const projectionMutation of allowedMutationsFor(
			'openspec_projection',
		)) {
			expect(swarmMutations.has(projectionMutation)).toBe(false);
		}
	});

	test('wired into `/swarm sdd status` markdown for an openspec-projected effective spec', async () => {
		const out = await handleSddStatusCommand(tempDir, []);
		expect(out).toContain(
			`allowed mutations: ${allowedMutationsFor('openspec_projection').join(', ')}`,
		);
		expect(out).not.toContain('allowed mutations: create, refine, archive');
	});

	test('wired into `/swarm sdd status` markdown for a native swarm effective spec', async () => {
		const nativeDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(fs.realpathSync(os.tmpdir()), 'sdd-mutations-native-'),
			),
		);
		try {
			fs.mkdirSync(path.join(nativeDir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(nativeDir, '.swarm', 'spec.md'),
				'# Specification: Native\n\n## Requirements\n- FR-001 MUST use the native swarm spec.\n',
				'utf-8',
			);
			const out = await handleSddStatusCommand(nativeDir, []);
			expect(out).toContain('Provider: swarm');
			expect(out).toContain(
				`allowed mutations: ${allowedMutationsFor('swarm').join(', ')}`,
			);
		} finally {
			fs.rmSync(nativeDir, { recursive: true, force: true });
		}
	});
});
