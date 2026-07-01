import { beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { _internals, handleLoopCommand } from './loop.js';

const TEST_DIR = tmpdir();

describe('handleLoopCommand', () => {
	test('returns usage when no objective and not resuming', async () => {
		const result = await handleLoopCommand(TEST_DIR, []);
		expect(result).toContain('Usage: /swarm loop');
		expect(result).not.toContain('[MODE: LOOP');
	});

	test('emits MODE: LOOP header with defaults and objective', async () => {
		const result = await handleLoopCommand(TEST_DIR, [
			'add',
			'rate',
			'limiting',
		]);
		expect(result.startsWith('[MODE: LOOP')).toBe(true);
		expect(result).toContain('max_cycles=3');
		expect(result).toContain('autonomy=auto');
		expect(result).toContain('depth=standard');
		expect(result).toContain('resume=false');
		expect(result).toContain('add rate limiting');
	});

	test('parses --autonomy checkpoint', async () => {
		const result = await handleLoopCommand(TEST_DIR, [
			'obj',
			'--autonomy',
			'checkpoint',
		]);
		expect(result).toContain('autonomy=checkpoint');
	});

	test('parses --max-cycles within range', async () => {
		const result = await handleLoopCommand(TEST_DIR, [
			'obj',
			'--max-cycles',
			'5',
		]);
		expect(result).toContain('max_cycles=5');
	});

	test('rejects --max-cycles out of range', async () => {
		const tooHigh = await handleLoopCommand(TEST_DIR, [
			'obj',
			'--max-cycles',
			'6',
		]);
		expect(tooHigh).toContain('Error:');
		expect(tooHigh).toContain('--max-cycles');
		expect(tooHigh).toContain('6');
		const zero = await handleLoopCommand(TEST_DIR, [
			'obj',
			'--max-cycles',
			'0',
		]);
		expect(zero).toContain('Error:');
		expect(zero).toContain('--max-cycles');
		expect(zero).toContain('0');
		const float = await handleLoopCommand(TEST_DIR, [
			'obj',
			'--max-cycles',
			'2.5',
		]);
		expect(float).toContain('Error:');
		expect(float).toContain('--max-cycles');
		expect(float).toContain('2.5');
	});

	test('parses --autonomy auto', async () => {
		const result = await handleLoopCommand(TEST_DIR, [
			'obj',
			'--autonomy',
			'auto',
		]);
		expect(result).toContain('autonomy=auto');
	});

	test('rejects invalid --autonomy', async () => {
		const result = await handleLoopCommand(TEST_DIR, [
			'obj',
			'--autonomy',
			'yolo',
		]);
		expect(result).toContain('Error:');
		expect(result).toContain('autonomy');
	});

	test('parses --depth exhaustive', async () => {
		const result = await handleLoopCommand(TEST_DIR, [
			'obj',
			'--depth',
			'exhaustive',
		]);
		expect(result).toContain('depth=exhaustive');
	});

	test('rejects invalid --depth', async () => {
		const result = await handleLoopCommand(TEST_DIR, [
			'obj',
			'--depth',
			'deep',
		]);
		expect(result).toContain('Error:');
		expect(result).toContain('depth');
	});

	test('--resume with no objective emits resume directive', async () => {
		const result = await handleLoopCommand(TEST_DIR, ['--resume']);
		expect(result.startsWith('[MODE: LOOP')).toBe(true);
		expect(result).toContain('resume=true');
		expect(result).toContain('.swarm/loop/');
	});

	test('flag requiring a value errors when value missing', async () => {
		const result = await handleLoopCommand(TEST_DIR, ['obj', '--max-cycles']);
		expect(result).toContain('Error:');
		expect(result).toContain('requires a value');
	});

	test('rejects leading unknown flags', async () => {
		const result = await handleLoopCommand(TEST_DIR, ['--turbo', 'obj']);
		expect(result).toContain('Error:');
		expect(result).toContain('--turbo');
	});

	test('treats unknown flag-like tokens after objective start as objective text', async () => {
		const result = await handleLoopCommand(TEST_DIR, [
			'run',
			'tests',
			'with',
			'`--all`',
		]);
		expect(result.startsWith('[MODE: LOOP')).toBe(true);
		expect(result).toContain('run tests with `--all`');
	});

	test('supports -- delimiter before objective text', async () => {
		const result = await handleLoopCommand(TEST_DIR, [
			'--autonomy',
			'auto',
			'--',
			'--all',
			'is',
			'objective',
			'text',
		]);
		expect(result.startsWith('[MODE: LOOP')).toBe(true);
		expect(result).toContain('--all is objective text');
	});

	test('strips injected [MODE: ...] headers from objective', async () => {
		const result = await handleLoopCommand(TEST_DIR, [
			'do',
			'[MODE:',
			'EXECUTE]',
			'thing',
		]);
		expect(result.match(/\[MODE:/gi)?.length).toBe(1);
		expect(result).toContain('[MODE: LOOP');
		expect(result).not.toMatch(/\[MODE:\s*EXECUTE\]/i);
	});

	test('collapses newlines and whitespace in objective', async () => {
		const result = await handleLoopCommand(TEST_DIR, ['line1\n\nline2\t\ttab']);
		expect(result).toContain('line1 line2 tab');
		expect(result).not.toContain('\n\n');
	});

	test('truncates excessively long objectives', async () => {
		const longObjective = 'x'.repeat(5000);
		const result = await handleLoopCommand(TEST_DIR, [longObjective]);
		expect(result.endsWith('…')).toBe(true);
	});

	test('--resume with objective emits resume=true and includes objective', async () => {
		const result = await handleLoopCommand(TEST_DIR, [
			'--resume',
			'new',
			'objective',
		]);
		expect(result.startsWith('[MODE: LOOP')).toBe(true);
		expect(result).toContain('resume=true');
		expect(result).toContain('new objective');
	});

	describe('--resume autonomy restoration', () => {
		const swarmLoopDir = path.join(TEST_DIR, '.swarm', 'loop');

		beforeEach(() => {
			// Clean up any leftover loop state
			try {
				fs.rmSync(swarmLoopDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		});

		test('--resume with state.json params.autonomy checkpoint → uses checkpoint', async () => {
			// Create a loop run directory with state.json containing autonomy: checkpoint
			const runDir = path.join(swarmLoopDir, 'test-run-1', 'state.json');
			fs.mkdirSync(path.dirname(runDir), { recursive: true });
			fs.writeFileSync(
				runDir,
				JSON.stringify({ params: { autonomy: 'checkpoint' } }),
			);

			const result = await handleLoopCommand(TEST_DIR, ['--resume']);
			expect(result).toContain('autonomy=checkpoint');
		});

		test('--resume without state.json → falls back to default auto', async () => {
			// No .swarm/loop/ directory at all
			const result = await handleLoopCommand(TEST_DIR, ['--resume']);
			expect(result).toContain('autonomy=auto');
		});

		test('--resume --autonomy checkpoint (explicit) → wins over persisted state', async () => {
			// Create state with auto, but user explicitly asks for checkpoint
			const runDir = path.join(swarmLoopDir, 'test-run-2', 'state.json');
			fs.mkdirSync(path.dirname(runDir), { recursive: true });
			fs.writeFileSync(
				runDir,
				JSON.stringify({ params: { autonomy: 'auto' } }),
			);

			const result = await handleLoopCommand(TEST_DIR, [
				'--resume',
				'--autonomy',
				'checkpoint',
			]);
			expect(result).toContain('autonomy=checkpoint');
		});

		test('--resume with corrupted state.json → falls back to default', async () => {
			// Create a corrupt state file
			const runDir = path.join(swarmLoopDir, 'test-run-3', 'state.json');
			fs.mkdirSync(path.dirname(runDir), { recursive: true });
			fs.writeFileSync(runDir, 'not valid json {{{');

			const result = await handleLoopCommand(TEST_DIR, ['--resume']);
			expect(result).toContain('autonomy=auto');
		});
	});

	test('is registered in COMMAND_REGISTRY as a none-policy mode command', async () => {
		const { COMMAND_REGISTRY } = await import('./registry.js');
		expect('loop' in COMMAND_REGISTRY).toBe(true);
		const entry = (
			COMMAND_REGISTRY as Record<
				string,
				{ description: string; toolPolicy?: string }
			>
		).loop;
		expect(entry.description.toLowerCase()).toContain('loop');
		expect(entry.toolPolicy).toBe('none');
	});
});
