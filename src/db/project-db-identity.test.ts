import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import {
	_internals,
	closeAllProjectDbs,
	closeProjectDb,
	getProjectDb,
} from './project-db.js';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('project-db-identity-');
});

afterEach(() => {
	closeAllProjectDbs();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function linkDirectory(target: string, alias: string): void {
	fs.symlinkSync(
		target,
		alias,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
}

describe('project DB physical identity (#2474)', () => {
	test('physical aliases share one handle and close through the alias', () => {
		const alias = `${tempDir}-alias`;
		try {
			linkDirectory(tempDir, alias);
			const direct = getProjectDb(tempDir);
			expect(getProjectDb(alias)).toBe(direct);
			closeProjectDb(alias);
			expect(getProjectDb(tempDir)).not.toBe(direct);
		} finally {
			fs.rmSync(alias, { recursive: true, force: true });
		}
	});

	test('missing root beneath an aliased parent is keyed after materialization', () => {
		const physicalParent = canonicalMkdtemp('project-db-missing-parent-');
		const aliasParent = `${physicalParent}-alias`;
		const aliasProject = path.join(aliasParent, 'new-project');
		const physicalProject = path.join(physicalParent, 'new-project');
		try {
			linkDirectory(physicalParent, aliasParent);
			const first = getProjectDb(aliasProject);
			expect(getProjectDb(aliasProject)).toBe(first);
			expect(getProjectDb(physicalProject)).toBe(first);
			expect(_internals.projectDbCount()).toBe(1);

			closeProjectDb(aliasProject);
			expect(_internals.projectDbCount()).toBe(0);
			expect(getProjectDb(physicalProject)).not.toBe(first);
		} finally {
			closeProjectDb(physicalProject);
			fs.rmSync(aliasParent, { recursive: true, force: true });
			fs.rmSync(physicalParent, { recursive: true, force: true });
		}
	});

	test('close follows a retargeted alias without closing the old root', () => {
		const otherDir = canonicalMkdtemp('project-db-retarget-');
		const alias = `${tempDir}-retarget-alias`;
		try {
			linkDirectory(tempDir, alias);
			const oldRootDb = getProjectDb(alias);
			const newRootDb = getProjectDb(otherDir);

			fs.rmSync(alias, { recursive: true, force: true });
			linkDirectory(otherDir, alias);
			closeProjectDb(alias);
			// A repeated close after the current target was removed from the cache
			// must not fall back to the stale alias binding for the old root.
			closeProjectDb(alias);

			expect(getProjectDb(otherDir)).not.toBe(newRootDb);
			expect(getProjectDb(tempDir)).toBe(oldRootDb);
		} finally {
			closeProjectDb(tempDir);
			closeProjectDb(otherDir);
			fs.rmSync(alias, { recursive: true, force: true });
			fs.rmSync(otherDir, { recursive: true, force: true });
		}
	});

	test('alias bindings remain bounded during churn', () => {
		const aliases: string[] = [];
		try {
			const db = getProjectDb(tempDir);
			for (let index = 0; index < 140; index += 1) {
				const alias = `${tempDir}-churn-${index}`;
				linkDirectory(tempDir, alias);
				aliases.push(alias);
				expect(getProjectDb(alias)).toBe(db);
			}
			expect(_internals.projectDbAliasCount()).toBeLessThanOrEqual(128);
			expect(_internals.projectDbCount()).toBe(1);
		} finally {
			for (const alias of aliases) {
				fs.rmSync(alias, { recursive: true, force: true });
			}
		}
	});

	test('Windows case aliases share one handle', () => {
		if (process.platform !== 'win32') return;
		const direct = getProjectDb(tempDir);
		expect(getProjectDb(tempDir.toUpperCase())).toBe(direct);
	});
});
