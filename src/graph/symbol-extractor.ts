import * as path from 'node:path';
import {
	extractGoSymbols,
	extractPythonSymbols,
	extractRustSymbols,
	extractTSSymbols,
} from '../tools/symbols';
import { getLanguageFromExtension } from './import-extractor';
import type { ExportedSymbol, SymbolKind } from './types';

/**
 * Extract exported symbols from a single file.
 *
 * Reuses the proven regex-based extractors from `src/tools/symbols.ts`
 * (`extractTSSymbols` / `extractPythonSymbols`) and maps their internal
 * SymbolInfo shape to our `ExportedSymbol` type.
 *
 * For Go and Rust, exported-symbol extraction is best-effort (out of scope
 * for Phase 1) — empty arrays are returned. The graph still tracks file-level
 * import edges for these languages.
 */

/**
 * @param relativeFilePath - file path relative to workspace root (forward-slash)
 * @param workspaceRoot - absolute workspace root
 */
export function extractExportedSymbols(
	relativeFilePath: string,
	workspaceRoot: string,
): ExportedSymbol[] {
	const ext = path.extname(relativeFilePath).toLowerCase();
	const language = getLanguageFromExtension(ext);
	if (!language) return [];

	if (language === 'typescript' || language === 'javascript') {
		const raw = extractTSSymbols(relativeFilePath, workspaceRoot);
		return raw.filter((s) => s.exported).map(toExported);
	}
	if (language === 'python') {
		const raw = extractPythonSymbols(relativeFilePath, workspaceRoot);
		return raw.filter((s) => s.exported).map(toExported);
	}
	if (language === 'rust') {
		const raw = extractRustSymbols(relativeFilePath, workspaceRoot);
		return raw.filter((s) => s.exported).map(toExported);
	}
	if (language === 'go') {
		const raw = extractGoSymbols(relativeFilePath, workspaceRoot);
		return raw.filter((s) => s.exported).map(toExported);
	}
	return [];
}

interface RawSymbol {
	name: string;
	kind: string;
	signature: string;
	line: number;
}

function toExported(raw: RawSymbol): ExportedSymbol {
	return {
		name: raw.name,
		kind: normalizeKind(raw.kind),
		signature: raw.signature || undefined,
		line: raw.line,
	};
}

function normalizeKind(kind: string): SymbolKind {
	switch (kind) {
		case 'function':
		case 'class':
		case 'interface':
		case 'type':
		case 'enum':
		case 'const':
		case 'variable':
		case 'method':
		case 'property':
			return kind;
		default:
			return 'variable';
	}
}
