import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AuthorityConfig } from '../../../src/config/schema';
import { clearScopeBindings } from '../../../src/scope/scope-binding';
import { resetSwarmState } from '../../../src/state';
import {
	executeDeclareScope,
	validateFiles,
} from '../../../src/tools/declare-scope';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let cleanup: (() => void) | undefined;

function setup(): string {
	const created = createSafeTestDir('declare-authority-2096-');
	cleanup = created.cleanup;
	fs.mkdirSync(path.join(created.dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(created.dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Authority preflight',
			swarm: 'default',
			phases: [
				{
					id: 1,
					name: 'Fix',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'fix',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		}),
	);
	return created.dir;
}

afterEach(() => {
	resetSwarmState();
	clearScopeBindings();
	cleanup?.();
	cleanup = undefined;
});

describe('issue #2096 declare_scope authority preflight', () => {
	test('accepts exact package, lockfile, and generated deliverable scope', async () => {
		const directory = setup();
		const result = await executeDeclareScope(
			{
				taskId: '1.1',
				files: ['package.json', 'bun.lock', 'dist/index.js'],
			},
			directory,
		);
		expect(result.success).toBe(true);
		expect(result.fileCount).toBe(3);
	});

	test.each([
		['.swarm/plan.json', 'AUTHORITY_PROTECTED_PATH'],
		['biome.json', 'AUTHORITY_VERIFIER_CONFIG'],
	] as const)('rejects hard protected declaration %s', async (file, code) => {
		const directory = setup();
		const result = await executeDeclareScope(
			{ taskId: '1.1', files: [file] },
			directory,
		);
		expect(result.success).toBe(false);
		expect(result.message).toBe('Scope denied by effective coder authority');
		expect(result.errors?.join(' ')).toContain(code);
	});

	test('uses effective custom universal and verifier policy', async () => {
		const directory = setup();
		const authority: AuthorityConfig = {
			enabled: true,
			rules: {},
			universal_deny_prefixes: ['private/'],
			verifier_config_paths: ['**/quality-gate.*'],
		};
		const universal = await executeDeclareScope(
			{ taskId: '1.1', files: ['private/token.txt'] },
			directory,
			undefined,
			authority,
		);
		expect(universal.errors?.join(' ')).toContain('AUTHORITY_UNIVERSAL_DENY');
		const verifier = await executeDeclareScope(
			{ taskId: '1.1', files: ['config/quality-gate.toml'] },
			directory,
			undefined,
			authority,
		);
		expect(verifier.errors?.join(' ')).toContain('AUTHORITY_VERIFIER_CONFIG');
	});

	test('rejects control and bidi path text before persistence', async () => {
		const directory = setup();
		for (const file of ['src/a\n.ts', 'src/\u202efile.ts']) {
			const result = await executeDeclareScope(
				{ taskId: '1.1', files: [file] },
				directory,
			);
			expect(result.success).toBe(false);
			expect(result.message).toBe('Validation failed');
		}
	});

	test('shares component-aware traversal semantics with plan scope', async () => {
		expect(validateFiles(['src/foo..bar.ts', '..cache/dist'])).toEqual([]);
		expect(validateFiles(['src/../escape.ts'])).not.toEqual([]);
		const result = await executeDeclareScope(
			{ taskId: '1.1', files: ['src/foo..bar.ts', '..cache/dist'] },
			setup(),
		);
		expect(result.success).toBe(true);
	});

	test('replace_existing is explicit and surfaces typed persistence failures', async () => {
		const directory = setup();
		const owner = {
			sessionID: 'architect-session',
			messageID: 'message-1',
		};
		const first = await executeDeclareScope(
			{ taskId: '1.1', files: ['src/a.ts'] },
			directory,
			owner,
		);
		expect(first.success).toBe(true);
		const conflict = await executeDeclareScope(
			{ taskId: '1.1', files: ['src/b.ts'] },
			directory,
			{ ...owner, messageID: 'message-2' },
		);
		expect(conflict.success).toBe(false);
		expect(conflict.errors?.join(' ')).toContain('SCOPE_BINDING_AMBIGUOUS');
		const replacement = await executeDeclareScope(
			{
				taskId: '1.1',
				files: ['src/b.ts'],
				replace_existing: true,
			},
			directory,
			{ ...owner, messageID: 'message-3' },
		);
		expect(replacement.success).toBe(true);
	});
});
