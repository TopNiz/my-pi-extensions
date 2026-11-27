import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import goalExtension, { buildEvidence, parseEvaluatorOutput, parseGoal, restoreGoal } from "../goal.ts";

afterEach(() => mock.restore());

function usage(tokens = 100, cost = 0.01) {
	return { input: tokens / 2, output: tokens / 2, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
		cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } };
}

function assistant(text: string, stopReason = "stop", reported: any = usage()) {
	return { role: "assistant", content: [{ type: "text", text }], stopReason, usage: reported, timestamp: Date.now() };
}

function assessment(verdict = "not_met", evidence: string[] = [], reason = "Run the missing check.") {
	return assistant(JSON.stringify({ verdict, evidence, reason }), "stop", usage(50, 0.002));
}

function projection(branch: any[]) {
	return branch.map((entry) => ({ sourceEntry: entry, messages: entry.type === "message" ? [entry.message] : [] }));
}

function extensionHarness(initialBranch?: any[]) {
	let serial = 0;
	let pending = false;
	let idle = true;
	const branch: any[] = initialBranch ? structuredClone(initialBranch) : [
		{ id: "before-goal", type: "message", message: { role: "user", content: "Unrelated earlier work" } },
	];
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const notifications: string[] = [];
	const messages: any[] = [];
	const calls: any[] = [];
	let complete: (model: any, context: any, options: any) => Promise<any> = async () => assessment();
	const pi: any = {
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => handlers.set(name, handler),
		appendEntry: (customType: string, data: any) => branch.push({ id: `state-${++serial}`, type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (message: any, options: any) => {
			messages.push({ ...message, options });
			branch.push({ id: `custom-${++serial}`, type: "custom_message", ...message });
		},
		sendUserMessage: () => { throw new Error("Feedback must not impersonate user input"); },
	};
	const ctx: any = {
		mode: "tui", hasUI: true, signal: undefined,
		ui: { notify: (text: string) => notifications.push(text), setStatus() {}, setWidget() {}, onTerminalInput: () => () => {} },
		waitForIdle: async () => {},
		sessionManager: { getBranch: () => branch, getLeafId: () => branch.at(-1)?.id ?? null, buildSessionProjection: () => ({ entries: projection(branch) }) },
		isIdle: () => idle, hasPendingMessages: () => pending,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			complete: async (model: any, context: any, options: any) => {
				calls.push({ model, context, options });
				return complete(model, context, options);
			},
		},
	};
	goalExtension(pi);
	const run = (args: string) => commands.get("goal").handler(args, ctx);
	const state = () => [...branch].reverse().find((entry) => entry.type === "custom" && entry.customType === "goal-state")?.data.goal;
	async function work(text = "Verification still needs work.", toolOutput?: string) {
		const results: any[] = [];
		const toolResultEntryIds: string[] = [];
		if (toolOutput !== undefined) {
			const result = { role: "toolResult", toolName: "bash", toolCallId: `call-${++serial}`,
				content: [{ type: "text", text: toolOutput }], isError: false, timestamp: Date.now() };
			const id = `tool-${++serial}`;
			branch.push({ id, type: "message", message: result });
			toolResultEntryIds.push(id);
			results.push(result);
		}
		const message = assistant(text);
		const messageEntryId = `assistant-${++serial}`;
		branch.push({ id: messageEntryId, type: "message", message });
		await handlers.get("turn_end")({ message, messageEntryId, toolResults: results, toolResultEntryIds, outcome: "completed" }, ctx);
	}
	async function settle(overrides: any = {}) {
		const event = {
			entries: [], continue: false, outcome: "completed",
			context: { contextMessages: branch.filter((entry) => entry.type === "message").map((entry) => entry.message), contextEntries: projection(branch), pendingMessages: [] },
			...overrides,
		};
		const result = await handlers.get("agent_before_settle")(event, ctx);
		for (const entry of result?.entries || []) branch.push({ id: `boundary-${++serial}`, ...entry });
		if (!(result?.continue ?? event.continue)) handlers.get("agent_settled")({ aborted: overrides.aborted ?? false }, ctx);
		return result;
	}
	return {
		branch, commands, handlers, notifications, messages, calls, ctx, run, state, work, settle,
		setPending: (value: boolean) => { pending = value; },
		setIdle: (value: boolean) => { idle = value; },
		setComplete: (fn: typeof complete) => { complete = fn; },
		setAssessment: (verdict: string, reason?: string) => {
			complete = async (_model, context) => {
				const packet = JSON.parse(context.messages[0].content[0].text);
				const records = packet.evidence ? packet.evidence.split("\n").map((line: string) => JSON.parse(line)) : [];
				const reference = [...records].reverse().find((record: any) => record.role === "toolResult") || records.at(-1);
				return assessment(verdict, reference ? [reference.id] : [], reason);
			};
		},
	};
}

describe("goal contract parsing", () => {
	test("finite defaults", () => {
		expect(parseGoal("Produce a verified report")).toMatchObject({ maxCycles: 20, timeLimitMs: 1_800_000, evaluatorModel: "deepseek/deepseek-flash" });
	});
	test("sentence-style, quoted, semicolon, and newline limits", () => {
		for (const raw of ['"do X; stop after 5 turns"', "do X. Stop after 5 cycles.", "do X\nStop after 5 turns."]) {
			expect(parseGoal(raw)).toMatchObject({ condition: "do X", maxCycles: 5 });
		}
	});
	test("cycle and time limits coexist in either order", () => {
		for (const raw of ["do X; stop after 5 turns; stop after 2 minutes", "do X; stop after 2 minutes; stop after 5 turns"]) {
			expect(parseGoal(raw)).toMatchObject({ condition: "do X", maxCycles: 5, timeLimitMs: 120_000 });
		}
	});
	test("evaluator option does not contaminate acceptance criteria", () => {
		expect(parseGoal("do X --evaluator local/model; stop after 3 turns")).toMatchObject({ condition: "do X", evaluatorModel: "local/model", maxCycles: 3 });
	});
	test("seconds and hours", () => {
		expect(parseGoal("do X; stop after 2 seconds").timeLimitMs).toBe(2000);
		expect(parseGoal("do X; stop after 2 hours").timeLimitMs).toBe(7_200_000);
	});
	test("invalid, duplicate, empty, and oversized conditions fail", () => {
		for (const raw of ["", "stop after 3 cycles", "do X; stop after 0 turns", "do X; stop after -1 turns", "do X; stop after 1.5 minutes", "do X; stop after 2 weeks", "do X; stop after 2 minutes; stop after 1 hour", "do X --evaluator", "do X --evaluator model", "do X --evaluator a/b --evaluator c/d", "x".repeat(4001)]) {
			expect(() => parseGoal(raw)).toThrow();
		}
	});
});

describe("evidence packet", () => {
	test("includes tool observations with IDs, excludes unrelated history and private thinking", () => {
		const packet = buildEvidence(projection([
			{ id: "old", type: "message", message: { role: "user", content: "old context" } as any },
			{ id: "boundary", type: "custom" },
			{ id: "tool", type: "message", message: { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "Tests: 42 passed" }], details: { hidden: "raw details" } } as any },
			{ id: "answer", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "Observed test result." }] } as any },
		]), ["tool", "answer"]);
		expect(packet.ids).toEqual(["tool", "answer"]);
		expect(packet.text).toContain("42 passed");
		for (const excluded of ["old context", "private reasoning", "raw details"]) expect(packet.text).not.toContain(excluded);
	});
	test("truncation and missing start markers are explicit, not silent", () => {
		const branch = Array.from({ length: 30 }, (_, i) => ({ id: `item-${i}`, type: "message", message: assistant(`${i}:` + "x".repeat(4000)) as any }));
		const packet = buildEvidence(projection(branch), [...branch.map((entry) => entry.id), "omitted-by-projection"], 18_000);
		expect(packet.omitted).toBe(true);
		expect(packet.text.length).toBeLessThanOrEqual(18_000);
		expect(packet.ids).toContain("item-0");
		expect(packet.ids).toContain("item-29");
	});
	test("oversized individual evidence is marked", () => {
		const packet = buildEvidence(projection([{ id: "large", type: "message", message: assistant("x".repeat(8000)) as any }]), ["large"]);
		expect(packet.omitted).toBe(true);
		expect(packet.text).toContain("Middle omitted");
	});
});

describe("structured evaluator assessments", () => {
	test("accepts the four verdicts with valid references", () => {
		for (const verdict of ["met", "not_met", "blocked", "impossible"]) {
			expect(parseEvaluatorOutput(JSON.stringify({ verdict, reason: "Observed evidence.", evidence: ["tool"] }), ["tool"]))
				.toEqual({ verdict: verdict as any, reason: "Observed evidence.", evidence: ["tool"] });
		}
	});
	test("fails closed on malformed or unsupported claims", () => {
		for (const output of ["", "MET: trust me", "null", "[]", "{}", JSON.stringify({ verdict: "met", reason: "yes", evidence: [] }), JSON.stringify({ verdict: "met", reason: "yes", evidence: ["invented"] }), JSON.stringify({ verdict: "not_met", reason: "", evidence: [] }), JSON.stringify({ verdict: "unknown", reason: "unsure", evidence: [] })]) {
			expect(parseEvaluatorOutput(output, ["tool"]).failed).toBe(true);
		}
	});
});

describe("commands and lifecycle", () => {
	test("bare command shows status; aliases remain available", async () => {
		const h = extensionHarness();
		await h.run("");
		expect(h.messages).toHaveLength(0);
		await h.run("do X");
		await h.run("");
		expect(h.notifications.at(-1)).toContain("State: active");
		await h.commands.get("goal-clear").handler("", h.ctx);
		await h.commands.get("goal-status").handler("", h.ctx);
		expect(h.state()).toBeNull();
		expect(h.notifications.at(-1)).toContain("No goal set");
	});
	test("pause retains state and resume retains accounting", async () => {
		const h = extensionHarness();
		await h.run("do X");
		await h.work();
		await h.run("pause");
		expect(h.state().phase).toBe("paused");
		expect(await h.settle()).toBeUndefined();
		await h.run("resume");
		expect(h.state().phase).toBe("active");
		expect(h.state().executorUsage.requests).toBe(1);
		expect(h.messages).toHaveLength(2);
	});
	test("does not start or replace goals while unrelated work or input is pending", async () => {
		const h = extensionHarness();
		h.setIdle(false);
		await h.run("do X");
		expect(h.messages).toHaveLength(0);
		h.setIdle(true);
		h.setPending(true);
		await h.run("do X");
		expect(h.messages).toHaveLength(0);
	});
	test("invalid replacement preserves the existing goal", async () => {
		const h = extensionHarness();
		await h.run("first");
		const id = h.state().id;
		await h.run("second; stop after 0 turns");
		expect(h.state().id).toBe(id);
	});
	test("user input pauses automatic pursuit, but extension input does not", async () => {
		const h = extensionHarness();
		await h.run("do X");
		h.handlers.get("input")({ source: "extension" }, h.ctx);
		expect(h.state().phase).toBe("active");
		h.handlers.get("input")({ source: "interactive" }, h.ctx);
		expect(h.state().phase).toBe("paused");
	});
	test("inactive goals are not injected as active instructions", async () => {
		const h = extensionHarness();
		await h.run("do X");
		await h.run("pause");
		expect(h.handlers.get("context")({ messages: [] }).messages.at(-1).content).toContain("Prior goal instructions are revoked");
	});
});

describe("safe evaluation and continuation", () => {
	test("does not evaluate intermediate turns; continues only at settlement", async () => {
		const h = extensionHarness();
		await h.run("do X");
		await h.work("Checking", "one observation");
		await h.work("Need another check");
		expect(h.calls).toHaveLength(0);
		expect(h.state().cycles).toBe(0);
		const result = await h.settle();
		expect(h.calls).toHaveLength(1);
		expect(h.state().cycles).toBe(1);
		expect(result.continue).toBe(true);
		expect(result.entries.at(-1).type).toBe("custom_message");
	});
	test("evaluator receives visible tool evidence, pinned criteria, and no tools", async () => {
		const h = extensionHarness();
		await h.run("Check the full test suite --evaluator local/reviewer");
		await h.work("Check results", "42 tests passed");
		await h.settle();
		const call = h.calls[0];
		expect(call.model).toEqual({ provider: "local", id: "reviewer" });
		expect(call.context.tools).toBeUndefined();
		const packet = JSON.parse(call.context.messages[0].content[0].text);
		expect(packet.condition).toBe("Check the full test suite");
		expect(packet.evidence).toContain("42 tests passed");
		expect(call.context.systemPrompt).toContain("no tools");
		expect(call.context.systemPrompt).toContain("Self-reported success is not verification");
	});
	test("completion on the final allowed cycle is evaluated, not mislabeled as a limit", async () => {
		const h = extensionHarness();
		h.setAssessment("met", "Test output supports the criteria.");
		await h.run("Tests pass; stop after 1 cycle");
		await h.work("Observed", "All tests passed");
		const result = await h.settle();
		expect(h.state().phase).toBe("completed");
		expect(result).toBeUndefined();
		expect(h.branch.at(-1).data.text).toContain("not independent proof");
		expect(h.state().lastEvidence[0]).toStartWith("tool-");
	});
	test("non-completion at the cycle limit retains limit-reached state", async () => {
		const h = extensionHarness();
		await h.run("Tests pass; stop after 1 turn");
		await h.work("Observed", "Tests failing");
		const result = await h.settle();
		expect(h.calls).toHaveLength(1);
		expect(h.state().phase).toBe("limit-reached");
		expect(result.continue).toBeUndefined();
		await h.run("resume");
		expect(h.messages).toHaveLength(1);
	});
	test("elapsed limit prevents another evaluation or continuation", async () => {
		const now = spyOn(Date, "now").mockReturnValue(1000);
		const h = extensionHarness();
		await h.run("do X; stop after 1 second");
		await h.work();
		now.mockReturnValue(2001);
		await h.settle();
		expect(h.calls).toHaveLength(0);
		expect(h.state().phase).toBe("limit-reached");
	});
	test("paused time is not charged against active-time limit", async () => {
		const now = spyOn(Date, "now").mockReturnValue(1000);
		const h = extensionHarness();
		await h.run("do X; stop after 5 seconds");
		now.mockReturnValue(2000);
		await h.run("pause");
		now.mockReturnValue(50_000);
		await h.run("resume");
		expect(h.state().elapsedMs).toBe(1000);
		expect(h.state().phase).toBe("active");
	});
	test("does not compete with pending work, input, or another continuation", async () => {
		const h = extensionHarness();
		await h.run("do X");
		await h.work();
		await h.settle({ continue: true });
		await h.settle({ context: { contextMessages: [], pendingMessages: [{ role: "user" }] } });
		h.setPending(true);
		await h.settle();
		expect(h.calls).toHaveLength(0);
		h.setPending(false);
		expect((await h.settle()).continue).toBe(true);
	});
	test("preserves prior extension boundary drafts", async () => {
		const h = extensionHarness();
		await h.run("do X");
		await h.work();
		const prior = { type: "custom", customType: "other-extension", data: { value: 1 } };
		expect((await h.settle({ entries: [prior] })).entries[0]).toEqual(prior);
	});
	test("accounts for executor and evaluator usage separately", async () => {
		const h = extensionHarness();
		await h.run("do X");
		await h.work();
		await h.work();
		await h.settle();
		expect(h.state().executorUsage).toEqual({ requests: 2, tokens: 200, cost: 0.02, unknown: 0 });
		expect(h.state().evaluatorUsage).toEqual({ requests: 1, tokens: 50, cost: 0.002, unknown: 0 });
	});
	test("missing provider usage remains explicitly unknown", async () => {
		const h = extensionHarness();
		h.setComplete(async () => ({ ...assessment(), usage: undefined }));
		await h.run("do X");
		await h.work();
		await h.settle();
		expect(h.state().evaluatorUsage.unknown).toBe(1);
	});
	test("blocked marker returns control without a paid assessment", async () => {
		const h = extensionHarness();
		await h.run("do X");
		await h.work("GOAL_BLOCKED: Need user consent to modify the named files.");
		await h.settle();
		expect(h.calls).toHaveLength(0);
		expect(h.state().phase).toBe("blocked");
	});
	test("blocked and impossible assessments remain reviewable and resumable", async () => {
		for (const verdict of ["blocked", "impossible"]) {
			const h = extensionHarness();
			h.setAssessment(verdict, "Required source is unavailable.");
			await h.run("do X");
			await h.work();
			await h.settle();
			expect(h.state().phase).toBe("blocked");
			expect(h.state().lastVerdict).toBe(verdict);
			await h.run("resume");
			expect(h.state().phase).toBe("active");
		}
	});
	test("two no-tool cycles pause instead of spinning", async () => {
		const h = extensionHarness();
		await h.run("do X");
		await h.work(); await h.settle();
		await h.work(); const result = await h.settle();
		expect(h.state().phase).toBe("paused");
		expect(result.continue).toBeUndefined();
	});
	test("repeated identical tool output also pauses conservatively", async () => {
		const h = extensionHarness();
		await h.run("do X");
		for (let i = 0; i < 3; i++) { await h.work("Same check", "identical output"); await h.settle(); }
		expect(h.state().phase).toBe("paused");
		expect(h.state().lastReason).toContain("Possible lack of progress");
	});
	test("recovered errors are not prematurely evaluated or cleared", async () => {
		const h = extensionHarness();
		await h.run("do X");
		await h.handlers.get("turn_end")({ message: assistant("", "error"), messageEntryId: "failed", toolResults: [], toolResultEntryIds: [], outcome: "error" }, h.ctx);
		expect(h.state().phase).toBe("active");
		await h.settle({ outcome: "error" });
		expect(h.state().phase).toBe("paused");
		expect(h.calls).toHaveLength(0);
	});
	test("works without terminal UI", async () => {
		const h = extensionHarness();
		h.ctx.mode = "print";
		h.ctx.ui.setStatus = () => { throw new Error("TUI called"); };
		h.ctx.ui.setWidget = () => { throw new Error("TUI called"); };
		await h.run("do X; stop after 1 cycle");
		await h.work();
		expect((await h.settle()).entries.at(-1).type).toBe("custom");
	});
});

describe("evaluator failures and races", () => {
	test("provider failure, incomplete response, and malformed verdict pause without clearing", async () => {
		for (const result of ["throw", "error", "aborted", "length", "invalid"]) {
			const h = extensionHarness();
			h.setComplete(async () => {
				if (result === "throw") throw new Error("internal diagnostic must not be relayed");
				return assistant(result === "invalid" ? "not JSON" : JSON.stringify({ verdict: "met", reason: "unreliable", evidence: [] }), result === "invalid" ? "stop" : result);
			});
			await h.run("do X");
			await h.work();
			await h.settle();
			expect(h.state().phase).toBe("paused");
			expect(JSON.stringify(h.branch)).not.toContain("internal diagnostic must not be relayed");
			await h.run("resume");
			expect(h.state().phase).toBe("active");
		}
	});
	test("unavailable evaluator fails closed", async () => {
		const h = extensionHarness();
		h.ctx.modelRegistry.find = () => undefined;
		await h.run("do X");
		await h.work(); await h.settle();
		expect(h.state().phase).toBe("paused");
		expect(h.state().evaluatorUsage.requests).toBe(0);
	});
	test("time-limited evaluation cancels only its own model request", async () => {
		const h = extensionHarness();
		let aborted = false;
		h.setComplete(async (_model, _context, options) => new Promise((_resolve, reject) => {
			options.signal.addEventListener("abort", () => { aborted = true; reject(new Error("stopped")); }, { once: true });
		}));
		await h.run("do X; stop after 1 second");
		await h.work(); await h.settle();
		expect(aborted).toBe(true);
		expect(h.state().phase).toBe("limit-reached");
	});
	test("pause, clear, input, and shutdown invalidate in-flight assessments", async () => {
		for (const action of ["pause", "clear", "input", "shutdown"]) {
			const h = extensionHarness();
			let release!: (value: any) => void;
			h.setComplete(async () => new Promise((resolve) => { release = resolve; }));
			await h.run("do X");
			await h.work();
			const settling = h.settle();
			expect(h.calls).toHaveLength(1);
			if (action === "input") h.handlers.get("input")({ source: "rpc" }, h.ctx);
			else if (action === "shutdown") h.handlers.get("session_shutdown")();
			else await h.run(action);
			release(assessment());
			expect(await settling).toBeUndefined();
			if (action === "pause" || action === "input") expect(h.state().phase).toBe("paused");
			if (action === "clear") expect(h.state()).toBeNull();
		}
	});
	test("new queued input during evaluation suppresses continuation", async () => {
		const h = extensionHarness();
		h.setComplete(async () => { h.setPending(true); return assessment(); });
		await h.run("do X");
		await h.work();
		expect(await h.settle()).toBeUndefined();
		expect(h.state().phase).toBe("paused");
	});
	test("aborted settlement pauses the active goal", async () => {
		const h = extensionHarness();
		await h.run("do X");
		h.handlers.get("agent_settled")({ aborted: true }, h.ctx);
		expect(h.state().phase).toBe("paused");
	});
});

describe("session persistence", () => {
	test("restore retains counters but does not silently restart work", async () => {
		const h = extensionHarness();
		await h.run("do X");
		await h.work("Observed", "evidence"); await h.settle();
		const restored = extensionHarness(h.branch);
		restored.handlers.get("session_start")({}, restored.ctx);
		expect(restored.messages).toHaveLength(0);
		await restored.run("");
		expect(restored.notifications.at(-1)).toContain("State: paused");
		await restored.run("resume");
		expect(restored.state().cycles).toBe(1);
		expect(restored.state().executorUsage.requests).toBe(1);
	});
	test("latest clear entry wins over old goals", async () => {
		const h = extensionHarness();
		await h.run("first"); await h.run("second"); await h.run("clear");
		const restored = extensionHarness(h.branch);
		restored.handlers.get("session_start")({}, restored.ctx);
		await restored.run("");
		expect(restored.notifications.at(-1)).toContain("No goal set");
		const messages = [{ role: "user", content: "Continue my normal request." }];
		for (const event of ["session_start", "session_tree"]) {
			restored.handlers.get(event)({}, restored.ctx);
			expect(restored.handlers.get("context")({ messages })).toBeUndefined();
		}
	});
	test("completed and blocked goals retain their outcomes", async () => {
		for (const verdict of ["met", "blocked"]) {
			const h = extensionHarness();
			h.setAssessment(verdict);
			await h.run("do X"); await h.work("Observed", "evidence"); await h.settle();
			const restored = restoreGoal({ version: 2, goal: h.state() });
			expect(restored?.phase).toBe(verdict === "met" ? "completed" : "blocked");
		}
	});
	test("tree navigation reconstructs the selected branch", async () => {
		const h = extensionHarness();
		await h.run("do X");
		const selected = structuredClone(h.branch);
		await h.run("clear");
		h.branch.splice(0, h.branch.length, ...selected);
		h.handlers.get("session_tree")({}, h.ctx);
		await h.run("");
		expect(h.notifications.at(-1)).toContain("State: paused");
	});
	test("legacy state migrates paused with new cycle semantics", () => {
		const goal = restoreGoal({ active: { condition: "do X", description: "do X", maxTurns: 5, timeLimitMs: 0, turnsElapsed: 3 } });
		expect(goal).toMatchObject({ phase: "paused", cycles: 0, maxCycles: 5, timeLimitMs: 1_800_000 });
	});
	test("malformed state cannot activate a goal", () => {
		for (const value of [null, {}, { version: 2, goal: {} }, { active: null }, { active: { condition: "" } }]) expect(restoreGoal(value)).toBeNull();
	});
});

describe("independent-review regressions", () => {
	test("observed verification cannot complete using an assistant-only citation", async () => {
		const h = extensionHarness();
		h.setAssessment("met");
		await h.run("Tests pass"); await h.work("I claim they pass"); await h.settle();
		expect(h.state().phase).toBe("paused");
	});
	test("explicit text-only verification permits an inspectable text deliverable", async () => {
		const h = extensionHarness();
		h.setAssessment("met");
		await h.run("Produce an answer --text-only"); await h.work("The requested answer."); await h.settle();
		expect(h.state().phase).toBe("completed");
		expect(h.state().condition).toBe("Produce an answer");
	});
	test("projected redactions and omissions cannot fall back to raw history", () => {
		const raw = { id: "raw", type: "message", message: assistant("Raw material that was removed") };
		const packet = buildEvidence([
			{ sourceEntry: raw as any, messages: [assistant("Approved replacement") as any] },
			{ sourceEntry: { ...raw, id: "omitted" } as any, messages: [] },
			{ sourceEntry: { ...raw, id: "unrelated" } as any, messages: [assistant("Unrelated work") as any] },
		], ["raw", "omitted"]);
		expect(packet.text).toContain("Approved replacement");
		expect(packet.text).not.toContain("Raw material");
		expect(packet.text).not.toContain("Unrelated work");
		expect(packet.omitted).toBe(true);
	});
	test("work observed while paused is not shared after resume", async () => {
		const h = extensionHarness();
		await h.run("do X"); await h.work("Goal work", "Goal observation");
		await h.run("pause"); await h.work("Unrelated answer", "Unrelated observation");
		await h.run("resume"); await h.work("Resumed goal", "Fresh observation"); await h.settle();
		const packet = h.calls[0].context.messages[0].content[0].text;
		expect(packet).not.toContain("Unrelated");
		expect(packet).toContain("Goal observation");
	});
	test("clear removes every goal-owned instruction without adding a replacement", async () => {
		const h = extensionHarness();
		await h.run("Old objective"); await h.run("clear");
		const owned = ["goal-kickoff", "goal-context", "goal-assessment", "goal-bound", "goal-evaluator-error", "goal-complete", "goal-live-context"]
			.map((customType) => ({ role: "custom", customType, content: "Old active instruction" }));
		const unrelated = { role: "custom", customType: "other-extension", content: "Keep this context." };
		const user = { role: "user", content: "Explain the literal text [GOAL MODE CLEARED], then continue my request." };
		const messages = [...owned, unrelated, user];
		for (let request = 0; request < 3; request++) {
			const result = h.handlers.get("context")({ messages });
			expect(result.messages).toEqual([unrelated, user]);
			expect(JSON.stringify(result.messages)).not.toContain("Prior goal instructions are revoked");
		}
		expect(messages).toEqual([...owned, unrelated, user]);
		expect(h.handlers.get("context")({ messages: [unrelated, user] })).toBeUndefined();
		expect(h.messages).toHaveLength(1);
		expect(h.calls).toHaveLength(0);
	});
	test("an unused or repeatedly cleared extension leaves normal requests unchanged", async () => {
		const h = extensionHarness();
		const messages = [{ role: "user", content: "My ordinary request." }];
		expect(h.handlers.get("context")({ messages })).toBeUndefined();
		await h.run("clear"); await h.run("clear");
		expect(h.handlers.get("context")({ messages })).toBeUndefined();
		expect(h.messages).toHaveLength(0);
		expect(h.calls).toHaveLength(0);
	});
	test("a new goal after clear injects only its current live instruction", async () => {
		const h = extensionHarness();
		await h.run("Old objective"); await h.run("clear");
		await h.run("New objective");
		const user = { role: "user", content: "My current request." };
		let messages = [{ role: "custom", customType: "goal-live-context", content: "Old objective" }, user];
		for (let request = 0; request < 3; request++) {
			messages = h.handlers.get("context")({ messages }).messages;
			expect(messages.filter((message) => message.customType === "goal-live-context")).toHaveLength(1);
			expect(messages.at(-1).content).toContain("[GOAL MODE ACTIVE] New objective");
			expect(JSON.stringify(messages)).not.toContain("Old objective");
			expect(messages[0]).toEqual(user);
		}
	});
	test("clear returns promptly even if the provider ignores cancellation", async () => {
		const h = extensionHarness();
		h.setComplete(async () => new Promise(() => {}));
		await h.run("do X"); await h.work();
		const settling = h.settle();
		await h.run("clear");
		expect(await settling).toBeUndefined();
		expect(h.state()).toBeNull();
	});
	test("provisional completion is invalidated by later work", async () => {
		const h = extensionHarness();
		h.setAssessment("met");
		await h.run("do X"); await h.work("Observed", "Tool observation");
		const context = { contextMessages: h.branch.filter((entry) => entry.type === "message").map((entry) => entry.message), contextEntries: projection(h.branch), pendingMessages: [] };
		await h.handlers.get("agent_before_settle")({ entries: [], continue: false, outcome: "completed", context }, h.ctx);
		expect(h.state().phase).toBe("active");
		await h.work("Further work changed the result");
		h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
		expect(h.state().phase).toBe("active");
	});
	test("abort after evaluation but before settlement cannot commit completion", async () => {
		const h = extensionHarness();
		h.setAssessment("met");
		await h.run("do X"); await h.work("Observed", "Tool observation");
		await h.settle({ aborted: true });
		expect(h.state().phase).toBe("paused");
		expect(h.branch.some((entry) => entry.type === "custom" && entry.data?.goal?.phase === "completed")).toBe(false);
	});
});

/** Actual Pi session/extension/print lifecycle, with deterministic in-memory models.
 * No discovery, stored credentials, network calls, session files, or real shell tools.
 * Resolve against this managed installation rather than adding test dependencies.
 */
async function runtimeHarness(options: {
	evaluate?: (packet: any) => Promise<any> | any;
	respond?: (request: number, context: any) => any;
	factories?: ((pi: any) => void)[];
} = {}) {
	const { readFileSync } = await import("node:fs");
	const { createRequire } = await import("node:module");
	const version = readFileSync(new URL("../../install/current-version", import.meta.url), "utf8").trim();
	if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error("Invalid managed Pi version");
	const root = new URL(`../../install/releases/${version}/node_modules/`, import.meta.url);
	const sdk = new URL("@earendil-works/pi-coding-agent/dist/", root);
	const [{ AgentSession }, { SessionManager }, { SettingsManager }, { createEventBus }, loader, { Agent }, { convertToLlm }, { createAssistantMessageEventStream }, { runPrintMode }] = await Promise.all([
		import(new URL("core/agent-session.js", sdk).href), import(new URL("core/session-manager.js", sdk).href),
		import(new URL("core/settings-manager.js", sdk).href), import(new URL("core/event-bus.js", sdk).href),
		import(new URL("core/extensions/loader.js", sdk).href), import(new URL("@earendil-works/pi-agent-core/dist/agent.js", root).href),
		import(new URL("core/messages.js", sdk).href), import(new URL("@earendil-works/pi-ai/dist/utils/event-stream.js", root).href),
		import(new URL("modes/print-mode.js", sdk).href),
	]);
	const { Type } = createRequire(new URL("index.js", sdk).href)("typebox");
	const model = { provider: "goal-test", id: "executor", name: "In-memory executor", api: "openai-completions", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const packets: any[] = [];
	const requests: any[] = [];
	const errors: any[] = [];
	let observations = 0;
	const runtime: any = {
		getModel: (_provider: string, id: string) => ({ ...model, id }),
		getPhysicalModel: (_provider: string, id: string) => ({ ...model, id }),
		hasConfiguredAuth: () => true, getAvailableSnapshot: () => [model], getError: () => undefined,
		getAuth: async () => undefined, isUsingOAuth: () => false,
		complete: async (_model: any, context: any) => {
			const packet = JSON.parse(context.messages[0].content[0].text);
			packets.push(packet);
			if (options.evaluate) return options.evaluate(packet);
			const records = packet.evidence.split("\n").filter(Boolean).map((line: string) => JSON.parse(line));
			const reference = [...records].reverse().find((entry: any) => entry.role === "toolResult") || records.at(-1);
			return assessment("met", reference ? [reference.id] : []);
		},
	};
	// Match createAgentSession's context bridge, including after extension reload.
	const extensionRunnerRef: { current?: any } = {};
	const agent = new Agent({ initialState: { model, thinkingLevel: "off" }, convertToLlm,
		transformContext: async (messages: any[]) => extensionRunnerRef.current?.emitContext(messages) ?? messages,
		streamFn: (_model: any, context: any) => {
			requests.push(context);
			const number = requests.length;
			const message = { ...assistant("Observed check output."), api: model.api, model: model.id, provider: model.provider,
				...(options.respond ? options.respond(number, context) : number % 2 === 1
					? { content: [{ type: "toolCall", id: `observe-${number}`, name: "observe", arguments: {} }], stopReason: "toolUse" }
					: {}),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: message.stopReason, message });
			return stream;
		},
	});
	const extensionRuntime = loader.createExtensionRuntime();
	const eventBus = createEventBus();
	const extensions = [];
	for (const factory of [goalExtension, ...(options.factories || [])]) {
		extensions.push(await loader.loadExtensionFromFactory(factory, process.cwd(), eventBus, extensionRuntime));
	}
	const resources: any = {
		getExtensions: () => ({ extensions, runtime: extensionRuntime, errors: [] }),
		getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "In-memory goal lifecycle test.", getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, reload: async () => {},
	};
	const session = new AgentSession({ agent, modelRuntime: runtime, resourceLoader: resources, extensionRunnerRef,
		cwd: process.cwd(), sessionManager: SessionManager.inMemory(process.cwd()),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		baseToolsOverride: { observe: { name: "observe", label: "Observe", description: "Return a deterministic test observation", parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: `Observation ${++observations}: test check passed` }], details: undefined }) } },
	});
	const bind = async () => session.bindExtensions({ mode: "json", commandContextActions: { waitForIdle: () => session.waitForIdle() }, onError: (error: any) => errors.push(error) });
	await bind();
	const state = () => [...session.sessionManager.getBranch()].reverse().find((entry: any) => entry.type === "custom" && entry.customType === "goal-state")?.data.goal;
	return { session, requests, packets, errors, state, runPrintMode, observations: () => observations };
}

describe("installed Pi runtime integration (no network)", () => {
	test("single-shot goal command waits through two work cycles and preserves an assistant tail", async () => {
		let evaluation = 0;
		const h = await runtimeHarness({ evaluate: (packet) => {
			const records = packet.evidence.split("\n").map((line: string) => JSON.parse(line));
			return assessment(++evaluation === 1 ? "not_met" : "met", [records.findLast((entry: any) => entry.role === "toolResult").id]);
		} });
		try {
			await h.session.prompt("/goal Check observations --evaluator goal-test/reviewer; stop after 2 cycles");
			expect(h.errors).toEqual([]);
			expect(h.state().phase).toBe("completed");
			expect(h.state().cycles).toBe(2);
			expect(h.requests).toHaveLength(4);
			expect(h.observations()).toBe(2);
			expect(h.packets).toHaveLength(2);
			expect(h.session.state.messages.at(-1).role).toBe("assistant");
		} finally { h.session.dispose(); }
	});
	test("abort while evaluator is pending cannot commit completion", async () => {
		let started!: () => void;
		const evaluating = new Promise<void>((resolve) => { started = resolve; });
		let release!: (value: any) => void;
		const h = await runtimeHarness({ evaluate: () => { started(); return new Promise((resolve) => { release = resolve; }); } });
		try {
			const run = h.session.prompt("/goal Check observations --evaluator goal-test/reviewer");
			await evaluating;
			const abort = h.session.abort();
			const records = h.packets[0].evidence.split("\n").map((line: string) => JSON.parse(line));
			release(assessment("met", [records.findLast((entry: any) => entry.role === "toolResult").id]));
			await Promise.all([run, abort]);
			expect(h.errors).toEqual([]);
			expect(h.state().phase).toBe("paused");
			expect(h.requests).toHaveLength(2);
			expect(h.session.sessionManager.getBranch().some((entry: any) => entry.data?.goal?.phase === "completed")).toBe(false);
		} finally { h.session.dispose(); }
	});
	test("context-edit drafts are respected before evidence leaves the session", async () => {
		const h = await runtimeHarness({ factories: [(pi) => {
			pi.on("turn_end", (event: any) => ({ entries: [...event.entries, ...event.toolResultEntryIds.map((targetId: string) => ({ type: "context_edit", targetId, replacement: { content: [{ type: "text", text: "Approved replacement" }] } }))] }));
		}] });
		try {
			await h.session.prompt("/goal Check observations --evaluator goal-test/reviewer");
			expect(h.errors).toEqual([]);
			expect(h.packets[0].evidence).toContain("Approved replacement");
			expect(h.packets[0].evidence).not.toContain("test check passed");
		} finally { h.session.dispose(); }
	});
	test("late settlement evidence changes invalidate provisional completion", async () => {
		const h = await runtimeHarness({ factories: [(pi) => {
			pi.on("agent_before_settle", (event: any) => {
				const observation = event.context.contextEntries.find((entry: any) => entry.messages.some((message: any) => message.role === "toolResult"));
				return { entries: [...event.entries, { type: "context_edit", targetId: observation.sourceEntry.id, replacement: { content: [{ type: "text", text: "Correction: check failed" }] } }] };
			});
		}] });
		try {
			await h.session.prompt("/goal Check observations --evaluator goal-test/reviewer");
			expect(h.errors).toEqual([]);
			expect(h.state().phase).toBe("paused");
			expect(h.state().lastVerdict).toBeUndefined();
			expect(h.state().lastReason).toContain("Evidence changed");
		} finally { h.session.dispose(); }
	});
	test("clearing removes goal instructions from later real model requests and stops evaluation", async () => {
		const h = await runtimeHarness();
		try {
			await h.session.prompt("/goal Synthetic old objective --evaluator goal-test/reviewer");
			const requests = h.requests.length;
			const evaluations = h.packets.length;
			await h.session.prompt("/goal clear");
			expect(h.state()).toBeNull();
			expect(h.requests).toHaveLength(requests);
			for (const prompt of ["Continue my ordinary request.", "Answer a second ordinary request."]) {
				const before = h.requests.length;
				await h.session.prompt(prompt);
				const later = h.requests.slice(before);
				expect(later.length).toBeGreaterThan(0);
				for (const request of later) {
					const messages = JSON.stringify(request.messages);
					expect(messages).toContain(prompt);
					expect(messages).not.toContain("Synthetic old objective");
					expect(messages).not.toContain("[GOAL");
					expect(messages).not.toContain("Prior goal instructions are revoked");
				}
				expect(h.packets).toHaveLength(evaluations);
			}
			expect(h.errors).toEqual([]);
		} finally { h.session.dispose(); }
	});
	test("JSON status produces a structured notification without another model call", async () => {
		const h = await runtimeHarness();
		try {
			await h.session.prompt("/goal Check observations --evaluator goal-test/reviewer");
			const count = h.requests.length;
			await h.session.prompt("/goal");
			const last = h.session.sessionManager.getBranch().at(-1);
			expect(last.customType).toBe("goal-notification");
			expect(last.data.text).toContain("State: completed");
			expect(h.requests).toHaveLength(count);
		} finally { h.session.dispose(); }
	});
	test("real text print mode finishes pursuit and emits its final answer", async () => {
		const h = await runtimeHarness();
		const output: string[] = [];
		const diagnostics: string[] = [];
		const stdout = spyOn(process.stdout, "write").mockImplementation(((chunk: any, ...args: any[]) => {
			output.push(String(chunk)); const callback = args.find((arg) => typeof arg === "function"); callback?.(); return true;
		}) as any);
		const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: any) => { diagnostics.push(String(chunk)); return true; }) as any);
		try {
			const exit = await h.runPrintMode({ session: h.session, setRebindSession() {}, dispose: async () => h.session.dispose() },
				{ mode: "text", initialMessage: "/goal Check observations --evaluator goal-test/reviewer" });
			expect(exit).toBe(0);
			expect(h.errors).toEqual([]);
			expect(output.join("")).toContain("Observed check output.");
			expect(diagnostics.join("")).toContain("GOAL ASSESSED COMPLETE");
		} finally { stdout.mockRestore(); stderr.mockRestore(); h.session.dispose(); }
	});
});
