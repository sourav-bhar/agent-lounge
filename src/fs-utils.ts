import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  const temporary = await writeTemporaryJson(target, value);
  try {
    await renameWithRetry(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function atomicWriteText(target: string, value: string): Promise<void> {
  const temporary = await writeTemporaryText(target, value);
  try {
    await renameWithRetry(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function atomicWriteTextIfAbsent(target: string, value: string): Promise<boolean> {
  const temporary = await writeTemporaryText(target, value);
  try {
    await link(temporary, target);
    return true;
  } catch (error) {
    if (
      (isNodeError(error, "EEXIST") ||
        isNodeError(error, "EPERM") ||
        isNodeError(error, "EACCES")) &&
      (await pathExists(target))
    ) {
      return false;
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function atomicWriteJsonIfAbsent(target: string, value: unknown): Promise<boolean> {
  const temporary = await writeTemporaryJson(target, value);
  try {
    await link(temporary, target);
    return true;
  } catch (error) {
    if (
      (isNodeError(error, "EEXIST") ||
        isNodeError(error, "EPERM") ||
        isNodeError(error, "EACCES")) &&
      (await pathExists(target))
    ) {
      return false;
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as unknown;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

export async function safeReadDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

export async function chmodPrivateDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  await chmod(directory, 0o700);
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function writeTemporaryJson(target: string, value: unknown): Promise<string> {
  return writeTemporaryText(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTemporaryText(target: string, value: string): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(target),
    `.tmp-${path.basename(target)}-${randomUUID()}`
  );
  const handle = await open(temporary, "wx", 0o600);
  let complete = false;
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await rm(temporary, { force: true });
  }
  return temporary;
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  const delays = process.platform === "win32" ? [0, 5, 20, 50, 100] : [0];
  let lastError: unknown;
  for (const wait of delays) {
    if (wait > 0) await delay(wait);
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (
        !isNodeError(error, "EPERM") &&
        !isNodeError(error, "EACCES") &&
        !isNodeError(error, "EBUSY")
      ) {
        throw error;
      }
    }
  }
  throw lastError;
}
