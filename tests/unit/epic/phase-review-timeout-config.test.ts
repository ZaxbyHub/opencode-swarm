/**
 * `epic.phase_review.timeout_ms`: schema bounds (identical to
 * `auto_review.timeout_ms`), the resolver's default / configured / legacy
 * `turbo.epic` paths, and the epic_phase_review tool handing the configured
 * value to runEpicPhaseReview.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { EpicConfigSchema } from '../../../src/config/schema';
import {
	EPIC_PHASE_REVIEW_DISPATCH_TIMEOUT_MS,
	resolveEpicPhaseReviewTimeoutMs,
} from '../../../src/epic/phase-readiness';
import {
	_internals,
	executeEpicPhaseReview,
} from '../../../src/tools/epic-phase-review';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { writeProjectConfig } from './start-fixture';

const realInternals = { ..._internals };
let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('epic-review-timeout-');
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('EpicConfigSchema phase_review.timeout_ms', () => {
	test('defaults to 300 s and accepts 10 s – 30 min', () => {
		const parsed = EpicConfigSchema.parse({ phase_review: {} });
		expect(parsed.phase_review?.timeout_ms).toBe(300_000);
		expect(
			EpicConfigSchema.parse({ phase_review: { timeout_ms: 10_000 } })
				.phase_review?.timeout_ms,
		).toBe(10_000);
		expect(
			EpicConfigSchema.parse({ phase_review: { timeout_ms: 1_800_000 } })
				.phase_review?.timeout_ms,
		).toBe(1_800_000);
	});

	test('rejects out-of-range, fractional and unknown values', () => {
		for (const bad of [
			{ timeout_ms: 9_999 },
			{ timeout_ms: 1_800_001 },
			{ timeout_ms: 1500.5 },
			{ timeout_ms: 300_000, extra: true },
		]) {
			expect(EpicConfigSchema.safeParse({ phase_review: bad }).success).toBe(
				false,
			);
		}
	});
});

describe('resolveEpicPhaseReviewTimeoutMs', () => {
	test('is the default when nothing is configured', () => {
		writeProjectConfig(dir, { epic: { mode: { enabled: true } } });
		expect(resolveEpicPhaseReviewTimeoutMs(dir)).toBe(
			EPIC_PHASE_REVIEW_DISPATCH_TIMEOUT_MS,
		);
	});

	test('reads the top-level epic block', () => {
		writeProjectConfig(dir, {
			epic: {
				mode: { enabled: true },
				phase_review: { timeout_ms: 900_000 },
			},
		});
		expect(resolveEpicPhaseReviewTimeoutMs(dir)).toBe(900_000);
	});

	test('reads the legacy turbo.epic path through the migration', () => {
		writeProjectConfig(dir, {
			turbo: {
				epic: {
					mode: { enabled: true },
					phase_review: { timeout_ms: 600_000 },
				},
			},
		});
		expect(resolveEpicPhaseReviewTimeoutMs(dir)).toBe(600_000);
	});
});

describe('epic_phase_review hands the configured timeout to the review', () => {
	test('runEpicPhaseReview receives resolveEpicPhaseReviewTimeoutMs(directory)', async () => {
		let received: number | undefined;
		_internals.isEpicOpenForProject = () => true;
		_internals.describeOpenEpicWaves = () => null;
		_internals.resolveEpicPhaseReviewTimeoutMs = (directory: string) =>
			directory === dir ? 123_000 : -1;
		_internals.runEpicPhaseReview = (async (
			_directory: string,
			phase: number,
			_session: string,
			options: { timeoutMs?: number },
		) => {
			received = options.timeoutMs;
			return {
				success: false,
				phase,
				reason: 'tasks-incomplete',
				message: 'stub',
			};
		}) as never;
		await executeEpicPhaseReview({ phase: 1 }, dir, 'arch-session');
		expect(received).toBe(123_000);
	});
});
