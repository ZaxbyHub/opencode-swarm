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
const realRunAutoDemotion = _internals.runAutoDemotion;
const config = KnowledgeConfigSchema.parse({});
const LESSON =
	'Run the full test suite before declaring a phase complete to catch cross-task regressions that per-task checks miss.';

// Realigned (Change 4): prose lessons must pass the Layer-5 actionability gate
// to reach the active store. This suite tests skipAutoPromotion, not the gate
// (which has dedicated suites), so provide an enrichment delegate that returns
// valid v3 fields and lets the entry store through the real pipeline.
const v3Delegate = async (): Promise<string> =>
	JSON.stringify({
		applies_to_agents: ['architect'],
		required_actions: ['run the full test suite before phase completion'],
	});

beforeEach(() => {
	tempDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'swarm-skip-promo-')),
	);
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	_internals.runAutoPromotion = realRunAutoPromotion;
	_internals.runAutoDemotion = realRunAutoDemotion;
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
			{ skipAutoPromotion: true, llmDelegate: v3Delegate },
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
			{ llmDelegate: v3Delegate },
		);

		expect(spy).toHaveBeenCalledTimes(1);
	});

	// G7 (#1716) — the phase_number > 0 gate: close.ts hardcodes
	// { phase_number: 0 }, so demotion must NOT run at close time. Phase-complete
	// passes the real phase number and demotion runs there only.
	test('G7: does NOT call runAutoDemotion when phase_number is 0 (close-time gate)', async () => {
		const promoSpy = mock(async () => {});
		const demotionSpy = mock(async () => {});
		_internals.runAutoPromotion = promoSpy;
		_internals.runAutoDemotion = demotionSpy;

		await curateAndStoreSwarm(
			[LESSON],
			'proj',
			{ phase_number: 0 }, // close.ts path
			tempDir,
			config,
			{ llmDelegate: v3Delegate },
		);

		// Promotion runs (no skipAutoPromotion); demotion does NOT (phase 0 gate).
		expect(promoSpy).toHaveBeenCalledTimes(1);
		expect(demotionSpy).not.toHaveBeenCalled();
	});

	test('G7: calls runAutoDemotion when phase_number > 0 (phase-complete path)', async () => {
		const promoSpy = mock(async () => {});
		const demotionSpy = mock(async () => {});
		_internals.runAutoPromotion = promoSpy;
		_internals.runAutoDemotion = demotionSpy;

		await curateAndStoreSwarm(
			[LESSON],
			'proj',
			{ phase_number: 5 }, // phase-complete.ts path
			tempDir,
			config,
			{ llmDelegate: v3Delegate },
		);

		expect(promoSpy).toHaveBeenCalledTimes(1);
		expect(demotionSpy).toHaveBeenCalledTimes(1);
		expect(demotionSpy).toHaveBeenCalledWith(tempDir, config, 5);
	});

	test('G7: skipAutoPromotion also skips runAutoDemotion (they are a pair)', async () => {
		const promoSpy = mock(async () => {});
		const demotionSpy = mock(async () => {});
		_internals.runAutoPromotion = promoSpy;
		_internals.runAutoDemotion = demotionSpy;

		await curateAndStoreSwarm(
			[LESSON],
			'proj',
			{ phase_number: 3 },
			tempDir,
			config,
			{ skipAutoPromotion: true, llmDelegate: v3Delegate },
		);

		expect(promoSpy).not.toHaveBeenCalled();
		expect(demotionSpy).not.toHaveBeenCalled();
	});
});
