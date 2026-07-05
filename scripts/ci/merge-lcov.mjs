#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const [partsDir, mergedFile, valueFile] = process.argv.slice(2);

if (!partsDir || !mergedFile || !valueFile) {
	console.error('usage: merge-lcov.mjs <parts-dir> <merged-file> <value-file>');
	process.exit(2);
}

const lineHitsByFile = new Map();

function getLineHits(sourceFile) {
	let lineHits = lineHitsByFile.get(sourceFile);
	if (!lineHits) {
		lineHits = new Map();
		lineHitsByFile.set(sourceFile, lineHits);
	}
	return lineHits;
}

const entries = (await readdir(partsDir))
	.filter((entry) => entry.endsWith('.info'))
	.sort();

if (entries.length === 0) {
	await mkdir(path.dirname(mergedFile), { recursive: true });
	await writeFile(mergedFile, '');
	await writeFile(valueFile, '0\n');
	console.error('No lcov.info files were found to merge');
	process.exit(1);
}

for (const entry of entries) {
	const partPath = path.join(partsDir, entry);
	const reader = readline.createInterface({
		input: createReadStream(partPath, { encoding: 'utf8' }),
		crlfDelay: Infinity,
	});
	let currentFile = '';
	for await (const line of reader) {
		if (line.startsWith('SF:')) {
			currentFile = line.slice(3);
			continue;
		}
		if (!currentFile || !line.startsWith('DA:')) {
			continue;
		}
		const [lineNumber, countText] = line.slice(3).split(',', 2);
		const count = Number.parseInt(countText ?? '0', 10);
		const safeCount = Number.isFinite(count) ? count : 0;
		const lineHits = getLineHits(currentFile);
		const previous = lineHits.get(lineNumber) ?? 0;
		if (safeCount > previous) {
			lineHits.set(lineNumber, safeCount);
		} else if (!lineHits.has(lineNumber)) {
			lineHits.set(lineNumber, 0);
		}
	}
}

let total = 0;
let covered = 0;
await mkdir(path.dirname(mergedFile), { recursive: true });
const merged = await open(mergedFile, 'w');
try {
	await merged.write('TN:\n');
	for (const sourceFile of [...lineHitsByFile.keys()].sort()) {
		const lineHits = lineHitsByFile.get(sourceFile);
		await merged.write(`SF:${sourceFile}\n`);
		let fileTotal = 0;
		let fileCovered = 0;
		const sortedLines = [...lineHits.keys()].sort((a, b) => Number(a) - Number(b));
		for (const lineNumber of sortedLines) {
			const hits = lineHits.get(lineNumber) ?? 0;
			fileTotal++;
			total++;
			if (hits > 0) {
				fileCovered++;
				covered++;
			}
			await merged.write(`DA:${lineNumber},${hits}\n`);
		}
		await merged.write(`LF:${fileTotal}\n`);
		await merged.write(`LH:${fileCovered}\n`);
		await merged.write('end_of_record\n');
	}
} finally {
	await merged.close();
}

const coverage = total === 0 ? 0 : (covered * 100) / total;
await writeFile(valueFile, `${coverage.toFixed(2)}\n`);
