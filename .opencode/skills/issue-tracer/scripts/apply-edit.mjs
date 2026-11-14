import { readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

try {
	const { values } = parseArgs({
		options: {
			file: { type: 'string' },
			find: { type: 'string' },
			replace: { type: 'string' },
			count: { type: 'string' },
		},
	});
	const { file, find, replace, count } = values;
	if (!file || !find || replace === undefined || !/^[1-9][0-9]*$/.test(count ?? '')) {
		throw new Error('usage: apply-edit.mjs --file PATH --find TEXT --replace TEXT --count N');
	}
	const info = lstatSync(file);
	if (!info.isFile() || info.size > 16 * 1024 * 1024) {
		throw new Error('Expected a regular file no larger than 16 MiB');
	}
	const bytes = readFileSync(file);
	const original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	const pieces = original.split(find);
	const actual = pieces.length - 1;
	if (actual !== Number(count)) throw new Error(`Expected ${count} matches, found ${actual}`);
	writeFileSync(file, pieces.join(replace));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
