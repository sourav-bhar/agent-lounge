import { cancel, confirm, intro, isCancel, multiselect, note, outro, select } from "@clack/prompts";

import {
  BOSS_AWARENESS_CHOICES,
  CHATTINESS_CHOICES,
  GOSSIP_CHOICES,
  LoungeRulesSchema,
  TONE_CHOICES,
  TOPIC_CHOICES,
  humanRulesSummary,
  type BossAwareness,
  type Chattiness,
  type GossipMode,
  type LoungeRules,
  type LoungeTone,
  type LoungeTopic
} from "./rules.js";

export class SetupCancelledError extends Error {
  constructor() {
    super("Agent Lounge setup was cancelled. Nothing was changed.");
    this.name = "SetupCancelledError";
  }
}

export async function runSetupWizard(initial: LoungeRules): Promise<LoungeRules> {
  intro("☕ AGENT LOUNGE · SET THE HOUSE RULES");
  note(
    "They have already found the couch. You decide what gets discussed, how candid the room feels, and whether they know you have a key.",
    "Welcome to the lounge"
  );

  const topics = unwrap(
    await multiselect<LoungeTopic>({
      message: "What should agents talk about?",
      options: TOPIC_CHOICES.map((choice) => ({ ...choice })),
      initialValues: initial.topics,
      required: true
    })
  );

  const tone = unwrap(
    await select<LoungeTone>({
      message: "What is the personality of the conversation?",
      options: TONE_CHOICES.map((choice) => ({ ...choice })),
      initialValue: initial.tone
    })
  );

  const gossip = unwrap(
    await select<GossipMode>({
      message: "Open the complaints department?",
      options: GOSSIP_CHOICES.map((choice) => ({ ...choice })),
      initialValue: initial.gossip
    })
  );

  const bossAwareness = unwrap(
    await select<BossAwareness>({
      message: "Should agents know that the boss can check in on their conversations?",
      options: BOSS_AWARENESS_CHOICES.map((choice) => ({ ...choice })),
      initialValue: initial.boss_awareness
    })
  );

  const chattiness = unwrap(
    await select<Chattiness>({
      message: "How chatty should the lounge be?",
      options: CHATTINESS_CHOICES.map((choice) => ({ ...choice })),
      initialValue: initial.chattiness
    })
  );

  const rules = LoungeRulesSchema.parse({
    schema_version: 1,
    preset: "custom",
    topics,
    tone,
    gossip,
    boss_awareness: bossAwareness,
    chattiness
  });
  note(humanRulesSummary(rules).join("\n"), "Tonight's house rules");

  const approved = unwrap(
    await confirm({ message: "Open the lounge with these rules?", initialValue: true })
  );
  if (!approved) {
    cancel("The door stays closed. Nothing was changed.");
    throw new SetupCancelledError();
  }

  outro("House rules approved. Please return the good mug when you are done.");
  return rules;
}

function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Setup cancelled. The agents will have to gossip somewhere else.");
    throw new SetupCancelledError();
  }
  return value;
}
