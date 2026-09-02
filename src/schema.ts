import { z } from "zod";

import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_TAG_MAX_LENGTH,
  MESSAGE_TAGS_MAX_COUNT,
  MESSAGE_TOPIC_MAX_LENGTH,
  STORE_SCHEMA_VERSION
} from "./constants.js";

const UnsafeTextControls =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const TopicSchema = z.preprocess(
  normalizeLineEndings,
  z
    .string()
    .trim()
    .min(1)
    .max(MESSAGE_TOPIC_MAX_LENGTH)
    .refine((value) => !value.includes("\n"), "Topics must use one line")
    .refine(
      (value) => !UnsafeTextControls.test(value),
      "Topics contain unsupported control characters"
    )
);

const BodySchema = z.preprocess(
  normalizeLineEndings,
  z
    .string()
    .trim()
    .min(1)
    .max(MESSAGE_BODY_MAX_LENGTH)
    .refine(
      (value) => !UnsafeTextControls.test(value),
      "Bodies contain unsupported control characters"
    )
);

const CurationNoteSchema = z.preprocess(
  normalizeLineEndings,
  z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine(
      (value) => !UnsafeTextControls.test(value),
      "Notes contain unsupported control characters"
    )
);

function normalizeLineEndings(value: unknown): unknown {
  return typeof value === "string" ? value.replaceAll(/\r\n?/g, "\n") : value;
}

export const MessageScopeSchema = z.enum(["personal", "project"]);
export type MessageScope = z.infer<typeof MessageScopeSchema>;

export const MessageKindSchema = z.enum([
  "preference",
  "lesson",
  "warning",
  "question",
  "reply",
  "note"
]);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const EvidenceSchema = z.enum([
  "explicit_user_statement",
  "observed_success",
  "observed_failure",
  "agent_inference",
  "human_note"
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const MessageTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(MESSAGE_TAG_MAX_LENGTH)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Tags use lowercase letters, numbers, dots, dashes, and underscores"
  );

export const ProjectRefSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{16}$/),
    name: TopicSchema
  })
  .strict();
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

export const AuthorSchema = z
  .object({
    client: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9._-]*$/i),
    run_id: z.string().uuid()
  })
  .strict();
export type Author = z.infer<typeof AuthorSchema>;

export const StoredMessageSchema = z
  .object({
    schema_version: z.literal(STORE_SCHEMA_VERSION),
    id: z.string().uuid(),
    created_at: z.string().datetime({ offset: true }),
    scope: MessageScopeSchema,
    kind: MessageKindSchema,
    topic: TopicSchema,
    body: BodySchema,
    tags: z.array(MessageTagSchema).max(MESSAGE_TAGS_MAX_COUNT),
    evidence: EvidenceSchema,
    confidence: ConfidenceSchema,
    author: AuthorSchema,
    project: ProjectRefSchema.optional(),
    thread_id: z.string().uuid(),
    reply_to: z.string().uuid().nullable(),
    supersedes: z.string().uuid().nullable()
  })
  .strict()
  .superRefine((message, context) => {
    if (message.scope === "project" && !message.project) {
      context.addIssue({
        code: "custom",
        path: ["project"],
        message: "Project-scoped messages require project metadata"
      });
    }
    if (message.scope === "personal" && message.project) {
      context.addIssue({
        code: "custom",
        path: ["project"],
        message: "Personal messages must not include project metadata"
      });
    }
  });
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

export const CreateMessageInputSchema = z
  .object({
    scope: MessageScopeSchema.default("personal"),
    kind: MessageKindSchema.default("note"),
    topic: TopicSchema,
    body: BodySchema,
    tags: z.array(MessageTagSchema).max(MESSAGE_TAGS_MAX_COUNT).default([]),
    evidence: EvidenceSchema.default("agent_inference"),
    confidence: ConfidenceSchema.default("medium"),
    reply_to: z.string().uuid().nullable().default(null),
    supersedes: z.string().uuid().nullable().default(null)
  })
  .strict()
  .superRefine((message, context) => {
    if (message.kind === "reply" && !message.reply_to) {
      context.addIssue({
        code: "custom",
        path: ["reply_to"],
        message: "Reply messages require reply_to"
      });
    }
  });
export type CreateMessageInput = z.infer<typeof CreateMessageInputSchema>;

export const CurationStateSchema = z.enum(["pinned", "hidden"]);
export type CurationState = z.infer<typeof CurationStateSchema>;

export const CurationRecordSchema = z
  .object({
    schema_version: z.literal(STORE_SCHEMA_VERSION),
    message_id: z.string().uuid(),
    state: CurationStateSchema,
    updated_at: z.string().datetime({ offset: true }),
    note: CurationNoteSchema.optional()
  })
  .strict();
export type CurationRecord = z.infer<typeof CurationRecordSchema>;

export const MessageViewSchema = z
  .object({
    message: StoredMessageSchema,
    curation: CurationRecordSchema.nullable()
  })
  .strict();
export type MessageView = z.infer<typeof MessageViewSchema>;

export interface MessageQuery {
  scope: MessageScope | "relevant" | "all";
  kind?: MessageKind;
  query?: string;
  threadId?: string;
  includeHidden: boolean;
  limit: number;
  offset: number;
}

export interface MessagePage {
  items: MessageView[];
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  warnings: string[];
}

export interface StoreDoctorReport {
  ok: boolean;
  home: string;
  initialized: boolean;
  permissions: string | null;
  message_count: number;
  trashed_count: number;
  malformed_files: string[];
  warnings: string[];
}
