"use strict";

/**
 * vibes-daemon
 * PC background daemon that connects to a WebSocket relay server,
 * listens for commands from a smartphone, executes them via `claude -p`,
 * and streams results back.
 */

require("dotenv").config();

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[vibes-daemon] Failed to load config.json: ${err.message}`);
    process.exit(1);
  }
}

const config = loadConfig();

const SERVER_URL = process.env.VIBES_SERVER_URL || config.serverUrl;
const TOKEN = process.env.VIBES_TOKEN || config.token;
const MACHINE_ID = process.env.VIBES_MACHINE_ID || config.machineId;
const CLAUDE_PATH = process.env.VIBES_CLAUDE_PATH || config.claudePath || "claude";

// Reconnect backoff settings (ms)
const RECONNECT_INITIAL = 1000;
const RECONNECT_MAX = 30000;
const RECONNECT_MULTIPLIER = 2;

// ============================================================================
// State
// ============================================================================

let ws = null;
let reconnectDelay = RECONNECT_INITIAL;
let reconnectTimer = null;
let isShuttingDown = false;

/** Currently running claude child process, or null if idle. */
let activeProcess = null;

// ============================================================================
// Logging helpers
// ============================================================================

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function logErr(msg) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ERROR: ${msg}`);
}

// ============================================================================
// WebSocket send (safe)
// ============================================================================

function wsSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      logErr(`wsSend failed: ${err.message}`);
    }
  }
}

// ============================================================================
// Status helpers
// ============================================================================

function sendStatus(state) {
  wsSend({ type: "status", state, machineId: MACHINE_ID });
  log(`Status -> ${state}`);
}

// ============================================================================
// Claude execution
// ============================================================================

/**
 * Execute a claude -p command and stream results back via WebSocket.
 *
 * @param {object} cmd - The command message from the relay server.
 * @param {string} cmd.prompt    - The prompt to pass to claude.
 * @param {string} [cmd.cwd]     - Working directory for the claude process.
 * @param {string} [cmd.sessionId] - Resume an existing claude session.
 */
function executeCommand(cmd) {
  if (activeProcess) {
    log("Busy — rejecting command (process already running)");
    wsSend({
      type: "error",
      error: "daemon is busy",
      machineId: MACHINE_ID,
    });
    return;
  }

  const { prompt, cwd, sessionId } = cmd;

  sendStatus("working");

  // Build claude CLI arguments
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  if (cwd) {
    args.push("--add-dir", cwd);
  }

  // Working directory: use provided cwd, falling back to home dir
  const workDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

  // Environment: clear CLAUDECODE to bypass nested-session guard
  const childEnv = Object.assign({}, process.env, { CLAUDECODE: "" });

  log(`Spawning: ${CLAUDE_PATH} ${args.join(" ")} (cwd: ${workDir})`);

  const isWindows = process.platform === "win32";
  const spawnOpts = {
    cwd: workDir,
    env: childEnv,
    shell: isWindows,
    // Do not use stdio: 'inherit' — we need to capture stdout/stderr
  };

  let child;
  try {
    child = spawn(CLAUDE_PATH, args, spawnOpts);
  } catch (err) {
    logErr(`Failed to spawn claude: ${err.message}`);
    sendStatus("idle");
    wsSend({
      type: "error",
      error: `spawn failed: ${err.message}`,
      machineId: MACHINE_ID,
    });
    return;
  }

  activeProcess = child;

  // Accumulate full text result and the session id returned by claude
  let fullResult = "";
  let claudeSessionId = sessionId || null;

  // Buffer for partial lines coming from stdout
  let stdoutBuf = "";

  child.stdout.on("data", (data) => {
    stdoutBuf += data.toString("utf8");

    // Process complete lines
    const lines = stdoutBuf.split("\n");
    // Keep the last (possibly incomplete) chunk in the buffer
    stdoutBuf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (_) {
        // Non-JSON output — treat as raw text chunk
        log(`claude stdout (non-JSON): ${trimmed}`);
        wsSend({ type: "stream", chunk: trimmed, machineId: MACHINE_ID });
        continue;
      }

      // stream-json format: each line is an event object
      // Common event types: system, assistant, user, result
      handleClaudeEvent(parsed);

      // Accumulate session id from result event
      if (parsed.type === "result") {
        if (parsed.session_id) claudeSessionId = parsed.session_id;
        if (parsed.result) fullResult += parsed.result;
      }

      // Accumulate assistant text chunks
      if (
        parsed.type === "assistant" &&
        parsed.message &&
        Array.isArray(parsed.message.content)
      ) {
        for (const block of parsed.message.content) {
          if (block.type === "text") {
            fullResult += block.text;
            wsSend({
              type: "stream",
              chunk: block.text,
              machineId: MACHINE_ID,
            });
          }
        }
      }
    }
  });

  child.stderr.on("data", (data) => {
    const text = data.toString("utf8").trim();
    if (text) {
      log(`claude stderr: ${text}`);
      // Forward stderr as a stream chunk so the phone can display it
      wsSend({ type: "stream", chunk: `[stderr] ${text}`, machineId: MACHINE_ID });
    }
  });

  child.on("close", (code) => {
    activeProcess = null;

    // Flush any remaining buffer content
    if (stdoutBuf.trim()) {
      let parsed;
      try {
        parsed = JSON.parse(stdoutBuf.trim());
        handleClaudeEvent(parsed);
        if (parsed.type === "result") {
          if (parsed.session_id) claudeSessionId = parsed.session_id;
          if (parsed.result) fullResult += parsed.result;
        }
      } catch (_) {
        wsSend({ type: "stream", chunk: stdoutBuf.trim(), machineId: MACHINE_ID });
      }
    }

    log(`claude exited with code ${code}`);

    wsSend({
      type: "result",
      content: fullResult,
      sessionId: claudeSessionId,
      exitCode: code,
      machineId: MACHINE_ID,
    });

    sendStatus("idle");
  });

  child.on("error", (err) => {
    logErr(`claude process error: ${err.message}`);
    activeProcess = null;
    wsSend({
      type: "error",
      error: err.message,
      machineId: MACHINE_ID,
    });
    sendStatus("idle");
  });
}

/**
 * Handle a parsed stream-json event from claude stdout.
 * Forwards interesting events as stream chunks to the phone.
 */
function handleClaudeEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case "system":
      // Emitted at start with session info
      if (event.session_id) {
        log(`claude session_id: ${event.session_id}`);
      }
      break;

    case "assistant":
      // Text chunks are handled in the caller
      break;

    case "tool_use":
      // Tool invocation — forward as info stream
      wsSend({
        type: "stream",
        chunk: `[tool] ${event.name || "unknown"}`,
        machineId: MACHINE_ID,
      });
      break;

    case "result":
      // Final result — handled in caller
      break;

    default:
      // Forward other events verbatim as debug chunks
      break;
  }
}

// ============================================================================
// Session browser
// ============================================================================

/**
 * List recent Claude Code sessions from ~/.claude/projects/
 * Returns: { type: "sessions", sessions: [...], machineId }
 */
function listSessions(msg) {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  const sessions = [];

  try {
    if (!fs.existsSync(claudeDir)) {
      wsSend({ type: "sessions", sessions: [], machineId: MACHINE_ID });
      return;
    }

    // Walk ~/.claude/projects/*/sessions/*.jsonl
    const projects = fs.readdirSync(claudeDir);
    for (const proj of projects) {
      // Check both layouts:
      //   projects/<proj>/sessions/*.jsonl  (some versions)
      //   projects/<proj>/*.jsonl           (current Claude Code)
      const sessDir = path.join(claudeDir, proj, "sessions");
      const projDir = path.join(claudeDir, proj);
      const searchDir = fs.existsSync(sessDir) ? sessDir : projDir;

      const files = fs.readdirSync(searchDir).filter(f => f.endsWith(".jsonl") && !f.startsWith("agent-"));
      for (const file of files) {
        const filePath = path.join(searchDir, file);
        try {
          const stat = fs.statSync(filePath);
          const sessionId = file.replace(".jsonl", "");

          // Read first and last lines for summary
          const content = fs.readFileSync(filePath, "utf8");
          const lines = content.trim().split("\n");
          let firstUserMsg = "";
          let messageCount = 0;

          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === "human" || parsed.role === "user") {
                messageCount++;
                if (!firstUserMsg && parsed.message) {
                  const text = typeof parsed.message === "string"
                    ? parsed.message
                    : Array.isArray(parsed.message.content)
                      ? parsed.message.content.find(b => b.type === "text")?.text || ""
                      : "";
                  firstUserMsg = text.slice(0, 100);
                }
              }
              if (parsed.type === "assistant" || parsed.role === "assistant") {
                messageCount++;
              }
            } catch (_) {}
          }

          sessions.push({
            sessionId,
            project: decodeURIComponent(proj.replace(/-/g, "/")),
            modified: stat.mtimeMs,
            size: stat.size,
            messageCount,
            preview: firstUserMsg || "(no preview)",
          });
        } catch (_) {}
      }
    }

    // Sort by most recent first, limit to 20
    sessions.sort((a, b) => b.modified - a.modified);
    const limited = sessions.slice(0, msg.limit || 20);

    wsSend({ type: "sessions", sessions: limited, machineId: MACHINE_ID });
    log(`Listed ${limited.length} sessions`);
  } catch (err) {
    logErr(`listSessions error: ${err.message}`);
    wsSend({ type: "sessions", sessions: [], machineId: MACHINE_ID });
  }
}

/**
 * Read a session's conversation history
 * Returns: { type: "session_detail", sessionId, messages: [...], machineId }
 */
function getSessionDetail(msg) {
  const { sessionId } = msg;
  if (!sessionId) {
    wsSend({ type: "error", error: "sessionId required", machineId: MACHINE_ID });
    return;
  }

  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  const messages = [];

  try {
    // Find the session file
    const projects = fs.readdirSync(claudeDir);
    let filePath = null;

    for (const proj of projects) {
      // Check both layouts
      const candidates = [
        path.join(claudeDir, proj, "sessions", `${sessionId}.jsonl`),
        path.join(claudeDir, proj, `${sessionId}.jsonl`),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          filePath = c;
          break;
        }
      }
      if (filePath) break;
    }

    if (!filePath) {
      wsSend({ type: "error", error: "Session not found", machineId: MACHINE_ID });
      return;
    }

    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        let role = null;
        let text = "";

        if (parsed.type === "human" || parsed.role === "user") {
          role = "user";
          if (typeof parsed.message === "string") {
            text = parsed.message;
          } else if (parsed.message?.content) {
            const blocks = Array.isArray(parsed.message.content) ? parsed.message.content : [];
            text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
          }
        } else if (parsed.type === "assistant" || parsed.role === "assistant") {
          role = "assistant";
          if (typeof parsed.message === "string") {
            text = parsed.message;
          } else if (parsed.message?.content) {
            const blocks = Array.isArray(parsed.message.content) ? parsed.message.content : [];
            text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
          }
        }

        if (role && text) {
          messages.push({ role, text: text.slice(0, 2000) });
        }
      } catch (_) {}
    }

    // Limit to last 50 messages
    const limited = messages.slice(-50);
    wsSend({ type: "session_detail", sessionId, messages: limited, machineId: MACHINE_ID });
    log(`Session detail: ${sessionId} (${limited.length} messages)`);
  } catch (err) {
    logErr(`getSessionDetail error: ${err.message}`);
    wsSend({ type: "error", error: err.message, machineId: MACHINE_ID });
  }
}

// ============================================================================
// Message handling
// ============================================================================

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    logErr(`Received invalid JSON: ${raw}`);
    return;
  }

  log(`Received message type="${msg.type}"`);

  switch (msg.type) {
    case "command":
      executeCommand(msg);
      break;

    case "sessions":
      listSessions(msg);
      break;

    case "session_detail":
      getSessionDetail(msg);
      break;

    case "ping":
      wsSend({ type: "pong", machineId: MACHINE_ID });
      break;

    case "status_request":
      sendStatus(activeProcess ? "working" : "idle");
      break;

    default:
      log(`Unknown message type: ${msg.type}`);
  }
}

// ============================================================================
// WebSocket connection management
// ============================================================================

function connect() {
  if (isShuttingDown) return;

  log(`Connecting to ${SERVER_URL} ...`);

  ws = new WebSocket(SERVER_URL);

  ws.on("open", () => {
    log("WebSocket connected");
    reconnectDelay = RECONNECT_INITIAL; // reset backoff on success

    // Register as daemon
    wsSend({
      type: "register",
      role: "daemon",
      token: TOKEN,
      machineId: MACHINE_ID,
    });

    // Advertise idle status immediately after registration
    sendStatus("idle");
  });

  ws.on("message", (data) => {
    handleMessage(data.toString("utf8"));
  });

  ws.on("close", (code, reason) => {
    ws = null;
    log(`WebSocket closed (code=${code} reason=${reason || "none"})`);

    if (!isShuttingDown) {
      scheduleReconnect();
    }
  });

  ws.on("error", (err) => {
    logErr(`WebSocket error: ${err.message}`);
    // "close" event fires after "error", so reconnect is handled there
  });
}

function scheduleReconnect() {
  if (isShuttingDown) return;

  log(`Reconnecting in ${reconnectDelay}ms ...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);

  // Exponential backoff
  reconnectDelay = Math.min(reconnectDelay * RECONNECT_MULTIPLIER, RECONNECT_MAX);
}

// ============================================================================
// Graceful shutdown
// ============================================================================

function shutdown(signal) {
  log(`Received ${signal} — shutting down gracefully`);
  isShuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (activeProcess) {
    log("Killing active claude process");
    try {
      activeProcess.kill("SIGTERM");
    } catch (_) {}
  }

  if (ws) {
    try {
      sendStatus("offline");
      ws.close(1000, "daemon shutting down");
    } catch (_) {}
    ws = null;
  }

  // Give a moment for the close message to be sent, then exit
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ============================================================================
// Hook status file watcher
// ============================================================================
// The vibes-hook.py writes status to ~/.vibes/status.json on each Claude Code
// event. We watch this file and forward changes to the WebSocket server so
// that the smartphone app can see real-time status from interactive sessions.

const STATUS_FILE = path.join(os.homedir(), ".vibes", "status.json");
let lastStatusMtime = 0;

function watchStatusFile() {
  const dir = path.dirname(STATUS_FILE);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  }

  // Poll every 500ms (fs.watch is unreliable on Windows)
  setInterval(() => {
    try {
      const stat = fs.statSync(STATUS_FILE);
      const mtime = stat.mtimeMs;
      if (mtime > lastStatusMtime) {
        lastStatusMtime = mtime;
        const raw = fs.readFileSync(STATUS_FILE, "utf8");
        const status = JSON.parse(raw);
        // Forward hook status to WebSocket server
        wsSend({
          type: "status",
          state: status.state || "idle",
          tool: status.tool || "",
          project: status.project || "",
          model: status.model || "",
          memory: status.memory || 0,
          machineId: MACHINE_ID,
        });
        log(`Hook status forwarded: ${status.state} (${status.project || "?"})`);
      }
    } catch (_) {
      // File doesn't exist yet or parse error — ignore
    }
  }, 500);
}

// ============================================================================
// Entry point
// ============================================================================

log("vibes-daemon starting");
log(`  Server  : ${SERVER_URL}`);
log(`  Machine : ${MACHINE_ID}`);
log(`  Claude  : ${CLAUDE_PATH}`);

connect();
watchStatusFile();
log("Watching ~/.vibes/status.json for hook updates");
