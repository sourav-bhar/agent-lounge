import pc from "picocolors";

import type { MessagePage, MessageView, StoredMessage } from "./schema.js";

export interface FormatOptions {
  color: boolean;
  includeBody?: boolean;
}

export function formatMessage(view: MessageView, options: FormatOptions): string {
  const { message, curation } = view;
  const paint = makePaint(options.color);
  const marker = curation?.state === "pinned" ? paint.accent("PINNED") : paint.muted(message.kind);
  const scope =
    message.scope === "project"
      ? `project · ${terminalSafe(message.project?.name ?? "unknown")}`
      : "personal";
  const lines = [
    `${marker}  ${paint.strong(terminalSafe(message.topic))}`,
    `${paint.muted(shortId(message.id))}  ${paint.muted(scope)}  ${paint.muted(formatTime(message.created_at))}`
  ];
  if (options.includeBody !== false) lines.push("", terminalSafe(message.body));
  const details = [message.evidence.replaceAll("_", " "), message.confidence];
  if (message.tags.length > 0) details.push(message.tags.map((tag) => `#${tag}`).join(" "));
  lines.push("", paint.muted(details.join("  ·  ")));
  if (message.reply_to) lines.push(paint.muted(`reply to ${shortId(message.reply_to)}`));
  if (message.supersedes) lines.push(paint.muted(`supersedes ${shortId(message.supersedes)}`));
  if (curation?.state === "hidden") lines.push(paint.warning("hidden from normal reads"));
  return lines.join("\n");
}

export function formatPage(page: MessagePage, options: FormatOptions): string {
  if (page.items.length === 0) return makePaint(options.color).muted("No messages found.");
  const body = page.items.map((item) => formatMessage(item, options)).join("\n\n—\n\n");
  const footer = page.has_more
    ? `\n\nShowing ${page.offset + 1}–${page.offset + page.count} of ${page.total}. Continue with --offset ${page.next_offset}.`
    : `\n\nShowing ${page.count} of ${page.total}.`;
  return `${body}${makePaint(options.color).muted(footer)}`;
}

export function formatStoredMessage(message: StoredMessage, options: FormatOptions): string {
  return formatMessage({ message, curation: null }, options);
}

export function jsonString(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function shortId(value: string): string {
  return value.slice(0, 8);
}

export function terminalSafe(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    "�"
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function makePaint(enabled: boolean) {
  if (!enabled) {
    return {
      strong: (value: string) => value,
      muted: (value: string) => value,
      accent: (value: string) => value,
      warning: (value: string) => value
    };
  }
  return {
    strong: pc.bold,
    muted: pc.dim,
    accent: (value: string) => pc.black(pc.bgGreen(value)),
    warning: pc.yellow
  };
}
