import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { validateObjective } from "./prompts";
import { completeGoal, createGoal } from "./state";
import type { GoalRuntime, GoalState } from "./types";
import { updateGoalWidget } from "./ui";

const createGoalSchema = Type.Object({
	objective: Type.String({ description: "The concrete objective to start pursuing." }),
});

type CreateGoalParams = Static<typeof createGoalSchema>;

const updateGoalSchema = Type.Object({
	status: StringEnum(["complete"] as const, {
		description: "Set to complete only when the objective is achieved and no required work remains.",
	}),
});

type UpdateGoalParams = Static<typeof updateGoalSchema>;

export function registerGoalTools(pi: ExtensionAPI, runtime: GoalRuntime): void {
	pi.registerTool({
		name: "goal_get",
		label: "Goal Get",
		description: "Get the current autonomous session goal, including status and continuation count.",
		promptSnippet: "Inspect the current autonomous session goal",
		parameters: Type.Object({}),
		async execute() {
			return goalToolResponse(runtime.getGoal());
		},
	});

	pi.registerTool({
		name: "goal_create",
		label: "Goal Create",
		description: "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Fails if a goal already exists.",
		promptSnippet: "Create an autonomous session goal only when explicitly requested",
		promptGuidelines: [
			"Use goal_create only when the user or higher-priority instructions explicitly ask to create a persistent/autonomous goal; do not infer goals from ordinary tasks.",
		],
		parameters: createGoalSchema,
		async execute(_toolCallId, params: CreateGoalParams, _signal, _onUpdate, ctx) {
			if (runtime.getGoal()) {
				throw new Error("cannot create a new goal because this session already has a goal; use goal_update only when the existing goal is complete");
			}
			const validationError = validateObjective(params.objective);
			if (validationError) throw new Error(validationError);
			const goal = createGoal(params.objective, { maxContinuations: runtime.getDefaultMaxContinuations() });
			runtime.setGoal(goal, "create", "created by model tool");
			updateGoalWidget(ctx, goal);
			return goalToolResponse(goal);
		},
	});

	pi.registerTool({
		name: "goal_update",
		label: "Goal Update",
		description: "Update the existing goal. Use this tool only to mark the goal achieved. Set status to complete only when the objective has actually been achieved and no required work remains. Do not mark a goal complete merely because you are stopping work. You cannot use this tool to pause, resume, clear, or replace a goal; those status changes are controlled by the user or system.",
		promptSnippet: "Mark the current autonomous session goal complete after verifying it is achieved",
		promptGuidelines: [
			"Use goal_update with status complete only after a requirement-by-requirement completion audit proves the full active goal is achieved and no required work remains.",
		],
		parameters: updateGoalSchema,
		async execute(_toolCallId, params: UpdateGoalParams, _signal, _onUpdate, ctx) {
			if (params.status !== "complete") {
				throw new Error("goal_update can only mark the existing goal complete; pause, resume, clear, and replacement are controlled by the user or system");
			}
			const current = runtime.getGoal();
			if (!current) throw new Error("cannot update goal because no goal is currently set");
			const completed = completeGoal(current, "model");
			runtime.setGoal(completed, "complete", "completed by model tool");
			updateGoalWidget(ctx, completed);
			return goalToolResponse(completed, "Goal achieved. Report completion to the user, including any important evidence or verification performed.");
		},
	});
}

function goalToolResponse(goal: GoalState | undefined, completionReport?: string) {
	const response = {
		goal: goal ? serializeGoal(goal) : null,
		completionReport: completionReport ?? null,
	};
	return {
		content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
		details: response,
	};
}

function serializeGoal(goal: GoalState) {
	return {
		goalId: goal.goalId,
		objective: goal.objective,
		status: goal.status,
		autonomous: goal.autonomous,
		continuationCount: goal.continuationCount,
		maxContinuations: goal.maxContinuations ?? null,
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
		completedAt: goal.completedAt ?? null,
		completedBy: goal.completedBy ?? null,
	};
}
