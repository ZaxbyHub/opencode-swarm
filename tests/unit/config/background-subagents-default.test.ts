/**
 * #1674 v8 composition-constraint guard.
 *
 * The v8 flagship epic (#1674) and the background-subagent-delegation GA epic
 * (#1676) must NOT both flip their defaults in the same release — the gate-
 * evidence race surface compounds in ways neither burn-in period has tested
 * independently. This test guards that constraint: it fails if
 * `hooks.background_subagents` ever flips to `true` by default, which would
 * indicate #1676 GA landed alongside this v8 flip.
 *
 * Run before merging #1674. If this test fails, coordinate with #1676 to
 * sequence the two flips into separate releases.
 */

import { describe, expect, test } from 'bun:test';
import { HooksConfigSchema } from '../../../src/config/schema';

describe('#1674/#1676 composition constraint — background_subagents default', () => {
	test('hooks.background_subagents schema default is still false', () => {
		// Parse an empty hooks object; the schema fills in defaults.
		const parsed = HooksConfigSchema.parse({});
		expect(parsed.background_subagents).toBe(false);
	});

	test('the schema still REJECTS a non-boolean background_subagents', () => {
		const result = HooksConfigSchema.safeParse({
			background_subagents: 'yes',
		});
		expect(result.success).toBe(false);
	});
});
