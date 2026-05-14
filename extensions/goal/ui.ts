import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { GoalState } from "./types";

const OBJECTIVE_WIDGET_LIMIT = 140;

export function updateGoalWidget(ctx: ExtensionContext, goal: GoalState | undefined): void {
	if (!ctx.hasUI) return;
	if (!goal) {
		ctx.ui.setStatus("goal", undefined);
		ctx.ui.setWidget("goal", undefined, { placement: "belowEditor" });
		return;
	}

	const icon = goal.status === "complete" ? "✅" : goal.status === "paused" ? "⏸" : "🎯";
	const status = goal.status === "active" && goal.autonomous ? "active · autonomous on" : goal.status === "active" ? "active · autonomous off" : goal.status;
	ctx.ui.setStatus("goal", `${icon} ${status}`);

	const lines = [
		`${icon} Goal: ${truncate(goal.objective, OBJECTIVE_WIDGET_LIMIT)}`,
		`Status: ${status} · continuations: ${goal.continuationCount}${goal.maxContinuations !== undefined ? `/${goal.maxContinuations}` : ""}`,
		commandsFor(goal),
	];
	ctx.ui.setWidget("goal", lines, { placement: "belowEditor" });
}

export function goalSummary(goal: GoalState | undefined): string {
	if (!goal) {
		return "No goal is currently set.\n\nUsage: /goal <objective>";
	}

	const lines = [
		"Goal",
		`Status: ${goal.status}`,
		`Autonomous: ${goal.autonomous ? "on" : "off"}`,
		`Continuations: ${goal.continuationCount}${goal.maxContinuations !== undefined ? ` / ${goal.maxContinuations}` : ""}`,
		`Created: ${new Date(goal.createdAt).toLocaleString()}`,
		`Updated: ${new Date(goal.updatedAt).toLocaleString()}`,
	];
	if (goal.completedAt) lines.push(`Completed: ${new Date(goal.completedAt).toLocaleString()}${goal.completedBy ? ` by ${goal.completedBy}` : ""}`);
	lines.push("", "Objective:", goal.objective, "", commandsFor(goal));
	return lines.join("\n");
}

function commandsFor(goal: GoalState): string {
	if (goal.status === "active") return "Commands: /goal pause · /goal edit · /goal auto off · /goal complete · /goal clear";
	if (goal.status === "paused") return "Commands: /goal resume · /goal edit · /goal clear";
	return "Commands: /goal clear · /goal <new objective>";
}

function truncate(value: string, max: number): string {
	if ([...value].length <= max) return value;
	return [...value].slice(0, max - 1).join("") + "…";
}
