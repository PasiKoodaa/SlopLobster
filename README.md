# SlopLobster



https://github.com/user-attachments/assets/0bc3c230-282a-4efb-a58e-365e82af710b


## Plan demo video



https://github.com/user-attachments/assets/11ae062c-58f9-4906-9e07-1a31e5d42456



**Local AI coding agent** — runs entirely on your machine. No accounts, no API keys, no cloud.

SlopLobster gives you a Claude Code / Cursor-like agent experience powered by any local LLM via [LM Studio](https://lmstudio.ai/). It reads, writes, and edits your files, runs shell commands, searches the web, automates browsers, and manages git — all through a single self-contained HTML file.


---

## Features

### Core Agent
- **Iterative tool loop** — the LLM reads files, edits code, runs commands, and iterates until the task is done
- **Streaming responses** — see the model think and act in real time
- **Pause / Resume** — pause between steps without losing anything: the current response and any tool calls it triggered finish normally, nothing is cut off mid-stream, and Resume continues exactly where it left off
- **Steer mid-run** — type guidance while the agent is working and it's queued in as a normal turn at the next safe checkpoint, without stopping the loop. Enter no longer aborts a running agent; it queues instead
- **Visible task checklist** — the agent maintains a live pending/in-progress/done checklist for multi-step tasks via `update_plan`, shown in a header popup
- **Mid-task clarifying questions** — the agent can pause and ask you a question via `ask_user` when it hits a genuine ambiguity, with optional quick-reply buttons (toggle-able if you'd rather it always guess and never interrupt)
- **Loop/stall detection** — automatically detects the agent repeating the exact same tool call 3+ times with no progress and forces it to stop, explain, or try something different instead of burning iterations silently
- **Context management** — automatic compaction with progress file persistence when context fills up, performed by a dedicated **memory agent** pass (separate model call, optionally a different/cheaper model than the one doing the task)
- **Configurable compaction triggers** — compact at a % of context window, an absolute token count, or both — whichever is hit first. The memory agent can also be disabled entirely if you'd rather a session just run until it hits the hard iteration cap
- **Cross-session project memory** — the agent can call `save_memory` to write durable facts (environment quirks, conventions, preferences) to `.sloplobster-memory.md`, which is loaded into every future conversation in the same workspace, completely bypassing compaction
- **Automatic environment detection** — the actual Python command, virtualenv status, and Node version are probed once via the companion server and stated plainly in the system prompt ("use python, not python3, here") instead of relying on the agent to discover and remember it
- **Environment-fix nudges** — when the agent fixes a failing command by switching to a different one, it's nudged once to `save_memory` if that looks like a real environment fact rather than a typo
- **Session token budget** — optional hard cap on cumulative output tokens for the browser session, mainly as a guardrail for unattended sub-agent/swarm runs
- **Sub-agents** — spawn focused read-only agents for context gathering, keeping the main context clean
- **Swarms** — spawn multiple parallel workers with shared memory/messaging for larger tasks
- **Deep research** — multi-step web research tool for open-ended questions
- **Plan mode** — break complex tasks into reviewable steps before executing

### Safety & Permissions
- **Default-deny on dangerous actions** — shell commands, git commits/pushes, and browser click/type/JS-eval all pause for confirmation by default. Each category has its own auto-approve toggle if you want to skip the prompts, and a separate "dangerous-pattern" floor (`rm -rf`, force push, etc.) that still confirms even with auto-approve on unless explicitly bypassed too
- **Edit approval mode** — requires Accept/Reject before applying file edits by default
- **Secret redaction** — API keys, tokens, JWTs, and private-key blocks are automatically redacted from tool output before they reach the model's context or get saved to conversation history
- **Per-tool enable/disable** — turn off tools you won't use in a project to trim the schema tokens sent on every turn
- **Settings profiles** — bundle the tool selection and permission settings into reusable presets: **Balanced** (default), **Fully Autonomous** (all auto-approve on, no interruptions), **Review Only** (every write-capable tool disabled), and **Minimal / Low-Context** (strips browser/swarm/research tools for small-context local models). Save your own custom profiles too

### File Operations
- **Read, edit, create, delete, move** files via the File System Access API
- **LCS-based diffing** — precise diffs shown for every edit, with compact/expand toggle
- **Edit approval mode** — requires Accept/Reject before applying changes by default (can be turned off for fully autonomous edits)
- **Write verification** — reads files back after writing to confirm integrity
- **Syntax checking** — auto-runs `py_compile` / `node -c` after edits
- **Auto-verify loop** — runs your test command after edits and auto-fixes on failure (configurable retries)

### Shell & Git
- **Full shell access** via the companion server — any OS command works
- **Streaming command output** — see output as it arrives, not after completion
- **Auto-timeout extension** — package installs (`pip`, `npm`, `cargo`, etc.) automatically get 300s
- **Confirmation by default** — every real shell command asks first unless you opt into auto-approve; commands matching the dangerous-pattern list (`rm -rf /`, `dd`, `mkfs`, etc.) confirm regardless unless separately bypassed
- **Structured test runner** — `run_tests` parses pytest/jest/vitest/mocha/cargo/go output into a compact pass/fail summary instead of dumping the raw log, and only includes the failure excerpt on failure
- **Git integration** — status, diff, log, add, commit, push, checkout/create branch, and stash, all as dedicated tools (push always confirms, since it's the one action touching shared remote history)
- **HTTP request tool** — `http_request` for testing REST APIs with proper method/headers/body support, instead of shell-escaping curl through `execute_command`

### Web & Browser
- **Web search** via DuckDuckGo with optional auto-fetch of top results
- **URL fetching** with HTML-to-text extraction (strips nav, scripts, styles, extracts links)
- **Browser automation** via Playwright — navigate, click, type, screenshot, evaluate JS, read console errors
- **Browser write actions confirm by default** — click/type/JS-eval pause for confirmation unless auto-approved
- **Reference site directory** — curated list of documentation sites with fetch/search hints injected into the system prompt

### Media
- **Image understanding** — attach images, paste from clipboard, or capture screen regions (vision-capable models)
- **PDF reading** — extracts text from PDFs via pdf.js
- **SVG rendering** — shows rendered preview with code toggle

### UI
- **Right panel** with file preview (syntax highlighted), session changes, terminal log, and git status
- **Resizable right panel** (drag the left edge)
- **File tree** with modified-file indicators and inline actions
- **Conversation management** — save, fork, delete, search, export to Markdown
- **Command palette** (`Ctrl+K`) for quick access to actions
- **Keyboard shortcuts** — `/` to focus, `Ctrl+B` sidebar, `Ctrl+Shift+N` new chat, `Esc` to stop
- **Dark theme** with amber/gold accent, optimized for long coding sessions

---

## Architecture

```
┌────────────────────────────────────────────────┐
│  SlopLobster (single HTML file)                │
│  ┌───────────┐  ┌──────────┐  ┌─────────────┐  │
│  │ Sidebar   │  │  Chat    │  │ Right Panel │  │
│  │ - Convs   │  │  Stream  │  │ - Files     │  │
│  │ - Files   │  │  Tools   │  │ - Changes   │  │
│  │ - Tools   │  │  Diffs   │  │ - Terminal  │  │
│  │ - Status  │  │  Images  │  │ - Git       │  │
│  └─────┬─────┘  └────┬─────┘  └──────┬──────┘  │
│        │             │               │         │
│  ──────┴─────────────┴───────────────┴──────   │
│  File System Access API (Chrome/Edge)          │
└──────────────────┬─────────────────────────────┘
                   │ HTTP
         ┌─────────┴──────────┐
         │  LM Studio (:1234) │  ← LLM inference (main agent + memory agent)
         └────────────────────┘
                   │ HTTP
         ┌─────────┴──────────┐
         │ Companion (:8765)  │  ← Shell, search, browser
         │ Python server      │
         └────────────────────┘
```

**Zero backend of its own** — SlopLobster is a pure frontend app. All heavy lifting is done by LM Studio and the companion server.

---

## Quick Start

### 1. Install LM Studio

Download from [lmstudio.ai](https://lmstudio.ai/). Load a model that supports tool/function calling (recommended): Qwen 3.5 or Gemma 4

**For best results**: use a model with ≥32k context and tool-use training. Check the `🔧` tag in the model selector — it indicates the model reports tool-use capability.

### 2. Start the Companion Server

SlopLobster has a **Save & Start** button on the welcome screen that downloads `SlopLobster-companion.py`. Or save it manually:

```bash
# Save the companion script (embedded in the HTML — click "Setup Companion" on welcome)
python SlopLobster-companion.py

# Optional: install Playwright for browser automation
pip install playwright
playwright install chromium

# Or if above doesn't work
python -m playwright install chromium
```

The companion runs on `http://127.0.0.1:8765` and provides:
- Shell command execution (with streaming)
- Web search (DuckDuckGo)
- URL content fetching
- AST-based code skeleton extraction
- Browser automation (if Playwright is installed)
- Environment probing (Python command, virtualenv, Node version) surfaced to the agent automatically

**Without the companion**, SlopLobster falls back to a virtual shell with basic commands (`ls`, `cat`, `grep`, `find`, etc.) — file editing still works, but you won't have git, search, real shell access, or `run_tests`/`http_request` server-side fetching.

### 3. Open SlopLobster

Open `index.html` in **Chrome** or **Edge** (required for the File System Access API). That's it — no build step, no `npm install`, no server to start.

### 4. Open a Workspace

Click **Open Workspace** in the sidebar and select your project directory. The agent can now read, create, and edit files in that directory. If a `.sloplobster-memory.md` file already exists there from a previous session, it's loaded automatically.

---

## Usage

### Basic Workflow

1. **Type a task** in the input box and press Enter
2. **Watch the agent** think, read files, make edits, run commands
3. **Review diffs** that appear after each edit — and Accept/Reject them if edit approval is on
4. **Intervene without stopping** — type guidance and it's queued in at the next safe step (doesn't abort the loop), click **Pause** to stop cleanly between steps and **Resume** later, or press **Esc**/click **Stop** for a hard abort

### Attaching Files

- **Drag and drop** files onto the input area
- **Click the 📎 button** to attach files
- **Paste images** from clipboard (Ctrl+V anywhere on the page)
- **Click the 📷 button** to capture a screen region (vision models only)

### Slash Commands

| Command | Description |
|---------|--------------|
| `/help` | Show all commands |
| `/new` | New conversation |
| `/compact` | Manually compact context |
| `/dir` | Open workspace directory |
| `/model` | List available models |
| `/tools` | List available tools |
| `/shell` | Check companion status |
| `/status` | Show full status |
| `/export` | Export conversation as Markdown |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message — or queue guidance if the agent is running |
| `Shift+Enter` | New line |
| `Esc` | Stop generation / close modal |
| `Ctrl+Shift+N` | New conversation |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+K` | Command palette |
| `Ctrl+F` | Search conversations |
| `Ctrl+,` | Open settings |
| `Ctrl+Shift+E` | Export conversation |
| `Ctrl+Shift+M` | Compact context |
| `Ctrl+Shift+P` | Toggle plan mode |
| `/` | Focus input |
| `↑` / `↓` | Input history |

### Plan Mode

Press `Ctrl+Shift+P` or click the Plan button to enable plan mode. Your next task will be broken into numbered steps that you can review before executing individually or all at once.

This is distinct from the always-on **task checklist** the agent maintains automatically for any multi-step task via `update_plan` — plan mode is an opt-in upfront breakdown you approve before work starts; the checklist is a live progress view during work that's already running.

### Pausing, Resuming, and Steering

- **Pause** (button next to Stop) waits for the agent to finish its current step — the response and any tool calls it triggered — before stopping. Nothing is cut off and no tokens are wasted. A **Resume** button appears in the chat to continue exactly where it left off.
- **Steering** — while the agent is running, type into the input box as normal. Pressing Enter (or clicking the queue button) doesn't stop the agent; it shows your message as a pending chip and injects it as a real turn at the next safe checkpoint, so the agent reacts to it in its very next response.
- **Stop** is a hard abort — use it when you want the agent to stop immediately, even mid-stream or mid-tool-call.

### Right Panel

- **Files** — click any file in the sidebar tree to preview it with syntax highlighting
- **Changes** — tracks all file modifications in the session with diffs and revert buttons
- **Term** — streaming log of all shell commands and their output
- **Git** — branch, status, quick stage/log actions

---

## Settings

Click ⚙️ in the header to configure:

| Setting | Default | Description |
|---------|---------|--------------|
| LM Studio URL | `http://localhost:1234` | LM Studio API endpoint |
| Companion URL | `http://127.0.0.1:8765` | Companion server endpoint |
| Temperature | 0.3 | Lower = more deterministic |
| Max Tokens | 60000 | Max response length |
| Max Iterations | 50 | Agent stops after this many tool loops |
| Context Window | 62768 | For context meter & auto-compact trigger |
| Auto-compact | 85% | Compact when context usage exceeds this |
| Session token budget | 0 (unlimited) | Stops the agent loop once cumulative session output tokens pass this |
| Also compact at absolute token count | 0 (off) | Compacts on whichever of this or the % threshold is hit first |
| Use a memory agent | ✓ | Toggle automatic compaction entirely off/on |
| Memory agent model | (blank = main model) | Optional cheaper/faster model just for compaction summaries |
| Max File Read | 500 KB | Truncate files larger than this |
| Verify Writes | ✓ | Read back files after writing |
| Require Approval | ✓ | Show Accept/Reject before edits |
| Auto-verify Command | (empty) | e.g. `pytest`, `npm test` — also used by `run_tests` if no command is given |
| Max Auto-fix Retries | 3 | Retries after test failure |
| Smart Context | 0 lines | File skeleton for large files (try 150-300) |
| Allow mid-task questions | ✓ | Lets the agent use `ask_user` to pause and ask; turn off for fully unattended runs |
| Clarifying questions before starting | ✗ | Ask a few questions up front before beginning a task |

### Dangerous Action Permissions

All off by default — the agent always asks first:

| Setting | Default | Description |
|---------|---------|--------------|
| Run shell commands without asking | ✗ | Auto-approve non-dangerous shell commands |
| Also skip confirmation for dangerous-pattern commands | ✗ | Bypasses the `rm -rf`/force-push floor too — requires the setting above to also be on |
| Commit to git without asking | ✗ | Auto-approve `git_commit` (note: `git_push` always confirms regardless) |
| Click/type/run JS in the browser without asking | ✗ | Auto-approve browser write actions |

### Enabled Tools

Every enabled tool's schema is sent to the model on every turn. Toggle individual tools off (except `think`, which is always on) to save context on tools you won't use in a given project.

### Settings Profiles

Bundles the above into a single switch: **Balanced** (default), **Fully Autonomous**, **Review Only (no writes)**, **Minimal / Low-Context**, or your own saved custom profiles.

### Model Load Settings

When you select a model that isn't loaded, SlopLobster can request LM Studio to load it with optimized settings:

| Setting | Default | Description |
|---------|---------|--------------|
| Context Length Override | 0 (model default) | Lower saves VRAM |
| Flash Attention | ✓ | Lower memory, faster generation |
| KV Cache → GPU | ✓ | Faster than RAM offload |
| MoE Experts | 0 (all) | Fewer experts = less VRAM for Mixtral/Qwen-MoE |
| Eval Batch Size | 0 (default) | Higher = faster prompt processing |

### System Prompt

Fully customizable with save/load presets. The default prompt includes:
- Dynamic capability checklist (updates based on what's connected)
- Workspace awareness (prevents nested directory creation)
- Detected environment info (Python command, virtualenv, Node version) — stated as fact, not left for the agent to discover
- A "don't lose what you learn" section prompting the agent to call `save_memory` the moment it discovers something durable, not at the end of the task
- Project memory (durable facts saved from previous sessions in this workspace, if any)
- Reference site directory (MDN, Python docs, React docs, etc.)
- File reading strategy guidelines
- Web search strategy with JS-rendered page workarounds
- Error recovery patterns
- Security boundary documentation

---

## Companion Server

The companion is a single Python file with no dependencies beyond the standard library. Optional dependency: `playwright` for browser automation.

```
SlopLobster-companion.py
├── Shell execution (streaming NDJSON)
├── Web search (DuckDuckGo HTML parsing)
├── URL fetching (HTML→text extraction)
├── AST signature extraction (Python, JS, generic)
├── Browser automation (Playwright wrapper)
├── Environment probing (Python cmd, venv, Node)
└── Status/health endpoint
```

### Endpoints

| Method | Path | Description |
|--------|------|--------------|
| GET | `/status` | Health check, platform info, Python env |
| POST | `/execute` | Run shell command (NDJSON stream) — also backs `run_tests` and git tools |
| POST | `/search` | DuckDuckGo search with optional fetch |
| POST | `/fetch` | Fetch and extract URL content |
| POST | `/ast_signatures` | Extract code skeleton from source |
| POST | `/browser_*` | Playwright browser automation |

`http_request` (for arbitrary REST API calls with custom methods/headers/bodies) runs directly from the browser via `fetch()` rather than through the companion, so same-origin/CORS-enabled APIs work without it — but is therefore subject to normal browser CORS restrictions; APIs without CORS headers need `execute_command` + curl via the companion instead.

### Security

- Binds to `127.0.0.1` only — no external access
- No authentication needed for localhost
- File operations are sandboxed by the browser's File System Access API (not the companion)
- SlopLobster validates all paths for traversal attacks before sending to the companion
- Dangerous shell commands, git pushes, and browser write actions confirm by default (see Settings → Dangerous Action Permissions)
- Secrets (API keys, tokens, JWTs, private keys) are pattern-redacted from tool output before it reaches the model or gets saved to history

---

## How It Works

### Tool Loop

SlopLobster uses the OpenAI-compatible tool/function calling API:

1. User sends a message
2. Message + system prompt + conversation history → LM Studio
3. LLM responds with either text, tool calls, or both
4. Tool calls are executed locally (file I/O) or via companion (shell, search, browser) — dangerous ones pause for confirmation first, per the permission settings
5. Tool results (secret-redacted) are appended to history and sent back to the LLM
6. At the top of each iteration: pending steer messages are injected, then pause/hard-stop/token-budget/compaction conditions are checked
7. Repeat until the LLM responds with text only, the loop is paused, or a stop condition is hit

### Context Management

- **Token estimation**: ~3.8 characters per token
- **Context meter**: shows usage as percentage of configured window
- **Memory agent**: a dedicated compaction pass (separate model call, optionally a cheaper override model) triggered by % of context window, an absolute token count, or both — whichever comes first. Can be disabled entirely
- **Compaction priority**: environment/tooling corrections are preserved first, ahead of generic task summary, files modified, and error history — and the summarizer is told what's already in project memory so it doesn't waste budget repeating it
- **Progress file**: a detailed `.sloplobster-progress-<id>.md` is saved to the workspace before compaction. It's excluded from listing/search/edit/delete (so the agent can't tamper with it or have it clutter results) but remains readable, so the agent can recover full context after compaction
- **Project memory**: `.sloplobster-memory.md` holds durable, cross-session facts saved via `save_memory` — loaded into every conversation's system prompt for as long as the workspace stays open, immune to compaction entirely
- **Smart context**: files over a configurable line threshold are reduced to their AST skeleton (function signatures with line numbers), saving thousands of tokens on large files

### Diff Engine

Uses a full **Longest Common Subsequence (LCS)** algorithm for precise diffs. For files where `m × n > 50,000`, falls back to a simple line-by-line comparison with truncation. Diffs are displayed in compact mode by default (changed lines + 1 line of context) with an expand toggle.

### Image Pipeline

1. Images are captured (screen share API or html2canvas fallback)
2. Compressed to JPEG at 1280px max dimension, 80% quality
3. Sent as `image_url` content parts in the API request
4. The LLM sees the actual pixels (if vision-capable)
5. Previews are shown in both the chat and the right panel

---

## Browser Support

| Browser | Status | Notes |
|---------|--------|-------|
| Chrome 86+ | ✅ Full | File System Access API, screen capture |
| Edge 86+ | ✅ Full | Same as Chrome |
| Firefox | ⚠️ Partial | No File System Access API — use companion for all file ops |
| Safari | ❌ No | No File System Access API or screen capture |

---

## Troubleshooting

**"No models" in selector**
- Make sure LM Studio is running and a model is loaded
- Check the API URL in Settings matches LM Studio's port (default 1234)

**Model selector shows different model than what's loaded**
- LM Studio's `/v1/models` endpoint lists all downloaded models, not just the loaded one
- Look for the `✓ LOADED` tag — only that model is actually active
- Use the 📥 button to load the selected model

**"Virtual shell only"**
- The companion server isn't running — start it with `python SlopLobster-companion.py`
- Check the companion URL in Settings matches the server's port

**Context filling up too fast**
- Enable Smart Context (Settings → Smart Context → 150-300 lines)
- Reduce Max File Read to truncate large files earlier
- Lower the Context Window setting, or set an absolute compact token threshold, to trigger auto-compact sooner
- Use plan mode to work in smaller steps

**Agent keeps making malformed tool calls**
- The model's context is likely full or nearly full — compact
- Large file writes get truncated by the API — use `edit_file` with small blocks instead of `write_file`
- Try a model with more context length

**Agent forgets something it figured out earlier (e.g. "use python not python3")**
- Ask it to `save_memory` explicitly, or it may already have been nudged to on its own
- Check `.sloplobster-memory.md` in the workspace — you can edit it directly
- Common cases (Python command, venv, Node version) are now auto-detected and stated in the system prompt, so they shouldn't need rediscovering at all

**Agent keeps repeating the same failing action**
- The loop/stall detector should catch 3 identical repeats automatically and inject a stop-and-explain message — if it's still stuck, use Pause or Stop and steer it manually

**"JavaScript-rendered page" when fetching URLs**
- `fetch_url` uses `urllib` which cannot execute JavaScript
- Use `web_search` with `site:domain.com <topic>` instead — DuckDuckGo's crawler executes JS
- Or use the browser automation tools to load the page in a real browser

**`http_request` fails with a network/CORS error**
- The target API doesn't allow cross-origin browser requests — this is a browser restriction, not a bug
- Use `execute_command` with curl instead, via the companion server

**Companion connection drops mid-conversation**
- SlopLobster automatically falls back to the virtual shell
- Tool calls that require the companion will fail gracefully
- Reconnect by clicking the 🔄 button or restarting the companion

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| UI | Vanilla HTML/CSS/JS, Tailwind CSS |
| Markdown | marked.js |
| Syntax Highlighting | highlight.js |
| Sanitization | DOMPurify |
| PDF | pdf.js |
| Screenshots | html2canvas + Screen Capture API |
| LLM | LM Studio (OpenAI-compatible API) |
| Shell/Search | Python stdlib + Playwright |
| Storage | localStorage (conversations, settings) + workspace files (progress/memory) |

---
