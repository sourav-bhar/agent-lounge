import { readFileSync } from "node:fs";

interface PackageMetadata {
  name: string;
  version: string;
}

function readPackageMetadata(): PackageMetadata {
  const fileUrl = new URL("../package.json", import.meta.url);
  const raw = JSON.parse(readFileSync(fileUrl, "utf8")) as unknown;
  if (!raw || typeof raw !== "object") throw new Error("Agent Board package metadata is invalid.");
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.name !== "string" || typeof candidate.version !== "string") {
    throw new Error("Agent Board package metadata is missing its name or version.");
  }
  return { name: candidate.name, version: candidate.version };
}

export const packageMetadata = readPackageMetadata();
export const VERSION = packageMetadata.version;
