import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { GOAL_CUSTOM_TYPE, type GoalEvent, type GoalSnapshotEntry, type GoalState } from "./types";
import { validateObjective } from "./prompts";

export function createGoal(objective: string, options?: Partial<Pick<GoalState, "autonomous" | "maxContinuations">>): GoalState {
	const trimmed = objective.trim();
	const validationError = validateObjective(trimmed);
	if (validationError) throw new Error(validationError);

	const now = Date.now();
	return {
		version: 1,
		goalId: randomUUID(),
		objective: trimmed,
		status: "active",
		createdAt: now,
		updatedAt: now,
		autonomous: options?.autonomous ?? true,
		continuationCount: 0,
		...(options?.maxContinuations !== undefined ? { maxContinuations: options.maxContinuations } : {}),
	};
}

export function restoreGoalFromBranch(ctx: ExtensionContext): GoalState | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; customType?: string; data?: GoalSnapshotEntry };
		if (entry.type !== "custom" || entry.customType !== GOAL_CUSTOM_TYPE) continue;
		return normalizeGoal(entry.data?.goal);
	}
	return undefined;
}

export function persistGoal(piAppendEntry: (customType: string, data?: unknown) => void, event: GoalEvent, goal: GoalState | undefined, note?: string): void {
	piAppendEntry(GOAL_CUSTOM_TYPE, {
		event,
		goal: goal ? { ...goal } : null,
		...(note ? { note } : {}),
	});
}

export function completeGoal(goal: GoalState, completedBy: "model" | "user"): GoalState {
	const now = Date.now();
	return {
		...goal,
		status: "complete",
		updatedAt: now,
		completedAt: now,
		completedBy,
		autonomous: false,
	};
}

export function updateGoalObjective(goal: GoalState, objective: string): GoalState {
	const trimmed = objective.trim();
	const validationError = validateObjective(trimmed);
	if (validationError) throw new Error(validationError);
	return {
		...goal,
		objective: trimmed,
		status: "active",
		updatedAt: Date.now(),
		autonomous: true,
		completedAt: undefined,
		completedBy: undefined,
	};
}

export function setGoalStatus(goal: GoalState, status: GoalState["status"]): GoalState {
	const now = Date.now();
	if (status === "complete") return completeGoal(goal, "user");
	return {
		...goal,
		status,
		updatedAt: now,
		...(status === "active" ? { autonomous: true, completedAt: undefined, completedBy: undefined } : {}),
		...(status === "paused" ? { autonomous: false } : {}),
	};
}

export function setGoalAutonomous(goal: GoalState, autonomous: boolean): GoalState {
	return {
		...goal,
		autonomous,
		updatedAt: Date.now(),
		...(autonomous && goal.status === "paused" ? { status: "active" as const } : {}),
	};
}

export function setGoalMaxContinuations(goal: GoalState, maxContinuations: number | undefined): GoalState {
	const next = { ...goal, updatedAt: Date.now() };
	if (maxContinuations === undefined) {
		delete next.maxContinuations;
	} else {
		next.maxContinuations = maxContinuations;
	}
	return next;
}

export function markContinuationQueued(goal: GoalState): GoalState {
	return {
		...goal,
		continuationCount: goal.continuationCount + 1,
		lastContinuationAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function normalizeGoal(goal: GoalState | null | undefined): GoalState | undefined {
	if (!goal || goal.version !== 1 || typeof goal.objective !== "string") return undefined;
	if (goal.status !== "active" && goal.status !== "paused" && goal.status !== "complete") return undefined;
	return {
		...goal,
		autonomous: goal.status === "active" ? (goal.autonomous ?? true) : Boolean(goal.autonomous),
		continuationCount: Number.isFinite(goal.continuationCount) ? goal.continuationCount : 0,
	};
}
