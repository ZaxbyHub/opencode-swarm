/**
 * #1850: gateway-level cohort integration tests (H-005).
 * Verifies the gateway's scopeKey + resolveRecordScope correctly handle
 * cohort-linked scenarios at the gateway level (not just schema-level).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MEMORY_CONFIG } from '../../../src/memory/config';
import { MemoryGateway } from '../../../src/memory/gateway';
import { writeMemoryLinkPointer } from '../../../src/memory/memory-link';
import { clearPool } from '../../../src/memory/provider-pool';

function makeTmp(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe('#1850 gateway cohort integration (H-005)', () => {
	const dirs: string[] = [];
	let prevXdg: string | undefined;
	let prevHome: string | undefined;

	beforeEach(() => {
		prevXdg = process.env.XDG_DATA_HOME;
		prevHome = process.env.HOME;
		const dataDir = makeTmp('gw-cohort-data-');
		dirs.push(dataDir);
		process.env.XDG_DATA_HOME = dataDir;
		process.env.HOME = dataDir;
	});

	afterEach(() => {
		process.env.XDG_DATA_HOME = prevXdg;
		process.env.HOME = prevHome;
		clearPool();
		for (const d of dirs.splice(0)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	test('F-27: cohort-linked gateway emits a cohort scope in deriveAllowedScopes', async () => {
		const dir = makeTmp('gw-linked-');
		dirs.push(dir);
		await writeMemoryLinkPointer(dir, {
			version: 2,
			linkId: 'gw-test-cohort',
			createdAt: new Date().toISOString(),
			cohortId: 'gw-cohort-id',
			generation: 1,
		});
		const config = {
			...DEFAULT_MEMORY_CONFIG,
			enabled: true,
			link: { enabled: true },
		};
		const gw = new MemoryGateway(
			{ directory: dir, sessionID: 'test-session' },
			{ config },
		);
		const scopes = gw.deriveAllowedScopes();
		const cohortScope = scopes.find((s) => s.type === 'cohort');
		expect(cohortScope).toBeDefined();
		expect(cohortScope?.cohortId).toBe('gw-cohort-id');
		// run/agent scopes should still be present (session isolation).
		expect(scopes.some((s) => s.type === 'run')).toBe(true);
	});

	test('F-28: non-linked gateway does NOT emit a cohort scope', () => {
		const dir = makeTmp('gw-unlinked-');
		dirs.push(dir);
		const config = { ...DEFAULT_MEMORY_CONFIG, enabled: true };
		const gw = new MemoryGateway({ directory: dir }, { config });
		const scopes = gw.deriveAllowedScopes();
		expect(scopes.find((s) => s.type === 'cohort')).toBeUndefined();
	});

	test('F-29: link.enabled=false does not emit cohort even with pointer', async () => {
		const dir = makeTmp('gw-disabled-');
		dirs.push(dir);
		await writeMemoryLinkPointer(dir, {
			version: 2,
			linkId: 'gw-disabled-cohort',
			createdAt: new Date().toISOString(),
			cohortId: 'gw-disabled-id',
			generation: 1,
		});
		// link.enabled is false (default) — cohort should NOT be active.
		const config = { ...DEFAULT_MEMORY_CONFIG, enabled: true };
		const gw = new MemoryGateway({ directory: dir }, { config });
		const scopes = gw.deriveAllowedScopes();
		expect(scopes.find((s) => s.type === 'cohort')).toBeUndefined();
	});

	test('F-30: createRecord defaults durable records to cohort scope when linked', async () => {
		const dir = makeTmp('gw-durable-');
		dirs.push(dir);
		await writeMemoryLinkPointer(dir, {
			version: 2,
			linkId: 'gw-durable-cohort',
			createdAt: new Date().toISOString(),
			cohortId: 'gw-durable-id',
			generation: 1,
		});
		const config = {
			...DEFAULT_MEMORY_CONFIG,
			enabled: true,
			link: { enabled: true },
		};
		const gw = new MemoryGateway({ directory: dir }, { config });
		const record = gw.createRecord({
			kind: 'project_fact',
			text: 'durable cohort test',
			source: { type: 'manual', ref: 'test' },
		});
		expect(record.scope.type).toBe('cohort');
		expect(record.scope.cohortId).toBe('gw-durable-id');
	});

	test('F-31: createRecord defaults ephemeral (scratch) records to local scope even when linked', async () => {
		const dir = makeTmp('gw-scratch-');
		dirs.push(dir);
		await writeMemoryLinkPointer(dir, {
			version: 2,
			linkId: 'gw-scratch-cohort',
			createdAt: new Date().toISOString(),
			cohortId: 'gw-scratch-id',
			generation: 1,
		});
		const config = {
			...DEFAULT_MEMORY_CONFIG,
			enabled: true,
			link: { enabled: true },
		};
		const gw = new MemoryGateway({ directory: dir }, { config });
		const record = gw.createRecord({
			kind: 'scratch',
			text: 'scratch should stay local',
		});
		// Scratch defaults to ephemeral stability → should NOT be cohort-scoped.
		expect(record.scope.type).not.toBe('cohort');
		expect(record.stability).toBe('ephemeral');
	});
});
