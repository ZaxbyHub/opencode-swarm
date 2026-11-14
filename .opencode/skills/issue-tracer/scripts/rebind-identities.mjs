import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const [root, head, tree, ...args] = process.argv.slice(2);
const gates = [
	['plan-critic', '06-critic-review.md'],
	['implementation-review', '08b-implementation-review.md'],
	['final-critic', '09-final-critic.md'],
];
const sha = /^[0-9a-f]{40}$/;

function replaceLine(content, key, before, after, file) {
	const lines = content.split(/\r?\n/);
	const matching = lines.map((line, index) => line.startsWith(key) ? index : -1).filter((index) => index >= 0);
	if (matching.length !== 1 || lines[matching[0]] !== key + before) {
		throw new Error(`${file}: inconsistent ${key.trim()}`);
	}
	lines[matching[0]] = key + after;
	return lines.join(content.includes('\r\n') ? '\r\n' : '\n');
}

try {
	const [slugFlag, slug, mode, reason] = args;
	const check = mode === '--check';
	if (slugFlag !== '--slug' || !/^[a-z0-9-]+$/.test(slug) ||
		(check ? args.length !== 3 : mode !== '--reason' || args.length !== 4 || !/^[\w .-]{1,120}$/.test(reason))) {
		throw new Error('usage: rebind-identities.sh --slug SLUG (--check | --reason REASON)');
	}
	let dir = root;
	for (const part of ['.agents', 'issue-traces', slug]) {
		dir = join(dir, part);
		if (!lstatSync(dir).isDirectory()) throw new Error(`unsafe trace directory: ${dir}`);
	}
	const read = (file) => {
		const target = join(dir, file);
		const stat = lstatSync(target);
		if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`unsafe trace file: ${file}`);
		return readFileSync(target, 'utf8');
	};
	const state = read('state.md');
	const lines = state.split(/\r?\n/);
	const start = lines.indexOf('## Gates');
	if (start < 0) throw new Error('state.md: missing Gates table');
	const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
	const rows = lines.slice(start + 1, end === -1 ? lines.length : end);
	const edits = new Map();
	const additions = [];
	let from;
	for (const [gate, file] of gates) {
		const latest = rows.filter((line) => line.startsWith(`| ${gate} |`)).at(-1);
		const [, , verdict, oldHead, oldTree, artifact] = latest?.split('|').map((cell) => cell.trim()) ?? [];
		if (verdict !== 'APPROVE' || !sha.test(oldHead) || oldTree !== tree ||
			(check && oldHead !== head) || (from && from !== oldHead) ||
			(artifact !== file && !artifact?.startsWith(file + ' rebind('))) {
			throw new Error(`state.md: inconsistent ${gate} approval or changed tree`);
		}
		if (!check && execFileSync('git', ['rev-parse', '--verify', oldHead + '^{tree}'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim() !== tree) {
			throw new Error(`state.md: ${gate} was not reviewed on this tree`);
		}
		from = oldHead;
		const content = replaceLine(read(file), 'reviewed-commit: ', oldHead, head, file);
		edits.set(file, replaceLine(content, 'tree-id: ', tree, tree, file));
		additions.push(`| ${gate} | APPROVE | ${head} | ${tree} | ${file} rebind(${reason}) |`);
	}
	const body = '10-pr-body.md';
	edits.set(body, replaceLine(read(body), 'PR head: ', from, head, body));
	if (!check && from !== head) {
		let insertion = end === -1 ? lines.length : end;
		while (insertion > start && !lines[insertion - 1]) insertion--;
		lines.splice(insertion, 0, ...additions);
		edits.set('state.md', lines.join(state.includes('\r\n') ? '\r\n' : '\n'));
		const staged = [];
		try {
			for (const [file, content] of edits) {
				const target = join(dir, file);
				const temp = target + '.' + randomUUID() + '.tmp';
				writeFileSync(temp, content, { flag: 'wx' });
				staged.push([temp, target]);
			}
			for (const [temp, target] of staged) renameSync(temp, target);
		} finally {
			for (const [temp] of staged) {
				try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
			}
		}
	}
} catch (error) {
	console.error(`rebind-identities: ${error.message}`);
	process.exitCode = 1;
}
