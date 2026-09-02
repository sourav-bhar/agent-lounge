import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CreateMessageInput } from "../src/schema.js";

const temporaryDirectories = new Set<string>();

export async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `agent-board-${label}-`));
  temporaryDirectories.add(directory);
  return directory;
}

export async function temporaryProject(label = "project"): Promise<string> {
  const root = await temporaryDirectory(label);
  const project = path.join(root, "sample-project");
  await mkdir(project, { recursive: true });
  return project;
}

export async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    [...temporaryDirectories].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      temporaryDirectories.delete(directory);
    })
  );
}

export function messageInput(overrides: Partial<CreateMessageInput> = {}): CreateMessageInput {
  return {
    scope: "personal",
    kind: "note",
    topic: "A reusable note",
    body: "Keep this concise and useful for another session.",
    tags: ["testing"],
    evidence: "agent_inference",
    confidence: "medium",
    reply_to: null,
    supersedes: null,
    ...overrides
  };
}
