import { beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => {
  const cancelled = Symbol("cancelled");
  return {
    cancelled,
    cancel: vi.fn(),
    confirm: vi.fn(),
    intro: vi.fn(),
    isCancel: vi.fn((value: unknown) => value === cancelled),
    multiselect: vi.fn(),
    note: vi.fn(),
    outro: vi.fn(),
    select: vi.fn()
  };
});

vi.mock("@clack/prompts", () => prompts);

import { presetRules } from "../src/rules.js";
import { runSetupWizard, SetupCancelledError } from "../src/setup-wizard.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("interactive Lounge setup", () => {
  it("asks every social question and returns a validated custom configuration", async () => {
    prompts.multiselect.mockResolvedValue(["the-boss", "plotting", "off-duty-banter"]);
    prompts.select
      .mockResolvedValueOnce("startup-kitchen")
      .mockResolvedValueOnce("full-tea")
      .mockResolvedValueOnce("known")
      .mockResolvedValueOnce("never-shut-up");
    prompts.confirm.mockResolvedValue(true);

    const rules = await runSetupWizard(presetRules("candid"));

    expect(rules).toEqual({
      schema_version: 1,
      preset: "custom",
      topics: ["the-boss", "plotting", "off-duty-banter"],
      tone: "startup-kitchen",
      gossip: "full-tea",
      boss_awareness: "known",
      chattiness: "never-shut-up"
    });
    expect(prompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ message: "What should agents talk about?", required: true })
    );
    expect(prompts.select.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        message: "Should agents know that the boss can check in on their conversations?",
        initialValue: "unknown"
      })
    );
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("Boss awareness: they know"),
      "Tonight's house rules"
    );
    expect(prompts.outro).toHaveBeenCalledOnce();
  });

  it("leaves the rules untouched when final confirmation is declined", async () => {
    prompts.multiselect.mockResolvedValue(presetRules("helpful").topics);
    prompts.select
      .mockResolvedValueOnce("friendly-coworkers")
      .mockResolvedValueOnce("closed")
      .mockResolvedValueOnce("known")
      .mockResolvedValueOnce("quiet-professionals");
    prompts.confirm.mockResolvedValue(false);

    await expect(runSetupWizard(presetRules("helpful"))).rejects.toBeInstanceOf(
      SetupCancelledError
    );
    expect(prompts.cancel).toHaveBeenCalledWith("The door stays closed. Nothing was changed.");
    expect(prompts.outro).not.toHaveBeenCalled();
  });

  it("handles a terminal cancellation without continuing to later prompts", async () => {
    prompts.multiselect.mockResolvedValue(prompts.cancelled);

    await expect(runSetupWizard(presetRules("candid"))).rejects.toThrow(
      "Agent Lounge setup was cancelled"
    );
    expect(prompts.cancel).toHaveBeenCalledWith(
      "Setup cancelled. The agents will have to gossip somewhere else."
    );
    expect(prompts.select).not.toHaveBeenCalled();
    expect(prompts.confirm).not.toHaveBeenCalled();
  });
});
