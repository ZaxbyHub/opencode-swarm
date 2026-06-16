/**
 * TypeScript declarations for bash-parser
 * Minimal declarations sufficient for build — AST is dynamic, use index signatures where needed
 */

declare module 'bash-parser' {
	export interface WordNode {
		type: 'Word';
		text: string;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface RedirectNode {
		type: 'Redirect';
		op: WordNode;
		file: WordNode;
		numberIo?: WordNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface CommandNode {
		type: 'Command';
		name?: WordNode;
		prefix?: WordNode[];
		suffix?: WordNode[];
		redirections?: RedirectNode[];
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		async?: boolean;
		bang?: boolean;
		[key: string]: unknown;
	}

	export interface SimpleCommandNode {
		type: 'SimpleCommand';
		name: WordNode;
		suffix?: WordNode[];
		[key: string]: unknown;
	}

	export interface PipelineNode {
		type: 'Pipeline';
		commands: CommandNode[];
		bang?: boolean;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface SubshellNode {
		type: 'Subshell';
		list: CommandNode | PipelineNode | LogicalExpressionNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface CompoundListNode {
		type: 'CompoundList';
		commands: (CommandNode | PipelineNode | LogicalExpressionNode)[];
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface LogicalExpressionNode {
		type: 'LogicalExpression';
		op: 'and' | 'or';
		left: CommandNode | PipelineNode | SubshellNode | LogicalExpressionNode;
		right: CommandNode | PipelineNode | SubshellNode | LogicalExpressionNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface ForNode {
		type: 'For';
		name: WordNode;
		wordlist?: WordNode[];
		do: CompoundListNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface WhileNode {
		type: 'While';
		clause: CompoundListNode;
		do: CompoundListNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface UntilNode {
		type: 'Until';
		clause: CompoundListNode;
		do: CompoundListNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface IfNode {
		type: 'If';
		clause: CompoundListNode;
		then: CompoundListNode;
		else?: CompoundListNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface FunctionNode {
		type: 'Function';
		name: WordNode;
		body: CommandNode;
		redirections?: RedirectNode[];
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface CaseItemNode {
		type: 'CaseItem';
		pattern: WordNode[];
		body: CompoundListNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface CaseNode {
		type: 'Case';
		clause: WordNode;
		cases?: CaseItemNode[];
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export type ASTNode =
		| WordNode
		| RedirectNode
		| CommandNode
		| SimpleCommandNode
		| PipelineNode
		| SubshellNode
		| CompoundListNode
		| LogicalExpressionNode
		| ForNode
		| WhileNode
		| UntilNode
		| IfNode
		| FunctionNode
		| CaseNode
		| CaseItemNode
		| ScriptNode;

	export interface ScriptNode {
		type: 'Script';
		commands: (
			| CommandNode
			| PipelineNode
			| LogicalExpressionNode
			| SubshellNode
		)[];
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface ParseOptions {
		mode?: 'posix' | 'bash' | 'word-expansion';
		insertLOC?: boolean;
	}

	function parse(command: string, options?: ParseOptions): ScriptNode;
	export default parse;

	// ---------------------------------------------------------------------------
	// Extended Bash AST types (from shell-write-detect)
	// These types complement the strict *Node types above with looser shapes
	// that match what bash-parser actually emits at runtime.
	// ---------------------------------------------------------------------------

	export type BashOperatorType =
		| 'GREAT'
		| 'DGREAT'
		| 'CLOBBER'
		| 'LESS'
		| 'LESSAND'
		| 'GREATAND'
		| 'DLESS'
		| 'DLESSDASH'
		| 'LESSGREAT'
		| string;

	export interface BashOperator {
		type: BashOperatorType;
		text?: string;
		loc?: unknown;
	}

	/** Type alias — BashWord is the same shape as WordNode. */
	export type BashWord = WordNode;

	export interface BashHereDocMarker {
		type: 'dless' | 'dlessdash';
		text: string;
		loc?: unknown;
	}

	export interface BashRedirect {
		type: 'Redirect';
		op: BashOperator;
		file: BashWord | BashHereDocMarker;
		number?: number;
		loc?: unknown;
	}

	export interface BashCommand {
		type: 'Command' | 'SimpleCommand';
		name?: BashWord | string;
		prefix?: (BashWord | BashRedirect | BashHereDocMarker)[];
		suffix?: (BashWord | BashRedirect | BashHereDocMarker)[];
		redirections?: BashRedirect[];
		loc?: unknown;
		async?: boolean;
		bang?: boolean;
	}

	export interface BashScript {
		type: 'Script';
		commands: BashNode[];
		loc?: unknown;
	}

	export interface BashPipeline {
		type: 'Pipeline';
		commands: BashNode[];
		loc?: unknown;
		bang?: boolean;
	}

	export interface BashSequence {
		type: 'Sequence';
		commands: BashNode[];
		loc?: unknown;
	}

	export interface BashList {
		type: 'List';
		commands: BashNode[];
		type_andor?: string;
		type_sep?: string;
		loc?: unknown;
	}

	export interface BashCompoundList {
		type: 'CompoundList';
		commands: BashNode[];
		redirections?: BashRedirect[];
		loc?: unknown;
	}

	export interface BashLogicalExpression {
		type: 'LogicalExpression';
		op: 'and' | 'or';
		left: BashNode;
		right: BashNode;
		loc?: unknown;
	}

	export interface BashAnd {
		type: 'And';
		left: BashNode;
		right: BashNode;
		loc?: unknown;
	}

	export interface BashOr {
		type: 'Or';
		left: BashNode;
		right: BashNode;
		loc?: unknown;
	}

	export interface BashSubshell {
		type: 'Subshell';
		list: BashNode;
		redirections?: BashRedirect[];
		loc?: unknown;
	}

	export interface BashProcessSubstitution {
		type: 'ProcessSubstitution';
		op: BashOperator;
		command: BashNode;
		loc?: unknown;
	}

	export interface BashIf {
		type: 'If';
		clause: BashNode;
		then: BashNode;
		else?: BashNode;
		loc?: unknown;
	}

	export interface BashFor {
		type: 'For';
		name: BashWord | string;
		wordlist?: BashWord[];
		do: BashNode;
		loc?: unknown;
	}

	export interface BashCase {
		type: 'Case';
		clause: BashWord;
		cases?: BashCaseItem[];
		loc?: unknown;
	}

	export interface BashCaseItem {
		type: 'CaseItem';
		pattern: BashWord[];
		body: BashNode;
		loc?: unknown;
	}

	export interface BashWhile {
		type: 'While';
		clause: BashNode;
		do: BashNode;
		loc?: unknown;
	}

	export interface BashUntil {
		type: 'Until';
		clause: BashNode;
		do: BashNode;
		loc?: unknown;
	}

	export interface BashFunction {
		type: 'Function';
		name: BashWord | string;
		body: BashNode;
		redirections?: BashRedirect[];
		loc?: unknown;
	}

	/**
	 * Union of all structural Bash AST node types.
	 * Leaf token types (BashWord, BashRedirect, BashHereDocMarker, BashOperator)
	 * are excluded — they appear as properties of structural nodes.
	 */
	export type BashNode =
		| BashScript
		| BashPipeline
		| BashSequence
		| BashList
		| BashCompoundList
		| BashLogicalExpression
		| BashAnd
		| BashOr
		| BashSubshell
		| BashProcessSubstitution
		| BashCommand
		| BashIf
		| BashFor
		| BashCase
		| BashCaseItem
		| BashWhile
		| BashUntil
		| BashFunction;
}
