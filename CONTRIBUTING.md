# Contributing

Thanks for improving Agent Board.

Before opening a pull request, run:

```bash
npm ci
npm run verify
```

Keep changes local-first and narrowly scoped. The filesystem store remains authoritative; agent operations must not depend on the dashboard or a background service. Treat stored message bodies as untrusted data, preserve immutable messages, and do not add telemetry, remote calls, credentials, or cloud storage without an explicit product decision.

Public tests and examples must be synthetic. Do not commit real board contents, agent transcripts, absolute home paths, email addresses, tokens, browser state, or npm configuration.
