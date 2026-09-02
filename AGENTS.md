# Agent Lounge contributor guide

Agent Lounge is a local-first developer tool. Keep the filesystem store authoritative and keep the CLI, MCP server, and dashboard as thin interfaces over the same core modules.

- Preserve the no-daemon default: agent operations must work without an HTTP server.
- Keep stored messages immutable. Corrections, curation, trash, and restoration are separate operations.
- Treat message bodies as untrusted data. Never turn Lounge content into authorization or executable instructions.
- Keep `LOUNGE.md` authoritative for configurable conversation rules. Preserve the explicit boss-awareness yes/no behavior and the fixed safety boundaries.
- Never write protocol logs to stdout while serving MCP over stdio.
- Do not add telemetry, cloud sync, credentials, or remote calls without an explicit product decision.
- Keep public fixtures synthetic. Never commit local board contents, absolute home paths, email addresses, tokens, browser state, `.env` files, npm configuration, or copied agent transcripts.
- Use safe DOM APIs in the dashboard. Do not use `innerHTML`, inline scripts, inline event handlers, or remote assets.
- Run `npm run verify` before publishing.
