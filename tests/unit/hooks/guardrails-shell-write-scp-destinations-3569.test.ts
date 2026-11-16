/**
 * #3569 residual-2 shipped suite — scp destination model.
 *
 * `scp SRC... DST`: the LAST operand is the destination; a destination with
 * `:` before its first `/` is REMOTE (no local write); earlier operands
 * (remote sources) are never local targets. Zero/one operand is a usage
 * error on real scp — nothing transfers. Brace destinations keep the
 * #3491 refusal backstop byte-shape. Windows drive-colon paths are LOCAL.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState } from '../../../src/state';

function pathsOf(
	command: string,
): Array<{ path: string | null; dyn: string | null }> {
	return detectPosixWrites(command).writes.map((w) => ({
		path: w.path ?? null,
		dyn: w.dynamicSourceWord ?? null,
	}));
}

beforeEach(() => {
	resetSwarmState();
});

describe('detector: destination grammar', () => {
	test('plain local destination is the single write target', () => {
		expect(pathsOf('scp f src/dst')).toEqual([{ path: 'src/dst', dyn: null }]);
	});
	test('escaping local destination is detected', () => {
		expect(pathsOf('scp f src/../esc')).toEqual([
			{ path: 'src/../esc', dyn: null },
		]);
	});
	test('remote source is NOT a local target; local dest is', () => {
		expect(pathsOf('scp host:f src/dst')).toEqual([
			{ path: 'src/dst', dyn: null },
		]);
	});
	test('remote source + escaping destination names the escape', () => {
		expect(pathsOf('scp host:f src/../esc')).toEqual([
			{ path: 'src/../esc', dyn: null },
		]);
	});
	test('remote destination (upload) emits nothing', () => {
		expect(pathsOf('scp f host:/x')).toEqual([]);
	});
	test('flag arguments are consumed, not operands (-P port)', () => {
		expect(pathsOf('scp -P 2222 f src/dst')).toEqual([
			{ path: 'src/dst', dyn: null },
		]);
	});
	test('glued flag value (-P2222) is consumed', () => {
		expect(pathsOf('scp -P2222 f src/dst')).toEqual([
			{ path: 'src/dst', dyn: null },
		]);
	});
	test('`--` ends options; later dash words are operands', () => {
		expect(pathsOf('scp -- f -weird')).toEqual([{ path: '-weird', dyn: null }]);
	});
	test('zero/one operand: usage error, nothing emitted', () => {
		expect(pathsOf('scp')).toEqual([]);
		expect(pathsOf('scp host:f')).toEqual([]);
	});
	test('Windows drive-colon destination is LOCAL, not remote', () => {
		expect(pathsOf('scp f C:/out/x')).toEqual([
			{ path: 'C:/out/x', dyn: null },
		]);
	});
});

describe('brace backstop preserved (#3491 byte-shape)', () => {
	test('brace destination keeps the dynamicSourceWord refusal', () => {
		expect(pathsOf('scp f src/{a,../esc}')).toEqual([
			{ path: null, dyn: 'src/{a,../esc}' },
		]);
	});
});
