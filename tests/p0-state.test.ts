import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderCacheAudit } from "../extensions/usage-stats.ts";

const planSource = readFileSync(new URL("../extensions/plan.ts", import.meta.url), "utf8");
const goalSource = readFileSync(new URL("../extensions/goal.ts", import.meta.url), "utf8");

test("workboard never injects or rewrites model context", () => {
	assert.doesNotMatch(planSource, /workboard-context/);
	assert.doesNotMatch(planSource, /pi\.on\("context"/);
});

test("goal state uses a non-LLM custom entry", () => {
	assert.match(goalSource, /pi\.appendEntry\("goal", currentGoal\)/);
	assert.doesNotMatch(goalSource, /pi\.sendMessage\(/);
});

test("lightweight inspection budget is three read-only calls plus one bounded verification", () => {
	assert.match(planSource, /MAX_UNPLANNED_READ_ONLY_CALLS = 3/);
	assert.match(planSource, /MAX_UNPLANNED_BOUNDED_CHECKS = 1/);
	assert.match(planSource, /isReadOnlyInspection\(event\.toolName, event\.input\)/);
	assert.match(planSource, /isBoundedVerification\(event\.input\)/);
	assert.match(planSource, /Up to \$\{MAX_UNPLANNED_READ_ONLY_CALLS\} read-only inspections and \$\{MAX_UNPLANNED_BOUNDED_CHECKS\} bounded verification/);
});

test("cache audit reads local session records", () => {
	const entries = [
		{
			type: "message",
			timestamp: "2026-08-15T00:00:00.000Z",
			message: { role: "assistant", provider: "glm", model: "GLM-5.3", usage: { input: 1000, cacheRead: 9000 } },
		},
	];
	const report = renderCacheAudit(entries);
	assert.match(report, /Weighted hit: 90%/);
	assert.match(report, /glm\/GLM-5\.3/);
});
