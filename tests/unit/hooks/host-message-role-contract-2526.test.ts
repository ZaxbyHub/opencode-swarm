/**
 * Issue #2526 host-contract pin.
 *
 * Two gates:
 *  1. Version tripwire — the installed `@opencode-ai/plugin` and
 *     `@opencode-ai/sdk` versions must equal the version this fixture was
 *     distilled from (anomalyco/opencode@v1.18.3). A lockfile bump fails here
 *     and forces re-verification of
 *     `tests/helpers/host-contract-v1_18_3.ts` against the new host source.
 *  2. Rendered-role set — pins WHICH roles the host's converter renders:
 *     user and assistant only; system never; flat entries throw. This is the
 *     contract every plugin guidance carrier depends on.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
	type HostPartsMessage,
	hostToModelMessages,
	PINNED_HOST_PACKAGE_VERSION,
} from '../../helpers/host-contract-v1_18_3';

function installedVersion(pkg: string): string {
	const pkgPath = path.join(process.cwd(), 'node_modules', pkg, 'package.json');
	const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
		version?: string;
	};
	if (typeof pkgJson.version !== 'string') {
		throw new Error(`no version field in ${pkgPath}`);
	}
	return pkgJson.version;
}

describe('host-contract pin (issue #2526)', () => {
	test('installed @opencode-ai packages match the pinned host version', () => {
		for (const pkg of ['@opencode-ai/plugin', '@opencode-ai/sdk']) {
			const version = installedVersion(pkg);
			expect(version).toBe(PINNED_HOST_PACKAGE_VERSION);
		}
	});

	test('the lockfile resolves both packages at the pinned version', () => {
		// The issue pins this contract to the LOCKFILE version: read bun.lock
		// directly so a dependency bump is caught even before `bun install`
		// updates node_modules.
		const lock = readFileSync(path.join(process.cwd(), 'bun.lock'), 'utf-8');
		for (const pkg of ['@opencode-ai/plugin', '@opencode-ai/sdk']) {
			expect(lock).toContain(`"${pkg}@${PINNED_HOST_PACKAGE_VERSION}"`);
		}
	});

	test('user entries with a non-empty text part render', () => {
		const message: HostPartsMessage = {
			info: { id: 'swarm-guidance:test', role: 'user' },
			parts: [{ type: 'text', text: 'deliver me' }],
		};
		const rendered = hostToModelMessages([message]);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]?.role).toBe('user');
		expect(rendered[0]?.parts[0]?.text).toBe('deliver me');
	});

	test('assistant entries render (user/assistant only — the rendered role set)', () => {
		const rendered = hostToModelMessages([
			{
				info: { id: 'a1', role: 'assistant' },
				parts: [{ type: 'text', text: 'ok' }],
			},
		]);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]?.role).toBe('assistant');
	});

	test('system entries are silently dropped — the defect behind #2526', () => {
		const rendered = hostToModelMessages([
			{
				info: { id: 'u1', role: 'user' },
				parts: [{ type: 'text', text: 'real user' }],
			},
			{
				info: { role: 'system' },
				parts: [{ type: 'text', text: '[ADVISORIES] dark' }],
			},
		]);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]?.role).toBe('user');
	});

	test('flat entries without parts throw the host TypeError (issue-trace class)', () => {
		const flat = {
			role: 'system',
			content: [{ type: 'text', text: '[MODE: TRACE]' }],
		} as unknown as HostPartsMessage;
		expect(() => hostToModelMessages([flat])).toThrow(TypeError);
	});

	test('empty-parts user entries are skipped; empty-text parts are dropped', () => {
		const rendered = hostToModelMessages([
			{ info: { id: 'empty', role: 'user' }, parts: [] },
			{
				info: { id: 'blank', role: 'user' },
				parts: [{ type: 'text', text: '' }],
			},
			{
				info: { id: 'mixed', role: 'user' },
				parts: [
					{ type: 'text', text: '' },
					{ type: 'text', text: 'survivor' },
				],
			},
		]);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]?.parts).toEqual([{ type: 'text', text: 'survivor' }]);
	});
});
