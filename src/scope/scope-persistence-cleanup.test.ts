import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearScopeBindingFromDisk } from './scope-persistence';

let workspace: string;
let external: string;

function bindingFile(
	directory: string,
	taskId: string,
	ownerSessionId: string,
): string {
	const ownerHash = createHash('sha256')
		.update(ownerSessionId)
		.digest('hex')
		.slice(0, 24);
	return path.join(
		directory,
		'.swarm',
		'scopes',
		`binding-${taskId}-${ownerHash}.json`,
	);
}

beforeEach(() => {
	workspace = fs.mkdtempSync(
		path.join(os.tmpdir(), 'scope-cleanup-workspace-'),
	);
	external = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-cleanup-external-'));
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
	fs.rmSync(external, { recursive: true, force: true });
});

describe('clearScopeBindingFromDisk containment', () => {
	test('removes a regular binding from the canonical scopes directory', () => {
		const target = bindingFile(workspace, '1.1', 'child-session');
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, '{}');

		clearScopeBindingFromDisk({
			directory: workspace,
			taskId: '1.1',
			ownerSessionId: 'child-session',
		});

		expect(fs.existsSync(target)).toBe(false);
	});

	test('fails closed when scopes is swapped to a symlink or junction', () => {
		const originalTarget = bindingFile(workspace, '1.1', 'child-session');
		const scopesDir = path.dirname(originalTarget);
		const displacedScopes = path.join(workspace, '.swarm', 'scopes-original');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(originalTarget, 'original');
		fs.renameSync(scopesDir, displacedScopes);

		const externalTarget = bindingFile(external, '1.1', 'child-session');
		fs.mkdirSync(path.dirname(externalTarget), { recursive: true });
		fs.writeFileSync(externalTarget, 'outside');
		fs.symlinkSync(
			path.dirname(externalTarget),
			scopesDir,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		clearScopeBindingFromDisk({
			directory: workspace,
			taskId: '1.1',
			ownerSessionId: 'child-session',
		});

		expect(fs.readFileSync(externalTarget, 'utf8')).toBe('outside');
		expect(
			fs.readFileSync(
				path.join(displacedScopes, path.basename(originalTarget)),
				'utf8',
			),
		).toBe('original');
	});

	test('fails closed when the binding leaf is a symlink or junction', () => {
		const target = bindingFile(workspace, '1.1', 'child-session');
		const externalTarget = path.join(external, 'outside-binding');
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.mkdirSync(externalTarget);
		fs.writeFileSync(path.join(externalTarget, 'sentinel.txt'), 'outside');
		fs.symlinkSync(
			externalTarget,
			target,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		clearScopeBindingFromDisk({
			directory: workspace,
			taskId: '1.1',
			ownerSessionId: 'child-session',
		});

		expect(
			fs.readFileSync(path.join(externalTarget, 'sentinel.txt'), 'utf8'),
		).toBe('outside');
		expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
	});
});
