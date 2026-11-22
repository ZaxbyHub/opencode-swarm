import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { checkpoint } from '../../../src/tools/checkpoint';
import {
	ensureSwarmGitExcluded,
	resetSwarmGitExcludedState,
} from '../../../src/utils/gitignore-warning';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string | undefined;
afterEach(() => {
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
	dir = undefined;
	resetSwarmGitExcludedState();
});

function git(args: string[]): string {
	if (!dir) throw new Error('Missing scratch project');
	return execFileSync('git', args, {
		cwd: dir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 15000,
		maxBuffer: 32768,
	}).trim();
}

function fixture() {
	dir = canonicalMkdtemp('audit-d8-');
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.invalid']);
	git(['config', 'user.name', 'Fixture']);
	git(['config', 'commit.gpgsign', 'false']);
	git(['config', 'core.autocrlf', 'false']);
	write('sample.txt', 'original');
	git(['add', 'sample.txt']);
	git(['commit', '-qm', 'fixture']);
}

function loc(rel: string) {
	return path.join(dir!, rel);
}
function write(rel: string, text: string) {
	fs.writeFileSync(loc(rel), text);
}
async function call(args: Record<string, unknown>) {
	const r = await checkpoint.execute(args, {
		directory: dir,
		worktree: dir,
		sessionID: 'd8-fixture',
	} as ToolContext);
	return JSON.parse(typeof r === 'string' ? r : r.output);
}
async function save() {
	return call({ action: 'save', label: 'fixture' });
}
async function baseline() {
	const r = await save();
	if (!r.success) throw new Error('FIXTURE baseline save: ' + r.error);
}
async function restore() {
	const p = await call({ action: 'restore', label: 'fixture' });
	if (!p.requires_confirm || typeof p.confirm_token !== 'string')
		throw new Error('FIXTURE restore preview: ' + JSON.stringify(p));
	return call({
		action: 'restore',
		label: 'fixture',
		confirm_token: p.confirm_token,
	});
}
function named(caseId: string, ok: boolean, detail: string) {
	if (!ok) {
		console.error(detail);
		throw new Error('ORACLE:' + caseId);
	}
}
test('review-R02G-AC1', async () => {
	fixture();
	await ensureSwarmGitExcluded(dir!);
	expect(git(['check-ignore', '.swarm/marker.txt'])).toBe('.swarm/marker.txt');
	fs.mkdirSync(loc('.swarm'), { recursive: true });
	write('.swarm/marker.txt', 'runtime');
	write('sample.txt', 'edited');
	write('new.txt', 'new');
	const result = await save();
	named(
		'R02G-AC1',
		result.success === true,
		'Save returned: ' + String(result.error),
	);
	expect(git(['show', result.sha + ':sample.txt'])).toBe('edited');
	expect(git(['show', result.sha + ':new.txt'])).toBe('new');
});
test('review-R02G-AC2', async () => {
	fixture();
	fs.mkdirSync(loc('.swarm'), { recursive: true });
	write('.swarm/marker.txt', 'runtime');
	write('sample.txt', 'edited');
	write('new.txt', 'new');
	const result = await save();
	expect(result.success).toBe(true);
	expect(
		git(['ls-tree', '-r', '--name-only', result.sha]).split('\n').sort(),
	).toEqual(['new.txt', 'sample.txt']);
	expect(git(['show', result.sha + ':new.txt'])).toBe('new');
});
test('review-R02G-AC3', async () => {
	fixture();
	await baseline();
	write('sample.txt', 'stage B');
	git(['add', 'sample.txt']);
	git(['update-index', '--chmod=+x', 'sample.txt']);
	write('sample.txt', 'work C');
	expect(git(['show', ':sample.txt'])).toBe('stage B');
	expect(git(['ls-files', '--stage', 'sample.txt'])).toStartWith('100755 ');
	expect(fs.readFileSync(loc('sample.txt'), 'utf8')).toBe('work C');
	const result = await restore();
	expect(result.success).toBe(true);
	expect(git(['show', ':sample.txt'])).toBe('original');
	const contents = execFileSync(
		process.execPath,
		[
			'-e',
			'const fs=require("node:fs");const p=require("node:path");const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p.join(d,e.name)):[fs.readFileSync(p.join(d,e.name),"utf8")]);console.log(JSON.stringify(walk(process.argv[1])));',
			result.backup_dir,
		],
		{
			cwd: dir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 12000,
			maxBuffer: 32768,
		},
	);
	const observed = JSON.parse(contents);
	expect(observed).toContain('work C');
	const manifest = path.join(result.backup_dir, 'recovery.json');
	const index = fs.existsSync(manifest)
		? JSON.parse(fs.readFileSync(manifest, 'utf8')).entries?.['sample.txt']
				?.index
		: undefined;
	named(
		'R02G-AC3',
		observed.includes('stage B') && index?.mode === '100755',
		'Fresh backup reader did not find staged bytes and mode',
	);
});
test('review-R02G-AC4', async () => {
	fixture();
	await baseline();
	fs.unlinkSync(loc('sample.txt'));
	expect(git(['status', '--porcelain', '--', 'sample.txt'])).toMatch(
		/D sample\.txt/,
	);
	const result = await restore();
	named(
		'R02G-AC4',
		result.success === true,
		'Deletion-only restore returned: ' + String(result.error),
	);
	expect(fs.readFileSync(loc('sample.txt'), 'utf8')).toBe('original');
	const manifest = path.join(result.backup_dir, 'recovery.json');
	const entry = fs.existsSync(manifest)
		? JSON.parse(fs.readFileSync(manifest, 'utf8')).entries?.['sample.txt']
		: undefined;
	named(
		'R02G-AC4',
		entry?.worktree?.kind === 'deleted',
		'Recovery manifest omitted the deletion',
	);
});
test('review-R02G-AC5', async () => {
	fixture();
	await baseline();
	git(['commit', '--allow-empty', '-qm', 'distinct pre-restore HEAD']);
	write('sample.txt', 'stage B');
	git(['add', 'sample.txt']);
	write('sample.txt', 'work C');
	write('.swarm/rollback-backups', 'fixture blocks writer directory');
	const before = git(['write-tree']);
	const head = git(['rev-parse', 'HEAD']);
	const result = await restore();
	expect(result.success).toBe(false);
	expect(git(['write-tree'])).toBe(before);
	expect(git(['rev-parse', 'HEAD'])).toBe(head);
	expect(fs.readFileSync(loc('sample.txt'), 'utf8')).toBe('work C');
});
