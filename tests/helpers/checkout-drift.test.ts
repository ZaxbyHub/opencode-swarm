/**
 * Checkout-drift bookend (tests/helpers/checkout-drift.ts), exercised against a
 * fake repo root in a temp dir — never the real checkout.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	diffCheckout,
	reportCheckoutDrift,
	resolveDriftMode,
	snapshotCheckout,
} from './checkout-drift';
import { canonicalMkdtemp } from './tmpdir';

let root: string;

function bumpMtime(p: string): void {
	const later = new Date(Date.now() + 60_000);
	fs.utimesSync(p, later, later);
}

beforeEach(() => {
	root = canonicalMkdtemp('checkout-drift-');
	fs.mkdirSync(path.join(root, 'src'));
	fs.writeFileSync(path.join(root, 'package.json'), '{}');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('checkout drift: top level', () => {
	test('a clean run reports nothing', () => {
		const before = snapshotCheckout(root);
		expect(diffCheckout(before, snapshotCheckout(root))).toEqual({
			topLevel: [],
			swarm: [],
		});
	});

	test('new entries, a created .swarm, and a modified root file are flagged', () => {
		const before = snapshotCheckout(root);
		fs.mkdirSync(path.join(root, '   '));
		fs.mkdirSync(path.join(root, '.swarm', 'cache'), { recursive: true });
		fs.writeFileSync(path.join(root, 'package.json'), '{"changed":true}');
		bumpMtime(path.join(root, 'package.json'));
		const drift = diffCheckout(before, snapshotCheckout(root));
		expect(drift.topLevel.sort()).toEqual(
			['   : created', '.swarm: created', 'package.json: modified'].sort(),
		);
	});

	test('build outputs and directory mtime churn are not flagged', () => {
		const before = snapshotCheckout(root);
		for (const out of ['dist', 'coverage', 'node_modules', 'graphify-out']) {
			fs.mkdirSync(path.join(root, out));
		}
		fs.writeFileSync(path.join(root, 'src', 'edited.ts'), 'x');
		bumpMtime(path.join(root, 'src'));
		expect(diffCheckout(before, snapshotCheckout(root)).topLevel).toEqual([]);
	});
});

describe('checkout drift: pre-existing .swarm', () => {
	beforeEach(() => {
		fs.mkdirSync(path.join(root, '.swarm', 'session'), { recursive: true });
		fs.writeFileSync(path.join(root, '.swarm', 'session', 'a.jsonl'), '1\n');
	});

	test('new, modified, and removed .swarm entries are flagged as swarm drift', () => {
		fs.writeFileSync(path.join(root, '.swarm', 'gone.json'), '{}');
		const before = snapshotCheckout(root);
		fs.mkdirSync(path.join(root, '.swarm', 'cache'));
		fs.writeFileSync(path.join(root, '.swarm', 'cache', 'h.jsonl'), '1\n');
		fs.appendFileSync(path.join(root, '.swarm', 'session', 'a.jsonl'), '2\n');
		fs.rmSync(path.join(root, '.swarm', 'gone.json'));
		const drift = diffCheckout(before, snapshotCheckout(root));
		expect(drift.topLevel).toEqual([]);
		expect(drift.swarm.sort()).toEqual(
			[
				'.swarm/cache: created',
				'.swarm/cache/h.jsonl: created',
				'.swarm/gone.json: removed',
				'.swarm/session/a.jsonl: modified',
			].sort(),
		);
	});

	test("CI's repository-validation reports are ignored", () => {
		const before = snapshotCheckout(root);
		const reports = path.join(root, '.swarm', 'repository-validation');
		fs.mkdirSync(reports);
		fs.writeFileSync(path.join(reports, 'unit-shard-1-0.json'), '{}');
		expect(diffCheckout(before, snapshotCheckout(root)).swarm).toEqual([]);
	});
});

describe('checkout drift: modes and reporting', () => {
	test('top level is always enforced; .swarm is enforced only in CI by default', () => {
		expect(resolveDriftMode({})).toEqual({
			topLevel: 'enforce',
			swarm: 'warn',
		});
		expect(resolveDriftMode({ CI: 'true' })).toEqual({
			topLevel: 'enforce',
			swarm: 'enforce',
		});
		expect(resolveDriftMode({ SWARM_TEST_CHECKOUT_DRIFT: 'OFF' })).toEqual({
			topLevel: 'off',
			swarm: 'off',
		});
	});

	test('enforced drift throws; warned drift only warns', () => {
		const drift = { topLevel: ['x: created'], swarm: ['.swarm/y: created'] };
		const warnings: string[] = [];
		expect(() =>
			reportCheckoutDrift(
				drift,
				{ topLevel: 'enforce', swarm: 'warn' },
				root,
				(m) => warnings.push(m),
			),
		).toThrow(/CHECKOUT DRIFT[\s\S]*x: created/);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('.swarm/y: created');

		expect(
			reportCheckoutDrift(drift, { topLevel: 'off', swarm: 'off' }, root),
		).toEqual([]);
	});
});
