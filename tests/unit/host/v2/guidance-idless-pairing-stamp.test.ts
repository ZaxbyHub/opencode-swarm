/**
 * Origin-stamp pairing for the v2 context bridge (src/host/v2/guidance.ts).
 *
 * Every v1 view is stamped `info.swarmV2Origin` (its index in the original
 * `event.messages`). Kept views pair to their original by object identity,
 * then `id`, then that stamp (role-checked for non-carriers). There is no
 * positional fallback: views the chain inserts carry no stamp and are dropped.
 *
 * Companion to guidance-idless-pairing.test.ts (kept split for the FR-006
 * 500-line cap). Covers the guardrails-rollback shape (every view replaced by
 * a structuredClone), stamp mechanics, retention of non-text messages whose
 * view the chain dropped, consumed carrier sources, and out-of-contract
 * (non-array) message content.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { materializeSystemGuidanceInPlace } from '../../../../src/hooks/messages-transform';
import { GUIDANCE_CARRIER_ID_PREFIX } from '../../../../src/hooks/system-guidance-carrier';
import { onV2ContextEvent } from '../../../../src/host/v2/guidance';
import type {
	V1HooksSubset,
	V2Message,
	V2SessionContextEvent,
} from '../../../../src/host/v2/types';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

type ViewMessage = {
	info: { id?: string; role?: string; [key: string]: unknown };
	parts: Array<{ type: string; text?: string }>;
};
type Transform = (messages: ViewMessage[]) => void;

function hooksWith(transform: Transform): V1HooksSubset {
	return {
		'experimental.chat.messages.transform': async (
			_input: unknown,
			output: { messages: ViewMessage[] },
		) => {
			transform(output.messages);
		},
	} as unknown as V1HooksSubset;
}

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	resetSwarmState();
	for (const dir of tempDirs.splice(0)) removeTreeWithRetry(dir);
});

const call = (id: string) => ({
	type: 'tool-call',
	id,
	name: 'shell',
	input: { command: 'true' },
});
const result = (id: string) => ({
	type: 'tool-result',
	id,
	name: 'shell',
	result: { type: 'text', value: 'ok' },
});
const text = (value: string) => ({ type: 'text', text: value });
const msg = (role: string, value: string, id?: string): V2Message => ({
	...(id === undefined ? {} : { id }),
	role,
	content: [text(value)],
});

function event(messages: V2Message[]): V2SessionContextEvent {
	return {
		sessionID: 'idless-stamp-session',
		agent: undefined,
		system: [],
		messages,
		options: {},
		tools: {},
	};
}

const textOf = (m: V2Message): string =>
	Array.isArray(m.content)
		? m.content
				.filter((p) => p.type === 'text')
				.map((p) => p.text)
				.join('')
		: '<opaque>';
const textsOf = (messages: V2Message[]) => messages.map(textOf);

/** Every tool-result must answer a tool-call in the message right before it. */
function orphanedResults(messages: V2Message[]): string[] {
	const orphans: string[] = [];
	messages.forEach((message, index) => {
		for (const part of message.content) {
			if (part.type !== 'tool-result') continue;
			const answered = messages[index - 1]?.content.some(
				(p) => p.type === 'tool-call' && p.id === part.id,
			);
			if (!answered) orphans.push(String(part.id));
		}
	});
	return orphans;
}

/** The guardrails rollback (src/index.ts): every view replaced by a clone. */
function rollback(messages: ViewMessage[]): void {
	const clones = structuredClone(messages);
	messages.length = 0;
	for (const clone of clones) messages.push(clone);
}

const verdict = (): ViewMessage => ({
	info: { role: 'assistant' },
	parts: [{ type: 'text', text: 'VERDICT' }],
});

const plainHistory = (): V2Message[] => [
	msg('user', 'u'),
	msg('assistant', 'a1'),
	msg('assistant', 'a2'),
];
const toolHistory = (): V2Message[] => [
	msg('user', 'u'),
	{ role: 'assistant', content: [text('a1'), call('t1')] },
	{ role: 'tool', content: [result('t1')] },
	{ role: 'assistant', content: [text('a2'), call('t2')] },
	{ role: 'tool', content: [result('t2')] },
];

describe('rollback clones + chain inserts (no positional pairing)', () => {
	test('RED at base — an id-less assistant view spliced between later same-role views overwrites nothing', async () => {
		const ev = event(plainHistory());
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				rollback(messages);
				messages.splice(2, 0, verdict());
			}),
			tempDir('swarm-stamp-rollback-insert-'),
		);
		expect(ev.messages).toEqual(plainHistory());
		expect(JSON.stringify(ev.messages)).not.toContain('VERDICT');
	});

	test('RED at base — same with a user message after the insert, two inserts', async () => {
		const host = [
			msg('user', 'u1'),
			msg('assistant', 'a1'),
			msg('user', 'u2'),
			msg('assistant', 'a2'),
		];
		const ev = event(host);
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				rollback(messages);
				messages.splice(2, 0, verdict());
				messages.splice(4, 0, verdict());
			}),
			tempDir('swarm-stamp-rollback-user-'),
		);
		expect(textsOf(ev.messages)).toEqual(['u1', 'a1', 'u2', 'a2']);
		expect(JSON.stringify(ev.messages)).not.toContain('VERDICT');
	});

	test('RED at base — tool-call/tool-result pairing survives rollback + insert', async () => {
		const ev = event(toolHistory());
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				rollback(messages);
				messages.splice(3, 0, verdict());
			}),
			tempDir('swarm-stamp-rollback-tools-'),
		);
		expect(ev.messages).toEqual(toolHistory());
		expect(orphanedResults(ev.messages)).toEqual([]);
	});

	test('RED at base — removing a same-role id-less original and inserting a same-role view removes the original, never overwrites it', async () => {
		const ev = event(plainHistory());
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				messages.splice(1, 1); // chain drops a1's view
				messages.push(verdict()); // ...and inserts a same-role view
			}),
			tempDir('swarm-stamp-remove-insert-'),
		);
		expect(textsOf(ev.messages)).toEqual(['u', 'a2']);
		expect(JSON.stringify(ev.messages)).not.toContain('VERDICT');
	});

	test('the stamp is a plain string key that survives structuredClone, and pairing works after a rollback', async () => {
		const seen: unknown[] = [];
		const ev = event([...toolHistory(), msg('assistant', 'a3')]);
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				for (const m of messages) seen.push(m.info.swarmV2Origin);
				expect(Object.keys(messages[0].info)).toContain('swarmV2Origin');
				rollback(messages);
				for (const m of messages) {
					for (const p of m.parts) {
						if (p.type === 'text') p.text = `${p.text}#`;
					}
				}
			}),
			tempDir('swarm-stamp-clone-'),
		);
		expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
		expect(textsOf(ev.messages)).toEqual(['u#', 'a1#', '', 'a2#', '', 'a3#']);
		expect(orphanedResults(ev.messages)).toEqual([]);
	});
});

describe('stamp mechanics', () => {
	test.each([
		['out of range high', 99],
		['negative', -1],
		['non-integer', 1.5],
		['string', '1'],
		['NaN', Number.NaN],
		['null', null],
	])('a forged stamp (%s) pairs to nothing and the view is dropped', async (_label, forged) => {
		const ev = event(plainHistory());
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				rollback(messages);
				messages[1].info.swarmV2Origin = forged;
				messages[1].parts[0].text = 'FORGED';
			}),
			tempDir('swarm-stamp-forged-'),
		);
		expect(textsOf(ev.messages)).toEqual(['u', 'a2']);
		expect(JSON.stringify(ev.messages)).not.toContain('FORGED');
	});

	test('a duplicate stamp does not steal an identity-paired original', async () => {
		const ev = event(plainHistory());
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				// a2 keeps its identity; a1 is replaced by a clone stamped as a2.
				const thief = structuredClone(messages[1]);
				thief.info.swarmV2Origin = 2;
				thief.parts[0].text = 'STOLEN';
				messages[1] = thief;
			}),
			tempDir('swarm-stamp-dup-identity-'),
		);
		expect(textsOf(ev.messages)).toEqual(['u', 'a2']);
		expect(JSON.stringify(ev.messages)).not.toContain('STOLEN');
	});

	test('duplicate stamps among clones are first-claim-wins; the later view is dropped', async () => {
		const ev = event(plainHistory());
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				rollback(messages);
				messages[2].info.swarmV2Origin = 1;
				messages[1].parts[0].text = 'a1#';
				messages[2].parts[0].text = 'a2#';
			}),
			tempDir('swarm-stamp-dup-clone-'),
		);
		expect(textsOf(ev.messages)).toEqual(['u', 'a1#']);
	});

	test('a stamp-paired view whose role differs from the original pairs to nothing', async () => {
		const ev = event(plainHistory());
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				rollback(messages);
				messages[1].info.role = 'user';
				messages[1].parts[0].text = 'WRONG-ROLE';
			}),
			tempDir('swarm-stamp-role-'),
		);
		expect(textsOf(ev.messages)).toEqual(['u', 'a2']);
		expect(JSON.stringify(ev.messages)).not.toContain('WRONG-ROLE');
	});

	test('precedence: id beats stamp when views are clones', async () => {
		const ev = event([
			msg('user', 'ua', 'a'),
			msg('assistant', 'ab', 'b'),
			msg('assistant', 'ac', 'c'),
		]);
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				rollback(messages);
				messages[1].info.swarmV2Origin = 2; // lies: points at c
				messages[2].info.swarmV2Origin = 1; // lies: points at b
				for (const m of messages) m.parts[0].text += '#';
			}),
			tempDir('swarm-stamp-id-over-stamp-'),
		);
		expect(textsOf(ev.messages)).toEqual(['ua#', 'ab#', 'ac#']);
	});

	test('precedence: object identity beats id', async () => {
		const ev = event([
			msg('user', 'ua', 'a'),
			msg('assistant', 'ab', 'b'),
			msg('assistant', 'ac', 'c'),
		]);
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				messages[1].info.id = 'c'; // id points at c, identity is b
				messages[1].parts[0].text = 'ab#';
			}),
			tempDir('swarm-stamp-identity-over-id-'),
		);
		expect(textsOf(ev.messages)).toEqual(['ua', 'ab#', 'ac']);
	});
});

describe('retention of messages whose view the chain dropped', () => {
	test('tool-call, tool-result and media messages stay in host order; text-only messages are removed', async () => {
		const host: V2Message[] = [
			msg('user', 'u'),
			{ role: 'assistant', content: [text('a1'), call('t1')] },
			{ role: 'tool', content: [result('t1')] },
			msg('assistant', 'a2'),
			{ role: 'user', content: [text('pic'), { type: 'media', url: 'x' }] },
			msg('assistant', 'a3'),
		];
		const originals = [...host];
		const ev = event(host);
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				messages.length = 0;
			}),
			tempDir('swarm-stamp-retention-'),
		);
		expect(ev.messages.length).toBe(3);
		expect(ev.messages[0]).toBe(originals[1]);
		expect(ev.messages[1]).toBe(originals[2]);
		expect(ev.messages[2]).toBe(originals[4]);
		expect(orphanedResults(ev.messages)).toEqual([]);
	});
});

describe('consumed carrier sources', () => {
	const sysSource = (): V2Message => ({
		role: 'system',
		content: [text('SYS-GUIDE'), { type: 'effort' }],
	});
	const occurrences = (haystack: string, needle: string) =>
		haystack.split(needle).length - 1;

	test('a system source with non-text parts is delivered once in event.system and removed from messages', async () => {
		const source = sysSource();
		const ev = event([msg('user', 'u'), source, msg('assistant', 'a')]);
		await onV2ContextEvent(
			ev,
			hooksWith((messages) =>
				materializeSystemGuidanceInPlace(messages as never),
			),
			tempDir('swarm-stamp-consumed-'),
		);
		expect(occurrences(JSON.stringify(ev.system), 'SYS-GUIDE')).toBe(1);
		expect(ev.messages.includes(source)).toBe(false);
		expect(textsOf(ev.messages)).toEqual(['u', 'a']);
	});

	test('a rollback clone materialized into a carrier AFTER cloning still consumes its source', async () => {
		const source = sysSource();
		const ev = event([msg('user', 'u'), source, msg('assistant', 'a')]);
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				rollback(messages);
				materializeSystemGuidanceInPlace(messages as never);
			}),
			tempDir('swarm-stamp-consumed-clone-'),
		);
		expect(occurrences(JSON.stringify(ev.system), 'SYS-GUIDE')).toBe(1);
		expect(ev.messages.includes(source)).toBe(false);
		expect(textsOf(ev.messages)).toEqual(['u', 'a']);
	});
});

describe('non-array message content (out of contract)', () => {
	const opaque = (role: string, content: unknown): V2Message =>
		({ role, content }) as unknown as V2Message;

	test('a claimed string-content message is left untouched, never split into characters', async () => {
		const weird = opaque('user', 'hello world');
		const ev = event([weird, msg('assistant', 'a')]);
		await onV2ContextEvent(
			ev,
			hooksWith(() => {}),
			tempDir('swarm-opaque-'),
		);
		expect(ev.messages[0]).toBe(weird);
		expect(weird.content as unknown).toBe('hello world');
		expect(textOf(ev.messages[1])).toBe('a');
	});

	test('a dropped string-content message is retained', async () => {
		const weird = opaque('user', 'hello world');
		const ev = event([weird, msg('assistant', 'a')]);
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				messages.length = 0;
			}),
			tempDir('swarm-opaque-drop-'),
		);
		expect(ev.messages).toEqual([weird]);
		expect(weird.content as unknown).toBe('hello world');
	});

	test('a string-content carrier source does not throw and its content is never split', async () => {
		const weird = opaque('system', 'SYS-STR');
		const ev = event([msg('user', 'u'), weird]);
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				messages[1].info.id = `${GUIDANCE_CARRIER_ID_PREFIX}x`;
				messages[1].parts = [{ type: 'text', text: 'CARRIER' }];
			}),
			tempDir('swarm-opaque-carrier-'),
		);
		expect(JSON.stringify(ev.system)).toContain('CARRIER');
		expect(weird.content as unknown).toBe('SYS-STR');
	});

	test('a claimed message with undefined content is not given an empty array', async () => {
		const weird = opaque('assistant', undefined);
		const ev = event([msg('user', 'u'), weird]);
		await onV2ContextEvent(
			ev,
			hooksWith(() => {}),
			tempDir('swarm-undef-'),
		);
		expect('content' in weird && weird.content !== undefined).toBe(false);
	});

	test('a dropped message with undefined content is removed, not retained', async () => {
		const ev = event([msg('user', 'u'), opaque('assistant', undefined)]);
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				messages.length = 1;
			}),
			tempDir('swarm-undef-drop-'),
		);
		expect(textsOf(ev.messages)).toEqual(['u']);
	});
});

describe('in-position write-back', () => {
	test('a non-text part that precedes the text keeps its slot', async () => {
		const host: V2Message = {
			role: 'assistant',
			content: [{ type: 'reasoning' }, text('t')],
		};
		const ev = event([host]);
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				messages[0].parts[0].text = 't#';
			}),
			tempDir('swarm-inpos-'),
		);
		expect(host.content.map((p) => p.type)).toEqual(['reasoning', 'text']);
		expect(textOf(host)).toBe('t#');
	});
});
