/**
 * The sink-device exemption matches the literal word only. Every near miss
 * (a trailing slash, another case, a doubled slash, a path under the device,
 * another device) is still a write target.
 */

import { describe, expect, test } from 'bun:test';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';

function writes(command: string): string[] {
	return detectPosixWrites(command).writes.map(
		(w) => `${w.category}:${w.path}`,
	);
}

describe('shell-write-detect: sink-device exemption is an exact match', () => {
	test.each([
		['echo x > /dev/null/', ['redirect:/dev/null/']],
		['echo x > /DEV/NULL', ['redirect:/DEV/NULL']],
		['echo x > /dev//null', ['redirect:/dev//null']],
		['echo x > /dev/null/x', ['redirect:/dev/null/x']],
		['echo x > /dev/nul', ['redirect:/dev/nul']],
		['echo x > /dev/zero/', ['redirect:/dev/zero/']],
		['echo x > /dev/random', ['redirect:/dev/random']],
		['echo x > /dev/full', ['redirect:/dev/full']],
		['echo x | tee /dev/null/', ['builtin_write:/dev/null/']],
		['dd if=a of=/dev/null/', ['builtin_write:/dev/null/']],
		['cat a >(cat > out.txt)', ['redirect:out.txt']],
		['cmd >& out.txt', ['redirect:out.txt']],
		['cmd &> out.txt', ['redirect:out.txt']],
		['cmd >&/dev/null', []],
		['cmd &>/dev/null', []],
	])('%s writes %j', (command, expected) => {
		expect(writes(command)).toEqual(expected);
	});

	// #3539 W5 re-pin: these used to be parse errors (bash-parser rejects a
	// process substitution; the guard failed closed on the whole line). With
	// procsub masking the span body IS analyzed — its redirect goes to the
	// sink device, so the exemption applies exactly as for a plain
	// `> /dev/null` — and the masked residual parses clean, so the analysis
	// carries no write and no parseError. A `>(…)` no longer hard-blocks a
	// line whose every write is a sink-device write.
	test.each([
		'cmd >(cat > /dev/null)',
		'cmd >(cat >> /dev/null)',
	])('%s is analyzed (sink-device body write) with no write and no parse error', (command) => {
		const result = detectPosixWrites(command);
		expect(result.writes).toEqual([]);
		expect(result.parseError).toBeUndefined();
	});
});
