import type { GraphEdge, GraphNode } from './types';

export interface ImportBinding {
	imported: string;
	local: string;
}

export interface ParsedImport {
	specifier: string;
	importType: GraphEdge['importType'];
	importedSymbols: string[];
	bindings: ImportBinding[];
	reExport: boolean;
}

interface FileStat {
	size: number;
	mtime: Date;
	mtimeMs: number;
}

interface OntologyInput {
	moduleName: string;
	filePath: string;
	content: string;
	language: string;
	exports: string[];
	imports: string[];
	hasManifest?: (relDir: string) => boolean;
}

export interface FallbackScannerDependencies {
	statFile: (filePath: string) => FileStat;
	readFile: (filePath: string) => string;
	isBinaryContent: (content: string) => boolean;
	extractExports: (
		filePath: string,
		absoluteRoot: string,
	) => { exports: string[]; exportLines: Record<string, number> };
	parseImports: (
		content: string,
		filePath: string,
		absoluteRoot: string,
	) => ParsedImport[];
	stripComments: (content: string) => string;
	toModuleName: (filePath: string, absoluteRoot: string) => string;
	getLanguage: (filePath: string) => string;
	extractOntology: (input: OntologyInput) => GraphNode['ontology'];
	resolveSpecifier: (
		absoluteRoot: string,
		filePath: string,
		specifier: string,
	) => string | null;
	usedSymbolsForImport: (
		parsedImport: ParsedImport,
		strippedContent: string,
	) => string[] | undefined;
	isScannableSourcePath: (filePath: string) => boolean;
}

export type FallbackScanOutcome =
	| {
			status: 'scanned';
			node: GraphNode & Required<Pick<GraphNode, 'sizeBytes' | 'mtimeMs'>>;
			edges: GraphEdge[];
	  }
	| {
			status: 'skipped';
			reason: 'oversized' | 'unreadable' | 'binary' | 'malformed';
			moduleName: string;
			language?: string;
			sizeBytes?: number;
			mtimeMs?: number;
	  };

export interface FallbackScanOptions {
	filePath: string;
	absoluteRoot: string;
	maxFileSize: number;
	hasManifest?: (relDir: string) => boolean;
	dependencies: FallbackScannerDependencies;
}

/**
 * Bounded, fail-open boundary for the legacy parser-based file scanner.
 *
 * All filesystem access happens before parser work, with the size cap enforced
 * before content is read. Language extraction and resolution stay injectable so
 * builder tests can replace them without process-wide module mocks.
 */
export function runFallbackScan({
	filePath,
	absoluteRoot,
	maxFileSize,
	hasManifest,
	dependencies,
}: FallbackScanOptions): FallbackScanOutcome {
	let moduleName: string;
	try {
		moduleName = dependencies.toModuleName(filePath, absoluteRoot);
	} catch {
		return {
			status: 'skipped',
			reason: 'malformed',
			moduleName: filePath,
		};
	}
	let fileStats: FileStat;
	let content: string;
	let language = 'unknown';

	try {
		fileStats = dependencies.statFile(filePath);
		if (fileStats.size > maxFileSize) {
			return {
				status: 'skipped',
				reason: 'oversized',
				moduleName,
				sizeBytes: fileStats.size,
				mtimeMs: fileStats.mtimeMs,
			};
		}
		content = dependencies.readFile(filePath);
	} catch {
		return { status: 'skipped', reason: 'unreadable', moduleName };
	}

	if (dependencies.isBinaryContent(content)) {
		return {
			status: 'skipped',
			reason: 'binary',
			moduleName,
			sizeBytes: fileStats.size,
			mtimeMs: fileStats.mtimeMs,
		};
	}

	try {
		const { exports, exportLines } = dependencies.extractExports(
			filePath,
			absoluteRoot,
		);
		const parsedImports = dependencies.parseImports(
			content,
			filePath,
			absoluteRoot,
		);
		const imports = parsedImports.map((parsed) => parsed.specifier);
		const strippedForUsage =
			parsedImports.length > 0 ? dependencies.stripComments(content) : '';
		language = dependencies.getLanguage(filePath);
		const node: GraphNode & Required<Pick<GraphNode, 'sizeBytes' | 'mtimeMs'>> =
			{
				filePath,
				moduleName,
				exports,
				...(Object.keys(exportLines).length > 0 ? { exportLines } : {}),
				imports,
				language,
				mtime: fileStats.mtime.toISOString(),
				sizeBytes: fileStats.size,
				mtimeMs: fileStats.mtimeMs,
				ontology: dependencies.extractOntology({
					moduleName,
					filePath,
					content,
					language,
					exports,
					imports,
					hasManifest,
				}),
			};

		const edges: GraphEdge[] = [];
		const sortedImports = [...parsedImports].sort((a, b) =>
			a.specifier.localeCompare(b.specifier),
		);
		for (const parsed of sortedImports) {
			const target = dependencies.resolveSpecifier(
				absoluteRoot,
				filePath,
				parsed.specifier,
			);
			if (target === null) continue;
			const usedSymbols = dependencies.usedSymbolsForImport(
				parsed,
				strippedForUsage,
			);
			edges.push({
				source: filePath,
				target,
				importSpecifier: parsed.specifier,
				importType: parsed.importType,
				importedSymbols: parsed.importedSymbols,
				...(usedSymbols !== undefined ? { usedSymbols } : {}),
				targetKind: dependencies.isScannableSourcePath(target)
					? 'node'
					: 'asset',
			});
		}

		return { status: 'scanned', node, edges };
	} catch {
		return {
			status: 'skipped',
			reason: 'malformed',
			moduleName,
			language,
			sizeBytes: fileStats.size,
			mtimeMs: fileStats.mtimeMs,
		};
	}
}
