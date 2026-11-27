/** Real v2 mapper contract against synthetic 2.3.0 schema fixtures.
 * Schema: packages/schema/src/session-event.ts at OpenCode 2.3.0.
 * This is not a live host test; fixture shape drift requires deliberate review.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mapV2EventToV1 } from './events.js';
import {
	clearTrackedNativeChildrenForTests,
	rememberVerifiedNativeChild,
} from './native-async-mode.js';
import type { V2EventEnvelope } from './types.js';

type Fixture = {
	id: string;
	type: string;
	data: Record<string, unknown>;
	expected: string | null;
	partType?: string;
	toolStatus?: string;
	synthetic?: boolean;
};
const fixtures = JSON.parse(
	readFileSync(
		new URL('./fixtures/opencode23-events.json', import.meta.url),
		'utf8',
	),
) as {
	compatibilityTarget: string;
	events: Fixture[];
};

beforeEach(clearTrackedNativeChildrenForTests);

describe('OpenCode 2.3.0 payload contract', () => {
	test('all 20 version-pinned host envelopes preserve their intended semantics', () => {
		expect(fixtures.compatibilityTarget).toBe('OpenCode 2.3.0');
		expect(fixtures.events).toHaveLength(20);
		expect(
			rememberVerifiedNativeChild('ses_verified_child', 'ses_parent'),
		).toBe(true);
		for (const envelope of fixtures.events) {
			const translated = mapV2EventToV1(envelope as V2EventEnvelope, () =>
				envelope.data.id === 'call_a' ? 'shell' : undefined,
			);
			expect(translated?.type ?? null).toBe(envelope.expected);
			if (envelope.partType) {
				const part = translated?.properties.part as
					| Record<string, unknown>
					| undefined;
				expect(part?.type).toBe(envelope.partType);
				expect(part?.sessionID).toBe(envelope.data.sessionID);
				if (envelope.toolStatus) {
					const state = part?.state as Record<string, unknown> | undefined;
					expect(state?.status).toBe(envelope.toolStatus);
					expect(state?.metadata).toBeUndefined();
				}
				if (envelope.synthetic !== undefined) {
					expect(part?.synthetic).toBe(envelope.synthetic);
				}
			}
		}
	});
	test('non-subagent tool progress cannot activate a child lease', () => {
		const translated = mapV2EventToV1(
			{
				type: 'session.tool.progress',
				data: {
					sessionID: 'ses_parent',
					id: 'call_shell',
					metadata: { sessionID: 'ses_foreign' },
				},
			} as V2EventEnvelope,
			() => 'shell',
		);
		expect(translated).toBeUndefined();
	});
});
