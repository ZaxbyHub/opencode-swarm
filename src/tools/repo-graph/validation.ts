/**
 * Validation functions for workspace paths, graph nodes, and graph edges.
 *
 * All public functions throw descriptive errors on invalid input so callers
 * can surface actionable messages rather than obscure downstream failures.
 */

import {
	containsControlChars,
	containsPathTraversal,
} from '../../utils/path-security';
import type { GraphEdge, GraphNode } from './types';

// ============ Validation ============

/**
 * Validate that a workspace directory is safe to use.
 * Accepts both absolute and relative paths.
 *
 * @param workspace - The workspace directory (path, absolute or relative, e.g. "/home/user/project" or "my-project")
 * @throws Error if the workspace is invalid
 */
export function validateWorkspace(workspace: string): void {
	if (!workspace || typeof workspace !== 'string' || workspace.trim() === '') {
		throw new Error('Invalid workspace: must be a non-empty string');
	}
	if (containsControlChars(workspace)) {
		throw new Error('Invalid workspace: control characters detected');
	}
	if (containsPathTraversal(workspace)) {
		throw new Error('Invalid workspace: path traversal detected');
	}
}

/**
 * Validate a graph node before adding to the graph.
 * @param node - The node to validate
 * @throws Error if the node is invalid
 */
export function validateGraphNode(node: GraphNode): void {
	if (!node || typeof node !== 'object') {
		throw new Error('Invalid node: must be an object');
	}
	if (!node.filePath || typeof node.filePath !== 'string') {
		throw new Error('Invalid node: filePath is required');
	}
	// filePath must be absolute
	if (
		!node.filePath.startsWith('/') &&
		!/^[A-Za-z]:[/\\]/.test(node.filePath)
	) {
		throw new Error('Invalid node: filePath must be absolute');
	}
	if (containsPathTraversal(node.filePath)) {
		throw new Error('Invalid node: filePath contains path traversal');
	}
	if (containsControlChars(node.filePath)) {
		throw new Error('Invalid node: filePath contains control characters');
	}
	if (!node.moduleName || typeof node.moduleName !== 'string') {
		throw new Error('Invalid node: moduleName is required');
	}
	// moduleName must be a relative path (not absolute, no traversal)
	if (
		node.moduleName.startsWith('/') ||
		node.moduleName.startsWith('\\') ||
		/^[A-Za-z]:[/\\]/.test(node.moduleName)
	) {
		throw new Error('Invalid node: moduleName must be relative');
	}
	if (containsPathTraversal(node.moduleName)) {
		throw new Error('Invalid node: moduleName contains path traversal');
	}
	if (containsControlChars(node.moduleName)) {
		throw new Error('Invalid node: moduleName contains control characters');
	}
	if (typeof node.language !== 'string') {
		throw new Error('Invalid node: language is required');
	}
	if (typeof node.mtime !== 'string') {
		throw new Error('Invalid node: mtime is required');
	}
	if (!Array.isArray(node.exports)) {
		throw new Error('Invalid node: exports must be an array');
	}
	for (const exp of node.exports) {
		if (typeof exp !== 'string') {
			throw new Error('Invalid node: exports must be an array of strings');
		}
		if (containsControlChars(exp)) {
			const preview = exp.slice(0, 120);
			throw new Error(
				`Invalid node: exports contains control characters (file=${node.filePath}, value="${preview}")`,
			);
		}
	}
	if (!Array.isArray(node.imports)) {
		throw new Error('Invalid node: imports must be an array');
	}
	for (const imp of node.imports) {
		if (typeof imp !== 'string') {
			throw new Error('Invalid node: imports must be an array of strings');
		}
		if (containsControlChars(imp)) {
			const preview = imp.slice(0, 120);
			throw new Error(
				`Invalid node: imports contains control characters (file=${node.filePath}, value="${preview}")`,
			);
		}
	}
}

/**
 * Validate a graph edge before adding to the graph.
 * @param edge - The edge to validate
 * @throws Error if the edge is invalid
 */
export function validateGraphEdge(edge: GraphEdge): void {
	if (!edge || typeof edge !== 'object') {
		throw new Error('Invalid edge: must be an object');
	}
	if (!edge.source || typeof edge.source !== 'string') {
		throw new Error('Invalid edge: source is required');
	}
	if (!edge.target || typeof edge.target !== 'string') {
		throw new Error('Invalid edge: target is required');
	}
	if (
		containsPathTraversal(edge.source) ||
		containsPathTraversal(edge.target)
	) {
		throw new Error('Invalid edge: path traversal detected');
	}
	if (containsControlChars(edge.source) || containsControlChars(edge.target)) {
		throw new Error('Invalid edge: control characters detected');
	}
}
