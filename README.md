# SlopLobster



https://github.com/user-attachments/assets/0bc3c230-282a-4efb-a58e-365e82af710b


## Plan demo video



https://github.com/user-attachments/assets/11ae062c-58f9-4906-9e07-1a31e5d42456



**Local AI coding agent** — runs with a model server on your machine. No cloud account required.

SlopLobster gives you a Claude Code / Cursor-like agent experience powered by a local model server. Built-in choices include [LM Studio](https://lmstudio.ai/), llama.cpp, [vLLM](https://docs.vllm.ai/), [LocalAI](https://localai.io/), [Jan](https://jan.ai/), [GPT4All](https://www.nomic.ai/gpt4all), and text-generation-webui, plus other local servers that expose the OpenAI-compatible API. It reads, writes, and edits your files, runs shell commands, searches the web, automates browsers, and manages git — all through a single self-contained HTML file.


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
- **Swarms** — a dependency graph of workers (`depends_on`) with shared memory and messaging. Independent workers can run concurrently when their `owns` file globs are disjoint (enforced on every write); failed workers block their dependents (or `continue`/`abort` per worker), incomplete workers are reported honestly instead of as "Done", progress is checkpointed so a re-run resumes, a worker with `kind: "critic"` and `reviews: "<author>"` is a read-only adversarial reviewer that must cite evidence and end with `VERDICT: APPROVE` or `VERDICT: REVISE` (on REVISE the author is sent back with the critique, up to `max_revisions`; a critic that still objects blocks its dependents), `check_command` makes a worker pass its own tests before it counts as done, a task contract (`contract`: acceptance criteria, token budget, deadline; 20% reserved for verification) is judged by an independent read-only verifier that sees only the project, never the workers' accounts, and failing criteria send just their owner back for targeted repair; a critic also gates every worker that builds on its author's output; shared-memory entries are hypotheses until marked verified with evidence; every run keeps an event log and metrics (verified rate, tokens per verified result, latency, repair frequency) that the `swarm_history` tool reports; round limits are soft budgets (sub-agents and workers get extended while they keep finding new things, are stopped early if they only repeat themselves or fail, and always write a final report even when cut off), long worker conversations are kept inside the model's context by trimming the oldest large tool outputs, token usage is shown live, and an optional `verify_command` decides whether the result is reported as verified. With `isolate: true` (companion + Git project root required) every worker gets its own Git worktree: dependents start from their upstream workers' branches, finished work is merged onto one integration branch, merge conflicts are reported instead of overwritten, and nothing reaches your working tree until you review and merge that branch in Harness → Isolation
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
- **Baseline-aware verification** — records your configured check before the first model turn, checks again after changes, and compares test failure identities. New failures trigger bounded repair attempts. Existing failures stay visible without automatic unrelated repairs; missing or ambiguous results stay unclassified.
- **Durable run journal** — saves ordered model requests, tool calls, approval decisions, command outcomes, verification comparisons, compactions and checkpoints in IndexedDB. Review the timeline and export JSON from **Harness → Journal**. Offline replay reconstructs the recorded timeline without calling a model or executing tools.

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
         │ Local model server │  ← LLM inference (main agent + memory agent)
         └────────────────────┘
                   │ HTTP
         ┌─────────┴──────────┐
         │ Companion (:8765)  │  ← Shell, search, browser
         │ Python server      │
         └────────────────────┘
```

**Zero backend of its own** — SlopLobster is a pure frontend app. Model inference is handled by your chosen local server; the companion provides shell, search, and browser tools.

---

## Quick Start

### 1. Start a local model server

Choose a backend in Settings. Presets are available for LM Studio, llama.cpp, vLLM, LocalAI, Jan, GPT4All, and text-generation-webui. Select **Other OpenAI-compatible local server** for another server that provides `/v1/models` and `/v1/chat/completions`. Enter its local base URL; `/v1` can be included or omitted. Servers that require authentication can use the Model API key field.

Load a model that supports tool/function calling (recommended): Qwen 3.5 or Gemma 4.
The selected server must expose streaming chat completions and tool calling for SlopLobster's agent tools; support varies by server and model.

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

Open `SlopLobster.html` in **Chrome** or **Edge** (required for the File System Access API). That's it — no build step, no `npm install`, no server to start.

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
| Backend | LM Studio | Choose LM Studio, llama.cpp, vLLM, LocalAI, Jan, GPT4All, text-generation-webui, or another local OpenAI-compatible server |
| Model API URL | `http://localhost:1234` | Local server base URL; the default changes with the selected backend |
| Model API key | (blank) | Optional local-server authentication; kept in this browser tab's session storage |
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
- All endpoints require a per-launch bearer token. Paste the token printed by the companion into Settings > Companion session token. The frontend retains it in this browser tab only.
- Host and Origin validation restrict requests to the paired local UI. For an HTTP-hosted UI, set `SLOPLOBSTER_ORIGINS` to its exact origin; the default `null` origin supports the local HTML file.
- Server-side capabilities are controlled with `SLOPLOBSTER_CAPABILITIES`, a comma-separated subset of `command,browser,mcp,dev`. An empty value disables these capabilities. Authenticated status, search, fetch, and AST extraction remain available.
- `SLOPLOBSTER_TOKEN` can supply a stable token for local automation; otherwise a fresh token is generated each launch.
- File operations are sandboxed by the browser's File System Access API (not the companion)
- SlopLobster validates all paths for traversal attacks before sending to the companion
- Dangerous shell commands, git pushes, and browser write actions confirm by default (see Settings → Dangerous Action Permissions)
- Secrets (API keys, tokens, JWTs, private keys) are pattern-redacted from tool output before it reaches the model or gets saved to history

---

## How It Works

### Tool Loop

SlopLobster uses the OpenAI-compatible tool/function calling API:

1. User sends a message
2. Message + system prompt + conversation history → the selected local model server
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
- Make sure the selected local server is running and has a model available
- Check that its `/v1/models` endpoint is reachable at the API URL in Settings
- Enter an API key if the server requires one, and allow browser CORS requests

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
- Interrupted real commands pause with an unknown outcome; they are never replayed through the virtual shell
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
| LLM | Local model server (OpenAI-compatible API) |
| Shell/Search | Python stdlib + Playwright |
| Storage | localStorage (conversations, settings) + workspace files (progress/memory) |

---


## Harness reliability (1.5.0)

The HTML and companion must be updated together. Start the companion, open Settings in the HTML, and paste its printed Companion session token. Restarting the companion generates a new token. The HTML download button produces the same script as the canonical Python file.

Independent file reads can run in parallel. Mutations and commands form ordered barriers, including edit approval and application. Shared reader/writer locks also coordinate worker tools. An edit and its test command in the same batch therefore execute in order. Unknown MCP tools and shell commands are treated conservatively as mutations.

Commands have stable IDs, bounded output, explicit exit codes, and cancellation. Resuming an interrupted task collects the existing job's status before another model turn. The companion retains jobs in memory (up to 64, evicting completed jobs when needed). Restarting it loses those records; inspect the workspace before deciding whether an unknown command should be repeated.

Compaction persists a task checkpoint containing the objective, user instructions, checklist, plan, and invariants separately from the generated summary. Failed or empty summaries pause the run and preserve the full conversation. Mutation arguments requiring JSON repair are rejected before execution. Pending file approvals reject stale previews, including initially empty and newly created files.

### Development and regression checks

Run `npm ci` once to install the pinned build dependency, edit the canonical sources, then run `node scripts/build.mjs`. The build compiles `src/tailwind.css` with `tailwind.config.cjs` into `vendor/tailwind.min.css`, scanning the HTML and JavaScript in `src/` for complete class names. Keep utility class names complete in source strings so they are included in the stylesheet. The app loads this static CSS locally; no Tailwind browser compiler runs. The distributable `SlopLobster.html` is generated entirely from `src/ui.html`, `src/app.js`, and the runtime modules in `src/`. Model requests live in `src/model-client.js`, strict SSE parsing in `src/model-stream.js`, orchestration in `src/agent-loop.js`, durable run accounting in `src/run-state.js`, shared backend policy in `src/backend-core.js`, and mutation receipts in `src/mutation-core.js` / `src/harness-services.js`. The companion remains canonical outside its generated features block, which comes from `src/companion-features.py` and `src/companion-services.py`. Do not edit generated HTML directly. The old `scripts/swarm-core.js` path forwards to the canonical `src/swarm-core.js` implementation. Users of the distribution do not need Node or a build step; distribute the generated HTML together with `vendor/`.

The embedded dev-server preview runs scripts in a sandbox with an opaque origin, preventing preview pages from accessing the SlopLobster document even if they load from the same URL origin. Origin storage, cookies, login flows and API requests that require the site's normal origin may not work inside the embedded preview. Use its **Open in browser** button for those features. Stopping or failing a preview unloads the frame.

```text
npm ci
node scripts/build.mjs
node scripts/check.mjs
node scripts/check.mjs --browser
node scripts/evaluate-harness.mjs --output harness-evaluation.json
node scripts/replay-journal.mjs exported-journal.json
```

The checks require Node 24 and Python 3.10 or later. Set `PYTHON` to select an interpreter. `--skip-python` runs just build and JavaScript checks; `--browser` additionally runs the Windows Chrome/Edge smoke test. CI runs build freshness and the complete JavaScript/Python suites on Windows and Linux, and browser smoke checks on Windows. The tests use scripted model responses and temporary workspaces, with no model download or LM Studio connection.

`evaluate-harness.mjs` exports per-scenario pass/fail results, verified rate and elapsed time for deterministic faults: compaction and reload at the run limit, interrupted streams containing valid-looking mutations, malformed or split SSE events, stalled models, cancellation, command reconciliation, stale approvals and conversation persistence. These are harness reliability measurements; they do not measure live-model quality or inference throughput. To compare local models, open Harness > Evaluations. The default benchmark is embedded from `tests/fixtures/coding-benchmark.json`. Its eight fixtures exercise narrow edits, coordinated changes, instruction scope, filenames with spaces, failing tests, empty inputs, decoy files and noisy diagnostics. The existing evaluation report measures verified completion, unintended writes, tokens and time. No model benchmark runs automatically.

Main-agent iteration counts, generated output tokens and active elapsed time are saved with the task. Compaction, Pause/Resume and reload preserve the allowance. A new submitted user task starts a new allowance; resuming an exhausted task requires raising its limit. Settings → General adds an optional active-time limit and a model inactivity timeout. Explicitly paused time is excluded. A reload during generation conservatively charges its saved output reservation and the uncertain elapsed time until recovery; raise the allowance after inspecting the task if necessary. Output allowances are reserved before requests, shared by concurrent workers, and capped by remaining context. Summaries, specialist passes and partial interrupted responses also consume output budget; token counts are labelled estimates when the model server omits usage. Queue token limits apply to each task across resumes and also respect the session cap.

The **Minimal / Low-Context** profile enables concise built-in instructions and a core coding toolset, including test execution. Specialist tools are loaded through `get_tool_schema`; disabled tools remain unavailable. Visible `think` calls can be disabled independently of the model's native reasoning. Custom system prompts are preserved. The context popup shows estimated schema and retrieved-context costs alongside instructions and conversation history. Interrupted or malformed model responses pause the task without executing partial calls; retry requires an explicit resume.

Reference sites are available on demand through `get_reference_sites(query, limit)`, which returns up to six matching links from the local catalogue without fetching their pages. In compact tool mode, load its schema with `get_tool_schema` first. The system prompt contains brief documentation guidance instead of the full catalogue. Saved prompts and presets automatically migrate `{{REFERENCE_SITES}}` to `{{REFERENCE_SECTION}}`, preserving the rest of the text. Unsupported prompt placeholders stop the request before anything is sent to the model and identify what to correct in Settings > System Prompt. Prompt substitutions run once over the template, so placeholder examples inside project memory remain literal data. The prompt cache uses the complete template and dynamic section values, including memory and invariants, to avoid stale instructions after edits of the same length.

### Baselines and run journals

Set **Settings → Tools → Auto-verify command** to enable baseline comparison. Before the first model turn, the harness runs that command in the active workspace (including an isolated worktree when selected). The baseline, scope and repair count survive compaction and resume. A changed command or workspace, interrupted baseline, unavailable companion or disabled `run_tests` tool prevents a confident comparison; the harness does not manufacture a new baseline after edits have begun. Dangerous command patterns retain their confirmation requirement.

Checks use explicit execution status and exit codes. An exception, timeout or unknown exit code cannot pass. For identifiable test output, the comparison distinguishes newly reported, still reported and no-longer-reported failure identities; equal failure counts alone are insufficient. A passing baseline followed by a failed check also triggers regression investigation. Existing failures and unclassified failures are reported without automatic repair instructions. Comparisons describe observed results, not proof that an edit caused a failure. Baseline success alone never counts as post-edit verification. Review both records in **Harness → Evidence**; full acceptance criteria still require their own evidence.

Run journaling is enabled by default and can be disabled under **Settings → General → Record run journal**. It uses dedicated IndexedDB stores, independent of the optional Evidence feature. Events commit before model requests, tool dispatch and accepted edits; failures to save pause new actions. A crash can leave a started operation without a completion event. **Harness → Journal** flags those operations for inspection and allows exporting the full event sequence. Command recovery still uses the existing stable command IDs; the journal never authorizes replaying an action. Deleting a conversation deletes its journals and events too.

Journal payloads contain redacted, bounded excerpts, request metadata and outcomes. They omit native reasoning and image data; full prompts are not recorded. Each detail is capped at roughly 24,000 characters, so an export is a diagnostic trace rather than a complete byte-for-byte recording. `node scripts/replay-journal.mjs exported-journal.json` reconstructs its timeline, unfinished operations and verification results offline. It performs no inference, shell commands or file edits. Keep the exported JSON when reporting a harness bug. If an older SlopLobster tab blocks the database upgrade, close it and reload this version.

## Harness features (1.6.0)

Open **Harness** in the top toolbar. Options persist in this browser; queue tasks, evidence, knowledge, recipes, and evaluation results persist in IndexedDB for the selected project.

| Feature | Default | How to use it |
| --- | --- | --- |
| Isolated tasks | Off | Set the absolute Git repository root in Options, then enable automatic isolation or create a task in Isolation. |
| Completion evidence | On | Review changed files, check results, screenshots, and unresolved checklist items in Evidence. |
| Project recipes | On | Discover suggested setup/build/lint/test/preview commands, review them, and save. Commands run only when requested and remain subject to approval. |
| Unattended queue | Off | Enable it, add prompts, acceptance criteria, iteration/token budgets, and explicitly mark independent tasks. |
| Session knowledge | On | Search prior project fixes and decisions, open their source conversations, and mark reviewed entries verified. |
| Automatic knowledge retrieval | Off | Enable to add matching project knowledge to new model turns. |
| Model evaluations | Manual | Select models, edit fixture tasks/settings, and run a benchmark explicitly. |

Restart the updated companion **1.6.0**, then enter its newly printed session token in Settings. Refresh the HTML page. The companion token belongs to the companion; the model server uses its own CORS and optional API key settings.

Isolated tasks use a generated branch and worktree under `.sloplobster/worktrees/`, with their own preview port. Files and shell commands route to that worktree. Worktrees start from committed HEAD; commit desired starting changes first. Review the diff before **Commit & merge**; a changed review or dirty original workspace blocks merging. **Discard** permanently removes the task worktree and branch after confirmation. This is Git isolation, not an operating-system sandbox: approved shell commands still have the user's normal access. MCP tools are omitted while an isolated task is active because their working directory cannot be guaranteed. Preview commands can use `{port}`; the server also sets `PORT`.

Evidence treats successful checks after the latest recorded file edit as verification of those checks. Agent claims alone do not verify completion. Explicit acceptance criteria remain unverified until reviewed. Screenshots are captured when the agent uses screenshot tools.

Recipe discovery never executes commands. Saved recipes are retained in browser storage and, when a project directory is open, in `.sloplobster/recipe.json`; they are loaded on future project sessions. Review discovered suggestions before running them.

The queue parks a task when it asks a question, stops on its budgets, and preserves its conversation for resumption. Later work proceeds only when marked independent or when preceding tasks have been reviewed as done. Existing command and edit approvals still apply; enabling the queue does not enable automatic approval. Answer a parked question or make a paused task ready, then start the queue again. Browser reloads convert interrupted running tasks to paused.

Knowledge entries include a source conversation and optional tool-call link. Entries saved by the model begin unverified. Automatic retrieval is optional and scoped to the project.

Evaluations use disposable text fixtures and a restricted file/check tool set. Each task defines `files`, `allowedWrites`, exact/substring file `assertions`, and optional predeclared shell `checks`. Shell checks require explicit confirmation before the benchmark starts; they run with normal user permissions. Variants specify a name, temperature, and maximum response tokens. Results compare verified completion rates, elapsed time, output/context tokens, unintended writes, and tool corrections. Tokens are labelled estimated when the server omits usage. Export JSON for comparisons. No live model benchmark runs automatically.

Conversation deletion removes its IndexedDB record, workspace JSON when a project is open, and browser cache entries. Deleted IDs are excluded from stale indexes and legacy imports, and pending saves are drained before removal. Workspace permission or database failures appear as an error instead of a successful deletion. Conversation storage for an isolated task uses its original project directory.

A companion connection banner appears below the toolbar when its token is missing, rejected, or the server cannot be reached. Paste the token printed in the companion terminal and choose **Connect companion**; Settings are not required for pairing. The banner clears after successful authentication, and the token is retained for the current browser tab session. A server restart requires its newly printed token.

Git review preserves whitespace in filenames and includes those files before merge. Queued tasks with missing conversations are blocked with an explanation. Shell commands invalidate earlier verification until checks run again. Feature data and the Git project path are now associated with the selected folder; configure its Git path in Harness Options when first pairing a folder. Basic runs with all optional harness features disabled do not require feature storage.

### Companion responsiveness and CPU use

Slow browser and embedding requests run in separate, reusable worker processes. Status checks and shell cancellation stay available while they run. Browser JavaScript evaluation has a 15-second hard limit, other browser operations normally have 45 seconds (selector waits up to 65), and embeddings have 120 seconds. A hard timeout stops the worker and its child processes; the error asks you to retry explicitly. Closing the browser also stops a stuck browser worker.

The embedding model is cached between batches. CPU inference defaults to two threads; set `SLOPLOBSTER_EMBED_THREADS` before launching the companion to select 1–4 threads. Unchanged MCP configurations reuse their running server, stderr is continuously drained, and failed startup or timed-out communication stops the process tree. Shell output and preview logs are bounded even when a process never prints a newline; excess shell output is discarded with backpressure. Shutdown waits for active shell commands to cancel.

After updating, stop and restart the companion and reload `SlopLobster.html`. If you use the companion downloaded from the GUI, download the updated copy first. A fresh session token appears on restart unless you explicitly configured `SLOPLOBSTER_TOKEN`.


### Backend compatibility, completion and recovery

All model passes, including planning, summaries, subagents, workers and evaluations, use a shared streaming client. Local server base URLs accept an optional trailing `/v1`. LM Studio and llama.cpp retain their native sampler fields; other servers receive portable OpenAI-compatible sampler fields. The **Use server sampling** option applies to every ordinary model pass. Evaluation variants explicitly supply their selected settings.

**Settings > General > Check model capabilities** manually checks streaming, tool calling and usage reporting on the selected model. It allows up to 128 output tokens and never executes the returned tool call. Capability observations are saved per server, backend and model. LM Studio is never sent `/v1/tokenize`; exact tokenization is attempted only on llama.cpp's `/tokenize` route. Other servers use reported usage or labelled estimates.

Explicit HTTP 408, 429 and transient server errors receive at most two retries with bounded delays. Authentication errors, dropped connections and interrupted streams are not automatically replayed. Context overflow permits one compaction attempt; truncated tool arguments permit two retries with smaller-edit guidance. Incomplete tool calls never execute, and recovery attempts count toward the existing run allowance and survive reload.

Completion has four outcomes: **verified**, **completed**, **completed with verification outstanding**, and **blocked**. Verification requires a successful recorded check after the latest relevant changes. Configured regression failures and unresolved operations block completion. Unfinished checklist items and acceptance criteria require review. Verification snapshots include hashes of files changed through the harness; external changes to those files invalidate earlier checks. This does not monitor every file in the repository or prove every acceptance criterion.

Native file writes, deletes and moves persist a prepared receipt before changing bytes, then verify the resulting hashes. Resume inspects those receipts and restores missing results without repeating operations. Edits reject changes since a tool read or approval; moves preserve binary bytes and reject existing destinations. Native browser file access cannot provide an atomic transaction against an unrelated external editor, so uncertain outcomes remain blocked. Managed worktree writes also retain the companion's hash comparison.

For uncertain outcomes, open **Harness > Journal**. **Recheck file outcomes** observes the files again. After inspecting the affected files, **Accept current files** records your decision and clears the block without repeating or undoing the operation. New verification is required. Deleting a conversation removes its output artifacts and settled receipts; unresolved receipts remain available for workspace recovery.

Long outputs and errors are saved as redacted artifacts in IndexedDB. Tool results expose their artifact IDs, and the `read_artifact` tool retrieves bounded sections. Compaction keeps task state, recovery counters, pending operations and artifact references separately from its summary, selects error lines as well as recent context, and saves the prior transcript. Artifact content is capped at 4,194,304 characters with explicit truncation metadata. Large artifact bodies use a separate database store so command and mutation recovery do not load them. Older unreferenced outputs are pruned above 128 per conversation; referenced outputs are retained. Storage failures pause new work and preserve the current result in memory.

Loop detection compares complete normalized arguments, output fingerprints and observed workspace progress. Changing diagnostics or actual file changes count as progress; varying timestamps alone do not. Subagents and workers use result fingerprints in their round budgets too.

Evaluation results include backend metadata, retry counts and failure categories. The table and JSON export include tokens spent per verified task, including tokens spent on failures, plus corrections and elapsed time. Evaluations use their own output allowance and the same transport/parser as normal runs. The deterministic fault report covers lost mutation receipts, partial moves, stale reads, artifact recovery and completion decisions. These checks use scripted model replies; live local-model quality comparisons remain manual.


### Review fixes: commands, plans and UI

Update both `SlopLobster.html` and `SlopLobster-companion.py`, restart the companion, and pair its new session token. The HTML checks for the companion's structured-argument and workspace-verification capabilities before connecting.

Commands, test commands and dev-server commands honor shell approval settings. Automatic Python syntax checks and `git_add` use argument arrays instead of interpolating paths into shell code. `git_add.paths` accepts one literal path (including spaces), an array of paths, or `"."` for all changes.

Before a command runs in a normal folder, the browser creates a temporary random challenge file and the companion verifies it in the proposed directory. The challenge file is then removed. The companion launch directory works automatically when it matches the selected folder. If it differs, set the selected folder's absolute path in **Harness > Options > Workspace path on the companion computer**. This path is saved per folder; Git isolation still requires a Git repository root. A mismatch blocks execution. Isolated tasks continue using their own task directories.

Virtual `touch` preserves existing files and requests edit approval when creating a new file. Plan execution advances only after a completed run; paused, blocked and failed steps remain resumable. Entirely unavailable tool batches receive error results for each call. Completed command receipts retain their output until the conversation is durably saved, including recovery after the companion restarts. Toast messages display plain text, and file-tree actions use event handlers that preserve filenames containing quotes.
