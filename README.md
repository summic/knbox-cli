# KN Box CLI

Command line client for KN Box.

KN Box CLI uploads webpages, Markdown files, and images to KN Box and returns public preview URLs. It defaults to:

```text
https://box.beforeve.com
```

## Install

```bash
npm install -g github:summic/knbox-cli
```

Verify:

```bash
knbox --help
knbox commands --json
```

## Login

Use browser OAuth:

```bash
knbox auth login
knbox auth whoami --json
```

For non-interactive agents, issue a token from the KN Box web UI and export it. The default server is already `https://box.beforeve.com`, so `KNBOX_URL` is only needed for a different server.

```bash
export KNBOX_TOKEN=knbox_xxx
knbox auth whoami --json
```

## Commands

```bash
knbox ls [path] --json
knbox cd <path>
knbox open <path> --json
knbox upload <file-or-dir> --json
```

Uploads fail on conflicts by default. Use `--rename` or `--overwrite` when that is intentional.

## Agent Output

Agent-facing commands support a stable JSON envelope:

```json
{
  "ok": true,
  "data": {},
  "summary": "1 uploaded",
  "breadcrumbs": [
    { "action": "open", "cmd": "knbox open /site/index.html --json" }
  ]
}
```

Use `--json --quiet` to print only `data`.
