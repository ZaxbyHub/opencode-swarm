#!/usr/bin/env node
/**
 * Build into dist.next then swap into place so opencode serve never reads a
 * half-deleted dist/ during rebuild (ENOENT plugin loads).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const distNext = path.join(root, 'dist.next');
const distPrev = path.join(root, 'dist.prev');

function run(cmd, args, env = {}) {
	const res = spawnSync(cmd, args, {
		cwd: root,
		stdio: 'inherit',
		env: { ...process.env, ...env },
	});
	if (res.status !== 0) process.exit(res.status ?? 1);
}

fs.rmSync(distNext, { recursive: true, force: true });

run('bun', ['run', 'scripts/generate-config-schema.ts']);
run('bun', ['run', 'scripts/copy-grammars.ts']);

run('bun', [
	'build',
	'src/index.ts',
	'--outdir',
	'dist.next',
	'--target',
	'node',
	'--format',
	'esm',
	'--external',
	'web-tree-sitter',
	'--minify-whitespace',
	'--minify-syntax',
]);
run('bun', [
	'build',
	'src/cli/index.ts',
	'--outdir',
	'dist.next/cli',
	'--target',
	'bun',
	'--format',
	'esm',
	'--external',
	'bash-parser',
	'--splitting',
]);
run('bun', ['run', 'scripts/copy-grammars.ts', '--to-dist'], {
	SWARM_BUILD_DIST: 'dist.next',
});
run('tsc', ['--emitDeclarationOnly', '--outDir', 'dist.next']);

fs.rmSync(distPrev, { recursive: true, force: true });
if (fs.existsSync(dist)) {
	fs.renameSync(dist, distPrev);
}
fs.renameSync(distNext, dist);
fs.rmSync(distPrev, { recursive: true, force: true });

console.log('atomic-dist-build: dist/ swapped cleanly');
