export type ViewerView = "diff" | "code";
export type ViewerPane = "tree" | "content";

export type FileFilter = "all" | "staged" | "unstaged";
export type DiffScope = "staged" | "unstaged";
export type PreferredRenderer = "delta" | "pi";
export type DiffAnnotationSide = "old" | "new" | "context" | "mixed";

export interface CodeViewerState {
	view: "code";
	selectedPath?: string;
	collapsedDirs: string[];
	treePaneVisible: boolean;
	activePane: ViewerPane;
	selectedLineIndex: number;
	selectionAnchorLineIndex?: number;
}

export interface DiffViewerState {
	view: "diff";
	selectedPath?: string;
	collapsedDirs: string[];
	treePaneVisible: boolean;
	activePane: ViewerPane;
	selectedLineIndex: number;
	selectionAnchorLineIndex?: number;
	filter: FileFilter;
	diffScopePreference: DiffScope;
	focusRef?: string;
}

export type ViewerState = CodeViewerState | DiffViewerState;

export interface CodeAnnotationTarget {
	view: "code";
	rootPath: string;
	path: string;
	startLine: number;
	endLine: number;
	excerpt: string[];
}

export interface DiffAnnotationTarget {
	view: "diff";
	repoRoot: string;
	branchName?: string;
	path: string;
	scope: DiffScope;
	side: DiffAnnotationSide;
	refs: string[];
	excerpt: string[];
}

export type ViewerAnnotationTarget = CodeAnnotationTarget | DiffAnnotationTarget;

export interface ViewerAnnotation {
	id: string;
	target: ViewerAnnotationTarget;
	note: string;
	createdAt: number;
}

export interface ViewerAnnotationController {
	list(): ViewerAnnotation[];
	find(target: ViewerAnnotationTarget): ViewerAnnotation | undefined;
	upsert(target: ViewerAnnotationTarget, note: string): void;
	remove(target: ViewerAnnotationTarget): void;
}

export interface ViewerSwitchResult {
	action: "switch";
	view: ViewerView;
	state: ViewerState;
}

export interface ViewerDraftResult {
	action: "draft";
	state: ViewerState;
}

export interface ViewerNotesResult {
	action: "notes";
	state: ViewerState;
}

export type ViewerResult = ViewerSwitchResult | ViewerDraftResult | ViewerNotesResult;

export interface NotesViewerState {
	selectedIndex: number;
	sourceView: ViewerView;
}

export interface NotesViewerBackResult {
	action: "back";
	state: NotesViewerState;
}

export interface NotesViewerJumpResult {
	action: "jump";
	state: NotesViewerState;
	target: ViewerAnnotationTarget;
}

export interface NotesViewerDraftResult {
	action: "draft";
	state: NotesViewerState;
}

export type NotesViewerResult = NotesViewerBackResult | NotesViewerJumpResult | NotesViewerDraftResult;

export interface ChangedFile {
	path: string;
	origPath?: string;
	x: string;
	y: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
	conflicted: boolean;
	renamed: boolean;
	copied: boolean;
	added: boolean;
	deleted: boolean;
}

export interface AggregateStats {
	fileCount: number;
	stagedCount: number;
	unstagedCount: number;
	untrackedCount: number;
	conflictedCount: number;
	renamedCount: number;
}

export interface TreeNodeBase {
	kind: "dir" | "file";
	name: string;
	path: string;
	parentPath: string | null;
	aggregate: AggregateStats;
}

export interface DirNode extends TreeNodeBase {
	kind: "dir";
	children: TreeNode[];
}

export interface FileNode extends TreeNodeBase {
	kind: "file";
	entry: ChangedFile;
}

export type TreeNode = DirNode | FileNode;

export interface VisibleTreeRow {
	node: TreeNode;
	depth: number;
}

export interface FileVersion {
	missing: boolean;
	binary: boolean;
	text: string;
}

export interface MessageDiffBody {
	type: "message";
	metadataLines: string[];
	lines: string[];
}

export interface PiDiffBody {
	type: "pi";
	metadataLines: string[];
	diffText: string;
}

export interface DeltaDiffBody {
	type: "delta";
	metadataLines: string[];
	output: string;
}

export type LoadedDiff = MessageDiffBody | PiDiffBody | DeltaDiffBody;

export interface CodeDirNode {
	kind: "dir";
	name: string;
	path: string;
	parentPath: string | null;
	descendantFileCount: number;
	children: CodeTreeNode[];
}

export interface CodeFileNode {
	kind: "file";
	name: string;
	path: string;
	parentPath: string | null;
}

export type CodeTreeNode = CodeDirNode | CodeFileNode;

export interface CodeVisibleRow {
	node: CodeTreeNode;
	depth: number;
}

export interface CodeLoadedPreview {
	type: "text" | "message";
	metadataLines: string[];
	lines: string[];
	plainLines: string[];
}
