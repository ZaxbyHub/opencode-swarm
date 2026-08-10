import { describe, expect, test } from 'bun:test';
import type { Plan } from '../../../src/config/plan-schema';
import { derivePlanMarkdown } from '../../../src/plan/manager';

function plan(files: string[]): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Quoted scope',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Scope',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Render scope',
						depends: [],
						files_touched: files,
					},
				],
			},
		],
	};
}

describe('derivePlanMarkdown files_touched projection', () => {
	test('renders sorted JSON-quoted paths without making markdown authoritative', () => {
		const markdown = derivePlanMarkdown(
			plan(['src/z.ts', 'docs/a "quoted".md', 'src/a.ts']),
		);
		expect(markdown).toContain(
			'files_touched: ["docs/a \\"quoted\\".md","src/a.ts","src/z.ts"]',
		);
	});

	test('omits empty scope metadata', () => {
		expect(derivePlanMarkdown(plan([]))).not.toContain('files_touched:');
	});
});
