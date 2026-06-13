import assert from "node:assert/strict";
import test from "node:test";
import { createTestStack } from "./helpers.js";
import type { ModelResult, UserRequest } from "../types/core.js";

function request(message: string): UserRequest {
    return {
        requestId: `req-${message}`,
        channel: "terminal",
        userId: "user-automation",
        conversationId: "conv-automation",
        message,
        attachments: [],
        metadata: {},
    };
}

test("automation command creates a reminder task", async () => {
    const { orchestrator, persistence } = createTestStack({
        ENABLE_AUTOMATION: "true",
        ENABLE_TOOL_ROUTER: "false",
    });

    const response = await orchestrator.handleRequest(request("remind submit assignment in 5m"));

    assert.equal(response.toolCalls.length, 1);
    assert.equal(response.toolCalls[0]?.name, "automation");
    assert.match(response.toolCalls[0]?.output ?? "", /Created reminder/);

    const tasks = await persistence.automations.listTasksByUser("user-automation", true);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.type, "reminder");
    assert.equal(tasks[0]?.status, "active");
    assert.equal(tasks[0]?.prompt, "submit assignment");
});

test("automation command creates a recurring prompt job", async () => {
    const { orchestrator, persistence } = createTestStack({
        ENABLE_AUTOMATION: "true",
        ENABLE_TOOL_ROUTER: "false",
    });

    const response = await orchestrator.handleRequest(request("every 1d do summarize today's AI news"));

    assert.equal(response.toolCalls.length, 1);
    assert.equal(response.toolCalls[0]?.name, "automation");
    assert.match(response.toolCalls[0]?.output ?? "", /Created recurring job/);

    const tasks = await persistence.automations.listTasksByUser("user-automation", true);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.type, "recurring-prompt");
    assert.equal(tasks[0]?.status, "active");
    assert.equal(tasks[0]?.prompt, "summarize today's AI news");
    assert.equal(tasks[0]?.intervalMs, 24 * 60 * 60 * 1000);
});

test("automation scheduler completes due reminder tasks", async () => {
    const { automation, persistence } = createTestStack({
        ENABLE_AUTOMATION: "true",
    });
    const dueAt = new Date(Date.now() - 1000);
    const task = await automation.createReminder({
        request: request("seed reminder"),
        prompt: "revise DSA",
        nextRunAt: dueAt,
    });

    const runs = await automation.runDueTasks(new Date());

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "completed");
    assert.equal(runs[0]?.output, "Reminder: revise DSA");

    const stored = await persistence.automations.getTask(task.id);
    assert.equal(stored?.status, "completed");
});

test("automation scheduler executes and reschedules recurring prompt jobs", async () => {
    const { automation, models, persistence } = createTestStack({
        ENABLE_AUTOMATION: "true",
        ENABLE_TOOL_ROUTER: "false",
        ENABLE_MEMORY: "false",
    });
    models.generate = async () =>
        ({
            provider: "openai",
            model: "gpt-test",
            text: "Daily AI summary",
        }) satisfies ModelResult;

    const task = await automation.createRecurringPrompt({
        request: request("seed recurring"),
        prompt: "summarize today's AI news",
        nextRunAt: new Date(Date.now() - 1000),
        intervalMs: 60 * 1000,
    });

    const runs = await automation.runDueTasks(new Date());

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "completed");
    assert.equal(runs[0]?.output, "Daily AI summary");

    const stored = await persistence.automations.getTask(task.id);
    assert.equal(stored?.status, "active");
    assert.ok(stored?.nextRunAt && stored.nextRunAt.getTime() > Date.now() - 1000);
});

test("automation service cancels active tasks", async () => {
    const { automation, persistence } = createTestStack({
        ENABLE_AUTOMATION: "true",
    });
    const task = await automation.createReminder({
        request: request("seed cancel"),
        prompt: "cancel me",
        nextRunAt: new Date(Date.now() + 60 * 1000),
    });

    const canceled = await automation.cancelTask("user-automation", task.id);

    assert.equal(canceled, true);
    const stored = await persistence.automations.getTask(task.id);
    assert.equal(stored?.status, "canceled");
});
