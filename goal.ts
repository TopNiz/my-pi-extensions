/**
 * /goal Extension — Autonomous multi-turn goal pursuit with a secondary evaluator.
 *
 * Inspired by Claude Code's /goal command described by Alexandru Dan.
 *
 * Usage:
 *   /goal "survey the 100 most cited papers on a topic; write a document with a
 *          table covering all 100; stop after 50 turns"
 *
 * How it works:
 *   1. Sets a verifiable completion condition with explicit bounds
 *   2. Injects the goal into the system prompt
 *   3. After each turn, a fast evaluator model reads the conversation and
 *      returns yes/no with a reason
 *   4. "no" → injects a steering message with the evaluator's guidance
 *   5. "yes" → announces completion and clears the goal
 *   6. /goal-clear stops the run on demand
 *   7. /goal-status shows current progress
 */

import type { AgentMessage, AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

// ── Types ───────────────────────────────────────────────────────────────────

interface ActiveGoal {
	/** Raw goal description (as typed by user). */
	description: string;
	/** The verifiable completion condition (everything before "; stop after"). */
	condition: string;
	/** Turn limit (0 = unlimited). */
	maxTurns: number;
	/** When the goal was started (Unix ms). */
	startedAt: number;
	/** Elapsed time limit in ms (0 = unlimited). */
	timeLimitMs: number;
	/** Evaluator model id (provider/model or just model name). */
	evaluatorModel: string;
	/** Turn counter (incremented at each turn_end). */
	turnsElapsed: number;
}

interface GoalState {
	active: ActiveGoal | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Parse a goal description like `"do X; stop after N turns"` */
function parseGoal(raw: string): Pick<ActiveGoal, "description" | "condition" | "maxTurns" | "timeLimitMs"> {
	const description = raw.trim();
	let condition = description;
	let maxTurns = 0;
	let timeLimitMs = 0;

	// Extract turn bound: "; stop after N turns" or "; stop after N turn"
	const turnMatch = condition.match(/;\s*stop\s+after\s+(\d+)\s+turns?\s*$/i);
	if (turnMatch) {
		maxTurns = parseInt(turnMatch[1], 10);
		condition = condition.replace(/;\s*stop\s+after\s+\d+\s+turns?\s*$/i, "").trim();
	}

	// Extract time bound: "; stop after N seconds/minutes/hours"
	const timeMatch = condition.match(/;\s*stop\s+after\s+(\d+)\s+(second|minute|hour)s?\s*$/i);
	if (timeMatch) {
		const amount = parseInt(timeMatch[1], 10);
		const unit = timeMatch[2].toLowerCase();
		if (unit === "second") timeLimitMs = amount * 1000;
		else if (unit === "minute") timeLimitMs = amount * 60_000;
		else if (unit === "hour") timeLimitMs = amount * 3_600_000;
		condition = condition.replace(/;\s*stop\s+after\s+\d+\s+(second|minute|hour)s?\s*$/i, "").trim();
	}

	return { description, condition, maxTurns, timeLimitMs };
}

function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min > 0) return `${min}m ${sec}s`;
	return `${sec}s`;
}

function extractMessageText(msg: AgentMessage): string {
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** Collect all assistant + user messages from the session branch. */
function collectMessages(ctx: ExtensionContext): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && "message" in entry) {
			const m = entry.message as AgentMessage;
			if (m.role === "user" || m.role === "assistant") {
				messages.push(m);
			}
		}
	}
	return messages;
}

/** Build the conversation text for the evaluator. */
function buildConversationText(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const m of messages) {
		const text = extractMessageText(m);
		if (!text) continue;
		if (m.role === "user") {
			parts.push(`USER: ${text}`);
		} else if (m.role === "assistant") {
			// Remove thinking blocks from evaluation text — the evaluator only
			// judges what Claude has surfaced in visible output.
			const cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
			if (cleaned) {
				parts.push(`ASSISTANT: ${cleaned}`);
			}
		}
	}
	return parts.join("\n\n");
}

// ── Evaluator ───────────────────────────────────────────────────────────────

interface EvalResult {
	met: boolean;
	reason: string;
}

/** Run a fast evaluator model (spawns `pi -p` subprocess). */
async function evaluateGoal(
	goal: ActiveGoal,
	conversationText: string,
	ctx: ExtensionContext,
): Promise<EvalResult> {
	// Keep conversation manageable
	const truncated = conversationText.length > 15000
		? "…" + conversationText.slice(-15000)
		: conversationText;

	const evalPrompt = [
		`You are a strict goal evaluator. Your ONLY job is to determine whether the following goal has been COMPLETELY satisfied based on the conversation so far.`,
		``,
		`GOAL: ${goal.condition}`,
		``,
		`RULES:`,
		`- Be strict. The goal is only MET if every requirement is provably satisfied by visible output.`,
		`- If the goal is NOT yet met, explain concisely what is still missing.`,
		`- Respond with EXACTLY one line: "MET: <reason>" or "NOT MET: <reason>"`,
		``,
		`CONVERSATION:`,
		truncated,
	].join("\n");

	const result = await runPiSubprocess(evalPrompt, goal.evaluatorModel, ctx.cwd, 15000);

	if (result.exitCode !== 0) {
		return { met: false, reason: `Evaluator error: ${(result.stderr || "(no stderr)").slice(0, 200)}` };
	}

	const output = result.stdout.trim();

	// Parse structured response
	const metMatch = output.match(/^MET:\s*(.*)/is);
	if (metMatch) return { met: true, reason: metMatch[1].trim() };
	const notMetMatch = output.match(/^NOT MET:\s*(.*)/is);
	if (notMetMatch) return { met: false, reason: notMetMatch[1].trim() };

	// Fallback
	return { met: false, reason: `Evaluator returned unclear response, assuming not yet met.` };
}

/** Fallback heuristic evaluator when model-based evaluation is not available. */
function heuristicEvaluate(goal: ActiveGoal, conversationText: string): EvalResult {
	// If we can't call a model, just check if the assistant has completed
	// enough turns to plausibly be done. This is a coarse fallback.
	const lines = conversationText.split("\n").filter((l) => l.startsWith("ASSISTANT:"));
	if (lines.length === 0) return { met: false, reason: "The agent hasn't started working yet." };

	// Check if the last assistant message suggests completion
	const last = lines[lines.length - 1];
	const doneKeywords = [
		"goal met", "completed", "finished", "all done",
		"all 100", "all items", "table covering all", "every requirement",
		"fully satisfied", "done.",
	];
	const hasDoneSignal = doneKeywords.some((kw) => last.toLowerCase().includes(kw));
	if (hasDoneSignal) return { met: true, reason: "Agent indicates completion." };

	// If the user recently sent a "GOAL MET" message, consider it done
	if (conversationText.includes("GOAL MET")) return { met: true, reason: "Goal completion signaled." };

	return { met: false, reason: "Continuing work. Heuristic evaluator: no completion signal detected yet." };
}

// ── Subprocess ──────────────────────────────────────────────────────────────

interface SubprocessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function runPiSubprocess(
	prompt: string,
	model: string,
	cwd: string,
	timeoutMs: number,
): Promise<SubprocessResult> {
	return new Promise((resolve) => {
		const currentScript = process.argv[1];
		const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");

		let command: string;
		let args: string[];

		if (currentScript && !isBunVirtual) {
			command = process.execPath;
			args = [currentScript, "--mode", "json", "-p", "--no-session", "-b"];
		} else {
			command = "pi";
			args = ["--mode", "json", "-p", "--no-session", "-b"];
		}

		if (model) args.push("--model", model);
		args.push(prompt);

		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let buffer = "";
		let fullText = "";

		const handleData = (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_end" && event.message) {
						for (const part of event.message.content || []) {
							if (part.type === "text") fullText += part.text;
						}
					}
				} catch {
					if (line.trim()) fullText += line + "\n";
				}
			}
		};

		proc.stdout.on("data", handleData);
		proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 2000);
		}, timeoutMs);

		proc.on("close", (code) => {
			clearTimeout(timer);
			if (buffer.trim()) {
				try {
					const event = JSON.parse(buffer);
					if (event.type === "message_end" && event.message) {
						for (const part of event.message.content || []) {
							if (part.type === "text") fullText += part.text;
						}
					}
				} catch {
					if (buffer.trim()) fullText += buffer;
				}
			}
			resolve({ exitCode: code ?? 0, stdout: fullText || stdout, stderr });
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			resolve({ exitCode: 1, stdout: "", stderr: err.message });
		});
	});
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function goalExtension(pi: ExtensionAPI) {
	const state: GoalState = { active: null };

	// ── State helpers ────────────────────────────────────────────────────

	function persistState(): void {
		pi.appendEntry("goal-state", { active: state.active });
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!state.active) {
			ctx.ui.setStatus("goal", undefined);
			ctx.ui.setWidget("goal", undefined);
			return;
		}
		const g = state.active;
		const elapsed = Date.now() - g.startedAt;
		const turnInfo = g.maxTurns > 0 ? `${g.turnsElapsed}/${g.maxTurns}` : `${g.turnsElapsed}`;
		const timeInfo = g.timeLimitMs > 0 ? ` ${formatElapsed(elapsed)}/${formatElapsed(g.timeLimitMs)}` : "";

		ctx.ui.setStatus(
			"goal",
			ctx.ui.theme.fg("accent", `🎯 ${g.description.slice(0, 50)}${g.description.length > 50 ? "…" : ""} [${turnInfo}${timeInfo}]`),
		);
		ctx.ui.setWidget("goal", [
			ctx.ui.theme.fg("accent", "🎯 ") + g.description,
			ctx.ui.theme.fg("muted", `Turns: ${turnInfo}${timeInfo} · eval: ${g.evaluatorModel || "default"}`),
		]);
	}

	function clearGoal(ctx: ExtensionContext, notify = true): void {
		if (!state.active) return;
		const desc = state.active.description;
		state.active = null;
		updateStatus(ctx);
		persistState();
		if (notify) ctx.ui.notify(`⏹️ Goal cleared: ${desc}`, "info");
	}

	function isBoundReached(goal: ActiveGoal): { reached: boolean; reason: string } {
		if (goal.maxTurns > 0 && goal.turnsElapsed >= goal.maxTurns) {
			return { reached: true, reason: `Turn limit (${goal.turnsElapsed}/${goal.maxTurns})` };
		}
		if (goal.timeLimitMs > 0) {
			const elapsed = Date.now() - goal.startedAt;
			if (elapsed >= goal.timeLimitMs) {
				return { reached: true, reason: `Time limit (${formatElapsed(elapsed)})` };
			}
		}
		return { reached: false, reason: "" };
	}

	// ── Commands ─────────────────────────────────────────────────────────

	pi.registerCommand("goal", {
		description: `Set a verifiable goal for autonomous work. Usage: /goal "description; stop after N turns"  or  /goal "description --evaluator openai-codex/gpt-5.5; stop after 10 turns"`,    
		handler: async (args, ctx) => {
			const raw = args?.trim();
			if (!raw) {
				ctx.ui.notify(
					'Usage: /goal "do X; stop after N turns" or /goal "do X; stop after N minutes"',
					"info",
				);
				return;
			}

			// Cancel any previous goal first
			if (state.active) clearGoal(ctx);

			const parsed = parseGoal(raw);

					// Evaluator model: gpt-5.5 via OpenAI Codex
			let evaluatorModel = "openai-codex/gpt-5.5";
			// Allow override via "--evaluator <model>" syntax in the goal description
			const evalMatch = parsed.description.match(/--evaluator\s+(\S+)/i);
			if (evalMatch) {
				evaluatorModel = evalMatch[1];
			}

			state.active = {
				...parsed,
				startedAt: Date.now(),
				evaluatorModel,
				turnsElapsed: 0,
			};

			ctx.ui.notify(`🎯 Goal set: ${parsed.description}`, "info");
			updateStatus(ctx);
			persistState();

			// Kick off the agent
			pi.sendMessage(
				{
					customType: "goal-kickoff",
					content: [
						`[GOAL ACTIVATED]`,
						``,
						`Goal: ${parsed.condition}`,
						``,
						`Work toward completing this goal. After each turn, an evaluator checks progress.`,
						`Do NOT stop early — continue until the goal is fully satisfied or you hit the bound.`,
						`Make your progress VISIBLE so the evaluator can confirm it.`,
					].join("\n"),
					display: true,
				},
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("goal-clear", {
		description: "Cancel the current goal",
		handler: async (_args, ctx) => {
			if (!state.active) {
				ctx.ui.notify("No active goal.", "info");
				return;
			}
			clearGoal(ctx);
		},
	});

	pi.registerCommand("goal-status", {
		description: "Show current goal progress",
		handler: async (_args, ctx) => {
			if (!state.active) {
				ctx.ui.notify("No active goal.", "info");
				return;
			}
			const g = state.active;
			const elapsed = Date.now() - g.startedAt;
			ctx.ui.notify([
				`🎯 ${g.description}`,
				`   Condition: ${g.condition}`,
				`   Turns: ${g.turnsElapsed}${g.maxTurns > 0 ? ` / ${g.maxTurns}` : " (unlimited)"}`,
				`   Elapsed: ${formatElapsed(elapsed)}${g.timeLimitMs > 0 ? ` / ${formatElapsed(g.timeLimitMs)}` : ""}`,
				`   Evaluator: ${g.evaluatorModel} (executor: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "current"})`,
			].join("\n"), "info");
		},
	});

	// ── Events ───────────────────────────────────────────────────────────

	// Inject goal context before each agent start
	pi.on("before_agent_start", async (event) => {
		if (!state.active) return;

		return {
			message: {
				customType: "goal-context",
				content: [
					`[GOAL MODE ACTIVE]`,
					``,
					`You are working autonomously toward a goal:`,
					state.active.condition,
					``,
					`RULES:`,
					`- Work toward the goal turn by turn.`,
					`- After each turn, an evaluator checks progress and provides feedback.`,
					`- DO NOT stop early. Continue until the goal is fully satisfied.`,
					`- If the evaluator flags something missing, address it on the next turn.`,
					`- Make your progress provable from visible output.`,
				].join("\n"),
				display: false,
			},
		};
	});

	// After each turn, evaluate progress via a secondary model
	pi.on("turn_end", async (event, ctx) => {
		if (!state.active) return;

		const goal = state.active;
		goal.turnsElapsed++;

		// Check bounds first
		const bound = isBoundReached(goal);
		if (bound.reached) {
			ctx.ui.notify(`⏹️ ${bound.reason}`, "warning");
			pi.sendMessage(
				{
					customType: "goal-bound",
					content: `[GOAL STOPPED — ${bound.reason}]\n\nGoal: ${goal.description}\n\nSummarize what you accomplished.`,
					display: true,
				},
				{ deliverAs: "steer" },
			);
			clearGoal(ctx, false);
			return;
		}

		// Collect messages and build conversation text for the evaluator
		const messages = collectMessages(ctx);
		const conversationText = buildConversationText(messages);

		// Run evaluation (try model-based, fall back to heuristic)
		let evaluation: EvalResult;
		try {
			evaluation = await evaluateGoal(goal, conversationText, ctx);
		} catch {
			evaluation = heuristicEvaluate(goal, conversationText);
		}

		if (evaluation.met) {
			ctx.ui.notify(`✅ Goal met: ${evaluation.reason}`, "success");
			pi.sendMessage(
				{
					customType: "goal-complete",
					content: `✅ [GOAL MET]\n\nGoal: ${goal.condition}\n\nEvaluator: ${evaluation.reason}\n\nThe goal has been satisfied.`,
					display: true,
				},
				{ deliverAs: "steer" },
			);
			clearGoal(ctx, false);
		} else {
			// Steering: inject evaluator feedback as a user message
			const steerMsg = [
				`[EVALUATOR FEEDBACK — goal not yet met]`,
				``,
				`Goal: ${goal.condition}`,
				`Evaluator: ${evaluation.reason}`,
				``,
				`Please continue working. Address the feedback above.`,
			].join("\n");

			updateStatus(ctx);
			persistState();

			pi.sendUserMessage(steerMsg, { deliverAs: "steer" });
		}
	});

	// ── Cleanup & restore ────────────────────────────────────────────────

	pi.on("session_shutdown", () => {
		state.active = null;
	});

	pi.on("session_start", (_event, ctx) => {
		// Restore persisted state
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "goal-state") {
				const data = entry.data as { active: ActiveGoal | null } | undefined;
				if (data?.active) {
					state.active = data.active;
					// Discard if stale
					if (state.active.timeLimitMs > 0 && Date.now() - state.active.startedAt > state.active.timeLimitMs) {
						state.active = null;
					} else if (state.active.maxTurns > 0 && state.active.turnsElapsed >= state.active.maxTurns) {
						state.active = null;
					}
				}
				break;
			}
		}
		if (state.active) {
			ctx.ui.notify(`📋 Restored goal: ${state.active.description}`, "info");
		}
		updateStatus(ctx);
	});
}
