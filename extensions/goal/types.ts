export const GOAL_CUSTOM_TYPE = "goal";
export const GOAL_CONTEXT_CUSTOM_TYPE = "goal-context";

export type GoalStatus = "active" | "paused" | "complete";
export type GoalEvent =
	| "set"
	| "create"
	| "replace"
	| "edit"
	| "pause"
	| "resume"
	| "complete"
	| "clear"
	| "auto"
	| "max"
	| "continue";

export interface GoalState {
	version: 1;
	goalId: string;
	objective: string;
	status: GoalStatus;
	createdAt: number;
	updatedAt: number;
	autonomous: boolean;
	continuationCount: number;
	lastContinuationAt?: number;
	completedAt?: number;
	completedBy?: "model" | "user";
	maxContinuations?: number;
}

export interface GoalSnapshotEntry {
	event: GoalEvent;
	goal: GoalState | null;
	note?: string;
}

export interface GoalRuntime {
	getGoal(): GoalState | undefined;
	setGoal(goal: GoalState | undefined, event: GoalEvent, note?: string): void;
	replaceGoal(objective: string, options?: Partial<Pick<GoalState, "autonomous" | "maxContinuations">>): GoalState;
	updateGoal(patch: Partial<GoalState>, event: GoalEvent, note?: string): GoalState;
	clearGoal(note?: string): void;
	continueGoal(reason: string): boolean;
	configureMaxContinuations(value: number | undefined): void;
	getDefaultMaxContinuations(): number | undefined;
}
