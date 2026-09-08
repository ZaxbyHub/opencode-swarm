/**
 * Acceptance checks for issue #2486 — AC6 (preview + explicit confirmation).
 *
 * Frozen contract: .agents/issue-traces/2486-consented-training-vault-export/check-contract.md
 *
 * previewTrainingExport is a pure read (writes nothing, issues no token).
 * executeTrainingExport fails closed without a token, on a wrong token, on a
 * token bound to a different scope, and on an expired token (15-minute TTL,
 * simulated with the frozen test clock). A correct token executes exactly
 * once; the consumed token is refused on reuse, and a fresh token re-exports
 * the identical content idempotently.
 *
 * RED at base: src/training/* does not exist yet.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { grantTrainingConsent } from '../../../src/training/consent.js';
import {
	executeTrainingExport,
	issueTrainingConfirmToken,
	previewTrainingExport,
} from '../../../src/training/exporter.js';
import {
	trainingExportsDir,
	trainingRootDir,
} from '../../../src/training/paths.js';
import {
	appendTrainingVaultRecord,
	buildTrainingVaultRecord,
} from '../../../src/training/vault.js';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

type Consent = ReturnType<typeof grantTrainingConsent>;

// Fixed instant inside the far-future consent validity window used below.
const TOKEN_EPOCH_MS = 1_800_000_000_000;
const TTL_MS = 15 * 60_000;

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Grants a consent valid far into the future (so frozen-clock windows stay
 * inside its validity) and appends two records.
 */
function seedVault(dir: string): Consent {
	const consent = grantTrainingConsent(dir, {
		quotas: { maxBytes: 10_485_760, maxRecords: 100, retentionDays: 30 },
		expiresAt: '2030-01-01T00:00:00.000Z',
	});
	for (const [kind, role, content, sessionId] of [
		['user_message', 'user', 'preview target one', 'sess-p1'],
		['assistant_message', 'assistant', 'preview target two', 'sess-p1'],
	] as const) {
		const record = buildTrainingVaultRecord({
			directory: dir,
			kind,
			role,
			content,
			sessionId,
			pluginVersion: 'test-0.0.0',
			source: 'chat',
			consent,
			now: new Date('2026-06-01T10:00:00.000Z'),
		});
		const res = appendTrainingVaultRecord(dir, record);
		expect(res.appended).toBe(true);
	}
	return consent;
}

function exportsDirEmpty(dir: string): boolean {
	const dirPath = trainingExportsDir(dir);
	return !fs.existsSync(dirPath) || fs.readdirSync(dirPath).length === 0;
}

describe('AC6 preview - side-effect-free preview', () => {
	test('preview writes nothing, issues no token, and leaves the vault untouched', () => {
		const dir = canonicalMkdtemp('training-ac6-preview-');
		try {
			seedVault(dir);
			const vaultPath = path.join(
				trainingRootDir(dir),
				'vault',
				'records.jsonl',
			);
			const before = fs.readFileSync(vaultPath, 'utf-8');

			const preview = previewTrainingExport(dir);
			expect(preview.requiresConfirm).toBe(true);
			expect(preview.recordCount).toBe(2);
			expect(preview.exportId).toMatch(/^[0-9a-f]{16}$/);
			expect(typeof preview.estimatedBytes).toBe('number');
			expect(preview.estimatedBytes).toBeGreaterThan(0);
			expect(typeof preview.destination).toBe('string');
			expect(preview.destination.length).toBeGreaterThan(0);
			expect(preview.split.train + preview.split.validation).toBe(2);
			expect(preview.quarantinedExcluded).toBe(0);

			// No files written, no pending op slot created.
			expect(exportsDirEmpty(dir)).toBe(true);
			expect(
				fs.existsSync(path.join(trainingRootDir(dir), 'pending-op.json')),
			).toBe(false);
			// The vault was not rewritten.
			expect(fs.readFileSync(vaultPath, 'utf-8')).toBe(before);
		} finally {
			rmDir(dir);
		}
	});
});

describe('AC6 confirm - execute fails closed on bad or stale tokens', () => {
	test('execute without a token fails closed', () => {
		const dir = canonicalMkdtemp('training-ac6-notoken-');
		try {
			seedVault(dir);
			const res = executeTrainingExport(dir, undefined, { confirmToken: '' });
			expect(res.written).toBe(false);
			expect(res.reason).toBe('token_mismatch');
			expect(exportsDirEmpty(dir)).toBe(true);
		} finally {
			rmDir(dir);
		}
	});

	test('wrong token is refused with no state change', () => {
		const dir = canonicalMkdtemp('training-ac6-wrong-');
		try {
			seedVault(dir);
			const res = executeTrainingExport(dir, undefined, {
				confirmToken: 'f'.repeat(24),
			});
			expect(res.written).toBe(false);
			expect(res.reason).toBe('token_mismatch');
			expect(exportsDirEmpty(dir)).toBe(true);
		} finally {
			rmDir(dir);
		}
	});

	test('valid token bound to a different scope is refused as scope_changed', () => {
		const dir = canonicalMkdtemp('training-ac6-scope-');
		try {
			seedVault(dir);
			const preview = previewTrainingExport(dir);
			const token = issueTrainingConfirmToken(dir, {
				kind: 'export',
				digest: preview.exportId,
			});
			// Execute with filters that differ from the previewed scope.
			const res = executeTrainingExport(
				dir,
				{ kinds: ['user_message'] },
				{ confirmToken: token },
			);
			expect(res.written).toBe(false);
			expect(res.reason).toBe('scope_changed');
			expect(exportsDirEmpty(dir)).toBe(true);
		} finally {
			rmDir(dir);
		}
	});

	test('expired token is refused (15-minute TTL, frozen clock)', () => {
		const dir = canonicalMkdtemp('training-ac6-expired-');
		try {
			seedVault(dir);
			const preview = previewTrainingExport(dir);
			const token = withFrozenClock(
				() =>
					issueTrainingConfirmToken(dir, {
						kind: 'export',
						digest: preview.exportId,
					}),
				{ fixedNow: TOKEN_EPOCH_MS },
			);
			const res = withFrozenClock(
				() => executeTrainingExport(dir, undefined, { confirmToken: token }),
				{ fixedNow: TOKEN_EPOCH_MS + TTL_MS + 60_000 },
			);
			expect(res.written).toBe(false);
			expect(res.reason).toBe('token_expired');
			expect(exportsDirEmpty(dir)).toBe(true);
		} finally {
			rmDir(dir);
		}
	});

	test('empty vault export is refused with reason empty', () => {
		const dir = canonicalMkdtemp('training-ac6-empty-');
		try {
			grantTrainingConsent(dir, { expiresAt: '2030-01-01T00:00:00.000Z' });
			const preview = previewTrainingExport(dir);
			expect(preview.recordCount).toBe(0);
			const token = issueTrainingConfirmToken(dir, {
				kind: 'export',
				digest: preview.exportId,
			});
			const res = executeTrainingExport(dir, undefined, {
				confirmToken: token,
			});
			expect(res.written).toBe(false);
			expect(res.reason).toBe('empty');
		} finally {
			rmDir(dir);
		}
	});
});

describe('AC6 confirm - correct token executes exactly once', () => {
	test('single-use token executes, is refused on reuse, and a fresh token re-exports idempotently', () => {
		const dir = canonicalMkdtemp('training-ac6-once-');
		try {
			seedVault(dir);
			const preview = previewTrainingExport(dir);
			const token = withFrozenClock(
				() =>
					issueTrainingConfirmToken(dir, {
						kind: 'export',
						digest: preview.exportId,
					}),
				{ fixedNow: TOKEN_EPOCH_MS },
			);

			const first = withFrozenClock(
				() => executeTrainingExport(dir, undefined, { confirmToken: token }),
				{ fixedNow: TOKEN_EPOCH_MS + 60_000 },
			);
			expect(first.written).toBe(true);
			expect(first.exportId).toBe(preview.exportId);
			expect(first.destination).toBeTruthy();
			const destination = first.destination as string;
			for (const name of [
				'records.jsonl',
				'train.jsonl',
				'validation.jsonl',
				'manifest.json',
			]) {
				expect(fs.existsSync(path.join(destination, name))).toBe(true);
			}
			const manifest = JSON.parse(
				fs.readFileSync(path.join(destination, 'manifest.json'), 'utf-8'),
			);
			expect(manifest.counts.total).toBe(2);

			// The consumed token must not work a second time.
			const replay = withFrozenClock(
				() => executeTrainingExport(dir, undefined, { confirmToken: token }),
				{ fixedNow: TOKEN_EPOCH_MS + 120_000 },
			);
			expect(replay.written).toBe(false);
			expect(replay.reason).toBe('token_mismatch');

			// A fresh token re-exports the identical content idempotently: same
			// exportId, no duplicate rows, still exactly one export directory.
			const token2 = withFrozenClock(
				() =>
					issueTrainingConfirmToken(dir, {
						kind: 'export',
						digest: preview.exportId,
					}),
				{ fixedNow: TOKEN_EPOCH_MS + 180_000 },
			);
			const second = withFrozenClock(
				() => executeTrainingExport(dir, undefined, { confirmToken: token2 }),
				{ fixedNow: TOKEN_EPOCH_MS + 240_000 },
			);
			expect(second.written).toBe(true);
			expect(second.exportId).toBe(preview.exportId);
			const recordsText = fs.readFileSync(
				path.join(destination, 'records.jsonl'),
				'utf-8',
			);
			expect(recordsText.split('\n').filter(Boolean)).toHaveLength(2);
			expect(fs.readdirSync(trainingExportsDir(dir))).toHaveLength(1);
		} finally {
			rmDir(dir);
		}
	});
});
