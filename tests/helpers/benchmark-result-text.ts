import type { CommandFailure } from '../../src/commands/registry.js';

/**
 * #2493: handleBenchmarkCommand returns a structured CommandFailure (text +
 * exit code) when its CI gate fails, and a plain string otherwise. Tests that
 * assert on the human-visible output normalize through this helper; the CLI
 * is the exit-code consumer.
 */
export function resultText(result: string | CommandFailure): string {
	return typeof result === 'string' ? result : result.text;
}
