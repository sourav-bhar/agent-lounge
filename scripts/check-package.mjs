import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const problems = [];
const publicFiles = await walk(root);
checkRepositoryNames(publicFiles, problems);
await checkRepositoryContents(publicFiles, problems);
await checkDashboardSource(problems);
const packageSummary = checkNpmPackage(problems);

if (problems.length > 0) {
  console.error("Public package audit failed:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log(
    `Public package audit passed: ${packageSummary.fileCount} files, ${formatBytes(packageSummary.size)} unpacked.`
  );
}

async function walk(directory) {
  const excludedDirectories = new Set([".git", ".playwright-cli", "coverage", "node_modules"]);
  const results = [];
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) results.push(target);
    }
  };
  await visit(directory);
  return results;
}

function checkRepositoryNames(files, output) {
  const forbidden = [
    /(^|\/)\.env(?:\.|$)/i,
    /(^|\/)\.npmrc$/i,
    /(^|\/)(?:credentials?|auth-state|browser-state)(?:\.|$)/i,
    /\.(?:key|pem|p12|pfx)$/i
  ];
  for (const file of files) {
    const relative = relativePath(file);
    if (forbidden.some((pattern) => pattern.test(relative))) {
      output.push(`forbidden public filename: ${relative}`);
    }
  }
}

async function checkRepositoryContents(files, output) {
  const patterns = [
    ["absolute macOS home path", /\/Users\/[^/\s"']+/g],
    ["absolute Windows home path", /[A-Za-z]:\\Users\\[^\\\s"']+/g],
    ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g],
    ["npm token", /\bnpm_[A-Za-z0-9]{30,}\b/g],
    ["OpenAI key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
    ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
    ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
  ];
  for (const file of files) {
    const info = await stat(file);
    if (info.size > 1_000_000 || path.extname(file).toLowerCase() === ".png") continue;
    const buffer = await readFile(file);
    if (buffer.includes(0)) continue;
    const content = buffer.toString("utf8");
    for (const [label, pattern] of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) output.push(`${label} found in ${relativePath(file)}`);
    }
  }
}

async function checkDashboardSource(output) {
  const script = await readFile(path.join(root, "public", "app.js"), "utf8");
  for (const forbidden of [
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    "eval(",
    "new Function"
  ]) {
    if (script.includes(forbidden)) output.push(`unsafe dashboard DOM primitive: ${forbidden}`);
  }
  const html = await readFile(path.join(root, "public", "index.html"), "utf8");
  if (/<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i.test(html)) {
    output.push("dashboard HTML contains a remote executable or visual asset");
  }
}

function checkNpmPackage(output) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 2_000_000,
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    output.push(`npm pack failed: ${sanitize(result.stderr || result.stdout)}`);
    return { fileCount: 0, size: 0 };
  }
  let report;
  try {
    report = JSON.parse(result.stdout)[0];
  } catch {
    output.push("npm pack did not return valid JSON");
    return { fileCount: 0, size: 0 };
  }
  const files = Array.isArray(report?.files) ? report.files : [];
  const names = files.map((file) => file.path);
  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/cli.js",
    "dist/index.js",
    "public/index.html",
    "public/styles.css",
    "public/app.js",
    "public/favicon.svg",
    "skills/agent-board/SKILL.md"
  ];
  for (const name of required) {
    if (!names.includes(name)) output.push(`npm package is missing ${name}`);
  }
  for (const name of names) {
    if (
      name !== "package.json" &&
      name !== "README.md" &&
      name !== "LICENSE" &&
      !name.startsWith("dist/") &&
      !name.startsWith("public/") &&
      !name.startsWith("skills/")
    ) {
      output.push(`unexpected npm package file: ${name}`);
    }
  }
  if (report?.unpackedSize > 750_000) {
    output.push(`npm package is unexpectedly large: ${formatBytes(report.unpackedSize)}`);
  }
  if (packageJson.name !== "agent-board" || packageJson.license !== "MIT") {
    output.push("package identity or license is not the expected public contract");
  }
  if (packageJson.bin?.["agent-board"] !== "dist/cli.js") {
    output.push("package CLI bin does not point to dist/cli.js");
  }
  return { fileCount: files.length, size: Number(report?.unpackedSize ?? 0) };
}

function relativePath(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function sanitize(value) {
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 500);
}

function formatBytes(value) {
  if (value < 1_000) return `${value} B`;
  return `${(value / 1_000).toFixed(1)} kB`;
}
