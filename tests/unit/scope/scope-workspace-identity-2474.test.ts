import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	canonicalWorkspaceIdentity,
	clearScopeBindings,
	createScopeBinding,
} from '../../../src/scope/scope-binding.js';
import {
	readScopeBindingFromDisk,
	writeScopeBindingToDisk,
} from '../../../src/scope/scope-persistence.js';
import { _internals as filesystemIdentityInternals } from '../../../src/utils/filesystem-identity.js';
import { canonicalMkdtemp, canonicalTmpDir } from '../../helpers/tmpdir';

const cleanup: string[] = [];
const originalFilesystemIdentityInternals = { ...filesystemIdentityInternals };

afterEach(() => {
	clearScopeBindings();
	Object.assign(
		filesystemIdentityInternals,
		originalFilesystemIdentityInternals,
	);
	for (const target of cleanup.splice(0).reverse()) {
		fs.rmSync(target, { recursive: true, force: true });
	}
});

describe('scope workspace physical identity (#2474)', () => {
	test('accepts a physical alias without widening to a foreign root', () => {
		const root = canonicalMkdtemp('scope-id-');
		const foreign = canonicalMkdtemp('scope-id-foreign-');
		const alias = `${root}-alias`;
		cleanup.push(root, foreign, alias);
		fs.symlinkSync(
			root,
			alias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		expect(canonicalWorkspaceIdentity(alias)).toBe(
			canonicalWorkspaceIdentity(root),
		);
		expect(canonicalWorkspaceIdentity(foreign)).not.toBe(
			canonicalWorkspaceIdentity(root),
		);
	});

	test('fails closed for a missing workspace', () => {
		const missing = path.join(canonicalTmpDir(), 'scope-id-missing-2474');
		expect(canonicalWorkspaceIdentity(missing)).toBeNull();
	});

	test('dual-reads a legacy Windows scope identity and rekeys it on durable write', async () => {
		const root = canonicalMkdtemp('scope-id-legacy-2474-');
		cleanup.push(root);
		fs.mkdirSync(path.join(root, '.git'));
		const plan = {
			schema_version: '1.0.0',
			title: 'Legacy Windows identity',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small' as const,
							description: 'Preserve legacy scope identity',
							depends: [],
							files_touched: ['src/a.ts'],
						},
					],
				},
			],
		};
		filesystemIdentityInternals.platform = () => 'win32';
		filesystemIdentityInternals.realpathSyncNative = () => {
			throw new Error('native resolver unavailable in the legacy release');
		};
		filesystemIdentityInternals.realpathSync = (target) =>
			`${path.resolve(String(target))}~1`;

		const legacyBinding = createScopeBinding({
			directory: root,
			plan,
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'architect-session',
			ownerMessageId: 'declare-scope',
			source: 'declare_scope',
		});
		const legacyIdentity = `${path
			.resolve(root)
			.replaceAll('\\', '/')
			.toLowerCase()}~1`;
		expect(legacyBinding?.workspaceIdentity).toBe(legacyIdentity);
		if (!legacyBinding) throw new Error('scope binding fixture failed');
		expect(await writeScopeBindingToDisk(root, legacyBinding)).toMatchObject({
			ok: true,
		});

		const scopesDir = path.join(root, '.swarm', 'scopes');
		const bindingFile = fs
			.readdirSync(scopesDir)
			.find((name) => name.startsWith('binding-') && name.endsWith('.json'));
		if (!bindingFile) throw new Error('durable scope fixture missing');
		const bindingPath = path.join(scopesDir, bindingFile);
		filesystemIdentityInternals.realpathSyncNative = (target) =>
			path.resolve(String(target));
		const currentIdentity = path
			.resolve(root)
			.replaceAll('\\', '/')
			.toLowerCase();
		clearScopeBindings();

		const recovered = readScopeBindingFromDisk({
			directory: root,
			taskId: '1.1',
			plan,
			ownerSessionId: 'architect-session',
			requireDeclaration: true,
		});
		expect(recovered?.workspaceIdentity).toBe(currentIdentity);
		if (!recovered) throw new Error('legacy scope identity was not recovered');
		expect(await writeScopeBindingToDisk(root, recovered)).toMatchObject({
			ok: true,
		});
		expect(
			(
				JSON.parse(fs.readFileSync(bindingPath, 'utf-8')) as {
					workspaceIdentity: string;
				}
			).workspaceIdentity,
		).toBe(currentIdentity);
	});
});
