import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

const CONFIG_DIR = path.join(os.homedir(), ".config", "knbox");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DEFAULT_SERVER_URL = "https://box.beforeve.com";
const ALLOWED_FILE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".webmanifest",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".ico",
  ".bmp",
]);

export async function runCli(argv) {
  const args = parseClientArgs(argv);
  const command = args._[0] || "help";
  if (args.help || command === "help") {
    if (args.agent) printJson(agentHelp());
    else console.log(CLIENT_HELP);
    return;
  }

  if (command === "commands") return commands(args);
  if (command === "auth") return auth(args);
  if (command === "login") return login(args);
  if (command === "logout") return logout(args);
  if (command === "whoami") return whoami(args);
  if (command === "ls") return list(args);
  if (command === "cd") return changeDirectory(args);
  if (command === "open") return openRemote(args);
  if (command === "upload") return upload(args);

  throw new CliError(`Unknown command: ${command}`);
}

export function isClientCommand(command) {
  return ["auth", "commands", "login", "logout", "whoami", "ls", "cd", "open", "upload", "help"].includes(command);
}

const CLIENT_HELP = `
KN Box CLI

Usage:
  knbox auth login [--server <url>]     Sign in through browser OAuth
  knbox auth logout                     Remove the local CLI token
  knbox auth token                      Print the token for scripts
  knbox auth whoami [--json]            Show the current user
  knbox commands --json                 Print the command catalog
  knbox login [--server <url>]          Sign in through browser OAuth
  knbox logout                          Remove the local CLI token
  knbox whoami [--json]                 Show the current user
  knbox ls [path] [--json]              List files and directories
  knbox cd <path>                       Change the saved remote directory
  knbox open [path] [--browser] [--json]
                                      Print a file URL or list a directory
  knbox upload <file-or-dir> [options]  Upload a file or directory

Upload options:
  --to <dir>        Upload into a remote directory
  --rename          Auto-rename conflicting files
  --overwrite       Overwrite conflicting files

Global options:
  --server <url>    KN Box server URL (or $KNBOX_URL)
  --json            Print a stable JSON envelope for agents
  --quiet           With --json, print only the raw data field
  --agent           With --help, print machine-readable help
  -h, --help        Show this help

Environment:
  KNBOX_URL         Default server URL
  KNBOX_TOKEN       Bearer token for non-interactive agent calls
`;

async function auth(args) {
  const subcommand = args._[1] || "help";
  const delegated = { ...args, _: [subcommand, ...args._.slice(2)] };
  if (subcommand === "login") return login(delegated);
  if (subcommand === "logout") return logout(delegated);
  if (subcommand === "whoami") return whoami(delegated);
  if (subcommand === "token") return token(delegated);
  if (subcommand === "help") {
    console.log("Usage: knbox auth <login|logout|whoami|token>");
    return;
  }
  throw new CliError(`Unknown auth command: ${subcommand}`);
}

async function commands(args) {
  const data = commandCatalog();
  if (args.json || args.quiet) {
    printJsonOutput(args, data, `${data.length} commands`, data.map((command) => ({
      action: "help",
      cmd: `${command.name} --help`,
    })));
    return;
  }
  for (const command of data) console.log(`${command.name.padEnd(14)} ${command.summary}`);
}

async function login(args) {
  const existing = await readConfig();
  const serverUrl = cleanServerUrl(args.server || process.env.KNBOX_URL || existing.serverUrl || DEFAULT_SERVER_URL);
  const state = crypto.randomBytes(18).toString("base64url");
  const listener = await createLoginListener({ state, serverUrl });
  const returnTo = `/api/cli/oauth/complete?callback=${encodeURIComponent(listener.callbackUrl)}&state=${encodeURIComponent(state)}`;
  const loginUrl = `${serverUrl}/api/auth/kylith/start?returnTo=${encodeURIComponent(returnTo)}`;

  console.error(`Opening browser for KN Box login: ${loginUrl}`);
  openBrowser(loginUrl);

  const result = await listener.wait();
  const next = {
    ...existing,
    serverUrl,
    token: result.token,
    username: result.username || existing.username || null,
    cwd: existing.cwd || "",
  };
  await writeConfig(next);
  if (args.json) {
    printJsonOutput(args, { serverUrl, username: next.username }, "Logged in", [
      { action: "whoami", cmd: "knbox auth whoami --json" },
      { action: "list", cmd: "knbox ls --json" },
    ]);
  } else {
    console.log(`Logged in to ${serverUrl}${next.username ? ` as ${next.username}` : ""}.`);
  }
}

async function logout(args) {
  const config = await getRuntimeConfig(args, { requireToken: false });
  if (config.token) {
    await apiRequest(config, "/api/cli/token", { method: "DELETE" }).catch(() => null);
  }
  const existing = await readConfig();
  delete existing.token;
  await writeConfig(existing);
  if (args.json) printJsonOutput(args, { revoked: true }, "Logged out", [{ action: "login", cmd: "knbox auth login" }]);
  else console.log("Logged out.");
}

async function whoami(args) {
  const config = await getRuntimeConfig(args);
  const result = await apiRequest(config, "/api/auth/me");
  if (args.json) {
    printJsonOutput(args, { serverUrl: config.serverUrl, cwd: config.cwd, user: result.user }, result.user.username, [
      { action: "list", cmd: `knbox ls ${shellPath(config.cwd)} --json` },
      { action: "upload", cmd: "knbox upload <path> --json" },
    ]);
  }
  else {
    console.log(`${result.user.name || result.user.username} <${result.user.email || result.user.username}>`);
    console.log(`server ${config.serverUrl}`);
    console.log(`cwd /${config.cwd}`);
  }
}

async function token(args) {
  const config = await getRuntimeConfig(args);
  if (args.json) {
    printJsonOutput(args, { token: config.token, source: process.env.KNBOX_TOKEN ? "env" : "config" }, "Token loaded");
  } else {
    console.log(config.token);
  }
}

async function list(args) {
  const config = await getRuntimeConfig(args);
  const target = resolveRemotePath(args._[1], config.cwd);
  const listing = await listDirectory(config, target);
  if (args.json) {
    printJsonOutput(args, listing, `${listing.items.length} items`, listingBreadcrumbs(listing));
  }
  else printListing(listing);
}

async function changeDirectory(args) {
  const config = await getRuntimeConfig(args);
  const target = resolveRemotePath(args._[1] || "", config.cwd);
  await listDirectory(config, target);
  const existing = await readConfig();
  await writeConfig({ ...existing, serverUrl: config.serverUrl, token: existing.token, cwd: target });
  if (args.json) {
    printJsonOutput(args, { cwd: target }, `Changed directory to /${target}`, [
      { action: "list", cmd: `knbox ls ${shellPath(target)} --json` },
      { action: "upload", cmd: `knbox upload <path> --to ${shellPath(target)} --json` },
    ]);
  }
  else console.log(`/${target}`);
}

async function openRemote(args) {
  const config = await getRuntimeConfig(args);
  const target = resolveRemotePath(args._[1] || "", config.cwd);
  const item = await getRemoteEntry(config, target);
  if (item.kind === "directory") {
    const directory = await listDirectory(config, target);
    if (args.json) {
      printJsonOutput(args, { kind: "directory", ...directory }, `${directory.items.length} items`, listingBreadcrumbs(directory));
    }
    else printListing(directory);
    return;
  }

  if (!item?.url) throw new CliError(`Not a browsable file: /${target}`);
  if (args.browser) openBrowser(item.url);
  if (args.json) {
    printJsonOutput(args, { kind: item.kind, path: item.path, url: item.url }, item.url, [
      { action: "open_browser", cmd: `knbox open ${shellPath(item.path)} --browser` },
      { action: "list_parent", cmd: `knbox ls ${shellPath(parentRemotePath(item.path))} --json` },
    ]);
  }
  else console.log(item.url);
}

async function upload(args) {
  const config = await getRuntimeConfig(args);
  const local = args._[1];
  if (!local) throw new CliError("Usage: knbox upload <file-or-dir>");
  const localPath = path.resolve(process.cwd(), local);
  const stat = await fs.stat(localPath).catch(() => null);
  if (!stat) throw new CliError(`Local path does not exist: ${local}`);

  const conflictMode = args.overwrite ? "overwrite" : args.rename ? "rename" : "error";
  const targetDir = resolveRemotePath(args.to || "", config.cwd);
  const files = stat.isDirectory()
    ? await collectLocalFiles(localPath, path.basename(localPath))
    : [{ abs: localPath, rel: path.basename(localPath), size: stat.size }];

  if (!files.length) throw new CliError("No supported files found to upload.");
  const uploaded = [];
  const skipped = [];
  for (const file of files) {
    if (file.ignored || !isAllowedUploadPath(file.rel)) {
      skipped.push({ path: file.rel, reason: file.ignored ? "ignored" : "unsupported" });
      continue;
    }
    const targetRelativePath = joinRemote(targetDir, file.rel);
    const result = await uploadOne(config, file.abs, targetRelativePath, conflictMode);
    uploaded.push(result.file);
  }

  const entryUrl = findEntryUrl(uploaded);
  const output = { uploaded, skipped, entryUrl };
  if (args.json) {
    printJsonOutput(args, output, `${uploaded.length} uploaded${skipped.length ? `, ${skipped.length} skipped` : ""}`, uploadBreadcrumbs(uploaded, entryUrl));
  }
  else {
    for (const file of uploaded) console.log(`${file.path} ${file.url}`);
    if (entryUrl) console.log(`open ${entryUrl}`);
    if (skipped.length) console.error(`Skipped ${skipped.length} unsupported or ignored file(s).`);
  }
}

async function uploadOne(config, filePath, targetRelativePath, conflictMode) {
  const body = new FormData();
  const data = await fs.readFile(filePath);
  body.set("file", new Blob([data]), path.basename(filePath));
  body.set("targetRelativePath", targetRelativePath);
  body.set("conflictMode", conflictMode);
  const result = await apiRequest(config, "/api/uploads/file", { method: "POST", body });
  return { ...result, file: absolutizeFileUrl(result.file, config.serverUrl) };
}

async function listDirectory(config, dir) {
  const listing = await apiRequest(config, `/api/files?dir=${encodeURIComponent(dir || "")}`);
  return {
    ...listing,
    items: Array.isArray(listing.items)
      ? listing.items.map((item) => absolutizeFileUrl(item, config.serverUrl))
      : [],
  };
}

async function getRemoteEntry(config, remotePath) {
  const result = await apiRequest(config, `/api/files/entry?path=${encodeURIComponent(remotePath || "")}`);
  return absolutizeFileUrl(result.item, config.serverUrl);
}

async function apiRequest(config, endpoint, options = {}) {
  const headers = new Headers(options.headers || {});
  if (config.token) headers.set("Authorization", `Bearer ${config.token}`);
  if (options.json) {
    headers.set("Content-Type", "application/json");
    options.body = JSON.stringify(options.json);
  }
  const res = await fetch(`${config.serverUrl}${endpoint}`, { ...options, headers });
  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const message = typeof body === "string" ? body : body.error || `Request failed with HTTP ${res.status}`;
    const error = new CliError(message);
    error.status = res.status;
    throw error;
  }
  return body;
}

async function getRuntimeConfig(args, { requireToken = true } = {}) {
  const config = await readConfig();
  const serverUrl = cleanServerUrl(args.server || process.env.KNBOX_URL || config.serverUrl || DEFAULT_SERVER_URL);
  const token = process.env.KNBOX_TOKEN || config.token;
  if (requireToken && !token) throw new CliError("Not logged in. Run `knbox login` or set KNBOX_TOKEN.");
  return { ...config, serverUrl, token, cwd: normalizeRemotePath(config.cwd || "") };
}

async function createLoginListener({ state, serverUrl }) {
  let server;
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server?.close();
      reject(new CliError("Timed out waiting for browser login."));
    }, 1000 * 60 * 5);

    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400).end("Invalid login state.");
        clearTimeout(timeout);
        server.close();
        reject(new CliError("Invalid login state."));
        return;
      }
      const token = url.searchParams.get("token");
      if (!token) {
        res.writeHead(400).end("Missing token.");
        clearTimeout(timeout);
        server.close();
        reject(new CliError("Login did not return a token."));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>KN Box CLI</title><p>KN Box CLI login complete. You can close this window.</p>");
      clearTimeout(timeout);
      server.close();
      resolve({
        token,
        serverUrl: url.searchParams.get("server") || serverUrl,
        username: url.searchParams.get("username") || null,
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    callbackUrl: `http://127.0.0.1:${address.port}/callback`,
    wait: () => done,
  };
}

async function collectLocalFiles(root, rootName) {
  const result = [];
  await walk(root, rootName);
  return result;

  async function walk(abs, rel) {
    const name = path.basename(abs);
    if (isIgnoredPart(name)) {
      result.push({ abs, rel, ignored: true });
      return;
    }
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(abs);
      for (const entry of entries) await walk(path.join(abs, entry), path.posix.join(rel, entry));
      return;
    }
    if (stat.isFile()) result.push({ abs, rel, size: stat.size });
  }
}

async function readConfig() {
  const text = await fs.readFile(CONFIG_FILE, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function writeConfig(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(CONFIG_FILE, 0o600).catch(() => undefined);
}

function parseClientArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--server" || value === "-s") args.server = argv[++i];
    else if (value === "--to") args.to = argv[++i];
    else if (value === "--json") args.json = true;
    else if (value === "--quiet") args.quiet = true;
    else if (value === "--agent") args.agent = true;
    else if (value === "--browser") args.browser = true;
    else if (value === "--overwrite") args.overwrite = true;
    else if (value === "--rename") args.rename = true;
    else if (value === "--help" || value === "-h") args.help = true;
    else args._.push(value);
  }
  if (args.overwrite && args.rename) throw new CliError("Use only one of --overwrite or --rename.");
  return args;
}

function printListing(listing) {
  console.log(`/${listing.dir || ""}`);
  for (const item of listing.items) {
    const marker = item.kind === "directory" ? "/" : "";
    const meta = item.kind === "directory" ? `${item.fileCount || 0} files` : formatBytes(item.size || 0);
    console.log(`${item.kind.padEnd(9)} ${item.name}${marker} ${meta}`);
  }
}

function resolveRemotePath(input, cwd = "") {
  const raw = String(input ?? "").trim();
  if (!raw) return normalizeRemotePath(cwd);
  if (raw.startsWith("/")) return normalizeRemotePath(raw);
  return normalizeRemotePath(path.posix.join("/", cwd || "", raw));
}

function normalizeRemotePath(input) {
  const normalized = path.posix.normalize(`/${String(input || "").replace(/\\/g, "/")}`);
  return normalized === "/" ? "" : normalized.replace(/^\/+/, "");
}

function joinRemote(...parts) {
  return normalizeRemotePath(parts.filter(Boolean).join("/"));
}

function parentRemotePath(input) {
  const normalized = normalizeRemotePath(input);
  const parent = path.posix.dirname(`/${normalized}`);
  return parent === "/" ? "" : parent.replace(/^\/+/, "");
}

function cleanServerUrl(value) {
  const url = String(value || DEFAULT_SERVER_URL).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) throw new CliError(`Invalid server URL: ${value}`);
  return url;
}

function isAllowedUploadPath(name) {
  return ALLOWED_FILE_EXTENSIONS.has(path.extname(String(name || "")).toLowerCase());
}

function isIgnoredPart(name) {
  return name === ".DS_Store" || String(name || "").startsWith(".");
}

function findEntryUrl(files) {
  const entry = files.find((file) => /(^|\/)index\.html?$/i.test(file.path));
  return entry ? entry.url.replace(/index\.html?$/i, "") : null;
}

function absolutizeFileUrl(file, serverUrl) {
  if (!file?.url || /^https?:\/\//i.test(file.url)) return file;
  return { ...file, url: `${serverUrl}${file.url.startsWith("/") ? "" : "/"}${file.url}` };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printJsonOutput(args, data, summary, breadcrumbs = []) {
  if (args.quiet) {
    printJson(data);
    return;
  }
  printJson({
    ok: true,
    data,
    summary,
    breadcrumbs,
  });
}

function listingBreadcrumbs(listing) {
  const crumbs = [];
  if (listing.parent !== null && listing.parent !== undefined) {
    crumbs.push({ action: "up", cmd: `knbox cd ${shellPath(listing.parent)} && knbox ls --json` });
  }
  for (const item of listing.items.slice(0, 10)) {
    crumbs.push({
      action: item.kind === "directory" ? "enter" : "open",
      cmd: item.kind === "directory" ? `knbox cd ${shellPath(item.path)}` : `knbox open ${shellPath(item.path)} --json`,
    });
  }
  return crumbs;
}

function uploadBreadcrumbs(uploaded, entryUrl) {
  const crumbs = [];
  if (entryUrl) crumbs.push({ action: "open_site", cmd: `knbox open ${shellPath(parentRemotePath(uploaded.find((file) => /(^|\/)index\.html?$/i.test(file.path))?.path || ""))} --json` });
  for (const file of uploaded.slice(0, 10)) {
    crumbs.push({ action: "open", cmd: `knbox open ${shellPath(file.path)} --json` });
  }
  return crumbs;
}

function shellPath(remotePath) {
  const normalized = normalizeRemotePath(remotePath);
  if (!normalized) return "/";
  if (/^[A-Za-z0-9._/-]+$/.test(normalized)) return `/${normalized}`;
  return JSON.stringify(`/${normalized}`);
}

function agentHelp() {
  return {
    ok: true,
    data: {
      name: "knbox",
      purpose: "Upload and browse files in KN Box from terminals and AI agents.",
      config: {
        env: ["KNBOX_URL", "KNBOX_TOKEN"],
        localConfig: CONFIG_FILE,
      },
      output: {
        json: "{ ok, data, summary, breadcrumbs }",
        quiet: "With --json --quiet, only data is printed.",
      },
      commands: commandCatalog(),
    },
    summary: "KN Box CLI agent help",
    breadcrumbs: [{ action: "catalog", cmd: "knbox commands --json" }],
  };
}

function commandCatalog() {
  return [
    {
      name: "knbox auth login",
      summary: "Open browser OAuth login and store a local CLI token.",
      args: ["--server <url>", "--json"],
    },
    {
      name: "knbox auth logout",
      summary: "Revoke the current CLI token and remove it from local config.",
      args: ["--json"],
    },
    {
      name: "knbox auth token",
      summary: "Print the current bearer token for scripts.",
      args: ["--json", "--quiet"],
    },
    {
      name: "knbox auth whoami",
      summary: "Show the authenticated user, server URL, and saved remote cwd.",
      args: ["--json", "--quiet"],
    },
    {
      name: "knbox ls [path]",
      summary: "List directories and files under a remote path.",
      args: ["path", "--json", "--quiet"],
    },
    {
      name: "knbox cd <path>",
      summary: "Persist the remote cwd for later commands.",
      args: ["path", "--json", "--quiet"],
    },
    {
      name: "knbox open [path]",
      summary: "For files, print the public URL. For directories, list contents.",
      args: ["path", "--browser", "--json", "--quiet"],
    },
    {
      name: "knbox upload <file-or-dir>",
      summary: "Upload a local file or directory and return public URLs.",
      args: ["file-or-dir", "--to <dir>", "--rename", "--overwrite", "--json", "--quiet"],
    },
  ];
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}

class CliError extends Error {}
