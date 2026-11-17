import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
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
	let actual = 0;
	let offset = 0;
	for (let match = original.indexOf(find, offset); match !== -1; match = original.indexOf(find, offset)) {
		actual++;
		offset = match + find.length;
	}
	if (actual !== Number(count)) throw new Error(`Expected ${count} matches, found ${actual}`);
	const size = bytes.length + actual * (Buffer.byteLength(replace) - Buffer.byteLength(find));
	if (size > 16 * 1024 * 1024) {
		throw new Error('Edited file would exceed 16 MiB');
	}
	const output = original.replaceAll(find, () => replace);
	const temp = join(dirname(file), `.apply-edit-${randomUUID()}.tmp`);
	try {
		writeFileSync(temp, output, { flag: 'wx', mode: info.mode & 0o777 });
		chmodSync(temp, info.mode & 0o777);
		const current = lstatSync(file);
		if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino ||
			current.size !== info.size || current.mtimeMs !== info.mtimeMs ||
			current.ctimeMs !== info.ctimeMs) throw new Error('File changed during asserted edit');
		renameSync(temp, file);
	} finally {
		try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
