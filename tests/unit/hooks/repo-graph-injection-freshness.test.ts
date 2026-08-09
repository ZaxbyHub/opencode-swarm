import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	_internals,
	getCachedGraph,
	resetGraphInjectionCache,
} from '../../../src/hooks/repo-graph-injection';
import {
	createEmptyGraph,
	type FreshnessProbe,
	saveGraph,
} from '../../../src/tools/repo-graph';

const originalProbe = _internals.probeFreshness;
let tmp: string;

function result(
	state: FreshnessProbe['state'],
	changed: string[] = [],
	removed: string[] = [],
): FreshnessProbe {
	return {
		state,
		changed,
		removed,
		truncated: state === 'inconclusive',
		probedFiles: 1,
		elapsedMs: 1,
	};
}

beforeEach(async () => {
	resetGraphInjectionCache();
	tmp = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'repo-graph-injection-freshness-')),
	);
	await saveGraph(tmp, createEmptyGraph(tmp));
});

afterEach(() => {
	_internals.probeFreshness = originalProbe;
	resetGraphInjectionCache();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('repo graph injection freshness gate', () => {
	test('serves clean and all inconclusive graphs as freshness-unknown', async () => {
		_internals.probeFreshness = async () => result('clean');
		expect(await getCachedGraph(tmp)).not.toBeNull();

		_internals.probeFreshness = async () =>
			result('inconclusive', [path.join(tmp, 'src/a.ts')]);
		expect(await getCachedGraph(tmp)).not.toBeNull();
	});

	test('applies the configured cap to complete changed and removed drift', async () => {
		_internals.probeFreshness = async () =>
			result(
				'drifted',
				[path.join(tmp, 'src/a.ts')],
				[path.join(tmp, 'src/b.ts')],
			);
		expect(await getCachedGraph(tmp, { refreshCap: 2 })).not.toBeNull();
		expect(await getCachedGraph(tmp, { refreshCap: 1 })).toBeNull();

		_internals.probeFreshness = async () => result('no-fingerprint');
		expect(await getCachedGraph(tmp)).toBeNull();
	});

	test('disabled mode evicts and returns null without probing', async () => {
		let probeCalls = 0;
		_internals.probeFreshness = async () => {
			probeCalls++;
			return result('clean');
		};

		expect(await getCachedGraph(tmp)).not.toBeNull();
		expect(await getCachedGraph(tmp, { enabled: false })).toBeNull();
		expect(probeCalls).toBe(1);
	});

	test('bounds the graph-file cache to sixteen normalized workspaces', async () => {
		_internals.probeFreshness = async () => result('clean');
		const roots: string[] = [];
		try {
			for (let index = 0; index < 17; index++) {
				const root = fs.realpathSync(
					fs.mkdtempSync(path.join(os.tmpdir(), `repo-graph-lru-${index}-`)),
				);
				roots.push(root);
				await saveGraph(root, createEmptyGraph(root));
				expect(await getCachedGraph(root)).not.toBeNull();
			}
			expect(_internals.cacheSize()).toBe(16);
		} finally {
			for (const root of roots) {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});
});
