/**
 * Validation functions for workspace paths, graph nodes, and graph edges.
 *
 * All public functions throw descriptive errors on invalid input so callers
 * can surface actionable messages rather than obscure downstream failures.
 */
import type { GraphEdge, GraphNode } from './types';
/**
 * Validate that a workspace directory is safe to use.
 * Accepts both absolute and relative paths.
 *
 * @param workspace - The workspace directory (path, absolute or relative, e.g. "/home/user/project" or "my-project")
 * @throws Error if the workspace is invalid
 */
export declare function validateWorkspace(workspace: string): void;
/**
 * Validate a graph node before adding to the graph.
 * @param node - The node to validate
 * @throws Error if the node is invalid
 */
export declare function validateGraphNode(node: GraphNode): void;
/**
 * Validate a graph edge before adding to the graph.
 * @param edge - The edge to validate
 * @throws Error if the edge is invalid
 */
export declare function validateGraphEdge(edge: GraphEdge): void;
