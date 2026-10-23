import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { buildEvaluatorInvocation, parseEvaluatorOutput } from "../goal.ts";

const PI_CLI = "/Users/nizarayed/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

describe("buildEvaluatorInvocation", () => {
	test("never passes the removed -b flag", () => {
		const { args } = buildEvaluatorInvocation("/tmp/pi.js", "openai-codex/gpt-5.5", "prompt");
		expect(args).not.toContain("-b");
	});

	test("uses the script path with the active node executable", () => {
		const { command, args } = buildEvaluatorInvocation("/tmp/pi.js", "m", "PROMPT");
		expect(command).toBe(process.execPath);
		expect(args).toEqual([
			"/tmp/pi.js",
			"--mode", "json",
			"-p",
			"--no-session",
			"--model", "m",
			"PROMPT",
		]);
	});

	test("falls back to the pi binary when there is no script or it is bun-virtual", () => {
		for (const script of [undefined, "/$bunfs/root/pi"]) {
			const { command, args } = buildEvaluatorInvocation(script, "m", "PROMPT");
			expect(command).toBe("pi");
			expect(args[0]).toBe("--mode");
			expect(args).not.toContain("-b");
		}
	});

	test("omits --model when no model is configured", () => {
		const { args } = buildEvaluatorInvocation("/tmp/pi.js", "", "PROMPT");
		expect(args).not.toContain("--model");
		expect(args.at(-1)).toBe("PROMPT");
	});

	test("the real Pi CLI accepts the generated flags", () => {
		const { args } = buildEvaluatorInvocation(PI_CLI, "some/model", "PROMPT");
		// Drop the prompt, then ask the CLI to print help: proves flag parsing.
		const probe = [...args.slice(1, -1), "--help"];
		const output = execFileSync(process.execPath, [PI_CLI, ...probe], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(output).toContain("--no-session");
	});
});

describe("parseEvaluatorOutput", () => {
	test("parses MET", () => {
		expect(parseEvaluatorOutput("MET: all requirements shown")).toEqual({
			met: true,
			reason: "all requirements shown",
		});
	});

	test("parses NOT MET", () => {
		const result = parseEvaluatorOutput("NOT MET: tests are missing");
		expect(result.met).toBe(false);
		expect(result.failed).toBeUndefined();
		expect(result.reason).toBe("tests are missing");
	});

	test("treats empty or unparseable output as a failure, not a verdict", () => {
		for (const output of ["", "   ", "I could not decide.", "MET", "NOTMET: nope"]) {
			const result = parseEvaluatorOutput(output);
			expect(result.met).toBe(false);
			expect(result.failed).toBe(true);
		}
	});
});
