import { describe, expect, it } from 'bun:test';
import { derivePlanId } from '../../../src/plan/utils';

describe('derivePlanId', () => {
	it('combines swarm and title with hyphen', () => {
		expect(derivePlanId({ swarm: 'mega', title: 'My Project' })).toBe(
			'mega-My_Project',
		);
	});

	it('replaces special characters with underscore', () => {
		expect(derivePlanId({ swarm: 'mega', title: 'Hello World! @#$%' })).toBe(
			'mega-Hello_World______',
		);
	});

	it('replaces non-alphanumeric characters (except hyphen and underscore) with underscore', () => {
		const result = derivePlanId({ swarm: 'local', title: 'test.v2.0' });
		expect(result).toBe('local-test_v2_0');
	});

	it('preserves hyphens and underscores', () => {
		expect(derivePlanId({ swarm: 'my-swarm', title: 'my_project' })).toBe(
			'my-swarm-my_project',
		);
	});

	it('preserves numbers', () => {
		expect(derivePlanId({ swarm: 'v2', title: 'Project 123' })).toBe(
			'v2-Project_123',
		);
	});

	it('handles empty strings', () => {
		expect(derivePlanId({ swarm: '', title: '' })).toBe('-');
	});

	it('handles unicode characters by replacing with underscore', () => {
		expect(derivePlanId({ swarm: 'mega', title: 'Projét' })).toBe(
			'mega-Proj_t',
		);
	});

	it('handles long titles', () => {
		const longTitle = 'A'.repeat(500);
		const result = derivePlanId({ swarm: 'mega', title: longTitle });
		expect(result).toBe(`mega-${longTitle}`);
	});

	it('matches the original inline pattern', () => {
		// Verify the canonical function produces the same result as the original inline pattern
		const plan = {
			swarm: 'mega',
			title: 'Stage B Hardcoded Parallel + final_council Gate',
		};
		const canonical = derivePlanId(plan);
		const inline = `${plan.swarm}-${plan.title}`.replace(
			/[^a-zA-Z0-9-_]/g,
			'_',
		);
		expect(canonical).toBe(inline);
	});
});
