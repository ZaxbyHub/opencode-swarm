import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_REPO_LIFECYCLE_RULES,
	evaluateRepoLifecycleWhen,
	resolveRepoLaneName,
	type RepoLifecycleContext,
} from '../../../src/vcs/repo-lifecycle';

describe('repo lifecycle CEL-shaped when', () => {
	const landCtx: RepoLifecycleContext = {
		engineRepo: true,
		event: 'land_lane',
		laneName: 'swarm-ses_abc-task-1',
		title: 'Fix gate',
		prBase: 'main',
	};

	test('structured when matches engine land_lane', () => {
		const rule = DEFAULT_REPO_LIFECYCLE_RULES.find((r) => r.id === 'engine_land_review');
		expect(rule).toBeDefined();
		expect(evaluateRepoLifecycleWhen(rule!.when, landCtx)).toBe(true);
	});

	test('CEL string engine_repo && event == integrate_lane', () => {
		const integrateCtx: RepoLifecycleContext = {
			...landCtx,
			event: 'integrate_lane',
		};
		expect(
			evaluateRepoLifecycleWhen('engine_repo && event == integrate_lane', integrateCtx),
		).toBe(true);
		expect(
			evaluateRepoLifecycleWhen('engine_repo && event == integrate_lane', landCtx),
		).toBe(false);
	});

	test('resolveRepoLaneName from swarm branch grammar', () => {
		expect(
			resolveRepoLaneName('/tmp', 'swarm/lane/ses_abc/task-1'),
		).toBe('swarm-ses_abc-task-1');
	});
});
