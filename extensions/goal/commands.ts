import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { objectiveUpdatedPrompt, validateObjective } from "./prompts";
import { completeGoal, createGoal, setGoalAutonomous, setGoalMaxContinuations, setGoalStatus, updateGoalObjective } from "./state";
import type { GoalRuntime, GoalState } from "./types";
import { goalSummary, updateGoalWidget } from "./ui";

export function registerGoalCommand(pi: ExtensionAPI, runtime: GoalRuntime): void {
	pi.registerCommand("goal", {
		description: "Set, inspect, or control an autonomous session goal",
		handler: async (args, ctx) => handleGoalCommand(pi, runtime, args, ctx),
	});
}

async function handleGoalCommand(pi: ExtensionAPI, runtime: GoalRuntime, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const raw = args ?? "";
	const trimmed = raw.trim();

	if (!trimmed || trimmed.toLowerCase() === "status") {
		ctx.ui.notify(goalSummary(runtime.getGoal()), "info");
		updateGoalWidget(ctx, runtime.getGoal());
		return;
	}

	const [command, ...restParts] = splitArgs(trimmed);
	const rest = restParts.join(" ").trim();

	switch (command.toLowerCase()) {
		case "pause":
			return pauseGoal(runtime, ctx);
		case "resume":
			return resumeGoal(runtime, ctx);
		case "clear":
			return clearGoal(runtime, ctx);
		case "complete":
			return completeGoalFromUser(runtime, ctx);
		case "edit":
			return editGoal(pi, runtime, ctx, rest);
		case "auto":
			return setAuto(runtime, ctx, rest);
		case "max":
			return setMax(runtime, ctx, rest);
		default:
			return setObjective(runtime, ctx, trimmed);
	}
}

async function setObjective(runtime: GoalRuntime, ctx: ExtensionCommandContext, objective: string): Promise<void> {
	const validationError = validateObjective(objective);
	if (validationError) {
		ctx.ui.notify(validationError, "error");
		return;
	}

	const current = runtime.getGoal();
	if (current && current.status !== "complete" && ctx.hasUI) {
		const ok = await ctx.ui.confirm("Replace active goal?", `Current goal:\n${current.objective}\n\nNew goal:\n${objective}`);
		if (!ok) return;
	}

	const goal = createGoal(objective, { maxContinuations: runtime.getDefaultMaxContinuations() });
	runtime.setGoal(goal, current ? "replace" : "create", current ? "replaced by user" : "created by user");
	updateGoalWidget(ctx, goal);
	ctx.ui.notify(`Goal active: ${goal.objective}`, "info");
	runtime.continueGoal("goal-created");
}

function pauseGoal(runtime: GoalRuntime, ctx: ExtensionCommandContext): void {
	const goal = requireGoal(runtime, ctx);
	if (!goal) return;
	const paused = setGoalStatus(goal, "paused");
	runtime.setGoal(paused, "pause", "paused by user");
	updateGoalWidget(ctx, paused);
	ctx.ui.notify("Goal paused", "info");
}

function resumeGoal(runtime: GoalRuntime, ctx: ExtensionCommandContext): void {
	const goal = requireGoal(runtime, ctx);
	if (!goal) return;
	const active = setGoalStatus(goal, "active");
	runtime.setGoal(active, "resume", "resumed by user");
	updateGoalWidget(ctx, active);
	ctx.ui.notify("Goal resumed", "info");
	runtime.continueGoal("goal-resumed");
}

function clearGoal(runtime: GoalRuntime, ctx: ExtensionCommandContext): void {
	if (!runtime.getGoal()) {
		ctx.ui.notify("No goal is currently set", "info");
		return;
	}
	runtime.clearGoal("cleared by user");
	updateGoalWidget(ctx, undefined);
	ctx.ui.notify("Goal cleared", "info");
}

function completeGoalFromUser(runtime: GoalRuntime, ctx: ExtensionCommandContext): void {
	const goal = requireGoal(runtime, ctx);
	if (!goal) return;
	const completed = completeGoal(goal, "user");
	runtime.setGoal(completed, "complete", "completed by user");
	updateGoalWidget(ctx, completed);
	ctx.ui.notify("Goal marked complete", "info");
}

async function editGoal(pi: ExtensionAPI, runtime: GoalRuntime, ctx: ExtensionCommandContext, inlineObjective: string): Promise<void> {
	const goal = requireGoal(runtime, ctx);
	if (!goal) return;
	const objective = inlineObjective || (await ctx.ui.editor("Edit goal", goal.objective))?.trim();
	if (!objective) return;
	const validationError = validateObjective(objective);
	if (validationError) {
		ctx.ui.notify(validationError, "error");
		return;
	}
	const updated = updateGoalObjective(goal, objective);
	runtime.setGoal(updated, "edit", "edited by user");
	updateGoalWidget(ctx, updated);
	ctx.ui.notify("Goal updated", "info");
	if (!ctx.isIdle()) {
		pi.sendMessage(
			{
				customType: "goal-context",
				content: objectiveUpdatedPrompt(updated),
				display: false,
				details: { goalId: updated.goalId, reason: "goal-edited" },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	} else {
		runtime.continueGoal("goal-edited");
	}
}

function setAuto(runtime: GoalRuntime, ctx: ExtensionCommandContext, rest: string): void {
	const goal = requireGoal(runtime, ctx);
	if (!goal) return;
	const value = rest.toLowerCase();
	if (value !== "on" && value !== "off") {
		ctx.ui.notify("Usage: /goal auto on|off", "error");
		return;
	}
	if (goal.status === "complete" && value === "on") {
		ctx.ui.notify("Completed goals cannot be made autonomous. Use /goal <objective> to start a new goal.", "error");
		return;
	}
	const updated = setGoalAutonomous(goal, value === "on");
	runtime.setGoal(updated, "auto", `autonomous ${value}`);
	updateGoalWidget(ctx, updated);
	ctx.ui.notify(`Goal autonomous mode ${value}`, "info");
	if (updated.status === "active" && updated.autonomous) runtime.continueGoal("goal-auto-on");
}

function setMax(runtime: GoalRuntime, ctx: ExtensionCommandContext, rest: string): void {
	const parsed = parseMaxContinuations(rest);
	if (parsed instanceof Error) {
		ctx.ui.notify(parsed.message, "error");
		return;
	}
	runtime.configureMaxContinuations(parsed);
	const goal = runtime.getGoal();
	if (goal) {
		const updated = setGoalMaxContinuations(goal, parsed);
		runtime.setGoal(updated, "max", parsed === undefined ? "removed continuation cap" : `set continuation cap to ${parsed}`);
		updateGoalWidget(ctx, updated);
	} else {
		updateGoalWidget(ctx, undefined);
	}
	ctx.ui.notify(parsed === undefined ? "Future goals have no continuation cap" : `Future goals will pause after ${parsed} continuations`, "info");
}

function requireGoal(runtime: GoalRuntime, ctx: ExtensionCommandContext): GoalState | undefined {
	const goal = runtime.getGoal();
	if (!goal) ctx.ui.notify("No goal is currently set. Usage: /goal <objective>", "error");
	return goal;
}

function parseMaxContinuations(value: string): number | undefined | Error {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed || trimmed === "off" || trimmed === "none" || trimmed === "unlimited") return undefined;
	const parsed = Number(trimmed);
	if (!Number.isInteger(parsed) || parsed <= 0) return new Error("Usage: /goal max <positive-integer|off>");
	return parsed;
}

function splitArgs(value: string): string[] {
	return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}
