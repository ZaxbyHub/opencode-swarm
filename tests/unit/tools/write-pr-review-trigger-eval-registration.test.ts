import { describe, expect, test } from 'bun:test';
import {
	AGENT_TOOL_MAP,
	WRITE_TOOL_NAMES,
} from '../../../src/config/constants';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import { TOOL_NAMES } from '../../../src/tools/tool-names';

describe('write_pr_review_trigger_eval registration', () => {
	test('is fully registered for Architect without becoming a generic write capability', () => {
		expect(TOOL_NAMES).toContain('write_pr_review_trigger_eval');
		expect(TOOL_MANIFEST.write_pr_review_trigger_eval).toBeDefined();
		expect(AGENT_TOOL_MAP.architect).toContain('write_pr_review_trigger_eval');
		expect(
			(WRITE_TOOL_NAMES as readonly string[]).includes(
				'write_pr_review_trigger_eval',
			),
		).toBe(false);
	});
});
