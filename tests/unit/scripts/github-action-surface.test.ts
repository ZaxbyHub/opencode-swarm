import { describe, expect, test } from 'bun:test';
import {
	loadActionSurface,
	requireActionWiring,
	requireDesignatedCaller,
	requireSecureCaller,
} from './github-action-contract';

describe('issue #2498 — published Action surface', () => {
	test('has one manifest and a designated by-ref two-job caller', () => {
		const surface = loadActionSurface();
		expect(surface.manifest.name).toEqual(expect.any(String));
		expect(surface.manifest.description).toEqual(expect.any(String));
		requireActionWiring(surface);
		requireDesignatedCaller(surface);
		requireSecureCaller(surface);
	});

	test('fails closed before either phase on a non-Linux runner', () => {
		const { manifestText } = loadActionSurface();
		const guard = 'if [[ "${RUNNER_OS:-}" != "Linux" ]]; then';
		expect(manifestText.split(guard).length - 1).toBe(2);
	});
});
