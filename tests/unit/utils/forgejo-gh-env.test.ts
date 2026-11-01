import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ForgeConfigSchema } from '../../../src/config/schema';
import {
	resolveForgejoGhEnvOverrides,
	shouldUseForgejoGh,
} from '../../../src/utils/forgejo-gh-env';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { cleanup: cleanupEnv } = createIsolatedTestEnv();

function makeRepoWithRemote(remote: string): string {
	const dir = canonicalMkdtemp('forgejo-gh-');
	spawnSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf-8' });
	spawnSync('git', ['remote', 'add', 'origin', remote], {
		cwd: dir,
		encoding: 'utf-8',
	});
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({}),
	);
	return dir;
}

describe('forge.gh_forgejo schema defaults', () => {
	test('enabled defaults to off when gh_forgejo object is present', () => {
		const parsed = ForgeConfigSchema.parse({
			gh_forgejo: {},
		});
		expect(parsed.gh_forgejo?.enabled).toBe('off');
	});
});

describe('shouldUseForgejoGh / resolveForgejoGhEnvOverrides', () => {
	const dirs: string[] = [];
	afterEach(() => {
		cleanupEnv();
		for (const d of dirs.splice(0)) {
			try {
				fs.rmSync(d, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	test('default-off: Forgejo remote does not enable bridge without config', () => {
		const dir = makeRepoWithRemote(
			'https://git.centralcloud.net/singularity/singularity-engine.git',
		);
		dirs.push(dir);
		expect(shouldUseForgejoGh(dir)).toBe(false);
		expect(resolveForgejoGhEnvOverrides(dir)).toBeNull();
	});

	test('auto + Forgejo remote enables bridge', () => {
		const dir = makeRepoWithRemote(
			'https://git.centralcloud.net/team/repo.git',
		);
		dirs.push(dir);
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ forge: { gh_forgejo: { enabled: 'auto' } } }),
		);
		expect(shouldUseForgejoGh(dir)).toBe(true);
	});

	test('on enables bridge even without Forgejo remote', () => {
		const dir = makeRepoWithRemote('https://github.com/o/r.git');
		dirs.push(dir);
		expect(shouldUseForgejoGh(dir, { enabled: 'on' })).toBe(true);
	});

	test('off disables bridge even with Forgejo remote', () => {
		const dir = makeRepoWithRemote(
			'https://git.centralcloud.net/team/repo.git',
		);
		dirs.push(dir);
		expect(shouldUseForgejoGh(dir, { enabled: 'off' })).toBe(false);
	});
});
