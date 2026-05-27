/**
 * Verifies the skipAutoPromotion option on curateAndStoreSwarm (issue #893, Chunk E):
 * propose-only callers must store candidate knowledge WITHOUT triggering auto-promotion
 * (which would promote unrelated pre-existing candidates as a side effect). Uses the
 * _internals DI seam + real temp dirs — no module mocks.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
import {
	_internals,
	curateAndStoreSwarm,
} from '../../../src/hooks/knowledge-curator';

let tempDir: string;
const realRunAutoPromotion = _internals.runAutoPromotion;
const config = KnowledgeConfigSchema.parse({});
const LESSON =
	'Run the full test suite before declaring a phase complete to catch cross-task regressions that per-task checks miss.';

beforeEach(() => {
	tempDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'swarm-skip-promo-')),
	);
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	_internals.runAutoPromotion = realRunAutoPromotion;
	rmSync(tempDir, { recursive: true, force: true });
});

describe('curateAndStoreSwarm skipAutoPromotion', () => {
	test('does NOT call runAutoPromotion when skipAutoPromotion is true', async () => {
		const spy = mock(async () => {});
		_internals.runAutoPromotion = spy;

		const result = await curateAndStoreSwarm(
			[LESSON],
			'proj',
			{ phase_number: 1 },
			tempDir,
			config,
			{ skipAutoPromotion: true },
		);

		expect(result.stored).toBe(1);
		expect(spy).not.toHaveBeenCalled();
	});

	test('calls runAutoPromotion by default (no options)', async () => {
		const spy = mock(async () => {});
		_internals.runAutoPromotion = spy;

		await curateAndStoreSwarm(
			[LESSON],
			'proj',
			{ phase_number: 1 },
			tempDir,
			config,
		);

		expect(spy).toHaveBeenCalledTimes(1);
	});
});
