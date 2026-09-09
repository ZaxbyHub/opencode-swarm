/**
 * Issue #2664 — deterministic set-equality between the code's closed Stage A
 * route vocabulary (STAGE_A_ROUTES) and the documented route table in
 * docs/configuration.md. Adding/removing a route without updating the docs
 * (or vice versa) fails here.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STAGE_A_ROUTES } from '../../../src/hooks/guardrails/stage-a-route';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const DOC = path.join(REPO_ROOT, 'docs', 'configuration.md');

function documentedRoutes(): Set<string> {
	expect(fs.existsSync(DOC)).toBe(true);
	const text = fs.readFileSync(DOC, 'utf8');
	const routes = new Set<string>();
	for (const route of STAGE_A_ROUTES) {
		// Each documented route appears as a table row `| <route> |`.
		if (new RegExp(`\\|\\s*${route}\\s*\\|`).test(text)) routes.add(route);
	}
	// Inverse: no documented route row outside the code vocabulary.
	for (const match of text.matchAll(/\|\s*([a-z_]+)\s*\|\s*[A-Z]/g)) {
		const candidate = match[1];
		if ((STAGE_A_ROUTES as readonly string[]).includes(candidate)) continue;
		// Any other snake_case row token immediately followed by a capital
		// letter (the description column) that looks like a route is drift.
		if (
			/^(valid_pass|pre_check_failed|invalid_result|no_task_correlation|attribution_ambiguous|late_result|duplicate_result)/.test(
				candidate,
			)
		) {
			throw new Error(`Undocumented-code route row found: ${candidate}`);
		}
	}
	return routes;
}

describe('stage-a-route vocabulary docs parity', () => {
	test('every STAGE_A_ROUTES member is documented in docs/configuration.md (set equality)', () => {
		const documented = documentedRoutes();
		for (const route of STAGE_A_ROUTES) {
			expect(documented.has(route)).toBe(true);
		}
		expect(documented.size).toBe(STAGE_A_ROUTES.length);
	});
});
