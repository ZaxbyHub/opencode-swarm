import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	_snapshotCoordinationInternals,
	startSnapshotCoordinationInitialization,
} from '../../../src/session/snapshot-coordination-init.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('snapshot coordination readiness bounds', () => {
	let root: string;
	const originalInitialize = _snapshotCoordinationInternals.initialize;
	const originalTimeout = _snapshotCoordinationInternals.timeoutMs;

	beforeEach(() => {
		root = canonicalMkdtemp('snapshot-coordination-cap-');
		_snapshotCoordinationInternals.entries.clear();
	});

	afterEach(() => {
		_snapshotCoordinationInternals.initialize = originalInitialize;
		_snapshotCoordinationInternals.timeoutMs = originalTimeout;
		_snapshotCoordinationInternals.entries.clear();
	});

	test('refuses a new root when all readiness slots are unsettled', async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		_snapshotCoordinationInternals.initialize = async () => blocked;
		_snapshotCoordinationInternals.timeoutMs = 1;

		const attempts = Array.from({ length: 32 }, (_, index) =>
			startSnapshotCoordinationInitialization(
				path.join(root, `root-${index.toString().padStart(2, '0')}`),
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(_snapshotCoordinationInternals.entries.size).toBe(32);
		await expect(
			startSnapshotCoordinationInitialization(path.join(root, 'overflow')),
		).rejects.toThrow(/capacity exhausted/i);
		release();
		await Promise.all(attempts);
	});
});
