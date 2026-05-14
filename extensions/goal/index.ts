import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { activeGoalContextPrompt, continuationContext } from "./prompts";
import { registerGoalCommand } from "./commands";
import { createGoal, markContinuationQueued, persistGoal, restoreGoalFromBranch, setGoalStatus } from "./state";
import { GOAL_CONTEXT_CUSTOM_TYPE, type GoalEvent, type GoalRuntime, type GoalState } from "./types";
import { updateGoalWidget } from "./ui";
import { registerGoalTools } from "./tools";

export default function goalExtension(pi: ExtensionAPI): void {
	let goal: GoalState | undefined;
	let lastContext: ExtensionContext | undefined;
	let queuedContinuationGoalId: string | undefined;
	let defaultMaxContinuations: number | undefined;
	let watchedAbortSignal: AbortSignal | undefined;
	let unwatchAbortSignal: (() => void) | undefined;

	pi.registerFlag("goal-max-continuations", {
		description: "Optional cap for autonomous goal continuations. Empty means unlimited.",
		type: "string",
		default: "",
	});

	const runtime: GoalRuntime = {
		getGoal: () => goal,
		setGoal: (next, event, note) => setGoal(next, event, note),
		replaceGoal: (objective, options) => {
			const next = createGoal(objective, { maxContinuations: defaultMaxContinuations, ...options });
			setGoal(next, goal ? "replace" : "create");
			return next;
		},
		updateGoal: (patch, event, note) => {
			if (!goal) throw new Error("No goal is currently set");
			const next = { ...goal, ...patch, updatedAt: Date.now() };
			setGoal(next, event, note);
			return next;
		},
		clearGoal: (note) => setGoal(undefined, "clear", note),
		continueGoal,
		configureMaxContinuations: (value) => {
			defaultMaxContinuations = value;
		},
		getDefaultMaxContinuations: () => defaultMaxContinuations,
	};

	registerGoalTools(pi, runtime);
	registerGoalCommand(pi, runtime);

	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		defaultMaxContinuations = parseOptionalPositiveInteger(pi.getFlag("goal-max-continuations"));
		goal = restoreGoalFromBranch(ctx);
		updateGoalWidget(ctx, goal);
		if (goal?.status === "active" && goal.autonomous && ctx.isIdle()) {
			continueGoal("session-start");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		lastContext = ctx;
		goal = restoreGoalFromBranch(ctx);
		queuedContinuationGoalId = undefined;
		updateGoalWidget(ctx, goal);
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastContext = ctx;
		queuedContinuationGoalId = undefined;
		watchAbortSignal(ctx);
		updateGoalWidget(ctx, goal);
	});

	pi.on("agent_end", async (event, ctx) => {
		lastContext = ctx;
		if (agentEndWasAborted(event.messages)) {
			pauseGoalForInterrupt("paused after agent interruption");
		}
		unwatchAbortSignal?.();
		unwatchAbortSignal = undefined;
		watchedAbortSignal = undefined;
		updateGoalWidget(ctx, goal);
		if (ctx.hasPendingMessages()) return;
		continueGoal("agent-end");
	});

	pi.on("context", async (event, ctx) => {
		lastContext = ctx;
		if (!goal || goal.status !== "active") return;
		if (lastMessageAlreadyHasGoalContext(event.messages)) return;
		event.messages.push({
			role: "user",
			content: [{ type: "text", text: activeGoalContextPrompt(goal) }],
			timestamp: Date.now(),
		});
		return { messages: event.messages };
	});

	pi.on("session_shutdown", async () => {
		unwatchAbortSignal?.();
		unwatchAbortSignal = undefined;
		watchedAbortSignal = undefined;
		lastContext = undefined;
	});

	function watchAbortSignal(ctx: ExtensionContext): void {
		const signal = ctx.signal;
		if (!signal || signal === watchedAbortSignal) return;
		unwatchAbortSignal?.();
		watchedAbortSignal = signal;

		const onAbort = () => pauseGoalForInterrupt("paused after agent interruption");
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		unwatchAbortSignal = () => signal.removeEventListener("abort", onAbort);
	}

	function pauseGoalForInterrupt(note: string): void {
		const current = goal;
		if (!current || current.status !== "active") return;
		const paused = setGoalStatus(current, "paused");
		setGoal(paused, "pause", note);
		lastContext?.ui.notify("Goal paused after the agent was interrupted. Use /goal resume to continue.", "warning");
	}

	function setGoal(next: GoalState | undefined, event: GoalEvent, note?: string): void {
		goal = next;
		if (!next || next.status !== "active") queuedContinuationGoalId = undefined;
		persistGoal((customType, data) => pi.appendEntry(customType, data), event, next, note);
		if (lastContext) updateGoalWidget(lastContext, next);
	}

	function continueGoal(reason: string): boolean {
		const current = goal;
		if (!current || current.status !== "active" || !current.autonomous) return false;
		if (queuedContinuationGoalId === current.goalId) return false;
		if (current.maxContinuations !== undefined && current.continuationCount >= current.maxContinuations) {
			const paused = setGoalStatus(current, "paused");
			setGoal(paused, "pause", `paused after reaching max continuations (${current.maxContinuations})`);
			pi.sendMessage(
				{
					customType: GOAL_CONTEXT_CUSTOM_TYPE,
					content: `Goal paused after reaching the configured maximum of ${current.maxContinuations} autonomous continuation(s). Use /goal resume to continue.`,
					display: true,
					details: { goalId: current.goalId, reason: "max-continuations" },
				},
				{ triggerTurn: false },
			);
			return false;
		}

		const next = markContinuationQueued(current);
		queuedContinuationGoalId = next.goalId;
		setGoal(next, "continue", reason);
		pi.sendMessage(
			{
				customType: GOAL_CONTEXT_CUSTOM_TYPE,
				content: continuationContext(next),
				display: true,
				details: { goalId: next.goalId, reason },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		return true;
	}
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const parsed = Number(trimmed);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function agentEndWasAborted(messages: unknown[]): boolean {
	return messages.some((message) => Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "assistant" && (message as { stopReason?: unknown }).stopReason === "aborted"));
}

function lastMessageAlreadyHasGoalContext(messages: unknown[]): boolean {
	const last = messages[messages.length - 1];
	const text = messageText(last);
	return text.includes("<goal_context source=\"pi-goal-continuation\"") || text.includes("<goal_context source=\"pi-goal-active\"") || text.includes("<goal_context source=\"pi-goal-updated\"");
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}
