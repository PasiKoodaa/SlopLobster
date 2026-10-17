
    try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; } catch(e) { console.warn('[pdf] worker init failed:', e); }
    const COMPANION_SCRIPT = ""; // Embedded by scripts/build.mjs.

    /** Strip <think>...</think> and <|channel>thought...<channel|> from model output */
    function stripThinkingBlocks(text) {
      if (!text) return '';
      text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
      text = text.replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '');
      // Handle unclosed thinking blocks (truncation)
      text = text.replace(/<\|channel>thought[\s\S]*$/g, '');
      return text.trim();
    }

    /**
     * Strip leaked chat-template / tool-call control tokens from content that is
     * about to be written to a FILE ON DISK (as opposed to the chat bubble, which
     * stripThinkingBlocks already covers).
     *
     * Why this happens: JSON-schema / grammar-constrained decoding (used for tool
     * calls) only constrains the STRUCTURE of the arguments — it does not limit
     * which characters a model puts inside a string value. A model that isn't
     * cleanly trained on this backend's tool-call format can keep generating past
     * the real content and start hallucinating a completely different pseudo
     * function-call syntax (e.g. Hermes/NousResearch-style "<tool_call><function=
     * write_file><parameter=path>...") or stray "<thinking>"/ChatML/Harmony
     * control tokens — all as perfectly valid characters inside the JSON string.
     * That garbage then lands verbatim in the file unless we cut it off here.
     *
     * Only trims a trailing tail once a leak marker is found partway through the
     * content — never touches content with no such marker, and never nukes the
     * whole string if the marker appears at/near position 0 (that's more likely
     * to be intentional content than a leak).
     */
    function stripLeakedModelArtifacts(content) {
      if (!content || typeof content !== 'string') return { text: content, stripped: false };
      const LEAK_PATTERNS = [
        /<tool_call>[\s\S]*$/i,
        /<\|tool_call\|>[\s\S]*$/i,
        /<function=[\s\S]*$/i,
        /<parameter=[\s\S]*$/i,
        /<\|channel>[\s\S]*$/i,
        /<\/?thinking>[\s\S]*$/i,
        /<\|im_start\|>[\s\S]*$/,
        /<\|im_end\|>[\s\S]*$/,
        /<\|eot_id\|>[\s\S]*$/,
        /<\|end_of_text\|>[\s\S]*$/,
        /<\|endoftext\|>[\s\S]*$/,
      ];
      let cutAt = -1;
      for (const p of LEAK_PATTERNS) {
        const m = content.match(p);
        if (m && m.index > 20 && (cutAt === -1 || m.index < cutAt)) cutAt = m.index;
      }
      if (cutAt === -1) return { text: content, stripped: false };
      return { text: content.slice(0, cutAt).replace(/\s+$/, '\n'), stripped: true, leaked: content.slice(cutAt, cutAt + 200) };
    }

    /* ═══════════════ TEMPLATES ═══════════════ */
    function esc(s) { if (!s) return ''; return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

    /* ═══════════════ SECRET REDACTION ═══════════════
       Applied to every tool result before it enters the model's context (and
       therefore before it's saved in conversation history). Pattern-based, not
       exhaustive — this catches common high-confidence secret shapes so an
       accidental `read_file .env` or an echoed API key doesn't get silently
       forwarded to the model and persisted in chat history. */
    const SECRET_PATTERNS = [
      // Cloud provider keys with recognizable prefixes
      { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS access key' },
      { re: /\bASIA[0-9A-Z]{16}\b/g, label: 'AWS temp access key' },
      { re: /\bsk-[A-Za-z0-9]{20,}\b/g, label: 'API secret key' },
      { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, label: 'Anthropic API key' },
      { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: 'Google API key' },
      { re: /\bghp_[A-Za-z0-9]{36}\b/g, label: 'GitHub token' },
      { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, label: 'GitHub fine-grained token' },
      { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'Slack token' },
      { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: 'JWT' },
      { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, label: 'private key block' },
      // Generic KEY=value / "key": "value" pairs where the key name looks secret-ish
      { re: /((?:api|secret|access|private|client)[-_]?(?:key|token|secret)|password|passwd|pwd)\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{12,})["']?/gi,
        label: 'credential assignment', group: 2 },
      { re: /Authorization:\s*Bearer\s+([A-Za-z0-9_\-.]{15,})/gi, label: 'bearer token', group: 1 }
    ];

    function redactSecrets(text) {
      if (!text || typeof text !== 'string') return text;
      let out = text;
      for (const p of SECRET_PATTERNS) {
        out = out.replace(p.re, (match, ...groups) => {
          if (p.group) {
            const secret = groups[p.group - 1];
            if (!secret) return match;
            return match.replace(secret, `[REDACTED ${p.label}]`);
          }
          return `[REDACTED ${p.label}]`;
        });
      }
      return out;
    }


    const TEMPLATES = [
      { id: 'analyze', label: 'Analyze Codebase', icon: 'fa-magnifying-glass-chart', prompt: 'Analyze this codebase. Use list_directory first to understand structure, then read key files. Explain architecture, dependencies, and entry points.', color: 'var(--cyan)' },
      { id: 'fix', label: 'Find & Fix Bugs', icon: 'fa-bug', prompt: 'Find and fix bugs in this project. Run tests, check for errors, and apply targeted fixes using edit_file.', color: 'var(--red)' },
      { id: 'refactor', label: 'Refactor Code', icon: 'fa-arrows-rotate', prompt: 'Refactor the selected code for better structure, readability, and maintainability. Preserve all functionality and run tests after changes.', color: 'var(--teal)' },
      { id: 'test', label: 'Write Tests', icon: 'fa-flask-vial', prompt: 'Write comprehensive tests for this code. Cover edge cases and error conditions. Use the project\'s existing test framework.', color: 'var(--green)' },
      { id: 'docs', label: 'Generate Docs', icon: 'fa-book', prompt: 'Generate documentation for this codebase. Include README updates, inline comments for complex logic, and API documentation where applicable.', color: 'var(--accent)' },
      { id: 'explain', label: 'Explain Code', icon: 'fa-lightbulb', prompt: 'Explain this code step by step. What does it do? How does it work? What are the key design decisions and potential issues?', color: 'var(--yellow)' },
    ];

    /* ═══════════════ STATE ═══════════════ */
    const modifiedFiles = new Set();
    const newFiles = new Set(); // tracks files created this session (yellow in tree)
    const allModified = new Set(); // accumulates across the session
    const state = {
      apiUrl: 'http://localhost:1234', compUrl: 'http://127.0.0.1:8765',
      backendType: 'lmstudio', // 'lmstudio' | 'llamacpp'
      isGitRepo: false,
      modelInfoMap: new Map(), // modelId -> {vision, contextLength, displayName, trainedForToolUse, architecture, paramsString}
      model: null, connected: false, compConnected: false, compInfo: null, compFailStreak: 0,
      sysPromptProfiles: {},
      safetyProfiles: {},
      messages: [], running: false, abortCtrl: null,
      dirHandle: null, dirName: '', fileTree: [],
      temp: 0.3, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, enforceJsonSchema: true,
      /* ── Server-side sampling toggle: when true, temp/top_p/top_k/min_p/
         repeat_penalty/presence_penalty are omitted from the request entirely
         so whatever LM Studio's loaded config or llama.cpp's startup flags
         set is what actually gets used, instead of the harness always
         overriding them. ── */
      useServerSampling: false,
      frequencyPenalty: 0,        // 0 = omit
      seed: -1,                   // -1 = omit (random)
      dryMultiplier: 0,           // 0 = disabled
      dryBase: 1.75,
      dryAllowedLength: 2,
      drySequenceBreakers: '["\\n", ":", "\\"", "*"]',
      xtcProbability: 0,          // 0 = disabled
      xtcThreshold: 0.1,
      mirostat: 0,                // 0 = off, 1 = v1, 2 = v2
      mirostatTau: 5.0,
      mirostatEta: 0.1,
      maxTokens: 60000, maxReadKB: 500, cmdTimeout: 60, ctxWindow: 62768,
      autoCompactPct: 85, maxIters: 50,
      journalEnabled: true,
      maxRunMinutes: 0, streamIdleSeconds: 120, compactTools: false, compactPrompt: false, discoveredTools: new Set(),
      /* ── Memory agent: the dedicated compaction pass. Toggle-able (matches
         Claude Code's "disable auto-compact"); optional absolute token
         threshold as an alternative/additional trigger to the percentage
         above; optional model override so compaction can use a cheaper model
         than the one doing the actual task. ── */
      memoryAgentEnabled: true,
      compactTokenThreshold: 0,
      memoryAgentModel: '',
      verifyWrites: true,
      /* ── Model load settings ── */
      requireEditApproval: true,
      /* ── Dangerous-action permissions: default is to always ask.
         shellAutoApprove only skips confirmation for commands NOT matched by
         the DANGEROUS pattern list below — those always confirm regardless. ── */
      shellAutoApprove: false,
      shellAutoApproveDangerous: false,
      gitWriteAutoApprove: false,
      browserWriteAutoApprove: false,
      /* ── Per-tool opt-out, so unused tool schemas don't eat context budget.
         Names in this Set are hidden from getToolDefs() entirely. ── */
      disabledTools: new Set(),
      /* ── Visible plan checklist, set via the update_plan tool ── */
      planItems: [],
      /* ── Competing hypotheses with confidence, set via update_beliefs — for
         exploratory/diagnostic work where the right approach isn't known yet.
         Rendered in the same panel as planItems; a task can have either, both
         (hypotheses first, then the concrete plan once one is confirmed), or
         neither. ── */
      beliefs: [],
      beliefNextAction: '',
      /* ── Cross-session project memory text, loaded from .sloplobster-memory.md
         when a workspace is opened; injected into every conversation's system
         prompt via {{PROJECT_MEMORY_SECTION}}. ── */
      projectMemoryText: '',
      clarifyMode: false,
      clarifyCount: 3,
      /* ── Whether the agent may use ask_user to pause mid-task. Default true;
         users doing fully unattended runs (long solo tasks, swarms) can turn
         this off so the agent always proceeds on its own judgment instead. ── */
      allowAskUser: true,
      /* ── Set by the Pause button; agentLoop checks this between iterations
         only (not mid-stream), so nothing is cut off. ── */
      pauseRequested: false,
      compToken: '',
      taskState: null,
      /* ── Messages typed by the user WHILE the agent is running. Drained into
         state.messages at the next safe boundary (same checkpoint as pause),
         so the agent picks them up in its very next turn without the loop
         being stopped or restarted. ── */
      pendingSteerMessages: [],
      /* ── Desktop notifications for events while the tab isn't focused: agent
         finished, a confirm dialog or ask_user is waiting, a hard-stop/budget
         limit was hit, companion disconnected mid-task. Off by default since
         requesting Notification permission is intrusive — opt-in only. ── */
      notificationsEnabled: false,
      /* ── Experimental Thinking Mode: bundles several reasoning strategies
         beyond update_beliefs — invariant tracking, premortem notes on risky
         actions, and reflexion (explicit self-critique) after test failures.
         Off by default: adds real overhead per turn, worth it mainly for
         gnarly/high-stakes tasks, not routine ones. ── */
      experimentalMode: false,
      invariants: [],
      autoVerifyCommand: '',
      /* ── Session token budget guard: 0 = unlimited. Checked against
         _sessionTotalOut (cumulative output tokens across this browser session,
         not persisted). Mainly a guardrail for runaway sub-agent/swarm runs. ── */
      tokenBudget: 0,
      autoVerifyMaxRetries: 3,
      _autoVerifyRetries: 0,
      planMode: false,
      currentPlan: null,
      planExecuting: false,
      planStepIndex: -1,
      smartContextThreshold: 0,
      checkpoints: [],
      checkpointEnabled: true,
      modelCtxOverride: 0,       // 0 = use model default
      modelFlashAttn: true,
      modelKvOffload: true,
      modelNumExperts: 0,        // 0 = use model default
      modelEvalBatch: 0,         // 0 = use model default
      // When true, requestModelLoad() sends only {model, echo_load_config}
      // and omits context_length/flash_attention/offload_kv_cache_to_gpu/
      // num_experts/eval_batch_size entirely, so LM Studio applies whatever
      // per-model preset or last-used load config it already has instead of
      // the harness's own defaults/overrides above.
      useModelLoadDefaults: false,
      autoScroll: true,
      conversations: [], activeConvId: null,
      fileCache: new Map(),
      fileBackups: new Map(),
      visionCapable: false,
      llamacppVision: false, // manually set or probed for llama.cpp
      pendingImages: [],   // [{dataUrl, name, size}]
      originalTask: null,
      projectType: null, projectMeta: null,
      browserAvailable: false,
      convSearchQuery: '',
      devServer: null,  // { port, command, pollInterval, ready }
      _realConvTokens: 0,
      mcpTools: [],
      mcpConfig: '',
      mcpConfigProfiles: {},   // named saved configs: { name: jsonString }
      mcpConfigHistory: []     // recent configs used: [{ ts, config }], most recent first
    };

    /* ═══════════════ INDEXEDDB PERSISTENCE ENGINE ═══════════════ */
    const DB_NAME = 'SlopLobster_DB';
    const DB_VERSION = 2;
    let _dbInstance = null;
    let _dbOpening = null;

    function getDB() {
      if (_dbInstance) return Promise.resolve(_dbInstance);
      if (_dbOpening) return _dbOpening;
      const opening = new Promise((resolve) => {
        if (!window.indexedDB) {
          console.warn('[DB] IndexedDB not available, falling back to localStorage');
          resolve(null);
          return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('conversations')) {
            db.createObjectStore('conversations', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('agent_states')) {
            db.createObjectStore('agent_states', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains('run_journals')) {
            const runs = db.createObjectStore('run_journals', { keyPath: 'id' });
            runs.createIndex('convId', 'convId');
          }
          if (!db.objectStoreNames.contains('run_events')) {
            const events = db.createObjectStore('run_events', { keyPath: 'id' });
            events.createIndex('runId', 'runId');
          }
        };
        req.onsuccess = e => {
          const connection = e.target.result;
          _dbInstance = connection;
          connection.onversionchange = () => { connection.close(); if (_dbInstance === connection) _dbInstance = null; };
          resolve(_dbInstance);
        };
        req.onerror = e => {
          console.error('[DB] Failed to open IndexedDB:', e.target.error);
          resolve(null);
        };
        req.onblocked = () => {
          console.warn('[DB] Close older SlopLobster tabs and reload to finish the database upgrade.');
          resolve(null);
        };
      });
      _dbOpening = opening;
      opening.then(() => { if (_dbOpening === opening) _dbOpening = null; });
      return opening;
    }

    async function dbGet(storeName, key) {
      const db = await getDB();
      if (!db) return null;
      return new Promise(resolve => {
        try {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (_) { resolve(null); }
      });
    }

    async function dbSet(storeName, value) {
      const db = await getDB();
      if (!db) return false;
      return new Promise(resolve => {
        try {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          const req = store.put(value);
          tx.oncomplete = () => resolve(true);
          tx.onabort = tx.onerror = () => resolve(false);
          req.onerror = (e) => {
            console.warn('[DB] dbSet error:', e.target?.error);
            resolve(false);
          };
        } catch (_) { resolve(false); }
      });
    }

    async function dbDelete(storeName, key) {
      const db = await getDB();
      if (!db) return false;
      return new Promise(resolve => {
        try {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          const req = store.delete(key);
          tx.oncomplete = () => resolve(true);
          tx.onabort = tx.onerror = req.onerror = () => resolve(false);
        } catch (_) { resolve(false); }
      });
    }

    async function dbGetAll(storeName) {
      const db = await getDB();
      if (!db) return [];
      return new Promise(resolve => {
        try {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        } catch (_) { resolve([]); }
      });
    }

    async function saveActiveAgentState() {
      if (!state.activeConvId) return;
      const snapshot = {
        id: 'active_session',
        convId: state.activeConvId,
        running: state.running,
        originalTask: state.originalTask,
        planMode: state.planMode,
        currentPlan: state.currentPlan,
        planExecuting: state.planExecuting,
        planStepIndex: state.planStepIndex,
        run: state.runController?.snapshot(),
        verification: state.verificationState || null,
        sessionOutput: _sessionTotalOut,
        timestamp: Date.now()
      };
      await dbSet('agent_states', snapshot);
      const checkpoint = { run: snapshot.run, verification: snapshot.verification, planStepIndex: snapshot.planStepIndex };
      // Timestamp-only saves do not need another identical checkpoint event.
      const stableSignature = JSON.stringify({ ...checkpoint, run: snapshot.run && { ...snapshot.run, savedAt: 0, elapsedMs: 0 } });
      if (state.runCheckpointSignature !== stableSignature && state.runController) {
        await recordRunEvent('run.checkpoint', checkpoint);
        state.runCheckpointSignature = stableSignature;
      }
    }

    async function clearActiveAgentState() {
      await dbDelete('agent_states', 'active_session');
    }

    const LIMITS = {
      MAX_SVG_SIZE: 5 * 1024 * 1024,
      MAX_IMAGE_SIZE: 10 * 1024 * 1024,
      MAX_PDF_SIZE: 100 * 1024 * 1024,
      MAX_TEXT_SIZE: 5 * 1024 * 1024,
      DIR_LIST_DEPTH: 8,
      SEARCH_DEPTH: 6,
      EMBEDDING_DEPTH: 5,
      MAX_SUMMARY_TEXT: 100000,
    };

    const inputHistory = [];
    let _prevHtmlPreviewUrl = null;
    let inputHistoryIdx = -1;
    let inputDraft = '';
    const toolCallHistory = [];
    let fileTreeRefreshTimer = null;
    function debouncedFileTreeRefresh() {
      clearTimeout(fileTreeRefreshTimer);
      fileTreeRefreshTimer = setTimeout(() => {
        refreshFileTree();
        // Per-file embedding updates are handled by debouncedEmbedUpdate
      }, 300);
    }
    const DEFAULT_SYS = `You are SlopLobster, a local AI coding agent with direct filesystem access, shell execution, web search, and optional image understanding.

═══ CURRENT DATE ═══
Today is {{CURRENT_DATE}}. Use this for all time references.

{{WORKSPACE_AWARENESS}}

{{PROJECT_MEMORY_SECTION}}

═══ CAPABILITY CHECKLIST ═══

Read this section to know what is available RIGHT NOW:

{{CAPABILITY_CHECKLIST}}
{{CAPABILITY_NOTE}}

═══ IMAGE UNDERSTANDING ═══

{{VISION_SECTION}}

═══ FILE MODIFICATIONS ═══

**File writing rules:**
- **edit_file** — for modifying existing files. Preferred. Put \`"path"\` first. Keep each \`old_text\` ≤ 20 lines.
- **write_file** — for NEW files only. Put \`"path"\` first. Use only if content is ≤ 100 lines.
- **write_file_chunked** — for NEW files > 100 lines. CRITICAL: keep each chunk ≤ 60 lines — the entire chunks array must fit in the token budget together, so many small chunks are always safer than a few large ones. Example:
  write_file_chunked({"path": "src/app.js", "chunks": ["lines 1-60...", "lines 61-120...", "lines 121-180..."]})
  If a write is truncated mid-chunks, the tool writes what it received and tells you how to continue with \`"append": true\`.

**Size heuristic:** If you estimate a file will be > 100 lines, always use \`write_file_chunked\` with ≤ 60-line chunks.

edit_file uses search/replace blocks. Rules:
- **Always put \`"path"\` as the first key** in the JSON object — before \`"edits"\`. If \`path\` comes after the edits array and the JSON is truncated, the path is lost and the call fails.
- The old_text MUST be a substring of the file. It is matched using four tiers in order: (1) exact, (2) CRLF + trailing-whitespace normalised, (3) indent-flexible (leading whitespace stripped and re-applied), (4) fuzzy best-window similarity score ≥ 0.88
- If the fuzzy score is between 0.45 and 0.88, the error message will show you the closest matching block in the file — copy it as your new old_text and retry
- If all tiers fail, use read_file or grep to find the exact current text, then retry
- old_text must be unique in the file — include enough surrounding context (3-5 lines) to guarantee uniqueness
- Keep each old_text under 20 lines — split large edits into multiple edit_file calls
- Multiple edits can be submitted in one call — they apply sequentially
- After applying edits, a diff is shown to you for review — check it is correct
- If a diff looks wrong, fix it with another edit_file call immediately

═══ FILE READING STRATEGY ═══

{{SMART_CONTEXT_SECTION}}

DO NOT read entire files unless the file is small (<100 lines) or you genuinely need all of it.

- Image files (marked [IMAGE] in list_directory) — read them with read_file, NOT read_file_lines. You will see the actual image visually.
- Use read_file_lines with start_line and end_line to read specific sections
- Use grep to find where something is defined before reading around it
- Use list_directory and search_files to understand structure before reading anything
- When you first open a project, start with list_directory (recursive) then read key config/entry files only
- If you read a file and it's truncated, switch to read_file_lines for the section you need


═══ SHELL EXECUTION ═══

{{SHELL_SECTION}}

═══ WEB SEARCH ═══

Use the search tool when your local knowledge is insufficient or a library's version has outpaced your training data.

1. The "LLM-First" Strategy
- Before deep-diving into HTML documentation, always check if the site supports AI-native protocols.
- Step 1: Search for the library/tool documentation.
- Step 2: Check for [domain]/llms.txt or [domain]/llms-full.txt. These are markdown-optimized versions of the docs that reduce token waste and hallucination.
- Step 3: Use fetch_url on the .txt version first. Only fallback to standard HTML if these are missing.

2. Search Query Patterns
- Don't just search for names; search for intent.
- Library Updates: [library name] changelog 2025 2026
- Fixing Errors: "[error message]" site:stackoverflow.com OR site:github.com
- Comparison: [library A] vs [library B] 2026 reddit (Good for finding "real world" sentiment on bugs).
- Implementation: [feature] [framework] example llms.txt

3. Reference Site Filtering
- When searching, you can focus on your reference sites (listed below) by appending site:[url] to your queries.
- Example: useActionState site:react.dev

4. Handling "Slop" & Noise
- Avoid SEO Spam: If a result looks like a generic "Top 10" listicle with AI-generated text, skip it.
- Date Check: Technology moves fast. Documentation or tutorials older than 18 months should be treated as "Legacy" unless no other info exists.
- The GitHub Source: If official docs are vague, search for the source code on GitHub. Reading the README.md or the tests/ folder is often faster than parsing broken documentation.

5. Verification Loop
After finding a solution online:
- Cross-reference: Check if the solution is compatible with the current project's package.json or requirements.txt.
- Verify: Don't just copy. Search for the specific function names in your reference sites to ensure the API signature hasn't changed.


{{REFERENCE_SECTION}}

═══ GIT OPERATIONS ═══

{{GIT_SECTION}}

═══ WORKFLOW ═══

1. THINK before acting — use the think tool to plan complex or multi-step tasks
2. READ before edit — never modify code you haven't seen
3. EDIT with precision — use edit_file with exact search/replace blocks
4. VERIFY after edit — check the diff that appears, run tests, read back changed sections
5. ITERATE on failure — if something breaks, read the error, think about the cause, fix it

Common error recovery patterns:
- "module not found" → install the package, or check the import path
- "syntax error" → read the exact lines around the error, fix the specific issue
- "test failed" → read the test output carefully, it tells you exactly what's wrong
- "permission denied" → try without sudo first, check file ownership
- "command not found" → check if the tool is installed, try alternative commands

═══ CONTEXT MANAGEMENT ═══

{{CONTEXT_SECTION}}

═══ PARALLEL EXECUTION ═══

You can call multiple tools in a single turn — they execute in parallel. Use this when:
- Reading multiple independent files
- Running independent searches
- Any tools that don't depend on each other's results

Do NOT parallelize when:
- The second tool depends on the first tool's output
- Editing the same file from multiple calls (they'd conflict)

═══ AGENT DELEGATION ═══

**spawn_sub_agent** — for a focused, self-contained sub-task. The sub-agent works alone and returns a summary. Use for: reading many files to build context, searching a codebase, or making a contained set of edits.

**spawn_swarm** — for complex tasks that need multiple specialists who share information. Workers run in listed order (or as a dependency graph via \`depends_on\`) and use a shared memory store to pass structured data to each other (API endpoints, schemas, decisions). Use for:
- Full-stack features (backend worker writes API shape → frontend worker reads it to write the fetch call)
- Parallel investigation across domains (auth, DB, UI, tests) that must stay consistent
- Any task where agent B needs to know what agent A decided

When spawning a swarm, design roles at the start: think about who needs to write what and who needs to read it. Use \`writes_to\` and \`reads_from\` to make the data flow explicit, \`depends_on\` for ordering, and \`owns\` globs so workers never write the same files. State what done means with \`contract.acceptance_criteria\` (an independent verifier checks each with evidence; failures send only the owning worker back) and bound the run with \`contract.token_budget\` / \`deadline_minutes\`. Shared memory entries are hypotheses unless a worker marks them verified with evidence. Add a worker with \`kind: "critic"\` and \`reviews: "<author>"\` to have an evidence-based adversarial review (use a different \`model\` for it if possible), and \`check_command\` so a worker must pass its own tests before it counts as done. A worker that fails blocks its dependents unless you set \`on_failure\`; a swarm is only reported as verified if you pass \`verify_command\` and it passes.

═══ BROWSER AUTOMATION ═══

{{BROWSER_SECTION}}


═══ SECURITY BOUNDARIES ═══

- All file operations are sandboxed to the working directory — path traversal (../) is blocked
- Dangerous shell commands (rm -rf /, dd, mkfs, etc.) require user confirmation
- The companion server is localhost-only

═══ WORKSPACE ═══

Working directory: {{WORKING_DIR}} — you are already inside this directory. Use relative paths directly (e.g. "src/main.py", NOT "{{WORKING_DIR}}/src/main.py"). Do NOT prefix paths with the directory name.
Project info: {{PROJECT_INFO}}
Python command: {{PYTHON_CMD}}{{ENV_DETAILS}} — this is DETECTED from the actual environment, not a guess. Trust it over training-data assumptions or defaults from a different machine. Do not re-verify it by trial and error.

═══ DON'T LOSE WHAT YOU LEARN ═══

Long tasks get compacted, and compaction summaries are lossy — a one-line environment fix ("use X not Y here") competes for space against the whole task history and can be the thing that gets dropped. The moment you discover something like that — not at the end of the task, right when it happens — call save_memory. It writes to a file that's shown to you at the start of every future conversation in this workspace, completely bypassing compaction. Good candidates: a command/tool that only works one specific way here, a project convention, a user preference stated once. Bad candidates: routine task progress (that's handled automatically) or anything secret.

═══ REASONING UNDER UNCERTAINTY ═══

Two tools track your progress visibly, for two different situations — pick based on whether you actually know the right approach yet, not by default habit:

- **update_plan**: the shape of the work is already known — "add these 3 files, refactor these functions". A fixed, ordered checklist.
- **update_beliefs**: you DON'T yet know what's true or what the right approach is — debugging ("why is this failing"), root-cause analysis, an architecture choice with real trade-offs. Track 2-4 competing hypotheses with a rough confidence each. Before acting, choose the action that best discriminates between your leading hypotheses — the one whose result would most change your confidence — rather than just the next thing that seems useful. After every observation, update confidences explicitly. Move a hypothesis to "ruled_out" when evidence contradicts it, but keep it in the list rather than deleting it — reviving a demoted hypothesis when a "confirmed" one turns out wrong should be cheap, not a restart.

Don't force a checklist onto something you're not actually sure about yet — a fake fixed plan you have to awkwardly revise is exactly the friction update_beliefs exists to avoid. Once a hypothesis is confirmed and you know the concrete steps to act on it, switch to update_plan for execution — update_beliefs is for figuring out what's true, update_plan is for doing something about it. Both can be active at once: the natural lifecycle for diagnostic work is hypotheses first, then a plan once one is confirmed.

{{INVARIANTS_SECTION}}{{EXPERIMENTAL_SECTION}}`;

    /* ═══════════════ PATH SANITIZATION ═══════════════ */
    function sanitizePath(raw) {
      if (!raw || typeof raw !== 'string') throw new Error('Path must be a non-empty string');
      let c = raw.replace(/\0/g, ''); try { c = decodeURIComponent(c); } catch { }
      c = c.replace(/\\/g, '/').replace(/^[\s/]+|[\s/]+$/g, '');
      if (!c) throw new Error('Path resolves to empty');
      const segs = c.split('/').filter(Boolean), out = [];
      for (const s of segs) {
        if (s === '.') continue;
        if (s === '..' || /^\.\.[/\\]/.test(s) || /[/\\]\.\.$/.test(s)) throw new Error(`Path traversal blocked: ".." segment detected`);
        if (/^\.{3,}$/.test(s)) throw new Error(`Path traversal blocked: "${s}" segment`);
        out.push(s);
      }
      if (!out.length) throw new Error('Path resolves to empty');
      return out;
    }

    /* ═══════════════ REFERENCE SITES ═══════════════ */
    const REFERENCE_SITES = [
      {
        category: 'Documentation (Core)', sites: [
          { name: 'MDN Web Docs', url: 'https://developer.mozilla.org/en-US/docs/', use: 'HTML, CSS, JS, Web APIs', fetch: true },
          { name: 'Python Docs', url: 'https://docs.python.org/3/', use: 'Standard library, PEPs', fetch: true },
          { name: 'Node.js Docs', url: 'https://nodejs.org/docs/latest/api/', use: 'Built-in modules, streams', fetch: true },
          { name: 'Rust Book', url: 'https://doc.rust-lang.org/book/', use: 'Ownership, lifetimes, safety', fetch: true },
          { name: 'Go Docs', url: 'https://go.dev/doc/', use: 'Concurrency, effective Go', fetch: true },
          { name: 'TypeScript Handbook', url: 'https://www.typescriptlang.org/docs/handbook/', use: 'Type system, utility types', fetch: true },
        ]
      },
      {
        category: 'Modern Runtimes & Tooling', sites: [
          { name: 'Bun', url: 'https://bun.sh/docs', use: 'Fast JS runtime, bundler, test runner', fetch: true },
          { name: 'Deno', url: 'https://docs.deno.com/', use: 'Secure TS runtime, built-in cloud primitives', fetch: true },
          { name: 'Biome', url: 'https://biomejs.dev/docs/', use: 'Unified linter/formatter (replaces Prettier/ESLint)', fetch: true },
          { name: 'Vite', url: 'https://vitejs.dev/guide/', use: 'Standard build tool for modern web apps', fetch: true },
        ]
      },
      {
        category: 'UI & Frontend Frameworks', sites: [
          { name: 'React', url: 'https://react.dev/reference', use: 'Components, Hooks, Server Components', fetch: true },
          { name: 'Next.js', url: 'https://nextjs.org/docs', use: 'App Router, Server Actions, Middleware', fetch: true },
          { name: 'Shadcn/ui', url: 'https://ui.shadcn.com/docs', use: 'AI-native component structures', fetch: true },
          { name: 'Tailwind CSS', url: 'https://tailwindcss.com/docs', use: 'V4+ utility-first styling', fetch: true },
          { name: 'Svelte', url: 'https://svelte.dev/docs/llms-full.txt', use: 'Svelte 5+ (LLM-optimized plaintext version)', fetch: true },
          { name: 'Vue', url: 'https://vuejs.org/guide/', use: 'Composition API, reactivity', fetch: true },
        ]
      },
      {
        category: 'AI Frameworks & Standards', sites: [
          { name: 'Model Context Protocol (MCP)', url: 'https://modelcontextprotocol.io/introduction', use: 'Standard for connecting LLMs to data/tools', fetch: true },
          { name: 'LangChain', url: 'https://python.langchain.com/docs/', use: 'Chain-of-thought, agentic workflows', fetch: true },
          { name: 'LlamaIndex', url: 'https://docs.llamaindex.ai/', use: 'RAG, data connectors, indexing', fetch: true },
          { name: 'OpenAI Docs', url: 'https://platform.openai.com/docs/', use: 'GPT-4o/o1 APIs, function calling', fetch: true },
          { name: 'Anthropic Docs', url: 'https://docs.anthropic.com/en/docs/', use: 'Claude API, prompt engineering', fetch: true },
          { name: 'Hugging Face', url: 'https://huggingface.co/docs', use: 'Open-source models, transformers', fetch: true },
        ]
      },
      {
        category: 'Database & Backend', sites: [
          { name: 'Drizzle ORM', url: 'https://orm.drizzle.team/docs/overview', use: 'Type-safe SQL query builder', fetch: true },
          { name: 'Supabase', url: 'https://supabase.com/docs', use: 'Auth, Database, Storage (Postgres-based)', fetch: true },
          { name: 'PostgreSQL', url: 'https://www.postgresql.org/docs/current/', use: 'Advanced SQL, JSONB, indexing', fetch: true },
          { name: 'Zod', url: 'https://zod.dev/', use: 'Schema validation for JSON & LLM outputs', fetch: true },
          { name: 'FastAPI', url: 'https://fastapi.tiangolo.com/', use: 'Pydantic-based Python APIs', fetch: true },
        ]
      },
      {
        category: 'Registries & Quick Lookups', sites: [
          { name: 'llms.txt Directory', url: 'https://directory.llmstxt.cloud/', use: 'List of AI-readable documentation sites', fetch: true },
          { name: 'Can I Use', url: 'https://caniuse.com/', use: 'Browser feature compatibility', search: true },
          { name: 'PyPI', url: 'https://pypi.org/search/?q=', use: 'Python package search', search: true },
          { name: 'npm', url: 'https://www.npmjs.com/search?q=', use: 'Node package search', search: true },
          { name: 'Stack Overflow', url: 'https://stackoverflow.com/search?q=', use: 'Error message solutions', search: true },
        ]
      },
    ];


    let _cachedReferenceSection = '';
    function buildReferenceSection() {
      if (_cachedReferenceSection) return _cachedReferenceSection;
      let text = '═══ REFERENCE SITES ═══\n\n';
      text += 'For accurate, up-to-date information, go directly to these sources instead of relying only on web_search.\n';
      text += 'For "fetch: yes" sites, use fetch_url to read the specific doc page. For "search" sites, append the query to the URL.\n\n';
      for (const cat of REFERENCE_SITES) {
        text += `**${cat.category}**\n`;
        for (const s of cat.sites) {
          const tags = [];
          if (s.fetch) tags.push('fetch=yes');
          if (s.search) tags.push('search=yes');
          const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
          text += `- ${s.name}: ${s.url}${tagStr}\n  → ${s.use}\n`;
        }
        text += '\n';
      }
      text += `**Strategy:**\n`;
      text += `- "How do I use X?" → fetch_url the relevant doc page directly (faster, more accurate than search)\n`;
      text += `- "What package does Y?" → web_search first, then fetch_url the top result or the registry page\n`;
      text += `- "Why is my code failing?" → web_search the exact error message (quote it), check Stack Overflow\n`;
      text += `- "What\'s the best practice for Z?" → web_search for comparisons, then fetch_url authoritative sources\n`;
      text += `- When fetching docs, use mode="text" for clean readable output. If text mode misses content, try mode="raw" for the specific section.\n`;
      text += `**WHEN TO AUTOMATICALLY SEARCH (do this WITHOUT being asked):**\n`;
      text += `- You get an error you don't immediately recognize → web_search the EXACT error message in quotes FIRST, before guessing at a fix\n`;
      text += `- You're about to use an API/function you're not 100% certain about → fetch_url the relevant doc page to verify syntax and behavior BEFORE writing the code\n`;
      text += `- You need to check if a CSS/JS feature works in a browser → fetch_url caniuse.com for that feature\n`;
      text += `- You're installing a package and unsure which one or what version → web_search "best [language] package for [task] 2024" or fetch_url the registry page\n`;
      text += `- A test fails with unexpected output → read the test output carefully, then web_search the specific assertion/error if the cause isn't obvious\n`;
      text += `- You're writing code for a framework you haven't confirmed the version of → fetch_url the framework docs to check if your approach matches the current version\n`;
      text += `- You get a deprecation warning → fetch_url the docs to find the current replacement\n\n`;
      text += `**WHEN NOT TO SEARCH (don't waste time):**\n`;
      text += `- Simple syntax errors you can see from the error message (missing bracket, typo)\n`;
      text += `- Logic errors where you can trace the issue by reading the code\n`;
      text += `- Problems you've already solved earlier in this conversation\n`;
      text += `- Anything where you can just read the relevant file and see the issue\n\n`;
      text += `**PATTERN — Error → Search → Fix → Verify:**\n`;
      text += `1. Read the error output carefully — is it obvious? If yes, fix directly.\n`;
      text += `2. If not obvious, web_search the exact error (quote it). Read top 1-2 results.\n`;
      text += `3. If the search results point to a doc page, fetch_url that page for the full context.\n`;
      text += `4. Apply the fix based on what you learned.\n`;
      text += `5. Re-run to verify. If it still fails, search again with the NEW error.\n`;
      text += `Do NOT just try random fixes in a loop. Research first, then act.\n`;
      _cachedReferenceSection = text;
      return text;
    }

    /* ═════════════════ TOKEN TRACKING ═══════════════ */

    const _tokenizeCache = new Map();

    async function exactTokenCount(text) {
      if (!text || !state.connected) return -1;
      const key = `${text.length}:${text.slice(0, 100)}:${text.slice(-100)}`;
      if (_tokenizeCache.has(key)) return _tokenizeCache.get(key);
      try {
        const res = await fetch(`${state.apiUrl}/v1/tokenize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(3000)
        });
        if (!res.ok) return -1;
        const data = await res.json();
        const count = data.count;
        _tokenizeCache.set(key, count);
        if (_tokenizeCache.size > 200) {
          const first = _tokenizeCache.keys().next().value;
          if (first !== undefined) _tokenizeCache.delete(first);
        }
        return count;
      } catch {
        return -1;
      }
    }



    const tokenTracker = {
      lastPromptTokens: -1,
      lastPromptTokensAsOfLen: 0,
      totalOutputTokens: 0,
      _callOut: 0,


      reset() { this._callOut = 0; this.lastPromptTokens = -1; this.lastPromptTokensAsOfLen = 0; this._loggedMissing = false; this._loggedEmpty = false; },

      feed(chunk) {
        if (!chunk?.usage) {
          if (!this._loggedMissing) {
            console.log('[tokenTracker] No usage field in chunk:', JSON.stringify(chunk).slice(0, 300));
            this._loggedMissing = true;
          }
          return;
        }
        if (!chunk.usage.prompt_tokens && !chunk.usage.completion_tokens) {
          if (!this._loggedEmpty) {
            console.log('[tokenTracker] Usage present but both zero');
            this._loggedEmpty = true;
          }
        }
        const u = chunk.usage;
        // Record how many messages existed when this request was SENT (i.e. before
        // this turn's assistant/tool messages get appended), so the meter can later
        // tell how much has been added since this "exact" reading was taken — see
        // getFreshTokenEstimate(). Without this, the header freezes at the prompt
        // size of the last completed API call until the NEXT one returns, even
        // though new tool results have already landed in state.messages.
        if (u.prompt_tokens != null) { this.lastPromptTokens = u.prompt_tokens; this.lastPromptTokensAsOfLen = state.messages.length; }
        if (u.completion_tokens != null) this._callOut += u.completion_tokens;
      },

      commit() {
        this.totalOutputTokens += this._callOut;
        this._callOut = 0;
      },

      estimate(text) {
        if (!text) return 0;
        const codeRatio = (text.match(/[{}[\]();]/g) || []).length / Math.max(text.length, 1);
        const factor = 3.8 - codeRatio * 1.0;
        return Math.ceil(text.length / Math.max(factor, 2.0));
      }
    };

    /* ═══════════════ TOKEN ESTIMATION & REAL TOKEN COUNTING ═══════════════ */
    const _tokenCountCache = new Map();

    /**
     * Get exact token count from LM Studio (/v1/tokenize) or llama.cpp (/tokenize),
     * caching results in memory and falling back to estimation.
     */
    async function countRealTokens(text) {
      if (!text || typeof text !== 'string') return 0;
      if (text.length < 8) return estimateTokens(text);
      const hash = text.length + ':' + text.slice(0, 30) + ':' + text.slice(-30);
      if (_tokenCountCache.has(hash)) return _tokenCountCache.get(hash);

      if (state.connected && state.apiUrl) {
        try {
          if (state.backendType === 'llamacpp') {
            const res = await fetch(`${state.apiUrl}/tokenize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: text })
            });
            if (res.ok) {
              const data = await res.json();
              if (Array.isArray(data.tokens)) {
                _tokenCountCache.set(hash, data.tokens.length);
                if (_tokenCountCache.size > 300) _tokenCountCache.delete(_tokenCountCache.keys().next().value);
                return data.tokens.length;
              }
            }
          } else {
            // LM Studio /v1/tokenize
            const res = await fetch(`${state.apiUrl}/v1/tokenize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: state.model, input: text })
            });
            if (res.ok) {
              const data = await res.json();
              const count = Array.isArray(data.tokens) ? data.tokens.length : (typeof data.count === 'number' ? data.count : (data.tokens ? Object.keys(data.tokens).length : null));
              if (count !== null) {
                _tokenCountCache.set(hash, count);
                if (_tokenCountCache.size > 300) _tokenCountCache.delete(_tokenCountCache.keys().next().value);
                return count;
              }
            }
          }
        } catch (_) {}
      }
      const est = estimateTokens(text);
      return est;
    }

    function estimateTokens(t) { if (!t) return 0; return Math.ceil(t.length / 3.8); }

    function estimateConvTokens() {
      return estimateTokensForMessages(state.messages);
    }

    function estimateTokensForMessages(msgs) {
      let total = 0;
      for (const m of msgs) {
        if (m.content) total += estimateTokens(m.content);
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            total += estimateTokens(tc.function?.arguments || '');
            total += 5;
          }
        }
        total += 4;
      }
      return total;
    }

    // The "exact" prompt-token count only reflects the size of the LAST completed
    // API request — anything pushed to state.messages since then (tool results,
    // the assistant's own message) isn't in it yet, and won't be until the NEXT
    // API call returns. Bridge that gap by adding a live estimate of just the
    // messages added since that reading, so the header doesn't visibly freeze
    // between iterations while a click-triggered breakdown (which always
    // estimates fresh) shows a different, more current number.
    function getFreshTokenEstimate() {
      const exact = tokenTracker.lastPromptTokens;
      if (exact > 0) {
        const newMsgs = state.messages.slice(tokenTracker.lastPromptTokensAsOfLen);
        return exact + (newMsgs.length ? estimateTokensForMessages(newMsgs) : 0);
      }
      return null;
    }

    let _syncRealTokensDebounce = null;
    function scheduleRealTokenSync() {
      clearTimeout(_syncRealTokensDebounce);
      _syncRealTokensDebounce = setTimeout(async () => {
        if (!state.connected || !state.messages.length) return;
        let total = 0;
        for (const m of state.messages) {
          if (m.content) total += await countRealTokens(m.content);
          if (m.tool_calls) {
            for (const tc of m.tool_calls) {
              total += await countRealTokens(tc.function?.arguments || '');
              total += 5;
            }
          }
          total += 4;
        }
        state._realConvTokens = total;
        updateContextMeter();
      }, 500);
    }

    function getContextPct() {
      const fresh = getFreshTokenEstimate();
      if (fresh !== null) return Math.min(100, (fresh / state.ctxWindow) * 100);
      if (!state._sysPromptLength) state._sysPromptLength = estimateTokens(DEFAULT_SYS);
      const convTok = state._realConvTokens > 0 ? state._realConvTokens : estimateConvTokens();
      return Math.min(100, ((convTok + state._sysPromptLength) / state.ctxWindow) * 100);
    }

    function updateContextMeter() {
      const fill = document.getElementById('ctx-fill'), label = document.getElementById('ctx-label');
      if (!fill || !label) return;
      if (!state._sysPromptLength) state._sysPromptLength = estimateTokens(DEFAULT_SYS);
      const fresh = getFreshTokenEstimate();
      const isExact = fresh !== null;
      const isRealSync = !isExact && state._realConvTokens > 0;
      const tok = isExact
        ? fresh
        : (state._realConvTokens > 0 ? state._realConvTokens : estimateConvTokens()) + state._sysPromptLength;
      const pct = Math.min(100, (tok / state.ctxWindow) * 100);
      const fillCls = pct > 80 ? 'high' : pct > 50 ? 'mid' : 'low';
      fill.style.width = pct + '%';
      fill.className = 'ctx-fill ' + fillCls;
      const remaining = state.ctxWindow - tok;
      const remainingPct = remaining / state.ctxWindow;
      // Show remaining tokens (red warning) when < 20% context left
      const hasEstimatedDelta = isExact && state.messages.length > tokenTracker.lastPromptTokensAsOfLen;
      if (remainingPct < 0.2) {
        label.textContent = formatTok(remaining) + ' left';
        label.style.color = 'var(--red)';
      } else {
        label.textContent = (isExact && !hasEstimatedDelta || isRealSync ? '' : '~') + formatTok(tok) + ' tok';
        label.style.color = '';
      }
      const stats = getCompressionStats();
      const meter = fill.closest('.ctx-meter');
      const precisionLabel = !isExact ? (isRealSync ? '(exact from /tokenize API)' : '(estimated)')
        : hasEstimatedDelta ? '(last exact reading + estimate of what\'s been added since)' : '(exact from response)';
      if (meter && stats && stats.saved > 100) {
        meter.title = `Context: ${formatTok(tok)} tokens ${precisionLabel} (${pct.toFixed(0)}% of ${formatTok(state.ctxWindow)})\nCompression saved: ~${formatTok(Math.round(stats.saved / 3.8))} tokens (${stats.pct}% reduction in tool outputs)`;
      } else if (meter) {
        meter.title = `Context usage: ${formatTok(tok)} tokens ${precisionLabel}`;
      }
    }

    /* ═══════════════ TEXT LOOP DETECTION ═══════════════ */
    const textLoopBuffer = [];
    const TEXT_LOOP_WINDOW = 4;     /* compare last N assistant messages */
    const TEXT_LOOP_THRESHOLD = 0.7; /* 70% word overlap = loop */

    /*
    function wordSet(text) {
      return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));
    }
    */

    function textFingerprint(text) {
      // Only use word-like tokens for fingerprinting — excludes operators/punctuation
      const tokens = text.match(/\b[a-zA-Z_][\w]*\b/g) || [];
      if (tokens.length < 5) return new Set(); // too short to compare meaningfully
      const bigrams = new Set();
      for (let i = 0; i < tokens.length - 1; i++) {
        bigrams.add(tokens[i].toLowerCase() + ' ' + tokens[i + 1].toLowerCase());
      }
      return bigrams;
    }

    function jaccard(a, b) {
      if (!a.size || !b.size) return 0;
      let inter = 0;
      for (const w of a) if (b.has(w)) inter++;
      return inter / (a.size + b.size - inter);
    }

    function checkTextLoop(newText) {
      if (!newText || newText.length < 10) return false;
      const words = textFingerprint(newText);
      textLoopBuffer.push(words);
      if (textLoopBuffer.length > TEXT_LOOP_WINDOW) textLoopBuffer.shift();
      if (textLoopBuffer.length < TEXT_LOOP_WINDOW) return false;

      /* Compare each pair in the window — if most pairs are highly similar, it's a loop */
      let similarPairs = 0;
      const totalPairs = textLoopBuffer.length * (textLoopBuffer.length - 1) / 2;
      for (let i = 0; i < textLoopBuffer.length; i++) {
        for (let j = i + 1; j < textLoopBuffer.length; j++) {
          if (jaccard(textLoopBuffer[i], textLoopBuffer[j]) >= TEXT_LOOP_THRESHOLD) similarPairs++;
        }
      }
      return (similarPairs / totalPairs) >= 0.6; /* 60% of all pairs are similar */
    }

    /* ═══════════════ VISION / IMAGES ═══════════════ */

    function detectVision(modelId) {
      if (!modelId) return false;
      /* ── llama.cpp: use probed or manually set flag ── */
      if (state.backendType === 'llamacpp') return state.llamacppVision;
      /* ── LM Studio: check native API metadata ── */
      const info = state.modelInfoMap.get(modelId);
      if (info !== undefined) return info.vision;
      return false;
    }

    /* Probe llama.cpp /props to detect mmproj/vision support.
       Falls back gracefully if the endpoint doesn't exist. */
    async function probeLlamaCppVision() {
      if (state.backendType !== 'llamacpp') return;
      // Try /props first (older builds), then /v1/props (newer)
      for (const path of ['/props', '/v1/props']) {
        try {
          const res = await fetch(state.apiUrl + path, { signal: AbortSignal.timeout(3000) });
          if (!res.ok) continue;
          const data = await res.json();
          // llama.cpp sets "vision" or includes "clip" / "mmproj" keys when a projection is loaded
          const hasVision = !!(
            data.vision ||
            data.has_vision ||
            data.clip_model_loaded ||
            data.mmproj ||
            (typeof data.model_type === 'string' && data.model_type.toLowerCase().includes('vision')) ||
            (Array.isArray(data.models) && data.models.some(m => m.type === 'clip' || m.type === 'mmproj'))
          );
          // Only upgrade to true from probe — never force false and override the user's manual toggle
          if (hasVision) { state.llamacppVision = true; updateVisionUI(); }
          return;
        } catch { /* endpoint may not exist */ }
      }
      // /props not available — leave as-is (user can toggle manually)
    }

    function updateVisionUI() {
      state.visionCapable = detectVision(state.model);
      /* Update header badge */
      let badge = document.getElementById('vision-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'vision-badge';
        badge.className = 'vision-badge off';
        const sel = document.getElementById('model-sel');
        sel.parentNode.insertBefore(badge, sel.nextSibling);
      }
      badge.className = 'vision-badge ' + (state.visionCapable ? 'on' : 'off');
      badge.textContent = state.visionCapable ? 'VISION' : 'text';
      badge.title = state.visionCapable ? 'Model supports image input' : 'Model does not support image input';

      /* Update screenshot button */
      const ssBtn = document.getElementById('screenshot-btn');
      if (ssBtn) ssBtn.disabled = !state.visionCapable;

      renderToolList();
    }

    function openImgViewer(src) {
      document.getElementById('img-viewer-img').src = src;
      document.getElementById('img-viewer').classList.add('open');
    }
    function closeImgViewer() {
      document.getElementById('img-viewer').classList.remove('open');
    }

    function compressImageToBase64(canvas, maxPx) {
      maxPx = maxPx || 1280;
      let w = canvas.width, h = canvas.height;
      if (w > maxPx || h > maxPx) {
        if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
        else { w = Math.round(w * maxPx / h); h = maxPx; }
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(canvas, 0, 0, w, h);
      /* JPEG at 0.8 quality — much smaller than PNG for screenshots */
      return c.toDataURL('image/jpeg', 0.8);
    }

    async function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            c.getContext('2d').drawImage(img, 0, 0);
            resolve(compressImageToBase64(c, 1280));
          };
          img.onerror = () => resolve(reader.result);
          img.src = reader.result;
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
    }

    /* ═══════════════ PDF SUPPORT ═══════════════ */
    function isPdfFile(file, path) {
      if (!file && !path) return false;
      if (file && file.type === 'application/pdf') return true;
      if (path && path.toLowerCase().endsWith('.pdf')) return true;
      if (file && file.name && file.name.toLowerCase().endsWith('.pdf')) return true;
      return false;
    }

    async function extractPdfText(file) {
      if (typeof pdfjsLib === 'undefined') {
        return '[PDF support unavailable — pdf.js library failed to load]';
      }
      const MAX_PAGES = 150;
      const MAX_CHARS = 600000;
      try {
        const buf = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
        const numPages = Math.min(pdf.numPages, MAX_PAGES);
        const pages = [];
        let totalChars = 0;
        for (let i = 1; i <= numPages; i++) {
          const page = await pdf.getPage(i);
          const tc = await page.getTextContent();
          /* Reconstruct reading order using item transforms */
          const items = tc.items.filter(it => it.str.trim());
          if (!items.length) { pages.push(`--- Page ${i} ---\n(empty)`); continue; }
          /* Simple approach: join all strings with spaces, deduplicate whitespace */
          let text = items.map(it => it.str).join(' ');
          text = text.replace(/\s+/g, ' ').trim();
          if (text) {
            pages.push(`--- Page ${i} ---\n${text}`);
            totalChars += text.length;
            if (totalChars > MAX_CHARS) { pages.push('\n[Truncated at ' + MAX_CHARS + ' characters]'); break; }
          }
        }
        const result = pages.join('\n\n');
        if (!result.trim()) {
          return `PDF: ${file.name}\nPages: ${pdf.numPages}\nSize: ${(file.size / 1024).toFixed(1)} KB\n⚠ No extractable text found — this may be a scanned/image-based PDF. The text is embedded in images and cannot be extracted without OCR.`;
        }
        return `PDF: ${file.name}\nPages: ${pdf.numPages} (extracted ${Math.min(numPages, pdf.numPages)} of ${pdf.numPages})\nCharacters: ${totalChars.toLocaleString()}\n---\n${result}`;
      } catch (e) {
        return `PDF: ${file.name}\nError extracting text: ${e.message}\n\nTip: If the PDF is encrypted or corrupted, try opening it in a viewer first.`;
      }
    }

    async function renderPdfFirstPageThumbnail(file) {
      /* Returns a data URL of the first page, or null on failure */
      if (typeof pdfjsLib === 'undefined') return null;
      try {
        const buf = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
        const page = await pdf.getPage(1);
        const scale = 1.0;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width; canvas.height = vp.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        return canvas.toDataURL('image/jpeg', 0.7);
      } catch { return null; }
    }

    async function renderPdfPagesToContainer(file, container) {
      if (typeof pdfjsLib === 'undefined') {
        const objectUrl = URL.createObjectURL(file);
        container.innerHTML = `
          <div style="padding:12px;text-align:center;border-bottom:1px solid var(--border)">
            <span style="font-size:11px;color:var(--tx-3)">pdf.js was not loaded. Using browser native viewer instead.</span>
            <a href="${objectUrl}" target="_blank" class="btn btn-sm" style="margin-left:8px;display:inline-block;padding:2px 8px;font-size:10px;background:var(--accent);color:white;border-radius:3px;text-decoration:none">Open in New Tab</a>
          </div>
          <iframe src="${objectUrl}" style="width:100%;height:calc(100vh - 200px);border:none;"></iframe>
        `;
        return;
      }
      container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--tx-3)"><i class="fas fa-spinner fa-spin"></i> Rendering pages...</div>';
      try {
        const buf = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
        container.innerHTML = '';
        const MAX_RENDER = 50;
        const numPages = Math.min(pdf.numPages, MAX_RENDER);
        for (let i = 1; i <= numPages; i++) {
          const page = await pdf.getPage(i);
          const scale = 1.5;
          const vp = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          canvas.style.cssText = 'max-width:100%;height:auto;display:block;margin:4px auto;border:1px solid var(--border);border-radius:4px;cursor:zoom-in;background:white;';
          canvas.title = `Page ${i} of ${pdf.numPages} — click to enlarge`;
          canvas.onclick = () => openImgViewer(canvas.toDataURL('image/png'));
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const label = document.createElement('div');
          label.style.cssText = 'font-size:9px;color:var(--tx-4);text-align:center;font-family:JetBrains Mono,monospace;padding:1px 0 6px;';
          label.textContent = `Page ${i} / ${pdf.numPages}`;
          container.appendChild(label);
          container.appendChild(canvas);
        }
        if (pdf.numPages > MAX_RENDER) {
          const note = document.createElement('div');
          note.style.cssText = 'padding:8px 12px;font-size:10px;color:var(--yellow);text-align:center;font-family:JetBrains Mono,monospace;';
          note.textContent = `Showing ${MAX_RENDER} of ${pdf.numPages} pages`;
          container.appendChild(note);
        }
      } catch (e) {
        container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--red)"><i class="fas fa-exclamation-triangle" style="font-size:20px;margin-bottom:8px;display:block"></i>${esc(e.message)}</div>`;
      }
    }

    function renderPdfPreview(file) {
      const previewEl = document.getElementById('rp-file-preview');
      const emptyEl = document.getElementById('rp-files-empty');
      previewEl.innerHTML = `
        <div class="rp-file-header">
          <span class="rp-file-name"><i class="fas fa-file-pdf" style="color:var(--red);margin-right:4px"></i>${esc(file.name)}</span>
          <span class="rp-file-meta">PDF · ${(file.size / 1024).toFixed(1)} KB</span>
          <div class="rp-file-actions">
            <button class="rp-file-act" onclick="rpCopyPdfText()" title="Copy extracted text"><i class="fas fa-copy"></i></button>
          </div>
        </div>
        <div id="rp-pdf-pages" style="padding:8px;overflow-y:auto;background:var(--bg-0)"></div>`;
      emptyEl.style.display = 'none';
      previewEl.style.display = 'block';
      renderPdfPagesToContainer(file, document.getElementById('rp-pdf-pages'));
      /* Extract text for copy functionality */
      extractPdfText(file).then(text => { rpState.activeFile = { content: text, isPdf: true }; });
    }

    function rpCopyPdfText() {
      if (rpState.activeFile?.content) {
        navigator.clipboard.writeText(rpState.activeFile.content).then(() => showToast('Copied PDF text', 'ok'));
      }
    }

    async function captureScreenRegion(promptText, reasonText) {
      /* ── Request screen share ── */
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: 'never', displaySurface: 'monitor' },
          audio: false,
          preferCurrentTab: false,
          selfBrowserSurface: 'exclude',
          systemAudio: 'exclude'
        });
      } catch (e) {
        if (e.name === 'NotAllowedError') return null;
        throw e;
      }

      /* ── Grab a frame ── */
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await new Promise((res, rej) => { video.onloadedmetadata = () => video.play().then(res).catch(rej); video.onerror = rej; });
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const vw = video.videoWidth, vh = video.videoHeight;
      const offscreen = document.createElement('canvas');
      offscreen.width = vw; offscreen.height = vh;
      offscreen.getContext('2d').drawImage(video, 0, 0, vw, vh);
      stream.getTracks().forEach(t => t.stop());
      video.srcObject = null;

      /* ── Scale to fit viewport ── */
      const maxW = window.innerWidth - 40, maxH = window.innerHeight - 160;
      const scale = Math.min(maxW / vw, maxH / vh, 1);
      const drawW = Math.round(vw * scale), drawH = Math.round(vh * scale);

      /* ── Build overlay ── */
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'screen-capture-overlay';

        if (promptText) {
          const hint = document.createElement('div');
          hint.className = 'screen-capture-hint';
          hint.innerHTML = `<div class="hint-icon"><i class="fas fa-camera"></i></div><div class="hint-text">${esc(promptText)}</div>${reasonText ? '<div class="hint-reason">' + esc(reasonText) + '</div>' : ''}`;
          overlay.appendChild(hint);
        }

        const area = document.createElement('div');
        area.className = 'screen-capture-area';
        area.style.width = drawW + 'px';
        area.style.height = drawH + 'px';

        const canvas = document.createElement('canvas');
        canvas.className = 'screen-capture-canvas';
        canvas.width = drawW; canvas.height = drawH;
        canvas.getContext('2d').drawImage(offscreen, 0, 0, drawW, drawH);

        const placeholder = document.createElement('div');
        placeholder.className = 'screen-capture-placeholder';
        placeholder.innerHTML = '<i class="fas fa-crop-simple" style="margin-right:6px"></i> Click and drag to select area';

        const selRect = document.createElement('div');
        selRect.className = 'selection-rect';

        const info = document.createElement('div');
        info.className = 'selection-info';

        area.append(canvas, placeholder, selRect, info);
        overlay.appendChild(area);

        const actions = document.createElement('div');
        actions.className = 'screen-capture-actions';
        const btnSel = document.createElement('button'); btnSel.className = 'sc-btn sc-btn-capture'; btnSel.textContent = 'Capture Selection';
        const btnAll = document.createElement('button'); btnAll.className = 'sc-btn'; btnAll.textContent = 'Capture All';
        const btnRedo = document.createElement('button'); btnRedo.className = 'sc-btn'; btnRedo.textContent = 'Reselect';
        const btnCancel = document.createElement('button'); btnCancel.className = 'sc-btn sc-btn-cancel'; btnCancel.textContent = 'Cancel';
        actions.append(btnSel, btnAll, btnRedo, btnCancel);
        overlay.appendChild(actions);
        document.body.appendChild(overlay);

        let dragging = false, sx, sy, cx, cy, hasSel = false;

        function pos(e) {
          const r = canvas.getBoundingClientRect();
          const t = e.touches?.[0] || e;
          if (!t) return { x: 0, y: 0 };
          return { x: Math.max(0, Math.min(drawW, t.clientX - r.left)), y: Math.max(0, Math.min(drawH, t.clientY - r.top)) };
        }

        function showSel() {
          const x = Math.min(sx, cx), y = Math.min(sy, cy), w = Math.abs(cx - sx), h = Math.abs(cy - sy);
          selRect.style.display = 'block';
          selRect.style.left = x + 'px'; selRect.style.top = y + 'px';
          selRect.style.width = w + 'px'; selRect.style.height = h + 'px';
          const ow = Math.round(w / scale), oh = Math.round(h / scale);
          info.style.display = 'block';
          info.style.left = x + 'px'; info.style.top = Math.max(0, y - 26) + 'px';
          info.textContent = ow + ' \u00d7 ' + oh;
        }

        function hideSel() { selRect.style.display = 'none'; info.style.display = 'none'; }

        function onDown(e) {
          e.preventDefault();
          const p = pos(e); dragging = true; sx = p.x; sy = p.y; cx = p.x; cy = p.y;
          hasSel = false; actions.style.display = 'none'; hideSel();
          placeholder.style.opacity = '0';
        }
        function onMove(e) {
          if (!dragging) return; e.preventDefault();
          const p = pos(e); cx = p.x; cy = p.y; showSel();
        }
        function onUp() {
          if (!dragging) return; dragging = false;
          if (Math.abs(cx - sx) > 8 && Math.abs(cy - sy) > 8) { hasSel = true; actions.style.display = 'flex'; }
          else { hideSel(); placeholder.style.opacity = '1'; }
        }

        canvas.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        canvas.addEventListener('touchstart', onDown, { passive: false });
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);

        function crop() {
          const x = Math.min(sx, cx), y = Math.min(sy, cy);
          const w = Math.abs(cx - sx), h = Math.abs(cy - sy);
          const ox = Math.round(x / scale), oy = Math.round(y / scale);
          const ow = Math.max(1, Math.round(w / scale)), oh = Math.max(1, Math.round(h / scale));
          const c = document.createElement('canvas'); c.width = ow; c.height = oh;
          c.getContext('2d').drawImage(offscreen, ox, oy, ow, oh, 0, 0, ow, oh);
          return compressImageToBase64(c, 1280);
        }

        function flash() {
          const f = document.createElement('div'); f.className = 'screen-capture-flash';
          document.body.appendChild(f); setTimeout(() => f.remove(), 300);
        }

        function cleanup() {
          canvas.removeEventListener('mousedown', onDown);
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          canvas.removeEventListener('touchstart', onDown);
          window.removeEventListener('touchmove', onMove);
          window.removeEventListener('touchend', onUp);
          window.removeEventListener('keydown', onEsc);
          overlay.remove();
        }

        btnSel.onclick = () => { flash(); const r = crop(); cleanup(); resolve(r); };
        btnAll.onclick = () => { flash(); cleanup(); resolve(compressImageToBase64(offscreen, 1280)); };
        btnRedo.onclick = () => { hasSel = false; actions.style.display = 'none'; hideSel(); placeholder.style.opacity = '1'; };
        btnCancel.onclick = () => { cleanup(); resolve(null); };

        function onEsc(e) { if (e.key === 'Escape') { cleanup(); resolve(null); window.removeEventListener('keydown', onEsc); } }
        window.addEventListener('keydown', onEsc);
      });
    }

    /* Fallback for environments without getDisplayMedia */
    async function captureScreenshotFallback() {
      if (typeof html2canvas === 'undefined') throw new Error('No screen capture available');
      const flash = document.createElement('div'); flash.className = 'screenshot-flash';
      document.body.appendChild(flash); setTimeout(() => flash.remove(), 350);
      const target = document.querySelector('.content') || document.body;
      const canvas = await html2canvas(target, {
        backgroundColor: '#08080a', scale: Math.min(window.devicePixelRatio, 1.5),
        useCORS: true, logging: false, imageTimeout: 5000,
        ignoreElements: (el) => el.classList?.contains('screenshot-flash') || el.classList?.contains('img-viewer') || el.classList?.contains('screen-capture-overlay')
      });
      return compressImageToBase64(canvas, 1280);
    }

    async function captureScreenshot() {
      if (navigator.mediaDevices?.getDisplayMedia) return await captureScreenRegion();
      return await captureScreenshotFallback();
    }

    function renderImageAttachments(container) {
      container.innerHTML = '';
      state.pendingImages.forEach((img, i) => {
        const el = document.createElement('div');
        el.className = 'img-attach';
        el.innerHTML = `<img src="${img.dataUrl}" onclick="openImgViewer('${img.dataUrl}')" alt="${esc(img.name)}"><div class="img-info"><div class="img-name">${esc(img.name)}</div><div class="img-size">${img.size}</div></div><button class="img-remove" onclick="removePendingImage(${i})" title="Remove"><i class="fas fa-xmark"></i></button>`;
        container.appendChild(el);
      });
    }

    function removePendingImage(idx) {
      state.pendingImages.splice(idx, 1);
      renderImageAttachments(document.getElementById('img-attachments'));
      updateSendBtn();
    }

    function showMsgImage(dataUrl, small) {
      const cls = small ? 'msg-img-small' : 'msg-img';
      return '<img class="' + cls + '" src="' + dataUrl + '" onclick="openImgViewer(this.src)" alt="attached image" loading="lazy">';
    }

    function addImageAttachmentsToInputArea() {
      let container = document.getElementById('img-attachments');
      if (!container) {
        container = document.createElement('div');
        container.id = 'img-attachments';
        container.style.display = 'none';
        const wrap = document.getElementById('input-wrap');
        wrap.parentNode.insertBefore(container, wrap.nextSibling);
      }
      container.style.display = state.pendingImages.length ? 'block' : 'none';
      renderImageAttachments(container);
    }

    /* ═══════════════ TOOL DEFINITIONS ═══════════════ */
    function getToolDefs(full = false) {
      const tools = [
        { type: 'function', function: { name: 'think', description: 'Think through a problem step by step before acting. Visible to user.', parameters: { type: 'object', properties: { thought: { type: 'string', description: 'Your reasoning and plan' } }, required: ['thought'] } } },
        { type: 'function', function: {
          name: 'update_plan',
          description: 'Set or update your visible task checklist for this conversation. Use this when the shape of the work is already known — a mechanical multi-step task like "add these files, refactor these functions". Call whenever you form a plan, complete a step, or the plan changes. ALWAYS pass the FULL list of items — each call fully replaces the previous checklist. Skip for single-step or trivial requests. If you\'re not sure what the right approach even is yet (debugging, "why is X happening", architecture choices), use update_beliefs instead — don\'t force uncertain work into a fake fixed checklist.',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                description: 'The complete, ordered list of plan steps.',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: 'Short description of this step' },
                    status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Current status of this step' }
                  },
                  required: ['text', 'status']
                }
              }
            },
            required: ['items']
          }
        }},
        { type: 'function', function: {
          name: 'update_beliefs',
          description: 'Track competing hypotheses with confidence when you don\'t yet know the right approach — debugging ("why is this failing"), root-cause analysis, architecture decisions with real trade-offs. Maintain 2-4 hypotheses with rough confidence (they don\'t need to sum to 100). Before acting, pick the action that best discriminates between your leading hypotheses, not just the next thing that seems useful. After every observation, call this again with updated confidences — move a hypothesis to "ruled_out" when evidence contradicts it (but keep it in the list, don\'t delete it, in case you need to revive it), and to "confirmed" once you\'re sure. ALWAYS pass the FULL list, not just the changed one. Once a hypothesis is confirmed and you know the concrete steps to act on it, switch to update_plan for the implementation steps — update_beliefs is for figuring out WHAT\'s true, update_plan is for executing once you know.',
          parameters: {
            type: 'object',
            properties: {
              hypotheses: {
                type: 'array',
                description: 'The complete list of hypotheses, including ruled-out ones (kept for reference, not deleted).',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: 'The hypothesis, stated concretely' },
                    confidence: { type: 'number', description: 'Rough confidence 0-100' },
                    status: { type: 'string', enum: ['active', 'ruled_out', 'confirmed'], description: 'active = still in play, ruled_out = contradicted by evidence but kept for reference, confirmed = this is the answer' }
                  },
                  required: ['text', 'confidence', 'status']
                }
              },
              next_action: { type: 'string', description: 'One sentence: what you\'re about to do next and which hypothesis/hypotheses it will help distinguish between' }
            },
            required: ['hypotheses']
          }
        }},
        { type: 'function', function: {
          name: 'set_invariants',
          description: '(Experimental mode) Declare constraints that must keep holding true for the rest of this task — things easy to silently break several edits later without noticing: "the public API of this function must not change", "all existing tests must stay green", "this config format stays backward-compatible". These are injected into your own system prompt for the rest of the conversation, not checked automatically — restate the full list (not just additions) whenever it changes, and actively double-check your own recent changes against it before moving on, especially after edits that weren\'t directly about the invariant itself.',
          parameters: {
            type: 'object',
            properties: {
              invariants: { type: 'array', items: { type: 'string' }, description: 'The complete list of constraints that must keep holding' }
            },
            required: ['invariants']
          }
        }},
        { type: 'function', function: {
          name: 'save_memory',
          description: 'Save a short, durable note to project memory — persists across conversations in this workspace and is shown to you at the start of every future session here, immune to context compaction. Call this IMMEDIATELY at the moment you discover something, don\'t wait until you think you\'re "done": environment/tooling quirks (e.g. "use python not python3 here", a command that only works one specific way), user preferences, architectural decisions, non-obvious conventions. A fix that cost you a failed attempt to find is exactly the kind of thing worth one save_memory call so it\'s never rediscovered the hard way again. Do NOT use for task-specific progress (handled automatically by compaction) or secrets/credentials.',
          parameters: {
            type: 'object',
            properties: {
              note: { type: 'string', description: 'The fact or preference to remember, as a short standalone sentence' }
            },
            required: ['note']
          }
        }},
        { type: 'function', function: {
          name: 'ask_user',
          description: 'Pause and ask the user a clarifying question in the middle of a task, when you hit a genuine fork you cannot safely guess (ambiguous requirement, missing credential, conflicting instruction, destructive choice). The conversation stops until they reply — don\'t use this for things you can reasonably infer or look up yourself.',
          parameters: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question to ask the user, with enough context to answer it' },
              options: { type: 'array', items: { type: 'string' }, description: 'Optional short list of suggested answers, shown as quick-reply buttons' }
            },
            required: ['question']
          }
        }},
        { type: 'function', function: { name: 'read_file', description: 'Read a file as text. For PDF files, text is automatically extracted. For raster image files (PNG, JPG, GIF, WebP, BMP, ICO marked [IMAGE] in list_directory), the image is sent to you visually. For SVG files, returns the raw XML markup as text — use view_image to see the rendered graphic instead.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path to file or image' } }, required: ['path'] } } },
        { type: 'function', function: {
          name: 'read_file_summary',
          description: 'Get a compressed summary of a file. Returns: purpose (1 line), imports, exports/classes/functions list with line ranges, key constants. Much cheaper than read_file for understanding what a file contains. Use this when you need to understand a file\'s structure without reading every line. For files under 150 lines, just use read_file instead.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path to file' }
            },
            required: ['path']
          }
        }},
        { type: 'function', function: { name: 'read_file_lines', description: 'Read specific line ranges from a file. Much more efficient than reading entire files.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path' }, start_line: { type: 'number', description: '1-based start line (default: 1)' }, end_line: { type: 'number', description: '1-based end line (default: end of file)' } }, required: ['path'] } } },
        { type: 'function', function: { name: 'view_image', description: 'Display an image file visually to the user. For SVG files, renders the graphic with a "View Code" toggle. For raster images (PNG, JPG, GIF, WebP), shows the image. If you are vision-capable, the image is also sent to you for analysis. Use this when you want to see how an image/SVG actually looks. Use read_file instead when you want to read the raw SVG/XML markup as text.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path to the image file (SVG, PNG, JPG, GIF, WebP, etc.)' } }, required: ['path'] } } },
        { type: 'function', function: { name: 'edit_file', description: 'CRITICAL: Modify existing files using search/replace blocks. ALWAYS put "path" as the FIRST key in the JSON — placing it after "edits" causes truncation when edits are large, resulting in a missing-path error. Keep each old_text block under 20 lines.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'REQUIRED FIRST: Relative path to the file to edit. Put this before "edits" in the JSON object.' }, edits: { type: 'array', items: { type: 'object', properties: { old_text: { type: 'string', description: 'Exact text to find (must be unique in file, under 20 lines)' }, new_text: { type: 'string', description: 'Replacement text' } }, required: ['old_text', 'new_text'] }, description: 'Array of search/replace edits to apply sequentially' } }, required: ['path', 'edits'] } } },
        { type: 'function', function: { name: 'write_file', description: 'Create a new file or completely overwrite. Only use for NEW files — prefer edit_file for existing files. If content is large (>200 lines), use write_file_chunked instead to avoid truncation.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path' }, content: { type: 'string', description: 'Full file content' } }, required: ['path', 'content'] } } },
        { type: 'function', function: { name: 'write_file_chunked', description: 'Write a large file by splitting content into an array of chunks that are concatenated in order. Use instead of write_file when file content is >100 lines — this prevents JSON truncation. CRITICAL: keep each chunk ≤ 60 lines so ALL chunks fit within the token budget together. More smaller chunks is always safer than fewer large ones. Put "path" first.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'REQUIRED FIRST: Relative path to the file to create/overwrite' }, chunks: { type: 'array', items: { type: 'string' }, description: 'Array of content strings concatenated in order to form the complete file. KEEP EACH CHUNK ≤ 60 LINES. The final file is chunks.join("").', minItems: 1 }, append: { type: 'boolean', description: 'If true, append chunks to existing file instead of overwriting. Use this to continue a partial write.' } }, required: ['path', 'chunks'] } } },
        { type: 'function', function: { name: 'list_directory', description: 'List files and directories. Image files are marked with [IMAGE].', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path (default: root)' }, recursive: { type: 'boolean', description: 'List recursively' } }, required: [] } } },
        { type: 'function', function: { name: 'search_files', description: 'Search for files by name pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Substring or glob pattern' } }, required: ['pattern'] } } },
        { type: 'function', function: { name: 'grep', description: 'Search for text patterns in files with line numbers and context.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex or text to search for' }, path: { type: 'string', description: 'File or directory to search (default: root)' }, include: { type: 'string', description: 'File glob to include, e.g. "*.py"' }, context_lines: { type: 'number', description: 'Lines of context around matches (default: 0)' } }, required: ['pattern'] } } },
        { type: 'function', function: { name: 'start_dev_server', description: 'Start a local dev server in the background. The preview appears in the Preview panel. Supports hot-reload. Use browser_screenshot and browser_console to inspect the running app.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to start the dev server, e.g. "npm run dev", "python -m http.server 8000", "cargo run"' }, port: { type: 'number', description: 'Port number (default: 3000)' } }, required: ['command'] } } },
        { type: 'function', function: { name: 'delete_file', description: 'Delete a file or empty directory. Use recursive=true for directories with contents. Use with caution — this cannot be undone.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path to delete' }, recursive: { type: 'boolean', description: 'Delete directory and all contents (default: false)' } }, required: ['path'] } } },
        { type: 'function', function: { name: 'move_file', description: 'Move or rename a file or directory. Creates parent directories in destination if needed.', parameters: { type: 'object', properties: { source: { type: 'string', description: 'Current relative path' }, destination: { type: 'string', description: 'New relative path' } }, required: ['source', 'destination'] } } },
        { type: 'function', function: { name: 'semantic_search', description: 'Semantic code search using embeddings. Finds files by meaning, not exact string match. Best for conceptual queries like "find the auth middleware" or "where is DB config". Falls back to grep if model not loaded. Returns ranked file paths with relevance scores and context snippets.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Natural language description of what to find' }, top_k: { type: 'number', description: 'Max results (default 8)' } }, required: ['query'] } } },
      ];
      if (Array.isArray(state.mcpTools) && state.mcpTools.length) {
        for (const mcpTool of state.mcpTools) {
          if (mcpTool && mcpTool.type === 'function' && mcpTool.function?.name) {
            tools.push(mcpTool);
          }
        }
      }
      if (state.visionCapable) {
        tools.push({ type: 'function', function: { name: 'screenshot', description: 'Capture a region of the user\'s screen. A prompt appears asking the user to share their screen and select an area. Use this to see error messages in terminals, other windows, IDE output, or anything outside SlopLobster. The captured image is included in your next context so you can see it. Falls back to capturing the SlopLobster UI if screen sharing is unavailable.', parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Brief note on what you are looking for — shown to the user so they know what to capture' } }, required: [] } } });
      }
      if (state.compConnected) {
        tools.push({ type: 'function', function: { name: 'web_search', description: 'Search the web via DuckDuckGo. Returns titles, URLs, and snippets. Set fetch_top=1-2 to auto-fetch full page content of top results for deeper reading. Essential for finding up-to-date docs, APIs, solutions.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, num_results: { type: 'number', description: 'Number of results (1-20, default 8)' }, fetch_top: { type: 'number', description: 'Fetch full content of top N results (0-3, default 0). Use 1-2 for quick lookups.' } }, required: ['query'] } } });
        tools.push({ type: 'function', function: { name: 'fetch_url', description: 'Fetch and extract content from a URL. Modes: "text" (default, clean readable text), "raw" (full source).', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full URL to fetch' }, mode: { type: 'string', enum: ['text', 'raw'], description: 'Extraction mode (default: text)' }, max_bytes: { type: 'number', description: 'Max response bytes (default 500000)' } }, required: ['url'] } } });
        tools.push({ type: 'function', function: { name: 'http_request', description: 'Make an HTTP request with a specific method, headers, and body — for testing/calling REST APIs (as opposed to fetch_url, which only GETs and extracts readable page content). Runs from the browser: same-origin and CORS-enabled APIs work directly; APIs without CORS headers will be blocked by the browser and need execute_command with curl instead (if a companion server is connected).', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full URL to request' }, method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method (default: GET)' }, headers: { type: 'object', description: 'Request headers as key/value pairs, e.g. {"Authorization": "Bearer ...", "Content-Type": "application/json"}' }, body: { type: 'string', description: 'Raw request body (e.g. a JSON string). Not used for GET/HEAD.' }, timeout: { type: 'number', description: 'Timeout in seconds (default 30)' } }, required: ['url'] } } });
        tools.push({ type: 'function', function: { name: 'execute_command', description: 'Execute ANY shell command via companion server. Use for: running tests, builds, installs, git operations. Package installs (pip, npm, cargo, etc.) automatically get a 300s timeout. For other long-running commands, set the timeout parameter.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Complete shell command' }, timeout: { type: 'number', description: 'Timeout in seconds (default: from settings, auto-extended for installs)' } }, required: ['command'] } } });
        tools.push({ type: 'function', function: { name: 'run_tests', description: 'Run a test command and get back a compact pass/fail summary instead of the full raw log — much cheaper on context than execute_command for iterative fix loops. Recognizes pytest, jest/vitest, mocha, cargo test, and go test output. Falls back to the tail of raw output if the format isn\'t recognized. On failure, includes the relevant failure excerpt.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Test command to run, e.g. "pytest", "npm test", "cargo test". Defaults to the configured auto-verify command if omitted.' }, timeout: { type: 'number', description: 'Timeout in seconds (default 120)' } }, required: [] } } });

        if (state.compConnected && state.isGitRepo) {
          tools.push({ type: 'function', function: { name: 'git_status', description: 'Show git working tree status.', parameters: { type: 'object', properties: {}, required: [] } } });
          tools.push({ type: 'function', function: { name: 'git_diff', description: 'Show git diff. Use staged=true for staged changes.', parameters: { type: 'object', properties: { staged: { type: 'boolean', description: 'Show staged changes only' }, file: { type: 'string', description: 'Specific file to diff' } }, required: [] } } });
          tools.push({ type: 'function', function: { name: 'git_log', description: 'Show recent git commit history.', parameters: { type: 'object', properties: { count: { type: 'number', description: 'Number of commits (default: 10)' } }, required: [] } } });
          tools.push({ type: 'function', function: { name: 'git_add', description: 'Stage files for commit. Use "." to stage all changes.', parameters: { type: 'object', properties: { paths: { type: 'string', description: 'File paths to stage (space-separated, or "." for all)' } }, required: ['paths'] } } });
          tools.push({ type: 'function', function: { name: 'git_commit', description: 'Commit staged changes with a descriptive message.', parameters: { type: 'object', properties: { message: { type: 'string', description: 'Commit message' }, premortem: { type: 'string', description: '(Experimental mode) One sentence: the most likely way this commit could be wrong, if it is. Shown to the user in the confirmation.' } }, required: ['message'] } } });
          tools.push({ type: 'function', function: { name: 'git_push', description: 'Push commits to a remote. Always confirms first (this affects a remote/shared repo).', parameters: { type: 'object', properties: { remote: { type: 'string', description: 'Remote name (default: origin)' }, branch: { type: 'string', description: 'Branch name (default: current branch)' }, force: { type: 'boolean', description: 'Use --force-with-lease (default: false). Use only if you are sure you want to overwrite remote history.' } }, required: [] } } });
          tools.push({ type: 'function', function: { name: 'git_checkout_branch', description: 'Switch to a branch, optionally creating it.', parameters: { type: 'object', properties: { branch: { type: 'string', description: 'Branch name' }, create: { type: 'boolean', description: 'Create the branch if it does not exist (git checkout -b)' } }, required: ['branch'] } } });
          tools.push({ type: 'function', function: { name: 'git_stash', description: 'Stash, pop, or list stashed working-tree changes.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['push', 'pop', 'list'], description: 'push = stash current changes (default), pop = restore most recent stash, list = show stashes' }, message: { type: 'string', description: 'Optional label for a push action' } }, required: [] } } });
        }

      } else {
        tools.push({ type: 'function', function: { name: 'execute_command', description: 'Limited virtual shell: ls, cat, head, tail, wc, grep, find, echo, mkdir, touch, pwd, tree, file, diff. Start companion for real shell + web search.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Virtual shell command' } }, required: ['command'] } } });
      }
      if (state.compConnected && state.browserAvailable) {
        tools.push({ type: 'function', function: { name: 'browser_launch', description: 'Launch a headless Chromium browser via Playwright. Required before any other browser tool. The browser persists across multiple tool calls — launch once, then navigate/click/type as needed. Close with browser_close when done.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Optional URL to navigate to immediately after launch' }, headless: { type: 'boolean', description: 'Run headless (default: true). Set false only for debugging.' } }, required: [] } } });
        tools.push({ type: 'function', function: { name: 'browser_navigate', description: 'Navigate the browser to a URL. Waits for DOM content to load.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to navigate to' }, wait_until: { type: 'string', enum: ['domcontentloaded', 'load', 'networkidle'], description: 'When to consider navigation complete (default: domcontentloaded)' } }, required: ['url'] } } });
        tools.push({ type: 'function', function: { name: 'browser_screenshot', description: 'Take a screenshot of the current page or a specific element. Returns the image so you can see what the page looks like. Use this after navigation, clicks, or interactions to verify the result visually.', parameters: { type: 'object', properties: { full_page: { type: 'boolean', description: 'Capture full scrollable page (default: false, viewport only)' }, selector: { type: 'string', description: 'CSS selector — screenshot only this element instead of full page' } }, required: [] } } });
        tools.push({ type: 'function', function: { name: 'browser_console', description: 'Get browser console messages. CRITICAL for debugging — always check this after page interactions to catch JavaScript errors, failed network requests, and warnings. Returns errors, warnings, and logs.', parameters: { type: 'object', properties: { types: { type: 'array', items: { type: 'string' }, description: 'Filter by message types (default: all). Common: ["error", "warning", "log"]' } }, required: [] } } });
        tools.push({ type: 'function', function: { name: 'browser_click', description: 'Click an element on the page by CSS selector. Use for buttons, links, dropdown triggers, etc.', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector of the element to click' } }, required: ['selector'] } } });
        tools.push({ type: 'function', function: { name: 'browser_type', description: 'Type text into an input field. Clears the field first then types. Set submit=true to press Enter after typing.', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector of the input field' }, text: { type: 'string', description: 'Text to type' }, submit: { type: 'boolean', description: 'Press Enter after typing (for forms/search)' } }, required: ['selector', 'text'] } } });
        tools.push({ type: 'function', function: { name: 'browser_evaluate', description: 'Execute JavaScript in the browser page context. Returns the result. Useful for: getting element states, checking CSS properties, extracting data, triggering events.', parameters: { type: 'object', properties: { script: { type: 'string', description: 'JavaScript to execute. Use return to get a value back.' } }, required: ['script'] } } });
        tools.push({ type: 'function', function: { name: 'browser_get_content', description: 'Get the text content or HTML of the page or a specific element. Use for reading page text, extracting data from specific sections.', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector — get content of this element only (default: whole page)' }, mode: { type: 'string', enum: ['text', 'html'], description: 'text (default) or raw HTML' } }, required: [] } } });
        tools.push({ type: 'function', function: { name: 'browser_wait_for', description: 'Wait for an element to appear/be visible/attached. Use after navigation or clicks that trigger async content loading.', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector to wait for' }, state: { type: 'string', enum: ['visible', 'hidden', 'attached'], description: 'Element state to wait for (default: visible)' }, timeout: { type: 'number', description: 'Max wait time in ms (default: 10000)' } }, required: ['selector'] } } });
        tools.push({ type: 'function', function: { name: 'browser_hover', description: 'Hover mouse over an element. Useful for tooltips, dropdown menus that appear on hover.', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector to hover over' } }, required: ['selector'] } } });
        tools.push({ type: 'function', function: { name: 'browser_select_option', description: 'Select an option in a <select> dropdown.', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector of the <select> element' }, value: { type: 'string', description: 'Value of the option to select' } }, required: ['selector', 'value'] } } });
        tools.push({ type: 'function', function: { name: 'browser_press_key', description: 'Press a keyboard key. Use for Enter, Tab, Escape, ArrowDown, etc. Common keys: Enter, Tab, Escape, ArrowUp, ArrowDown, Backspace.', parameters: { type: 'object', properties: { key: { type: 'string', description: 'Key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown")' } }, required: ['key'] } } });
        tools.push({ type: 'function', function: { name: 'browser_scroll', description: 'Scroll the page. Use to see content below the fold.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction (default: down)' }, amount: { type: 'number', description: 'Pixels to scroll (default: 500, ignored for top/bottom)' } }, required: [] } } });
        tools.push({ type: 'function', function: { name: 'browser_go_back', description: 'Navigate back in browser history.', parameters: { type: 'object', properties: {}, required: [] } } });
        tools.push({ type: 'function', function: { name: 'browser_go_forward', description: 'Navigate forward in browser history.', parameters: { type: 'object', properties: {}, required: [] } } });
        tools.push({ type: 'function', function: { name: 'browser_close', description: 'Close the browser. Always call this when done to free resources.', parameters: { type: 'object', properties: {}, required: [] } } });
      }

      tools.push({
        type: 'function',
        function: {
          name: 'spawn_sub_agent',
          description: 'Spawn a sub-agent to handle a focused sub-task independently. The sub-agent runs with restricted tools and returns a summary. Its intermediate tool calls are hidden from the user — only the final summary appears.\n\nUse for:\n- Reading multiple files to understand a module before making changes\n- Searching for patterns across a codebase\n- Gathering context (schema, APIs, config) before implementing\n\nThe sub-agent has its own context — it keeps your main context clean.\n\nDefault tools (read-only): read_file, read_file_lines, list_directory, search_files, grep\nAdd "think" for reasoning, or write tools (edit_file, write_file) if the sub-agent should make changes.',
          parameters: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Clear description of what the sub-agent should accomplish' },
              tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Which tools the sub-agent can use. Defaults to [read_file, read_file_lines, list_directory, search_files, grep]'
              },
              max_iterations: { type: 'number', description: 'Soft round budget (default 10, min 4, max 30). It is extended automatically while the sub-agent keeps making progress and it is stopped early if it spins; a final report is always written, so do not set it very low.' }
            },
            required: ['task']
          }
        }
      });

      tools.push({
        type: 'function',
        function: {
          name: 'get_tool_schema',
          description: 'Get the full parameter schema for any tool. Use when you need the exact parameter names, types, and constraints before calling an unfamiliar tool.',
          parameters: {
            type: 'object',
            properties: {
              tool_name: { type: 'string', description: 'Name of the tool to look up' }
            },
            required: ['tool_name']
          }
        }
      });

      tools.push({
        type: 'function',
        function: {
          name: 'swarm_history',
          description: 'Statistics over past swarm runs on this device: verified-success rate, tokens per verified result, mean latency, repair frequency, and how runs with and without critics compare. Use it to decide whether a swarm is worth its cost for a task like this one.',
          parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many recent runs to list (default 10, max 25)' }, group_by: { type: 'string', enum: ['critic', 'check', 'isolated', 'criteria'], description: 'Compare runs with and without this feature (default critic)' } }, required: [] }
        }
      });
      tools.push({
        type: 'function',
        function: {
          name: 'spawn_swarm',
          description: 'Spawn a multi-agent swarm with a Manager and specialised Worker agents that share a live memory state. Workers can read what others have written and build on each other\'s outputs — unlike sub-agents, they communicate.\n\nUse for:\n- Full-stack tasks where frontend needs to know the backend API\n- Parallel investigation across different parts of a codebase\n- Tasks that decompose cleanly into independent specialisms (auth, DB, UI, tests, docs…)\n- Any task where agents need to hand off structured data to each other\n\nWorkflow:\n1. The Manager designs the worker roles and their execution order (sequential waves or independent)\n2. Workers run in order — each sees the shared memory written by earlier workers\n3. Workers can write keys to shared memory that later workers read\n4. The Manager synthesises all worker summaries into a final answer\n\nShared memory is a simple key/value store — workers write things like\n  {"api_endpoints": "/api/v1/users POST, /api/v1/users/:id GET"}\nand later workers read those keys to stay consistent.',
          parameters: {
            type: 'object',
            properties: {
              goal: { type: 'string', description: 'The high-level goal for the entire swarm — a few sentences describing what should be accomplished' },
              workers: {
                type: 'array',
                description: 'Worker agents. By default they run in listed order; use depends_on for a dependency graph so independent workers can run concurrently.',
                items: {
                  type: 'object',
                  properties: {
                    name:  { type: 'string', description: 'Short identifier, e.g. "backend", "auth", "tests"' },
                    role:  { type: 'string', description: 'One sentence describing what this worker does' },
                    task:  { type: 'string', description: 'Detailed instructions for the worker. Mention which shared memory keys to READ and which to WRITE.' },
                    tools: { type: 'array', items: { type: 'string' }, description: 'Tool names this worker may use. Defaults to read+write tools.' },
                    reads_from:  { type: 'array', items: { type: 'string' }, description: 'Shared memory keys this worker will read (optional, for documentation)' },
                    writes_to:   { type: 'array', items: { type: 'string' }, description: 'Shared memory keys this worker will write (optional, for documentation)' },
                    max_iterations: { type: 'number', description: 'Soft round budget for this worker (default 10, max 25). Extended automatically while it makes progress; a final report is always produced.' },
                    depends_on: { type: 'array', items: { type: 'string' }, description: 'Names of workers that must finish first. If NO worker sets depends_on, workers run in listed order. Workers with no unmet dependencies may run concurrently.' },
                    owns: { type: 'array', items: { type: 'string' }, description: 'Glob patterns of files this worker may write, e.g. ["src/api/**"]. Required (and disjoint) for workers to write concurrently.' },
                    on_failure: { type: 'string', enum: ['block', 'abort', 'continue'], description: 'If this worker fails: block dependents (default), abort the whole swarm, or continue as if it succeeded.' },
                    retries: { type: 'number', description: 'Automatic retries after a transient API failure (default 1, max 2)' },
                    kind: { type: 'string', enum: ['worker', 'critic'], description: 'A "critic" is a read-only adversarial reviewer of the worker named in "reviews". It must cite evidence and end with VERDICT: APPROVE or VERDICT: REVISE; on REVISE the author is sent back to fix the issues (up to max_revisions).' },
                    reviews: { type: 'string', description: 'For kind "critic": the name of the worker whose output it reviews. The critic automatically runs after that worker.' },
                    max_revisions: { type: 'number', description: 'For critics: how many times the author may be sent back (0-2, default 1). If the critic still objects, the critic is reported incomplete and its dependents are blocked.' },
                    check_command: { type: 'string', description: 'Command the worker must pass before it counts as done (e.g. its tests). A failure is fed back to the worker, which gets extra rounds to fix it.' },
                    check_retries: { type: 'number', description: 'How many times a failed check_command is fed back to the worker (0-3, default 2).' },
                    model: { type: 'string', description: 'Optional model id for this worker (e.g. a cheaper model for read-only exploration). Defaults to the current model.' },
                    token_budget: { type: 'number', description: 'Optional cap on this worker\'s output tokens (min 256). The worker is asked to wrap up when it is reached. 0 or omitted = unlimited.' }
                  },
                  required: ['name', 'role', 'task']
                }
              },
              max_worker_iterations: { type: 'number', description: 'Default soft round budget for workers that do not set max_iterations (default 10). Budgets extend while a worker makes progress.' },
              concurrency: { type: 'number', description: 'Workers to run at once (1-4, default 1). Only honoured when concurrent writers have disjoint "owns".' },
              isolate: { type: 'boolean', description: 'Give every worker its own Git worktree (requires the companion and a Git project root in Harness settings). Changes are merged onto one reviewable branch and never touch the working tree until the user merges them. Strongly recommended for concurrent or multi-file work.' },
              contract: { type: 'object', description: 'What "done" means, fixed up front. acceptance_criteria: list of strings or {text, owner} that an INDEPENDENT verifier (own context, read-only) must confirm with evidence; failing criteria send their owner worker back for targeted repair (repair_rounds, default 1, max 2). token_budget / deadline_minutes bound the whole swarm and keep 20% in reserve for verification. verifier_model optionally uses a different model for verification.',
                properties: { acceptance_criteria: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { text: { type: 'string' }, owner: { type: 'string' } }, required: ['text'] }] } }, token_budget: { type: 'number' }, deadline_minutes: { type: 'number' }, repair_rounds: { type: 'number' }, verifier_model: { type: 'string' } } },
              verify_command: { type: 'string', description: 'Optional test command run after all workers finish; its result decides whether the swarm is reported as verified.' }
            },
            required: ['goal', 'workers']
          }
        }
      });

      tools.push({
        type: 'function',
        function: {
          name: 'deep_research',
          description: 'Perform deep iterative web research on a topic. Generates multiple search queries, reads top results using web_search and fetch_url, and synthesizes a comprehensive report with citations. Requires companion server. Use for complex questions requiring thorough investigation.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'The research question or topic to investigate deeply' },
              depth: { type: 'number', description: 'Research depth: 1=Quick, 2=Standard (default), 3=Exhaustive' }
            },
            required: ['query']
          }
        }
      });

      // Respect user's per-tool opt-outs (settings → Tools → Enabled Tools).
      // Visible reasoning is optional; model-native reasoning does not need a tool.
      // ask_user has its own dedicated toggle (allowAskUser) in addition to the
      // generic list, since disabling it changes agent behavior (never interrupts)
      // rather than just trimming context.
      let filtered = tools;
      if (!state.allowAskUser) filtered = filtered.filter(t => t.function.name !== 'ask_user');
      if (!state.experimentalMode) filtered = filtered.filter(t => t.function.name !== 'set_invariants');
      if (state.disabledTools && state.disabledTools.size) {
        filtered = filtered.filter(t => !state.disabledTools.has(t.function.name));
      }
      filtered.push(...harnessFeatureToolDefs());
      if(featureTask()) filtered = filtered.filter(t => !state.mcpServerMap?.[t.function.name]);
      if (state.compactTools && !full) {
        const core = new Set(['read_file', 'read_file_lines', 'list_directory', 'search_files', 'grep', 'edit_file', 'write_file', 'execute_command', 'run_tests', 'update_plan', 'ask_user', 'get_tool_schema']);
        const hidden = filtered.filter(t => !core.has(t.function.name) && !state.discoveredTools?.has(t.function.name));
        filtered = filtered.filter(t => core.has(t.function.name) || state.discoveredTools?.has(t.function.name));
        const discover = filtered.find(t => t.function.name === 'get_tool_schema');
        if (discover) discover.function.description = 'Load a specialist tool schema before calling it. Available: ' + hidden.map(t => t.function.name).join(', ');
      }
      return filtered;
    }

    const TOOL_ICONS = { swarm_history: 'chart-line', think: 'brain', update_plan: 'list-check', update_beliefs: 'brain', set_invariants: 'shield-halved', ask_user: 'circle-question', save_memory: 'floppy-disk', read_file: 'file-code', read_file_summary: 'file-lines', read_file_lines: 'file-lines', view_image: 'image', edit_file: 'pen-to-square', write_file: 'file-circle-plus', write_file_chunked: 'file-circle-plus', list_directory: 'list', search_files: 'magnifying-glass', grep: 'magnifying-glass-plus', web_search: 'globe', fetch_url: 'magnifying-glass', http_request: 'satellite-dish', execute_command: 'terminal', run_tests: 'flask-vial', start_dev_server: 'server', delete_file: 'trash', move_file: 'arrows-turn-right', git_status: 'code-branch', git_diff: 'code-compare', git_log: 'clock-rotate-left', git_add: 'plus', git_commit: 'check', git_push: 'cloud-arrow-up', git_checkout_branch: 'code-branch', git_stash: 'box-archive', browser_launch: 'rocket', browser_navigate: 'compass', browser_screenshot: 'camera', browser_console: 'terminal', browser_click: 'hand-pointer', browser_type: 'keyboard', browser_evaluate: 'code', browser_get_content: 'file-lines', browser_wait_for: 'hourglass', browser_hover: 'arrow-pointer', hand_pointer: 'list-dropdown', browser_press_key: 'keyboard', browser_scroll: 'arrows-up-down', browser_go_back: 'arrow-left', browser_go_forward: 'arrow-right', browser_close: 'xmark', browser_select_option: 'hand-pointer', semantic_search: 'brain', spawn_sub_agent: 'sitemap', spawn_swarm: 'network-wired', swarm_memory_write: 'database', swarm_message: 'comments', get_tool_schema: 'book-open', screenshot: 'desktop', deep_research: 'flask' };

    // All tools, including visible reasoning, may be disabled.
    const TOOL_TOGGLE_LOCKED = new Set();

    function renderToolList() {
      const defs = getAllToolDefsUnfiltered();
      const el = document.getElementById('tools-list');
      if (el) {
        el.innerHTML = defs.filter(t => !state.disabledTools?.has(t.function.name)).map(t => {
          const n = t.function.name;
          const live = ((n === 'execute_command' || n === 'web_search') && state.compConnected) || (n.startsWith('browser_') && state.browserAvailable) ? ' live' : '';
          return `<div class="tool-tag${live}" title="${t.function.description}"><i class="fas fa-${TOOL_ICONS[n] || 'bolt'}"></i> ${n}</div>`;
        }).join('');
      }
      renderToolToggleList(defs);
    }

    // Unfiltered tool list (ignores disabledTools) — used to populate the
    // settings toggle UI itself, so a disabled tool still shows up to re-enable.
    function getAllToolDefsUnfiltered() {
      const savedDisabled = state.disabledTools;
      const savedAllowAsk = state.allowAskUser;
      const savedExperimental = state.experimentalMode;
      state.disabledTools = new Set();
      state.allowAskUser = true;
      state.experimentalMode = true;
      const defs = getToolDefs(true);
      state.disabledTools = savedDisabled;
      state.allowAskUser = savedAllowAsk;
      state.experimentalMode = savedExperimental;
      return defs;
    }

    function renderToolToggleList(defs) {
      const el = document.getElementById('tool-toggle-list');
      if (!el) return;
      defs = defs || getAllToolDefsUnfiltered();
      el.innerHTML = defs.map(t => {
        const n = t.function.name;
        const locked = TOOL_TOGGLE_LOCKED.has(n);
        const checked = !state.disabledTools.has(n);
        return `<label class="tool-toggle-row" title="${esc(t.function.description)}">` +
          `<input type="checkbox" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''} onchange="toggleToolEnabled('${n}', this.checked)">` +
          `<i class="fas fa-${TOOL_ICONS[n] || 'bolt'}"></i> ${n}` +
          `</label>`;
      }).join('');
    }

    function onShellAutoApproveChange() {
      const parent = document.getElementById('s-shell-autoapprove');
      const child = document.getElementById('s-shell-autoapprove-dangerous');
      if (!parent || !child) return;
      child.disabled = !parent.checked;
      if (!parent.checked) child.checked = false;
    }

    function toggleToolEnabled(name, enabled) {
      if (TOOL_TOGGLE_LOCKED.has(name)) return;
      if (enabled) state.disabledTools.delete(name);
      else state.disabledTools.add(name);
      renderToolList();
      persistSettings();
    }


    async function retrySingleTool(panel) {
      if (state.running) return;
      const toolCallId = panel.el._toolCallId;
      if (!toolCallId) {
        showToast('Cannot retry — tool call ID not available', 'warn');
        return;
      }

      // 1. Locate the tool result and its parent assistant message in history
      const toolResultIdx = state.messages.findIndex(m => m.role === 'tool' && m.tool_call_id === toolCallId);
      if (toolResultIdx < 0) {
        showToast('Cannot retry — tool result not found in history', 'warn');
        return;
      }

      let assistantIdx = -1;
      let targetToolCall = null;
      for (let i = toolResultIdx - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m.role === 'assistant' && m.tool_calls) {
          const foundTc = m.tool_calls.find(t => t.id === toolCallId);
          if (foundTc) { assistantIdx = i; targetToolCall = foundTc; break; }
        }
      }

      if (assistantIdx < 0 || !targetToolCall) {
        showToast('Cannot retry — parent assistant message not found', 'warn');
        return;
      }

      // 2. Preserve the assistant's text content so context isn't lost on retry
      const assistantMsg = state.messages[assistantIdx];
      const preservedText = assistantMsg.content || null;
      const toolName = targetToolCall.function.name;
      const toolArgs = targetToolCall.function.arguments;

      // 3. Truncate history to BEFORE the assistant message.
      //    This safely discards the entire parallel batch, all tool results,
      //    and any subsequent assistant replies, preventing API format violations.
      state.messages = state.messages.slice(0, assistantIdx);

      // 4. Inject a targeted instruction forcing the LLM to re-execute exactly this tool.
      //    We inject this as a 'user' message so the API accepts it cleanly.
      state.messages.push({
        role: 'user',
        content: `[SYSTEM: Retry specific tool. You MUST call exactly this tool and ONLY this tool in your response. Do not output any text.\n\nTool: ${toolName}\nArguments: ${toolArgs}]`
      });

      // 5. Restore assistant text as a synthetic "thinking" block so context is preserved.
      //    Without this, any explanation or context the assistant provided would be silently
      //    lost, potentially breaking the agent's understanding of what it was doing.
      if (preservedText) {
        state.messages.push({
          role: 'assistant',
          content: preservedText
        });
        state.messages.push({
          role: 'user',
          content: '[SYSTEM: Retry — the previous tool call failed. Do NOT output any text. Call the exact same tool with the exact same arguments.]'
        });
      }

      // 6. Clean up the DOM from the assistant message down to the bottom of the chat
      let domElToRemove = panel.el;
      let prev = panel.el.previousElementSibling;

      while (prev) {
        // Tool panels belonging to the same parallel batch
        if (prev.classList.contains('tool-panel') && prev._batchId === panel.el._batchId) {
          domElToRemove = prev;
          prev = prev.previousElementSibling;
          continue;
        }
        // The assistant message that initiated the batch — include in deletion
        if (prev.classList.contains('msg') && prev._msgIndex === assistantIdx) {
          domElToRemove = prev;
          break;
        }
        // Unrelated user/agent message — safety boundary, stop walking backwards
        if (prev.classList.contains('msg')) {
          break;
        }
        // Associated UI elements: think blocks, diff panels, search panels,
        // sub-agent panels, verify indicators, compact banners, etc.
        domElToRemove = prev;
        prev = prev.previousElementSibling;
      }

      // Remove everything from the target element to the end of the chat
      let curr = domElToRemove;
      while (curr && curr.parentNode === $msg()) {
        const next = curr.nextElementSibling;
        curr.remove();
        curr = next;
      }

      // FIX: Re-index remaining .msg elements so pruneMsg() and retryMsg() use correct indices.
      // Without this, a message originally at index 15 would still have _msgIndex=15 even after
      // 6 messages before it were removed — causing pruneMsg() to splice the wrong position
      // in state.messages, silently corrupting context on subsequent edits.
      let newIndex = 0;
      const remainingMsgs = $msg().querySelectorAll('.msg');
      for (const el of remainingMsgs) {
        if (el._msgIndex !== undefined) {
          el._msgIndex = newIndex++;
        }
      }

      // 7. Reset streaming state and restart the agent loop.
      //    The agent loop will immediately pick up the new user message, call the tool,
      //    and handle all SVGs, image previews, and diff rendering natively.
      streamEl = null;
      agentLoop();
    }

    /* ═══════════════ DEV SERVER ═══════════════ */
    function pollDevServer(port) {
      stopDevPolling();
      const maxPolls = 60; // 60 * 2s = 2 minutes max startup wait
      let polls = 0;

      state.devServer.pollInterval = setInterval(async () => {
        if (!state.devServer || state.devServer.port !== port) {
          stopDevPolling();
          return;
        }
        if (++polls > maxPolls) {
          stopDevPolling();
          return;
        }

        try {
          const res = await companionFetch(`${state.compUrl}/dev_status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port }),
            signal: AbortSignal.timeout(3000)
          });
          const data = await res.json();

          if (!data.alive) {
            stopDevPolling();
            updateDevPreviewUI('error');
            appendMsg('system', `Dev server exited unexpectedly (port ${port}). Check the terminal output for errors.`);
            state.devServer = null;
            return;
          }

          if (data.ready && !state.devServer.ready) {
            state.devServer.ready = true;
            updateDevPreviewUI('ready');
            switchRpTab('preview');
            showToast(`Dev server ready → http://localhost:${port}`, 'ok');
          }
        } catch {
          // Network error — companion may have disconnected
        }
      }, 2000);
    }

    function stopDevPolling() {
      if (state.devServer?.pollInterval) {
        clearInterval(state.devServer.pollInterval);
        state.devServer.pollInterval = null;
      }
    }

    async function stopDevServer() {
      if (!state.devServer) return;
      const { port } = state.devServer;
      stopDevPolling();

      try {
        await companionFetch(`${state.compUrl}/dev_stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port }),
          signal: AbortSignal.timeout(5000)
        });
      } catch { /* ignore */ }

      updateDevPreviewUI('stopped');
      state.devServer = null;
      // Then optionally hide after a delay:
      setTimeout(() => { if (!state.devServer) updateDevPreviewUI('stopped'); }, 2000);
    }

    function updateDevPreviewUI(status) {
      const header = document.getElementById('rp-preview-header');
      const statusEl = document.getElementById('rp-preview-status');
      const iframe = document.getElementById('rp-preview-iframe');
      const emptyEl = document.getElementById('rp-preview-empty');
      const activeEl = document.getElementById('rp-preview-active');
      const bar = document.getElementById('rp-preview-bar');
      const badge = document.getElementById('rp-preview-badge');

      if (!state.devServer) {
        emptyEl.style.display = '';
        activeEl.style.display = 'none';
        if (badge) badge.style.display = 'none';
        return;
      }

      emptyEl.style.display = 'none';
      activeEl.style.display = 'flex';
      if (bar) bar.style.display = 'flex';

      const { port } = state.devServer;
      const urlEl = document.getElementById('rp-preview-url');
      if (urlEl) urlEl.textContent = `localhost:${port}`;

      const statusMap = {
        starting: { text: 'Starting...', color: 'var(--yellow)', icon: 'fa-spinner fa-spin', badgeColor: 'var(--yellow)' },
        ready: { text: 'Running', color: 'var(--green)', icon: 'fa-circle', badgeColor: 'var(--green)' },
        error: { text: 'Error', color: 'var(--red)', icon: 'fa-circle-exclamation', badgeColor: 'var(--red)' },
        stopped: { text: 'Stopped', color: 'var(--tx-4)', icon: 'fa-stop', badgeColor: 'var(--tx-4)' }
      };
      const s = statusMap[status] || statusMap.stopped;

      if (statusEl) {
        statusEl.innerHTML = `<i class="fas ${s.icon}" style="font-size:8px"></i> ${s.text}`;
        statusEl.style.color = s.color;
      }
      if (badge) {
        badge.style.display = '';
        badge.style.background = s.badgeColor;
      }

      if (status === 'ready' && iframe && iframe.src !== `http://localhost:${port}/`) {
        iframe.src = `http://localhost:${port}/`;
      }

      if (status === 'error' && header) {
        header.style.borderBottomColor = 'rgba(239,68,68,.3)';
      } else if (header) {
        header.style.borderBottomColor = '';
      }
    }

    function reloadDevPreview() {
      const iframe = document.getElementById('rp-preview-iframe');
      if (iframe && state.devServer) {
        iframe.src = iframe.src;
      }
    }

    function setDevPreviewWidth(btn, width) {
      const wrap = document.getElementById('rp-preview-iframe-wrap');
      const iframe = document.getElementById('rp-preview-iframe');
      if (!wrap) return;
      if (width === '100%') {
        wrap.style.maxWidth = 'none';
        wrap.style.margin = '0';
        iframe.style.maxWidth = 'none';
      } else {
        wrap.style.maxWidth = width;
        wrap.style.margin = '0 auto';
        iframe.style.maxWidth = width;
      }
      document.querySelectorAll('#rp-preview-bar .device-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }

    /* ═══════════════ SEMANTIC CODE SEARCH ═══════════════ */
    function openIDB(name, version, storeName) {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open(name, version);
          req.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (storeName && !db.objectStoreNames.contains(storeName)) {
              db.createObjectStore(storeName, { keyPath: 'path' });
            }
          };
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(req.result);
        });
    }

    function cosineSimilarity(a, b) {
      let dot = 0, na = 0, nb = 0;
      const len = Math.min(a.length, b.length);
      for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
      return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
    }

    class EmbeddingService {
      constructor() { this.model = null; this.ready = false; this.loading = false; this.error = null; this._loadPromise = null; }
      async load() {
        if (this._loadPromise) return this._loadPromise;
        this._loadPromise = this._doLoad().finally(() => {
          if (!this.ready) this._loadPromise = null; // allow retry on failure
        });
        return this._loadPromise;
      }
      async _doLoad() {
        this.loading = true; this.error = null;
        updateEmbeddingUI('loading');
        try {
          const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
          env.allowLocalModels = false;
          this.model = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
            progress_callback: (p) => {
              if (p.status === 'progress') updateEmbeddingUI('downloading', p.progress);
              else if (p.status === 'ready') updateEmbeddingUI('ready');
              else if (p.status === 'downloading') updateEmbeddingUI('downloading', 0);
            }
          });
          const test = await this.model('test query', { pooling: 'mean', normalize: true });
          if (!test?.data?.length) throw new Error('Model output unexpected');
          this.ready = true; this.loading = false;
          updateEmbeddingUI('ready');
        } catch (e) {
          this.error = e.message; this.loading = false; this.ready = false;
          updateEmbeddingUI('error', e.message);
          console.error('[embed] load error:', e);
        }
      }
      async embed(text) {
        if (!this.ready) throw new Error(this.error || 'Model not loaded');
        const r = await this.model(text, { pooling: 'mean', normalize: true });
        // all-MiniLM-L6-v2 has fixed dimension 384
        return new Float32Array(r.data.slice(0, 384));
      }
      async embedBatch(texts, bs = 16) {
            if (!this.ready) throw new Error(this.error || 'Model not loaded');
            const DIM = 384; // Hardcoded for all-MiniLM-L6-v2
            const res = [];
            for (let i = 0; i < texts.length; i += bs) {
              const batchTexts = texts.slice(i, i + bs);
              const out = await this.model(batchTexts, { pooling: 'mean', normalize: true });
              for (let j = 0; j < out.data.length; j += DIM) {
                res.push(new Float32Array(out.data.slice(j, j + DIM)));
              }
            }
            return res;
          }
      isReady() { return this.ready; }
      retryLoad() {
          this.error = null;
          this._loadPromise = null;
          updateEmbeddingUI(semanticIndex.size > 0 ? 'ready' : 'empty');
      }
    }

    const embeddingService = new EmbeddingService();

    class SemanticIndex {
      constructor() {
        this.embeddings = new Map();
        this.fileMeta = new Map();
        this.indexing = false;
        this.cancelled = false;
        this.lastIndexed = null;
      }
      clear() {
        this.embeddings.clear();
        this.fileMeta.clear();
        this.indexing = false;
        this.lastIndexed = null;
        updateEmbeddingUI('empty');
      }

      get size() { return this.embeddings.size; }

      has(p) { return this.embeddings.has(p); }

      async addFile(path, content) {
        const mx = 6000;
        let t = content;
        if (t.length > mx) t = t.slice(0, mx) + '...';
        const emb = await embeddingService.embed(t);
        this.embeddings.set(path, emb);
        this.fileMeta.set(path, {
          summary: content.split('\n').slice(0, 3).join('\n').slice(0, 120),
          charCount: content.length,
          timestamp: Date.now()
        });
      }

      remove(p) {
        this.embeddings.delete(p);
        this.fileMeta.delete(p);
      }

      search(qEmb, topK = 8) {
        const r = [];
        for (const [p, e] of this.embeddings) {
          r.push({
            path: p,
            score: cosineSimilarity(qEmb, e),
            summary: (this.fileMeta.get(p) || {}).summary || ''
          });
        }
        r.sort((a, b) => b.score - a.score);
        return r.slice(0, topK);
      }
    }

    const semanticIndex = new SemanticIndex();

    const _embedUpdateTimers = new Map();
    function debouncedEmbedUpdate(path) {
      if (_embedUpdateTimers.size > 200) {
        // Evict oldest 50 entries
        const keys = [..._embedUpdateTimers.keys()].slice(0, 50);
        keys.forEach(k => { clearTimeout(_embedUpdateTimers.get(k)); _embedUpdateTimers.delete(k); });
      }
      clearTimeout(_embedUpdateTimers.get(path) || 0);
      _embedUpdateTimers.set(path, setTimeout(async () =>{
        try {
          if (!embeddingService.isReady() || !state.dirHandle) return;
          const c = state.fileCache.get(path); if (!c) return;
          await semanticIndex.addFile(path, c);
          semanticIndex.indexedFiles = semanticIndex.size;
          updateEmbeddingUI(semanticIndex.indexing ? 'indexing' : 'ready');
          debouncedPersistEmbeddings();
        } catch { }
      }, 2000));
    }

    let _embedPersistTimer = null;
    function debouncedPersistEmbeddings() {
      clearTimeout(_embedPersistTimer);
      _embedPersistTimer = setTimeout(persistEmbeddingsToIDB, 10000);
    }

    async function persistEmbeddingsToIDB() {
        try {
          const db = await openIDB('sloplobster', 2, 'embeddings');
          const tx = db.transaction('embeddings', 'readwrite');
          const store = tx.objectStore('embeddings');
          store.clear();

          for (const [path, embedding] of semanticIndex.embeddings) {
            const meta = semanticIndex.fileMeta.get(path) || {};
            store.put({
              path,
              embedding: Array.from(embedding),
              summary: meta.summary || '',
              charCount: meta.charCount || 0,
              timestamp: meta.timestamp || 0
            });
          }

          await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          });

          console.log('[index] persisted', semanticIndex.embeddings.size);
        } catch (e) {
          console.error('[index] persist error:', e);
        }
    }

    async function loadEmbeddingsFromIDB() {
        try {
          const db = await openIDB('sloplobster', 2, 'embeddings');
          const tx = db.transaction('embeddings', 'readonly');
          const store = tx.objectStore('embeddings');
          const entries = [];

          await new Promise((resolve, reject) => {
            const req = store.openCursor();
            req.onerror = () => reject(req.error);
            req.onsuccess = function(event) {
              const cursor = event.target.result;
              if (!cursor) { resolve(entries); return; }
              const val = cursor.value;
              if (val && val.embedding) {
                entries.push({
                  key: cursor.primaryKey,
                  value: new Float32Array(val.embedding),
                  meta: { summary: val.summary || '', charCount: val.charCount || 0, timestamp: val.timestamp || 0 }
                });
              }
              cursor.continue();
            };
          });

          semanticIndex.indexedFiles = entries.length;
          for (const entry of entries) {
            semanticIndex.embeddings.set(entry.key, entry.value);
            semanticIndex.fileMeta.set(entry.key, entry.meta);
          }
        } catch (e) { console.error('[index] load error:', e); }
    }

    async function startIndexing() {
      if (!state.dirHandle || semanticIndex.indexing) return;
      semanticIndex.clear();
      semanticIndex.indexing = true;
      semanticIndex.cancelled = false;
      updateEmbeddingUI('indexing');
      try {
        const files = [];
        let skippedCount = 0;
        async function walk(h, pfx, d) {
          if (d > LIMITS.EMBEDDING_DEPTH) return;
          try {
            for await (const [n, kh] of h.entries()) {
              if (SKIP.has(n)) { skippedCount++; continue; }
              const full = pfx ? pfx + '/' + n : n;
              if (kh.kind === 'file') files.push(full);
              if (kh.kind === 'directory') {
                try { await walk(kh, full, d + 1); } catch {}
              }
            }
          } catch (e) {
            if (files.length === 0) throw e;
          }
        }
        await walk(state.dirHandle, '', 0);
        semanticIndex.totalFiles = files.length;
        if (files.length === 0 && skippedCount > 0) {
          semanticIndex.indexing = false; updateEmbeddingUI('empty'); return;
        }
        if (files.length === 0) { semanticIndex.indexing = false; updateEmbeddingUI('empty'); return; }

        const skipExts = new Set(['png','jpg','jpeg','gif','webp','bmp','ico','pdf','zip','tar','gz','exe','dll','so','o','a','wasm','svg','mp3','mp4','wav','ogg','mpg','mov','avi']);
        const embeddable = files.filter(f => !skipExts.has(f.split('.').pop().toLowerCase()));
        if (!embeddingService.isReady()) { semanticIndex.indexing = false; updateEmbeddingUI('unavailable'); return; }

        const BATCH_READ = 10, BATCH_EMBED = 16, MAX_FILE = 50000;
        let rb = []; let rc = 0;
        for (let i = 0; i < embeddable.length; i++) {
          if (semanticIndex.cancelled) break;
          rb.push(embeddable[i]); rc++;
          updateEmbeddingUI('reading', null, null, null, rc, embeddable.length);
          if (rb.length >= BATCH_READ || i === embeddable.length - 1) {
            const contents = [], vp = [];
            for (const p of rb) {
              try {
                const h = await resolvePath(p); if (h.kind !== 'file') continue;
                const f = await h.getFile();
                if (f.size > MAX_FILE) continue;
                const b = await f.slice(0, 8000).arrayBuffer(); const by = new Uint8Array(b);
                if (by.some(x => x === 0)) continue;
                contents.push(await f.text()); vp.push(p);
              } catch { /* skip */ }
            }
            rb = [];
            if (vp.length > 0) {
              const embs = await embeddingService.embedBatch(contents, BATCH_EMBED);
              for (let j = 0; j < vp.length; j++) {
                if (semanticIndex.cancelled) break;
                semanticIndex.embeddings.set(vp[j], embs[j]);
                semanticIndex.fileMeta.set(vp[j], { summary: contents[j].split('\n').slice(0, 3).join('\n').slice(0, 120), charCount: contents[j].length, timestamp: Date.now() });
                semanticIndex.indexedFiles++;
                updateEmbeddingUI('indexing', null, null, null, semanticIndex.indexedFiles, embeddable.length);
              }
            }
          }
        }
        semanticIndex.indexing = false; semanticIndex.lastIndexed = Date.now();
        updateEmbeddingUI('ready');
        debouncedPersistEmbeddings();
      } catch (e) {
        console.error('[index] error:', e);
        semanticIndex.indexing = false;
        updateEmbeddingUI('error', e.message);
      }
    }

    function cancelIndexing() {
      semanticIndex.cancelled = true;
      if (semanticIndex.indexing) { semanticIndex.indexing = false; updateEmbeddingUI('ready'); }
    }

    async function getQueryEmbedding(text) {
      if (!embeddingService.isReady()) {
        return null;
      }
      try {
        return await embeddingService.embed(text);
      } catch {
        return null;
      }
    }

    async function doSemanticSearch(query, topK = 8) {
        if (!query) return { output: 'Error: "query" is required for semantic_search. Example: semantic_search({"query": "find the auth middleware"})' };

        if (!state.dirHandle) return { output: 'No workspace open. Open a directory to enable semantic search.' };

        const indexedCount = semanticIndex.size;
        const isReady = embeddingService.isReady();

        // ── Not ready: fall back to grep ──
        if (!isReady) {
          const gr = await grepSafe(query, '', '', '', 0);
          return {
            output: '[Semantic search not ready — ' + (embeddingService.error || 'model still loading') + '. Using grep fallback. Results may be less accurate.]\n\n' + gr.output + '\n\n[TIP: Wait for the model to finish loading (~22MB first-time download), then call semantic_search again for better results.]',
            _fallback: true
          };
        }

        // ── Empty index: tell the agent what's going on ──
        if (indexedCount === 0) {
          return { output: '[Semantic index is empty — no files indexed yet. Indexing runs when you open a directory and after file changes. Try again in a moment.]' };
        }

        // ── Get query embedding ──
        const qEmb = await getQueryEmbedding(query);
        if (!qEmb) {
          // getQueryEmbedding already logs the error internally
          const gr = await grepSafe(query, '', '', '', 0);
          return { output: '[Failed to generate query embedding. Using grep fallback.]\n\n' + gr.output, _fallback: true };
        }

        // ── Search the index ──
        const results = semanticIndex.search(qEmb, topK);

        // ── No matches: give actionable diagnostics ──
        if (results.length === 0) {
          const workspaceFiles = state.fileTree.filter(f => f.k === 'file' && !SKIP.has(f.n));
          const unindexed = workspaceFiles.length - indexedCount;
          const diagnostics = [];
          if (unindexed > 0) {
            diagnostics.push(unindexed + ' file(s) not yet indexed');
          }
          const fallbackHint = diagnostics.length
            ? '\n\n[Indexed ' + indexedCount + ' of ' + workspaceFiles.length + ' workspace files. ' + diagnostics.join('. ') + '.]'
            : '';

          const gr = await grepSafe(query, '', '', '', 0);
          return {
            output: '[No semantic matches in ' + indexedCount + ' indexed file' + (indexedCount !== 1 ? 's' : '') + '. Your query may be too specific or use different terminology than the actual code.' + fallbackHint + '\n\n[Falling back to grep:]\n' + gr.output,
            _fallback: true
          };
        }

        // ── Build result output with context snippets ──
        const CTX = 5;
        let output = '';

        for (let i = 0; i < Math.min(results.length, CTX); i++) {
          let snip = '';
          try {
            const h = await resolvePath(results[i].path);
            if (h.kind !== 'file') continue;
            const f = await h.getFile();
            const t = await f.text();
            snip = t.split('\n').slice(0, 4).join('\n');
          } catch { /* skip unreadable files */ }
          output += (i + 1) + '. ' + results[i].path + ' (relevance: ' + results[i].score.toFixed(2) + ')\n';
          if (snip.trim()) output += '   ' + snip.trimEnd() + '\n';
          output += '\n';
        }

        for (let i = CTX; i < results.length; i++) {
          output += (i + 1) + '. ' + results[i].path + ' (relevance: ' + results[i].score.toFixed(2) + ')\n';
        }

        output += '\n[Top ' + CTX + ' results include context lines. Use read_file or read_file_lines for details. Score: 1.0 = perfect, 0.0 = unrelated]';

        return { output, _results: results };
      }

    /* ═══════════════ FILE SYSTEM ═══════════════ */
    const SKIP = new Set([
      'node_modules', '.git', '.svn', '__pycache__', '.venv', 'venv',
      '.next', '.nuxt', 'dist', 'build', '.cache', '.parcel-cache',
      'coverage', '.tox', '.DS_Store', 'Thumbs.db',
      '.mypy_cache', '.pytest_cache', '.turbo',
      'SlopLobster-companion.py', '.sloplobster', '.hg'
    ]);

    const MAX_CACHE_BYTES = 50 * 1024 * 1024;
    function cacheSet(key, value) {
      state.fileCache.set(key, value);
      let total = 0; for (const [, v] of state.fileCache) total += v.length;
      if (total > MAX_CACHE_BYTES) {
        for (const [k, v] of state.fileCache) {
          if (total <= MAX_CACHE_BYTES * 0.7) break;
          total -= v.length;
          state.fileCache.delete(k);
        }
      }
    }

    function isSkippedPath(raw) {
      if (!raw) return false;
      const segs = raw.replace(/\\/g, '/').split('/').filter(Boolean);
      if (!segs.length) return false;
      const fileName = segs[segs.length - 1];
      if (SKIP.has(fileName) || SKIP.has(segs[0])) return true;
      if (/^\.sloplobster-progress-/.test(fileName)) return true;
      return false;
    }

    // The progress file is intentionally hidden from listing/grep/edit/delete/move
    // (via isSkippedPath) so the agent can't tamper with its own recovery notes or
    // have them clutter search results. But it must still be READABLE, since the
    // agent is explicitly instructed to recover context from it after compaction.
    // Keep this narrow: matches the exact generated filename pattern only.
    function isProgressFile(raw) {
      if (!raw) return false;
      const segs = raw.replace(/\\/g, '/').split('/').filter(Boolean);
      if (!segs.length) return false;
      const fileName = segs[segs.length - 1];
      return /^\.sloplobster-progress-/.test(fileName);
    }

    function isGemma() {
      if (!state.model) return false;
      const id = (state.model || '').toLowerCase();
      return id.includes('gemma');
    }

    function isQwen() {
      if (!state.model) return false;
      const id = (state.model || '').toLowerCase();
      return id.includes('qwen');
    }

    function usesThinkChannels() {
      if (!state.model) return false;
      const id = (state.model || '').toLowerCase();
      return id.includes('gemma') || id.includes('qwen');
    }

    /* ═══════════════ SMART CONTEXT INJECTION ═══════════════ */

    function extractSignaturesJs(source, language) {
      const lines = source.split('\n');
      const result = [];
      const seen = new Set();

      function add(idx, text) {
        const key = idx + ':' + text;
        if (seen.has(key)) return;
        seen.add(key);
        result.push('L' + (idx + 1) + ': ' + text);
      }

      if (language === 'py') {
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i];
          const indent = raw.match(/^(\s*)/)[1];
          const trimmed = raw.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          let m = trimmed.match(/^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
          if (m) { add(i, indent + (m[1] || '') + 'def ' + m[2] + '(' + m[3].slice(0, 80) + ')'); continue; }
          m = trimmed.match(/^class\s+(\w+)(?:\(([^)]*)\))?(?:\s*:)?/);
          if (m) { add(i, indent + 'class ' + m[1] + (m[2] ? '(' + m[2] + ')' : '')); continue; }
          m = trimmed.match(/^@([\w.]+(?:\([^)]*\))?)/);
          if (m) { add(i, indent + '@' + m[1]); continue; }
          if (/^(import|from)\s/.test(trimmed)) { add(i, trimmed.slice(0, 100)); }
        }
      } else if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(language)) {
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i];
          const indent = raw.match(/^(\s*)/)[1];
          const trimmed = raw.trim();
          if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
          let m = raw.match(/^(\s*)(export\s+(?:default\s+)?)?(async\s+)?function\s+(\*?\s*\w+)\s*\(([^)]*)\)/);
          if (m) { add(i, indent + (m[2] || '') + (m[3] || '') + 'function ' + m[4].trim() + '(' + m[5].trim().slice(0, 80) + ')'); continue; }
          m = raw.match(/^(\s*)(export\s+(?:default\s+)?)?(const|let|var)\s+(\w+)\s*=\s*(\([^)]*\)|[^\s=]+?)\s*=>/);
          if (m) { add(i, indent + (m[2] || '') + m[3] + ' ' + m[4] + ' = ' + m[5].trim().slice(0, 60) + ' => ...'); continue; }
          m = raw.match(/^(\s*)(export\s+(?:default\s+)?)?class\s+(\w+)/);
          if (m) { add(i, indent + (m[2] || '') + 'class ' + m[3]); continue; }
          if (indent.length >= 2) {
            m = trimmed.match(/^(async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/);
            if (m) { add(i, indent + (m[1] || '') + m[2] + '(' + m[3].trim().slice(0, 80) + ')'); continue; }
            m = trimmed.match(/^(get|set)\s+(\w+)\s*\(/);
            if (m) { add(i, indent + m[1] + ' ' + m[2] + '(...)'); continue; }
          }
          if (/^(import|export)\s/.test(trimmed)) { add(i, trimmed.slice(0, 100)); }
        }
      } else {
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
          if (/^(function|class|def|pub\s+fn|fn\s|module|impl|trait|struct|enum|interface|type|const|let|var)\s/.test(trimmed)) {
            add(i, trimmed.slice(0, 120));
          }
        }
      }

      return result.length > 0 ? result.join('\n') : null;
    }

    async function getFileSkeleton(source, language, filePath, totalLines) {
      /* ── Try companion for accurate AST-based extraction ── */
      if (state.compConnected && source.length <= 1000000) {
        try {
          const res = await companionFetch(`${state.compUrl}/ast_signatures`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source, language, include_docstrings: true, body_preview_lines: 3 }),
            signal: AbortSignal.timeout(5000)
          });
          if (res.ok) {
            const data = await res.json();
            if (data.outline) {
              return `File: ${filePath} (${totalLines} lines → structure skeleton)\n` +
                `Use read_file_lines with the line numbers below to read specific sections.\n` +
                `═══════════════════════════════════════════════════════════\n\n` +
                data.outline;
            }
          }
        } catch { /* fallback */ }
      }

      /* ── Enhanced client-side extraction ── */
      const outline = extractEnhancedSkeleton(source, language, filePath);
      if (outline) {
        return `File: ${filePath} (${totalLines} lines → structure skeleton)\n` +
          `Use read_file_lines with the line numbers below to read specific sections.\n` +
          `═══════════════════════════════════════════════════════════\n\n` +
          outline;
      }
      return null;
    }

    function requireWorkspace() { if (!state.dirHandle) throw new Error('No workspace directory open'); }

    function extractEnhancedSkeleton(source, language) {
      const lines = source.split('\n');
      const maxLines = 300; // threshold for skeleton mode

      if (lines.length <= maxLines) return null;

      const result = [];
      const BODY_PREVIEW = 3; // lines of body to show after each signature

      if (language === 'py') {
        result.push(`[Imports]`);
        for (let i = 0; i < Math.min(lines.length, 50); i++) {
          const trimmed = lines[i].trim();
          if (/^(import |from )/.test(trimmed)) result.push(`L${i+1}: ${trimmed}`);
          if (trimmed && !/^(import |from |#|""")/.test(trimmed) && result.length > 1) break;
        }

        let inDocstring = false;
        let docstringLines = [];
        let docstringIndent = '';

        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i];
          const trimmed = raw.trim();
          const indent = raw.match(/^(\s*)/)[1];

          // Track docstrings
          if (inDocstring) {
            if (raw.trim() === '"""' || raw.trim() === "'''") {
              inDocstring = false;
              for (const dl of docstringLines) result.push(`  ${dl}`);
              docstringLines = [];
              continue;
            }
            docstringLines.push(`L${i+1}: ${raw}`);
            continue;
          }

          if ((trimmed.startsWith('"""') || trimmed.startsWith("'''")) && trimmed.length > 3) {
            // Single-line docstring
            result.push(`L${i+1}: ${indent}${trimmed}`);
            continue;
          }
          if (trimmed === '"""' || trimmed === "'''") {
            inDocstring = true;
            docstringIndent = indent;
            continue;
          }

          if (!trimmed || trimmed.startsWith('#')) continue;

          let m = trimmed.match(/^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\s:]+))?/);
          if (m) {
            const prefix = indent + (m[1] || '') + 'def ' + m[2];
            const args = m[3].slice(0, 80);
            const ret = m[4] ? ` -> ${m[4]}` : '';
            result.push(`L${i+1}: ${prefix}(${args})${ret}`);

            // Body preview: next non-blank, non-docstring lines
            let bodyCount = 0;
            for (let j = i + 1; j < Math.min(i + 30, lines.length) && bodyCount < BODY_PREVIEW; j++) {
              const bl = lines[j].trim();
              if (!bl || bl === '"""' || bl === "'''" || bl.startsWith('#')) continue;
              if (/^(async\s+)?def\s|^class\s/.test(bl)) break;
              result.push(`L${j+1}: ${lines[j]}`);
              bodyCount++;
            }
            continue;
          }

          m = trimmed.match(/^class\s+(\w+)(?:\(([^)]*)\))?(?:\s*:)?/);
          if (m) {
            const bases = m[2] || '';
            result.push(`L${i+1}: ${indent}class ${m[1]}(${bases})`);

            // Show class-level attributes and first method signatures
            let bodyCount = 0;
            for (let j = i + 1; j < Math.min(i + 60, lines.length); j++) {
              const cl = lines[j].trim();
              if (!cl) continue;
              if (/^class\s/.test(cl)) break;

              const cm = cl.match(/^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
              if (cm) {
                result.push(`L${j+1}: ${lines[j].match(/^(\s*)/)[1]}${cm[1] || ''}def ${cm[2]}(${cm[3].slice(0, 60)})`);
                bodyCount++;
                // Skip body of the method
                let k = j + 1;
                const methodIndent = lines[j].match(/^(\s*)/)[1].length;
                for (; k < lines.length; k++) {
                  const trimmedLine = lines[k].trim();
                  if (!trimmedLine) continue;
                  const lineIndent = lines[k].match(/^(\s*)/)[1].length;
                  if (lineIndent <= methodIndent) {
                    break;
                  }
                }
                j = k - 1;
                continue;
              }

              // Class-level assignment
              const am = cl.match(/^(\w+)\s*(?::\s*[^=]+)?\s*=/);
              if (am && lines[j].match(/^(\s*)/)[1] === indent) {
                result.push(`L${j+1}: ${lines[j]}`);
                bodyCount++;
              }
              if (bodyCount > 8) break;
            }
            result.push(`L${/* approximate end */ i + 1}: ...`);
            continue;
          }
        }
      }

      // Similar enhanced extraction for JS/TS
      else if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(language)) {
        // Collect imports first
        result.push(`[Imports]`);
        for (let i = 0; i < Math.min(lines.length, 50); i++) {
          if (/^(import |export\s+(?:type\s+)?|const\s+\w+\s*=\s*require)/.test(lines[i].trim())) {
            result.push(`L${i+1}: ${lines[i].trim().slice(0, 100)}`);
          }
        }

        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i];
          const trimmed = raw.trim();
          const indent = raw.match(/^(\s*)/)[1];
          if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

          // Functions
          let m = raw.match(/^(\s*)(export\s+(?:default\s+)?)?(async\s+)?function\s+(\*?\s*\w+)\s*\(([^)]*)\)/);
          if (m) {
            result.push(`L${i+1}: ${indent}${m[2] || ''}${m[3] || ''}function ${m[4].trim()}(${m[5].trim().slice(0, 80)})`);
            // Body preview
            let bc = 0;
            for (let j = i + 1; j < Math.min(i + 20, lines.length) && bc < BODY_PREVIEW; j++) {
              const bl = lines[j].trim();
              if (!bl || bl.startsWith('//') || /^(export\s+|function\s|class\s|const\s)/.test(bl)) break;
              result.push(`L${j+1}: ${lines[j]}`);
              bc++;
            }
            continue;
          }

          // Arrow functions / const assignments
          m = raw.match(/^(\s*)(export\s+(?:default\s+)?)?(const|let|var)\s+(\w+)\s*=\s*(\([^)]*\)|[^\s=]+?)\s*=>/);
          if (m) {
            result.push(`L${i+1}: ${indent}${m[2] || ''}${m[3]} ${m[4]} = ${m[5].trim().slice(0, 60)} => ...`);
            continue;
          }

          // Classes
          m = raw.match(/^(\s*)(export\s+(?:default\s+)?)?class\s+(\w+)/);
          if (m) {
            result.push(`L${i+1}: ${indent}${m[2] || ''}class ${m[3]}`);
            // Show methods
            let bc = 0;
            for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
              const cl = lines[j];
              if (!cl.trim()) continue;
              if (/^class\s/.test(cl.trim()) && cl.match(/^(\s*)/)[1].length <= indent.length) break;
              const cm = cl.match(/^\s+(async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/);
              if (cm) {
                result.push(`L${j+1}: ${cl.trim().slice(0, 100)}`);
                bc++;
              }
              if (bc > 12) break;
            }
            continue;
          }
        }
      }

      // Generic fallback
      else {
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
          if (/^(function|class|def|pub\s+fn|fn\s|module|impl|trait|struct|enum|interface|type|const|let|var)\s/.test(trimmed)) {
            result.push(`L${i+1}: ${trimmed.slice(0, 120)}`);
          }
        }
      }

      return result.length > 0 ? result.join('\n') : null;
    }


    async function resolvePath(raw) {
      requireWorkspace(); const segs = sanitizePath(raw); let h = state.dirHandle;
      for (let i = 0; i < segs.length - 1; i++) { if (h.kind !== 'directory') throw new Error(`Cannot traverse into "${segs[i]}" — not a directory`); h = await h.getDirectoryHandle(segs[i]); }
      const last = segs[segs.length - 1];
      try {
        const fh = await h.getFileHandle(last);
        /* Some browsers return a handle for directories too — verify it's actually a file */
        if (fh.kind === 'file') return fh;
        return h.getDirectoryHandle(last);
      } catch {
        return await h.getDirectoryHandle(last);
      }
    }
    function getEffectiveSmartThreshold() {
      if (state.smartContextThreshold > 0) return state.smartContextThreshold;
      // Auto: use ~2% of context window as the threshold
      // A 32k context → skeleton files > 640 lines
      // A 128k context → skeleton files > 2560 lines
      return Math.max(100, Math.floor(state.ctxWindow * 0.02));
    }

     /**
     * Strip body previews and docstrings from a skeleton string.
     * Returns only "fixed parts": imports, function/class signatures with line numbers.
     * This survives compaction, so the agent sees the same structure after compact.
     */
    function stripBodyPreviews(skeletonText) {
      const lines = skeletonText.split('\n');
      const result = [];
      let inImports = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { result.push(line); continue; }

        // Keep structural markers and instructions unconditionally
        if (/^File:/.test(trimmed) ||
            /^Use read_file_lines/.test(trimmed) ||
            /^═+/.test(trimmed)) {
          result.push(line); inImports = false; continue;
        }
        if (/^(?:import |from )/.test(trimmed)) { inImports = true; result.push(line); continue; }
        if (inImports) continue;

        // Keep only signatures (fixed parts)
        if (/^L\d+: (?:async\s+)?(?:def|class)\s/.test(trimmed)) {
          result.push(line); continue;
        }

        // Skip body previews, class attributes, variable assignments, comments, everything else
      }

      return result.join('\n');
    }


    async function readFileSafe(rel) {
      requireWorkspace();
      if (isSkippedPath(rel) && !isProgressFile(rel)) return { output: `File "${rel}" is filtered by workspace rules and cannot be read.` };

      const h = await resolvePath(rel);
      if (h.kind !== 'file') throw new Error(`"${rel}" is a directory`);
      const f = await h.getFile();

      /* ── PDF files: extract text via pdf.js ── */
      if (isPdfFile(f, rel)) {
        const maxB = LIMITS.MAX_PDF_SIZE;
        if (f.size > maxB) return { output: `PDF: ${rel}\nSize: ${(f.size / 1024 / 1024).toFixed(1)} MB\n⚠ Too large to extract (max 100 MB)` };
        try {
          const text = await extractPdfText(f);
          cacheSet(rel, text);
          const thumb = await renderPdfFirstPageThumbnail(f);
          return { output: text, _pdfThumbnail: thumb, _pdfPath: rel, _pdfFile: f };
        } catch (e) { return { output: `PDF: ${rel}\nError: ${e.message}` }; }
      }

      /* ── SVG files: return raw XML markup with rendered preview URL ── */
      if (f.type && f.type.includes('svg')) {
        const maxB = LIMITS.MAX_TEXT_SIZE;
        if (f.size > maxB) return { output: `SVG: ${rel}\nSize: ${(f.size / 1024).toFixed(1)} KB\n⚠ Too large to preview (max 5 MB). Use read_file_lines to read sections of the raw data.` };
        const text = await f.text();
        cacheSet(rel, text);
        let previewUrl = null;
        try { previewUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text))); }
        catch { previewUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text); }
        return {
          output: `SVG: ${rel}\nSize: ${text.length} chars, ${text.split('\n').length} lines\n---\n${text}`,
          _svgPreviewUrl: previewUrl, _svgText: text, _svgPath: rel
        };
      }

      /* ── Raster image files: compress and return base64 for vision ── */
      if (f.type && f.type.startsWith('image/') && !f.type.includes('svg')) {
        const maxB = LIMITS.MAX_IMAGE_SIZE;
        if (f.size > maxB) return { output: `Image: ${rel}\nType: ${f.type}\nSize: ${(f.size / 1024 / 1024).toFixed(1)} MB\n⚠ Too large to view (max 10 MB)...` };
        try {
          const dataUrl = await fileToBase64(f);
          const sizeKB = Math.round((dataUrl.length * 3 / 4) / 1024);
          return { output: `Image: ${rel}\nType: ${f.type}\nSize: ${sizeKB} KB (compressed)\n[Image sent to you for viewing in the next message]`, _imageDataUrl: dataUrl, _imagePath: rel, _imageReason: 'read_file' };
        } catch (e) { return { output: `Image: ${rel}\nType: ${f.type}\nError reading image: ${e.message}` }; }
      }

      const maxB = state.maxReadKB * 1024;
      const text = await f.text();
      cacheSet(rel, text);
      const lines = text.split('\n');
      const ext = rel.split('.').pop().toLowerCase();

      /* ── Smart Context: skeleton for large files ── */
      const threshold = getEffectiveSmartThreshold();
      if (threshold > 0) {
        const lineCount = lines.length;
        if (lineCount > threshold) {
          let skeleton = null;

          // Try companion for accurate AST-based extraction
          if (state.compConnected) {
            try {
              skeleton = await getFileSkeleton(text, ext, rel, lineCount);
            } catch { /* fallback to client-side */ }
          }

          // Fallback: client-side extraction (runs regardless of companion)
          if (!skeleton) {
            skeleton = extractEnhancedSkeleton(text, ext);
          }

          if (skeleton) {
            const skelLen = skeleton.length;
            if (skelLen > 4000) {
              const stripped = stripBodyPreviews(skeleton);
              return {
                output: `File: ${rel} (${lineCount} lines, ${(text.length / 1024).toFixed(1)} KB)\n` +
                  `Large file — showing structure only (signatures)\n` +
                  `Use grep to find what you need, then read_file_lines for specific sections.\n` +
                  `═══════════════════════════════════════════════════════════════════════════\n\n` +
                  stripped
              };
            }
            // Skeleton is reasonable size, return as-is
            return { output: skeleton };
          }

          // No skeleton available — fall through to structure-aware truncation

          // No skeleton available — use structure-aware truncation (head + tail)
          if (f.size > maxB) {
            const truncated = structureAwareTruncate(text, lines, maxB, rel);
            cacheSet(rel, truncated.fullText);
            return { output: truncated.output, _truncated: true, _shownLines: truncated.shownLines };
          }
        }
      }

      /* ── Structure-Aware Truncation for oversized files ── */
      if (f.size > maxB) {
        const truncated = structureAwareTruncate(text, lines, maxB, rel);
        cacheSet(rel, truncated.fullText);
        return { output: truncated.output, _truncated: true, _shownLines: truncated.shownLines };
      }

      return { output: `File: ${rel}\nSize: ${text.length} chars, ${lines.length} lines\n---\n${text}` };
    }

    async function readFileSummarySafe(rel) {
      requireWorkspace();
      const h = await resolvePath(rel);
      if (h.kind !== 'file') return { output: `"${rel}" is not a file` };
      const f = await h.getFile();
      if (f.size > LIMITS.MAX_TEXT_SIZE) return { output: `File too large for summary (${(f.size/1024/1024).toFixed(1)} MB)` };

      // For small files, just do it client-side
      if (f.size < 50000) {
      const text = await f.text();
      const lines = text.split('\n');
      if (lines.length < 150) return { output: `File: ${rel} (${lines.length} lines) — small enough to read directly with read_file` };
      return { output: buildLocalSummary(rel, text, lines) };
      }

      // For larger files, use the API
      try {
        const text = await f.text();

        if (!state.running) state.abortCtrl = new AbortController();
        const data = await requestModelJSON({
            model: state.model,
            messages: [
              { role: 'system', content: 'Summarize this source file in exactly this format:\nPurpose: <one line>\nImports: <comma-separated list, or "none">\nExports: <comma-separated list, or "none">\nClasses: <name> (L<start>-L<end>) — one line each\nFunctions: <name> (L<start>-L<end>) — one line each\nConstants: <name> = <value preview>\nKey logic: <2-3 sentences about the most important behavior>\nBe precise with line numbers.' },
              { role: 'user', content: text.slice(0, 100000) + (text.length > 100000 ? '\n... [truncated]' : '') }
            ],
            temperature: 0.1,
            max_tokens: 500
          }, state.abortCtrl?.signal);
        const summary = data.choices?.[0]?.message?.content || '';
        return { output: `File: ${rel} (${lines.length} lines, ${(f.size/1024).toFixed(1)} KB)\n---\n${summary}` };
      } catch {
        const text = await f.text();
        return { output: buildLocalSummary(rel, text.slice(0, 50000), text.split('\n')) };
      }
    }


    function buildLocalSummary(path, text, lines) {
      const ext = path.split('.').pop().toLowerCase();
      const result = [`File: ${path} (${lines.length} lines)`, ''];

      // Extract imports
      const imports = [];
      for (let i = 0; i < Math.min(lines.length, 60); i++) {
        const trimmed = lines[i].trim();
        if (/^(import\s|from\s)/.test(trimmed)) imports.push(trimmed.slice(0, 80));
        if (trimmed && !/^import|^from|^#|^"""/.test(trimmed) && imports.length > 0) break;
      }
      if (imports.length) result.push(`Imports: ${imports.join(', ')}`);
      else result.push('Imports: none');

      // Extract top-level symbols
      const symbols = [];
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t || t.startsWith('#') || t.startsWith('//')) continue;

        let m;
        if (ext === 'py') {
          m = t.match(/^(async\s+)?def\s+(\w+)\s*\(/);
          if (m) { symbols.push(`${m[2]} (L${i+1})`); continue; }
          m = t.match(/^class\s+(\w+)/);
          if (m) { symbols.push(`class ${m[1]} (L${i+1})`); continue; }
        } else {
          m = t.match(/^(export\s+)?(async\s+)?function\s+(\w+)/);
          if (m) { symbols.push(`${m[3]} (L${i+1})`); continue; }
          m = t.match(/^(export\s+)?(?:const|let|var)\s+(\w+)/);
          if (m) { symbols.push(`${m[2]} (L${i+1})`); continue; }
          m = t.match(/^class\s+(\w+)/);
          if (m) { symbols.push(`class ${m[1]} (L${i+1})`); continue; }
        }
      }
      if (symbols.length) result.push(`Symbols: ${symbols.slice(0, 30).join(', ')}${symbols.length > 30 ? ' ...' + (symbols.length - 30) + ' more' : ''}`);

      // First meaningful line as purpose hint
      let purpose = '';
      for (let i = 0; i < Math.min(lines.length, 20); i++) {
        const t = lines[i].trim();
        if (t.startsWith('#') || t.startsWith('//') || t.startsWith('"""') || t.startsWith("'''")) {
          if (!purpose) purpose = t.replace(/^[#/"]+\s*/, '').slice(0, 100);
        }
        if (t && !t.startsWith('#') && !t.startsWith('//') && !t.startsWith('import') && !t.startsWith('from') && !t.startsWith('export') && !t.startsWith('const ') && !t.startsWith('let ')) break;
      }
      if (purpose) result.push(`Purpose: ${purpose}`);

      return result.join('\n');
    }

    function structureAwareTruncate(fullText, lines, maxBytes, filePath) {
      const maxChars = maxBytes; // approximate 1:1 byte:char for ASCII-heavy code
      const boundaryPattern = /^(?:\s*(?:def |async def |class |function |export |const |let |var |interface |type |impl |trait |module |# │{2,}))/;
      const sectionBreak = /^(?:\n{2,}|[ \t]*\n[ \t]*\n)/;

      let cutPoint = maxChars;

      // Scan backwards from the byte limit to find a logical boundary
      for (let i = Math.min(lines.length - 1, Math.floor(maxChars / 40)); i >= Math.floor(maxChars * 0.6); i--) {
        const lineStart = lines.slice(0, i).join('\n').length;
        if (lineStart > maxChars) continue;

        if (boundaryPattern.test(lines[i]) || sectionBreak.test(lines[i])) {
          cutPoint = lineStart + lines[i].length;
          break;
        }
      }

      const head = fullText.slice(0, cutPoint);
      const remaining = fullText.slice(cutPoint);
      const remainingLines = remaining.split('\n').length;

      // Also grab the last ~20 lines as a tail, if they add useful context
      const tailLines = lines.slice(-20);
      const tailText = tailLines.join('\n');
      const hasTail = remainingLines > 20;

      let output = `File: ${filePath}\nLines: ${lines.length} (showing first ${head.split('\n').length}${hasTail ? ' + last 20' : ''})\n---\n${head}`;
      if (hasTail) {
        output += `\n\n... ${remainingLines - 20} lines omitted ...\n\n`;
        output += `── Last 20 lines ──\n${tailText}`;
      }
      output += `\n\n[Use read_file_lines for specific sections. Total: ${lines.length} lines, ${fullText.length} chars]`;

      return {
        output,
        fullText: head + (hasTail ? '\n\n' + tailText : ''),
        totalLines: lines.length,
        shownLines: head.split('\n').length + (hasTail ? 20 : 0)
      };
    }

    async function readFileLinesSafe(rel, startLine, endLine) {
      requireWorkspace()
      if (isSkippedPath(rel) && !isProgressFile(rel)) return { output: `File "${rel}" is filtered by workspace rules and cannot be read.` };
      const h = await resolvePath(rel); if (h.kind !== 'file') throw new Error(`"${rel}" is a directory`);
      const f = await h.getFile();

      /* ── PDFs don't have meaningful line ranges ── */
      if (rel.toLowerCase().endsWith('.pdf')) {
        return { output: `PDF: ${rel}\n⚠ Line ranges don't apply to PDFs. Use read_file to extract all text, or view_image to see rendered pages.` };
      }

      /* Images can't show line ranges */
      if (f.type && f.type.startsWith('image/') && !f.type.includes('svg')) {
        return { output: `Image: ${rel}\nType: ${f.type}\n⚠ This is a binary image file — line ranges don't apply.\nUse read_file to view the image, or execute_command with a tool like "identify" or "file" for metadata.` };
      }

      const buf = await f.slice(0, 8000).arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.some(b => b === 0)) return { output: 'Binary file — cannot read line ranges' };
      const text = await f.text(); cacheSet(rel, text);
      const lines = text.split('\n');
      const s = Math.max(1, startLine || 1) - 1;
      const e = Math.min(lines.length, endLine || lines.length);
      const selected = lines.slice(s, e);
      const header = `File: ${rel}\nLines: ${s + 1}-${e} of ${lines.length}\n---\n`;
      const numbered = selected.map((l, i) => `${String(s + i + 1).padStart(4)} | ${l}`).join('\n');
      return { output: header + numbered };
    }

    async function viewImageSafe(rel) {
      requireWorkspace();
      if (isSkippedPath(rel)) return { output: `"${rel}" is filtered by workspace rules.` };
      const h = await resolvePath(rel);
      if (h.kind !== 'file') return { output: `"${rel}" is not a file` };
      const f = await h.getFile();

      /* ── PDF handling ── */
      if (isPdfFile(f, rel)) {
        const maxB = LIMITS.MAX_PDF_SIZE;
        if (f.size > maxB) return { output: `PDF: ${rel}\nToo large (max 100 MB)` };
        try {
          const text = await extractPdfText(f);
          cacheSet(rel, text);
          const thumb = await renderPdfFirstPageThumbnail(f);
          return {
            output: text,
            _pdfThumbnail: thumb,
            _pdfPath: rel,
            _pdfFile: f
          };
        } catch (e) { return { output: `PDF: ${rel}\nError: ${e.message}` }; }
      }

      const isSvg = f.type && f.type.includes('svg');
      const isRaster = f.type && f.type.startsWith('image/') && !isSvg;

      if (!isSvg && !isRaster) {
        return { output: `"${rel}" is not an image file (type: ${f.type || 'unknown'}). Use read_file for text files.` };
      }

      const maxB = LIMITS.MAX_IMAGE_SIZE;
      if (f.size > maxB) {
        return { output: `Image: ${rel}\nType: ${f.type}\nSize: ${(f.size / 1024 / 1024).toFixed(1)} MB\n⚠ Too large to preview (max 10 MB). Use read_file_lines to read sections of the raw data.` };
      }

      /* ── SVG: render preview + keep text for code toggle ── */
      if (isSvg) {
        const text = await f.text();
        cacheSet(rel, text);
        let previewUrl;
        try { previewUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text))); }
        catch { previewUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text); }

        const result = {
          output: `SVG: ${rel}\nSize: ${text.length} chars, ${text.split('\n').length} lines\n[Rendered preview shown to user]`,
          _svgPreviewUrl: previewUrl,
          _svgText: text,
          _svgPath: rel,
        };
        /* If vision-capable, also send to model so it can see the rendered graphic */
        if (state.visionCapable) {
          result._imageDataUrl = previewUrl;
          result._imagePath = rel;
          result._imageReason = 'view_image (rendered SVG)';
          result._imageType = 'svg';
        }
        return result;
      }

      /* ── Raster image ── */
      try {
        const dataUrl = await fileToBase64(f);
        const sizeKB = Math.round((dataUrl.length * 3 / 4) / 1024);
        const result = {
          output: `Image: ${rel}\nType: ${f.type}\nSize: ${sizeKB} KB\n[Preview shown to user${state.visionCapable ? ' and sent to you for viewing' : ''}]`,
          _previewDataUrl: dataUrl,
          _previewPath: rel,
        };
        /* If vision-capable, send to model */
        if (state.visionCapable) {
          result._imageDataUrl = dataUrl;
          result._imagePath = rel;
          result._imageReason = 'view_image';
          result._imageType = 'raster';
        }
        return result;
      } catch (e) {
        return { output: `Image: ${rel}\nError reading: ${e.message}` };
      }
    }

    /* ═══════════════ EDIT-FILE MATCHING ENGINE ═══════════════
     *
     * Tier 1 — exact string match
     * Tier 2 — CRLF + trailing-whitespace normalisation
     * Tier 3 — indent-flexible: strip all leading whitespace, match on
     *           content, then re-indent new_text to match the file's indent
     * Tier 4 — best-window similarity: score every N-line window in the
     *           file against old_text using Jaccard on word tokens.
     *           If score ≥ FUZZY_THRESHOLD apply the edit; if score ≥
     *           HINT_THRESHOLD but below the apply bar, show the near-
     *           match so the LLM can fix its old_text immediately.
     * ═══════════════════════════════════════════════════════ */
    const FUZZY_APPLY_THRESHOLD = 0.88; // auto-apply above this similarity (raised from 0.82)
    const FUZZY_HINT_THRESHOLD  = 0.45; // show near-match hint above this

    function _editTokens(line) {
      // Normalise: lower-case, collapse whitespace, split on non-word chars
      return line.toLowerCase().replace(/\s+/g, ' ').trim().split(/[^a-z0-9_]+/).filter(Boolean);
    }

    function _jaccard(setA, setB) {
      if (!setA.size && !setB.size) return 1;
      if (!setA.size || !setB.size) return 0;
      let inter = 0;
      for (const t of setA) if (setB.has(t)) inter++;
      return inter / (setA.size + setB.size - inter);
    }

    /**
     * Score a window using a blend of:
     *  - Jaccard on word tokens (order-insensitive, catches renames/typos)
     *  - Exact-token-sequence overlap (order-sensitive, penalises wrong-block matches)
     * The blend prevents high scores when the same tokens appear in a completely
     * different structural context (e.g. two functions with the same keywords).
     */
    function _windowScore(fileLines, start, oldLines) {
      const len = oldLines.length;
      if (start + len > fileLines.length) return 0;
      let jaccardTotal = 0;
      let seqTotal = 0;
      for (let i = 0; i < len; i++) {
        const fToks = _editTokens(fileLines[start + i]);
        const oToks = _editTokens(oldLines[i]);
        const fa = new Set(fToks);
        const oa = new Set(oToks);
        jaccardTotal += _jaccard(fa, oa);
        // Sequence score: longest common prefix of tokens / max length
        let lcp = 0;
        const minLen = Math.min(fToks.length, oToks.length);
        for (let k = 0; k < minLen; k++) {
          if (fToks[k] === oToks[k]) lcp++; else break;
        }
        const maxLen = Math.max(fToks.length, oToks.length, 1);
        seqTotal += lcp / maxLen;
      }
      // 70% Jaccard + 30% sequence order — order matters but shouldn't dominate
      return (0.7 * (jaccardTotal / len)) + (0.3 * (seqTotal / len));
    }

    /** Find the best-matching window; returns {score, start, realOld} */
    function _bestWindow(fileLines, oldLines) {
      const len = Math.max(oldLines.length, 1);
      let best = { score: 0, start: 0 };
      for (let s = 0; s <= fileLines.length - len; s++) {
        const sc = _windowScore(fileLines, s, oldLines);
        if (sc > best.score) best = { score: sc, start: s };
      }
      best.realOld = fileLines.slice(best.start, best.start + len).join('\n');
      return best;
    }

    /** Strip the common leading indent from a block of lines */
    function _dedent(lines) {
      const minInd = lines
        .filter(l => l.trim())
        .reduce((m, l) => Math.min(m, l.match(/^(\s*)/)[1].length), Infinity);
      const ind = isFinite(minInd) ? minInd : 0;
      return { lines: lines.map(l => l.slice(ind)), indent: ind };
    }

    /**
     * Re-indent new_text so its base indent matches targetIndent spaces.
     * Fixed: applies the prefix to ALL non-empty lines (including line 0),
     * after stripping the original base indent from the entire block.
     */
    function _reindent(newText, targetIndent) {
      const newLines = newText.split('\n');
      const { lines: dedented } = _dedent(newLines);
      const prefix = ' '.repeat(targetIndent);
      return dedented.map(l => l.trim() === '' ? l : prefix + l).join('\n');
    }

    /**
     * Safe string replacement that avoids regex pitfalls by using
     * indexOf + slice instead of String.replace() with a pattern.
     * Also verifies uniqueness so we don't silently replace the wrong instance.
     */
    function _safeReplace(content, realOld, replacement) {
      const idx = content.indexOf(realOld);
      if (idx === -1) return null; // not found
      // Check for duplicate occurrences
      const secondIdx = content.indexOf(realOld, idx + 1);
      const unique = secondIdx === -1;
      const newContent = content.slice(0, idx) + replacement + content.slice(idx + realOld.length);
      return { newContent, unique };
    }

    async function editFileSafe(rel, edits, dryRun = false) {
      requireWorkspace();
      const segs = sanitizePath(rel);
      rel = segs.join('/'); // normalize so it matches f.p in the file tree
      if (isSkippedPath(rel)) return { output: `File "${rel}" is filtered by workspace rules and cannot be edited.` };

      let dir = state.dirHandle;
      for (let i = 0; i < segs.length - 1; i++) dir = await dir.getDirectoryHandle(segs[i], { create: true });
      const fh = await dir.getFileHandle(segs[segs.length - 1], { create: false });
      const file = await fh.getFile();
      let content = await file.text();
      const originalContent = content;
      if (!state.fileBackups.has(rel)) state.fileBackups.set(rel, content);

      const results = [];
      const allDiffs = [];

      const cleanLines = lines => {
        let start = 0, end = lines.length;
        while (start < end && lines[start].trim() === '') start++;
        while (end > start && lines[end - 1].trim() === '') end--;
        return lines.slice(start, end);
      };

      let anyLeakStripped = false;
      for (let i = 0; i < edits.length; i++) {
        let { old_text, new_text = '' } = edits[i];
        if (!old_text) { results.push(`Edit ${i + 1}: ERROR — old_text is empty`); continue; }

        // Guard against leaked chat-template/tool-call control tokens inside new_text
        // (same root cause as writeFileSafe — see stripLeakedModelArtifacts).
        const _leak = stripLeakedModelArtifacts(new_text);
        if (_leak.stripped) { new_text = _leak.text; anyLeakStripped = true; }

        // ── Tier 1: exact match ──────────────────────────────────────────
        let idx = content.indexOf(old_text);
        if (idx !== -1) {
          const occ = (content.split(old_text).length - 1);
          if (occ > 1) results.push(`Edit ${i + 1}: WARNING — old_text found ${occ} times, replacing first`);
          content = content.slice(0, idx) + new_text + content.slice(idx + old_text.length);
          results.push(`Edit ${i + 1}: OK`);
          allDiffs.push(generateDiffFromStrings(old_text, new_text));
          continue;
        }

        // ── Tier 2: CRLF + trailing-whitespace normalisation ─────────────
        const norm = s => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                          .split('\n').map(l => l.replace(/[^\S\n]+$/, '')).join('\n');
        const normContent = norm(content);
        const normOld    = norm(old_text);
        idx = normContent.indexOf(normOld);
        if (idx !== -1) {
          const lineStart = normContent.substring(0, idx).split('\n').length - 1;
          const origLines = content.split('\n');
          const oldLineCount = normOld.split('\n').length;
          const realOld = origLines.slice(lineStart, lineStart + oldLineCount).join('\n');
          if (content.includes(realOld)) {
            const replaced = _safeReplace(content, realOld, new_text);
            if (replaced) {
              content = replaced.newContent;
              const warn = replaced.unique ? '' : ' WARNING — matched block appears multiple times, replaced first occurrence';
              results.push(`Edit ${i + 1}: OK (whitespace-normalized match)${warn}`);
              allDiffs.push(generateDiffFromStrings(realOld, new_text));
              continue;
            }
          }
        }

        // ── Tier 3: indent-flexible match ────────────────────────────────
        // Strip all leading indent from both sides, match on content only,
        // then re-apply the file's indentation to new_text.
        {
          const fileLines = content.split('\n');
          const oldClean = cleanLines(old_text.split('\n'));
          const newClean = cleanLines(new_text.split('\n'));

          if (oldClean.length > 0) {
            const { lines: dedentedOld } = _dedent(oldClean);
            const dedentedOldStr = dedentedOld.join('\n').replace(/[^\S\n]+$/gm, '');

            // Build a dedented version of the file for searching
            let matchStart = -1;
            let matchLen   = dedentedOld.length;
            for (let s = 0; s <= fileLines.length - matchLen; s++) {
              const slice = fileLines.slice(s, s + matchLen);
              const { lines: dedentedSlice } = _dedent(slice);
              const dedentedSliceStr = dedentedSlice.join('\n').replace(/[^\S\n]+$/gm, '');
              if (dedentedSliceStr === dedentedOldStr) {
                matchStart = s;
                break;
              }
            }

            if (matchStart !== -1) {
              const realOld = fileLines.slice(matchStart, matchStart + matchLen).join('\n');
              // Detect the indent of the first non-empty matched line in the file
              const firstNonEmpty = fileLines.slice(matchStart, matchStart + matchLen).find(l => l.trim());
              const fileIndent = firstNonEmpty ? firstNonEmpty.match(/^(\s*)/)[1].length : 0;
              const reindentedNew = _reindent(newClean.join('\n'), fileIndent);
              const replaced = _safeReplace(content, realOld, reindentedNew);
              if (replaced) {
                content = replaced.newContent;
                const warn = replaced.unique ? '' : ' WARNING — matched block appears multiple times, replaced first occurrence';
                results.push(`Edit ${i + 1}: OK (indent-flexible match, re-indented to ${fileIndent} spaces)${warn}`);
                allDiffs.push(generateDiffFromStrings(realOld, reindentedNew));
                continue;
              }
            }
          }
        }

        // ── Tier 4: best-window similarity (fuzzy) ───────────────────────
        {
          const fileLines = content.split('\n');
          const oldClean = cleanLines(old_text.split('\n'));
          const newClean = cleanLines(new_text.split('\n'));

          // Skip fuzzy for very short (1-line) old_text — too many false matches
          if (oldClean.length >= 2) {
            const best = _bestWindow(fileLines, oldClean);

            if (best.score >= FUZZY_APPLY_THRESHOLD) {
              // High confidence — apply automatically
              const firstNonEmpty = (best.realOld.split('\n')).find(l => l.trim());
              const fileIndent = firstNonEmpty ? firstNonEmpty.match(/^(\s*)/)[1].length : 0;
              const reindentedNew = _reindent(newClean.join('\n'), fileIndent);
              const replaced = _safeReplace(content, best.realOld, reindentedNew);
              if (replaced) {
                content = replaced.newContent;
                const warn = replaced.unique ? '' : ' WARNING — matched block appears multiple times, replaced first occurrence';
                results.push(`Edit ${i + 1}: OK (fuzzy match, score=${best.score.toFixed(2)}, re-indented to ${fileIndent} spaces)${warn}`);
                allDiffs.push(generateDiffFromStrings(best.realOld, reindentedNew));
                continue;
              }
              // realOld not found in content (prior edit shifted things) — fall through to error
            }

            if (best.score >= FUZZY_HINT_THRESHOLD) {
              // Low-confidence near-match: show what the file actually has so the LLM can fix it
              const preview = best.realOld.split('\n').slice(0, 12).join('\n');
              results.push(
                `Edit ${i + 1}: ERROR — old_text not found (fuzzy score ${best.score.toFixed(2)}, below threshold).\n` +
                `The closest match in the file (score=${best.score.toFixed(2)}) is:\n` +
                '```\n' + preview + (best.realOld.split('\n').length > 12 ? '\n... (truncated)' : '') + '\n```\n' +
                `Copy the exact text above as your new old_text.`
              );
              continue;
            }
          }

          // No useful match found at all
          results.push(
            `Edit ${i + 1}: ERROR — old_text not found in ${rel}.\n` +
            `Tried: exact, CRLF-normalised, indent-flexible, and fuzzy matching. ` +
            `Use read_file or grep to find the exact current text and retry.`
          );
        }
      }

      const editLeakWarning = anyLeakStripped
        ? '\n\n⚠️ Detected and removed leaked model control tokens from one or more new_text values (the model kept generating past the intended replacement text).'
        : '';

      if (dryRun) {
        const hasChanges = content !== originalContent;
        if (!hasChanges) return { output: results.join('\n') + editLeakWarning, diff: null, _pendingApproval: false };
        const diffOutput = allDiffs.filter(d => d.lines.length);
        const diff = diffOutput.length
          ? { path: rel, lines: diffOutput.flatMap(d => d.lines), stats: { additions: diffOutput.flatMap(d => d.lines).filter(l => l.type === 'add').length, deletions: diffOutput.flatMap(d => d.lines).filter(l => l.type === 'del').length }, truncated: false }
          : null;
        return { output: '[PENDING APPROVAL] ' + results.join('\n') + editLeakWarning, diff, _pendingApproval: true, _pendingPath: rel, _pendingNewContent: content, _pendingIsNewFile: false, _pendingOriginalContent: originalContent };
      }

      const w = await fh.createWritable(); await w.write(content); await w.close();
      state.fileCache.set(rel, content); modifiedFiles.add(rel);

      let verifyMsg = '';
      if (state.verifyWrites) {
        try {
          const verify = await (await fh.getFile()).text();
          verifyMsg = verify === content ? '\n✓ Write verified' : '\n✗ WRITE VERIFICATION FAILED — file content mismatch!';
        } catch { verifyMsg = '\n? Could not verify write'; }
      }

      const diffOutput = allDiffs.filter(d => d.lines.length);
      return {
        output: results.join('\n') + verifyMsg + editLeakWarning,
        diff: diffOutput.length
          ? { path: rel, lines: diffOutput.flatMap(d => d.lines), stats: { additions: diffOutput.flatMap(d => d.lines).filter(l => l.type === 'add').length, deletions: diffOutput.flatMap(d => d.lines).filter(l => l.type === 'del').length }, truncated: false }
          : null
      };
    }

    /* ═══════════════ LCS-BASED DIFF ═══════════════ */
    function generateDiffFromStrings(oldText, newText) {
      const ol = oldText.split('\n'), nl = newText.split('\n');
      const m = ol.length, n = nl.length;
      if (m * n > 50000) {
        const lines = []; let count = 0; const max = 120; const maxLen = Math.max(m, n);
        for (let i = 0; i < maxLen && count < max; i++) {
          if (i >= m) { lines.push({ type: 'add', text: '+' + nl[i] }); count++; }
          else if (i >= n) { lines.push({ type: 'del', text: '-' + ol[i] }); count++; }
          else if (ol[i] !== nl[i]) { lines.push({ type: 'del', text: '-' + ol[i] }); lines.push({ type: 'add', text: '+' + nl[i] }); count++; }
        }
        if (count >= max) lines.push({ type: 'ctx', text: '  ... (diff truncated — files too large for precise LCS)' });
        return { lines, stats: { additions: lines.filter(l => l.type === 'add').length, deletions: lines.filter(l => l.type === 'del').length } };
      }
      const dp = new Array(m + 1);
      for (let i = 0; i <= m; i++) { dp[i] = new Int32Array(n + 1); }
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          if (ol[i - 1] === nl[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
          else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
      const result = []; let i = m, j = n;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && ol[i - 1] === nl[j - 1]) { result.push({ type: 'ctx', text: ' ' + nl[j - 1] }); i--; j--; }
        else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { result.push({ type: 'add', text: '+' + nl[j - 1] }); j--; }
        else { result.push({ type: 'del', text: '-' + ol[i - 1] }); i--; }
      }
      result.reverse();
      return { lines: result, stats: { additions: result.filter(l => l.type === 'add').length, deletions: result.filter(l => l.type === 'del').length } };
    }

    /* Compact diff: show only changed lines + minimal context */
    function compactDiffLines(lines, ctxBefore, ctxAfter) {
      if (lines.length <= 50) return { compact: lines, hidden: 0 };
      ctxBefore = ctxBefore ?? 1; ctxAfter = ctxAfter ?? 1;
      const out = [];
      let lastEmitted = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].type !== 'ctx') {
          const start = Math.max(0, i - ctxBefore);
          if (start > lastEmitted + 1) {
            out.push({ type: 'ellipsis', text: '  ···' });
          }
          for (let j = Math.max(start, lastEmitted + 1); j < i; j++) {
            out.push(lines[j]);
          }
          out.push(lines[i]);
          lastEmitted = i;
        }
      }
      if (lastEmitted >= 0 && lastEmitted < lines.length - 1) {
        const end = Math.min(lines.length, lastEmitted + 1 + ctxAfter);
        for (let j = lastEmitted + 1; j < end; j++) out.push(lines[j]);
      }
      return { compact: out, hidden: lines.length - out.filter(l => l.type !== 'ellipsis').length };
    }

    async function writeFileSafe(rel, content, dryRun = false) {
      requireWorkspace(); const segs = sanitizePath(rel);
      rel = segs.join('/'); // normalize so it matches f.p in the file tree
      const _leakCheck = stripLeakedModelArtifacts(content);
      let leakWarning = '';
      if (_leakCheck.stripped) {
        content = _leakCheck.text;
        leakWarning = '\n\n⚠️ Detected and removed leaked model control tokens from the end of the content ' +
          '(the model kept generating past the real content — looked like: ' + JSON.stringify(_leakCheck.leaked.slice(0, 80)) + '...). ' +
          'The file was written WITHOUT this garbage. If the file looks incomplete, re-check it with read_file and fix with edit_file.';
      }
      let dir = state.dirHandle;
      for (let i = 0; i < segs.length - 1; i++) dir = await dir.getDirectoryHandle(segs[i], { create: true });
      const lastName = segs[segs.length - 1];
      let prevContent = null;
      try {
        const eh = await dir.getFileHandle(lastName);
        if (eh.kind === 'file') {
          prevContent = await (await eh.getFile()).text();
        } else {
          throw new Error('is a directory');
        }
      } catch (e) {
        /* File doesn't exist yet (expected for new files) — any other error
           (permission, is a directory, etc.) re-throws so we don't silently
           overwrite something we shouldn't */
        if (e.message !== 'is a directory' && !e.message.includes('not found') && !e.name.includes('NotFound')) {
          throw e;
        }
      }
      if (prevContent !== null && !state.fileBackups.has(rel)) state.fileBackups.set(rel, prevContent);
      if (dryRun) {
        const isNew = prevContent === null;
        const diff = !isNew ? { path: rel, lines: generateDiffFromStrings(prevContent, content).lines, stats: generateDiffFromStrings(prevContent, content).stats, truncated: false } : null;
        return { output: (isNew ? '[PENDING APPROVAL] Create ' + rel : '[PENDING APPROVAL] Overwrite ' + rel) + leakWarning, diff, _pendingApproval: true, _pendingPath: rel, _pendingNewContent: content, _pendingIsNewFile: isNew, _originalContent: prevContent };
      }
      const fh = await dir.getFileHandle(lastName, { create: true });
      const w = await fh.createWritable(); await w.write(content); await w.close();
      state.fileCache.set(rel, content); modifiedFiles.add(rel);
      if (prevContent === null) newFiles.add(rel); // brand-new file — highlight yellow
      let verifyMsg = '';
      if (state.verifyWrites) { try { const v = await (await fh.getFile()).text(); verifyMsg = v === content ? '\n✓ Write verified' : '\n✗ WRITE VERIFICATION FAILED'; } catch { } }
      const diff = prevContent !== null ? { path: rel, lines: generateDiffFromStrings(prevContent, content).lines, stats: generateDiffFromStrings(prevContent, content).stats, truncated: false } : null;
      return { output: `Created ${rel} (${content.length} chars)${verifyMsg}${leakWarning}`, diff };
    }

    async function deleteFileSafe(rel, recursive) {
      requireWorkspace(); const segs = sanitizePath(rel);
      if (isSkippedPath(rel)) return `File "${rel}" is filtered by workspace rules and cannot be deleted.`;
      let dir = state.dirHandle; for (let i = 0; i < segs.length - 1; i++)dir = await dir.getDirectoryHandle(segs[i]);
      const name = segs[segs.length - 1];
      await dir.removeEntry(name, { recursive: !!recursive });
      state.fileCache.delete(rel); modifiedFiles.delete(rel); newFiles.delete(rel);
      return `Deleted: ${rel}`;
    }
    async function moveFileSafe(source, destination) {
      requireWorkspace();
      if (isSkippedPath(source) || isSkippedPath(destination)) return 'Source or destination is filtered by workspace rules.';
      const srcSegs = sanitizePath(source), dstSegs = sanitizePath(destination);
      let srcDir = state.dirHandle; for (let i = 0; i < srcSegs.length - 1; i++)srcDir = await srcDir.getDirectoryHandle(srcSegs[i]);
      const srcName = srcSegs[srcSegs.length - 1];
      const srcHandle = await srcDir.getFileHandle(srcName);
      let dstDir = state.dirHandle; for (let i = 0; i < dstSegs.length - 1; i++)dstDir = await dstDir.getDirectoryHandle(dstSegs[i], { create: true });
      const dstName = dstSegs[dstSegs.length - 1];
      if (source === destination) return 'Source and destination are the same';
      const srcFile = await srcHandle.getFile(); const content = await srcFile.text();
      const fh = await dstDir.getFileHandle(dstName, { create: true });
      const w = await fh.createWritable(); await w.write(content); await w.close();
      await srcDir.removeEntry(srcName, { recursive: false });
      state.fileCache.delete(source); state.fileCache.set(destination, content);
      if (modifiedFiles.has(source)) { modifiedFiles.delete(source); modifiedFiles.add(destination); }
      if (newFiles.has(source)) { newFiles.delete(source); newFiles.add(destination); }
      return `Moved: ${source} → ${destination}`;
    }

    async function listDirSafe(rel, recursive) {
      requireWorkspace();
      let files = [];
      /* ── Normalize path: "." and "./" mean root ── */
      let normPath = (rel || '').replace(/^\.\/?$/, '');
      if (normPath === '' || normPath === '/') normPath = '';

      let dh;
      if (normPath === '') {
        dh = state.dirHandle;
      } else {
        const segs = sanitizePath(normPath);
        dh = state.dirHandle;
        for (const seg of segs) {
          if (dh.kind !== 'directory') throw new Error('Cannot traverse into "' + seg + '" — parent is not a directory');
          dh = await dh.getDirectoryHandle(seg);
        }
      }

      if (!dh || dh.kind !== 'directory') throw new Error(`"${rel || '/'}" is not a directory`);

      const entries = [];
      let skippedCount = 0;

      async function walk(h, pfx, d) {
        if (d > LIMITS.DIR_LIST_DEPTH) { entries.push('  ' + pfx + '/ [depth limit]'); return; }
        try {
          for await (const [name, kh] of h.entries()) {
            if (SKIP.has(name)) { skippedCount++; continue; }
            const full = pfx ? pfx + '/' + name : name;
            /* Extension-based image detection — no getFile() I/O needed */
            let suffix = '';
            if (kh.kind === 'file') {
              const ext = name.split('.').pop().toLowerCase();
              if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'tiff', 'tif', 'avif'].includes(ext)) {
                suffix = ' [IMAGE]';
              }
              if (ext === 'pdf') {
                suffix = ' [PDF]';
            }
            }
            entries.push((kh.kind === 'directory' ? 'DIR ' : 'FILE ') + full + suffix);
            files.push(full);
            if (recursive && kh.kind === 'directory') {
              try { await walk(kh, full, d + 1); } catch { entries.push('  ' + full + '/ [error reading]'); }
            }
          }
        } catch (e) {
          if (entries.length === 0) throw e;
          entries.push('  [error: ' + e.message + ']');
        }
      }

      await walk(dh, '', 0);

      if (entries.length === 0 && skippedCount > 0) {
        return 'Directory is empty (all ' + skippedCount + ' entries are in the skip list: ' + [...SKIP].slice(0, 6).join(', ') + ', ...)';
      }
      if (entries.length === 0) {
        return 'Directory is empty (no files found)';
      }

      let output = entries.join('\n');
      if (skippedCount > 0) {
        output += '\n\n[' + skippedCount + ' entries skipped: ' + [...SKIP].slice(0, 6).join(', ') + ', ...]';
      }
      return output;
    }

    async function searchFilesSafe(pattern) {
      requireWorkspace();
      const results = [];
      let re;
      try { re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'); }
      catch { re = new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&'), 'i'); }
      async function walk(h, pfx, d) {
        if (d > 6 || results.length >= 100) return;
        for await (const [name, kh] of h.entries()) {
          if (isSkippedPath(pfx ? pfx + '/' + name : name)) continue;  // ← CHANGED
          const full = pfx ? pfx + '/' + name : name;
          if (re.test(name)) results.push(full);
          if (kh.kind === 'directory' && results.length < 100) await walk(kh, full, d + 1);
        }
      }
      await walk(state.dirHandle, '');
      return results.length ? results.join('\n') : 'No files found.';
    }

    async function grepSafe(pattern, searchPath, includeGlob, contextLines) {
      requireWorkspace();
      if (!pattern) return { output: 'Error: Pattern is empty or undefined' };
      let regex;
      try { regex = new RegExp(pattern); }
      catch { return { output: `Invalid regex: ${pattern}` }; }
      const ctx = Math.min(contextLines || 0, 10);
      const results = [];
      let fileCount = 0;
      const MAX_FILES = 50, MAX_MATCHES = 200;
      async function searchFile(fileHandle, filePath) {
        const f = await fileHandle.getFile();
        if (f.type && f.type.startsWith('image/') && !f.type.includes('svg')) return;
        if (f.size > LIMITS.MAX_TEXT_SIZE) return;
        const buf = await f.slice(0, 8000).arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (bytes.some(b => b === 0)) return;
        const text = await f.text();
        if (!includeGlob || filePath.endsWith(includeGlob.replace(/^\*/, ''))) {
          const lines = text.split('\n');
          let matches = 0;
          for (let i = 0; i < lines.length && matches < MAX_MATCHES; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              if (matches === 0) results.push(`\n${filePath}:`);
              const start = Math.max(0, i - ctx), end = Math.min(lines.length, i + ctx + 1);
              for (let j = start; j < end; j++) {
                const prefix = j === i ? '>>' : '  ';
                results.push(`  ${prefix} ${j + 1}: ${lines[j]}`);
              }
              matches++;
            }
          }
          if (matches) fileCount++;
        }
      }

      async function walk(h, pfx, d) {
        if (d > LIMITS.DIR_LIST_DEPTH || fileCount >= MAX_FILES) return;
        for await (const [name, kh] of h.entries()) {
          if (isSkippedPath(pfx ? pfx + '/' + name : name)) continue;
          const full = pfx ? pfx + '/' + name : name;
          if (kh.kind === 'file') await searchFile(kh, full);
          else if (kh.kind === 'directory') await walk(kh, full, d + 1);
        }
      }
      await walk(state.dirHandle, searchPath || '', 0);
      const totalMatches = results.filter(l => l.includes('>>')).length;
      return { output: results.length ? `Found ${totalMatches} match(es) in ${fileCount} file(s):${results.join('\n')}` : 'No matches found.' };
    }


    /* ═══════════════ BROWSER API ═══════════════ */
    async function browserApi(endpoint, args) {
      try {
        const res = await companionFetch(`${state.compUrl}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args || {}),
          signal: AbortSignal.timeout(30000)
        });

        /* ── 404 = endpoint missing in this companion version ── */
        if (res.status === 404) {
          const isDev = endpoint.startsWith('/dev_');
          if (isDev) {
            return `[Dev Server Error] Endpoint not available in this companion version. Update the embedded companion script or start the dev server manually with: ${args?.command || 'npm run dev'}`;
          }
          return `[Browser Error] Endpoint not found: ${endpoint}. Your companion may need to be updated.`;
        }

        /* ── Handle non-JSON responses (Python crashes return HTML error pages) ── */
        if (!res.ok) {
          let errText = await res.text().catch(() => '');
          if (errText.includes('<!DOCTYPE') || errText.includes('<html')) {
            const tmp = document.createElement('DIV'); tmp.innerHTML = errText;
            errText = tmp.textContent || tmp.innerText || 'HTTP ' + res.status;
            errText = errText.trim().replace(/\s+/g, ' ').slice(0, 400);
          }
          return `[Browser Error] HTTP ${res.status}: ${errText}`;
        }

        /* ── Handle empty response (companion crashed) ── */
        const text = await res.text().catch(() => '');
        if (!text || !text.trim()) {
          if (endpoint.startsWith('/dev_')) {
            return `[Dev Server Error] Endpoint not available in this companion version. Start the dev server manually: ${args?.command || 'npm run dev'}`;
          }
          return `[Browser Error] Empty response — companion likely crashed. Check the companion terminal for traceback.`;
        }

        let data;
        try { data = JSON.parse(text); }
        catch {
          return `[Browser Error] Invalid response${text.length > 200 ? ': ' + text.slice(0, 150) + '...' : ''}`;
        }
        if (data.error) return `[Browser Error] ${data.error}`;
        if (endpoint === '/browser_navigate') return `Navigated to ${data.url}\nTitle: ${data.title || '(none)'}${data.timeout ? '\n⚠ Load timed out — page may have partially loaded' : ''}`;
        if (endpoint === '/browser_launch') return `Browser launched (headless: ${data.headless})\nURL: ${data.url || '(blank)'}`;
        if (endpoint === '/browser_click') return `Clicked: ${data.selector}`;
        if (endpoint === '/browser_type') return `Typed "${args.text}" into ${args.selector}${args.submit ? ' and pressed Enter' : ''}`;
        if (endpoint === '/browser_evaluate') return `Result (${data.type}): ${data.result}`;
        if (endpoint === '/browser_get_content') return `Page content (${data.mode}, ${data.length} chars):\n---\n${data.content}`;
        if (endpoint === '/browser_wait_for') return data.ok ? `Element visible: ${data.selector}` : `Timeout waiting for: ${data.selector}`;
        if (endpoint === '/browser_hover') return `Hovered: ${data.selector}`;
        if (endpoint === '/browser_select_option') return `Selected "${args.value}" in ${data.selector}`;
        if (endpoint === '/browser_press_key') return `Pressed: ${data.key}`;
        if (endpoint === '/browser_scroll') return `Scrolled ${data.direction}${data.amount ? ' ' + data.amount + 'px' : ''}`;
        if (endpoint === '/browser_go_back' || endpoint === '/browser_go_forward') return `Navigated ${endpoint.replace('browser_', '')}: ${data.url}`;
        if (endpoint === '/browser_close') return 'Browser closed.';
        if (endpoint === '/dev_start') return `Dev server starting: "${args.command}" → http://localhost:${args.port}\n\nPreview loading in the Preview panel.`;
        if (endpoint === '/dev_status') return `Dev server: ${data.alive ? 'running' : 'stopped'} | Ready: ${data.ready ? 'Yes' : 'No'}${data.output_tail ? '\nTail: ' + data.output_tail.slice(-200) : ''}`;
        if (endpoint === '/dev_output') return `Dev server output (${data.alive ? 'running' : 'stopped'}):\n${data.output}`;
        if (endpoint === '/dev_stop') return `Dev server stopped.`;
        return JSON.stringify(data);
      } catch (e) {
        return `[Browser Error] ${e.message}`;
      }
    }


    async function handleBrowserScreenshot(args) {
      try {
        const res = await companionFetch(`${state.compUrl}/browser_screenshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ full_page: args.full_page || false, selector: args.selector || null }),
          signal: AbortSignal.timeout(30000)
        });
        const data = await res.json();
        if (data.error) return { output: `[Screenshot Error] ${data.error}` };

        const sizeKB = Math.round((data.screenshot.length * 3 / 4) / 1024);
        const info = args.selector ? `Element: ${args.selector}` : (args.full_page ? 'Full page' : 'Viewport');
        const output = `Screenshot (${info}) — ${sizeKB} KB`;

        const result = { output, _screenshotDataUrl: data.screenshot, _imagePath: 'browser-screenshot', _imageReason: info, _imageType: 'browser' };
        return result;
      } catch (e) {
        return { output: `[Screenshot Error] ${e.message}` };
      }
    }

    async function handleBrowserConsole(args, panel) {
      try {
        const res = await companionFetch(`${state.compUrl}/browser_console`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ types: args.types || null }),
          signal: AbortSignal.timeout(10000)
        });
        const data = await res.json();

        /* Build text output */
        let output = `Console: ${data.total} messages (${data.errors} errors, ${data.warnings} warnings)\n`;
        if (data.recent_errors && data.recent_errors.length) {
          output += '\n── ERRORS ──\n';
          for (const e of data.recent_errors) {
            output += `  [${e.type}] ${e.text}\n`;
          }
        }
        if (data.recent_warnings && data.recent_warnings.length) {
          output += '\n── WARNINGS ──\n';
          for (const w of data.recent_warnings) {
            output += `  [${w.type}] ${w.text}\n`;
          }
        }
        if (!data.errors && !data.warnings) {
          output += 'No errors or warnings.';
        }

        /* Show console panel in chat */
        if (panel && panel.el) {
          const consoleEl = document.createElement('div');
          consoleEl.className = 'search-panel';
          const hasErrors = data.errors > 0;
          const hasWarnings = data.warnings > 0;
          consoleEl.style.borderColor = hasErrors ? 'rgba(239,68,68,.3)' : hasWarnings ? 'rgba(234,179,8,.3)' : 'var(--border)';

          let contentHtml = '';
          if (data.recent_errors && data.recent_errors.length) {
            contentHtml += '<div style="padding:6px 10px;border-bottom:1px solid var(--border);font-size:10px;font-weight:700;color:var(--red);font-family:JetBrains Mono,monospace"><i class="fas fa-circle-xmark"></i> ERRORS (' + data.recent_errors.length + ')</div>';
            for (const e of data.recent_errors) {
              contentHtml += `<div style="padding:4px 10px;border-bottom:1px solid var(--border);font-size:10px;font-family:JetBrains Mono,monospace;color:var(--red);background:rgba(239,68,68,.04)"><span style="color:var(--tx-4);margin-right:6px">${esc(e.type)}</span>${esc(e.text)}</div>`;
            }
          }
          if (data.recent_warnings && data.recent_warnings.length) {
            contentHtml += '<div style="padding:6px 10px;border-bottom:1px solid var(--border);font-size:10px;font-weight:700;color:var(--yellow);font-family:JetBrains Mono,monospace"><i class="fas fa-triangle-exclamation"></i> WARNINGS (' + data.recent_warnings.length + ')</div>';
            for (const w of data.recent_warnings) {
              contentHtml += `<div style="padding:4px 10px;border-bottom:1px solid var(--border);font-size:10px;font-family:JetBrains Mono,monospace;color:var(--yellow);background:rgba(234,179,8,.03)"><span style="color:var(--tx-4);margin-right:6px">${esc(w.type)}</span>${esc(w.text)}</div>`;
            }
          }
          if (!hasErrors && !hasWarnings) {
            contentHtml = '<div style="padding:12px;text-align:center;color:var(--green);font-size:11px"><i class="fas fa-check-circle" style="margin-right:4px"></i> No errors or warnings</div>';
          }

          consoleEl.innerHTML = `<div class="search-hdr" style="${hasErrors ? 'background:rgba(239,68,68,.06)' : hasWarnings ? 'background:rgba(234,179,8,.04)' : ''}"><i class="fas fa-terminal" style="color:${hasErrors ? 'var(--red)' : hasWarnings ? 'var(--yellow)' : 'var(--teal)'}"></i><div class="search-q">Browser Console</div><span class="search-meta">${data.total} msgs · ${data.errors} err · ${data.warnings} warn</span></div><div class="search-results">${contentHtml}</div>`;
          $msg().appendChild(consoleEl);
          scrollBottom();
        }

        return { output };
      } catch (e) {
        return { output: `[Console Error] ${e.message}` };
      }
    }

    /* ═══════════════ GIT ═══════════════ */
    async function gitStatus() { return await execViaCompanion('git status --short 2>/dev/null || echo "NOT A GIT REPOSITORY"'); }
    async function gitDiff(staged, file) { const s = staged ? '--cached' : ''; const f = file ? `-- "${file}"` : ''; return await execViaCompanion(`git diff ${s} ${f} 2>&1`); }
    async function gitLog(count) { return await execViaCompanion(`git log --oneline -${count || 10} 2>&1`); }
    async function gitAdd(paths) {
      const escaped = paths.split(/\s+/).map(p => `'${p.replace(/'/g, "'\\''")}'`).join(' ');
      return await execViaCompanion(`git add ${escaped} 2>&1`);
    }
    async function gitCommit(message) {
      // Single-quote and escape any embedded single quotes
      const safe = "'" + String(message).replace(/'/g, "'\\''") + "'";
      return await execViaCompanion(`git commit -m ${safe} 2>&1`);
    }
    async function gitPush(remote, branch, force) {
      const r = remote ? `'${String(remote).replace(/'/g, "'\\''")}'` : '';
      const b = branch ? `'${String(branch).replace(/'/g, "'\\''")}'` : '';
      const f = force ? '--force-with-lease' : '';
      return await execViaCompanion(`git push ${f} ${r} ${b} 2>&1`.replace(/\s+/g, ' ').trim());
    }
    async function gitCheckoutBranch(branch, create) {
      const b = "'" + String(branch).replace(/'/g, "'\\''") + "'";
      return await execViaCompanion(`git checkout ${create ? '-b ' : ''}${b} 2>&1`);
    }
    async function gitStash(action, message) {
      if (action === 'pop') return await execViaCompanion('git stash pop 2>&1');
      if (action === 'list') return await execViaCompanion('git stash list 2>&1');
      const m = message ? "-m '" + String(message).replace(/'/g, "'\\''") + "'" : '';
      return await execViaCompanion(`git stash push ${m} 2>&1`.trim());
    }

    /* ═══════════════ run_tests: structured pass/fail parsing ═══════════════
       Heuristic regex parsing for common test-framework summary lines, so the
       model gets a compact {passed, failed, total} readout instead of the full
       raw log eating context on every iteration of a fix loop. Falls back to
       returning the tail of raw output when no known pattern matches. */
    function parseTestOutput(raw) {
      const out = String(raw || '');
      const patterns = [
        // pytest: "3 passed, 1 failed in 0.42s" (order/subset varies)
        { name: 'pytest', re: /(\d+)\s+passed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+error(?:ed)?)?(?:,\s*(\d+)\s+skipped)?/i,
          map: m => ({ passed: +m[1] || 0, failed: (+m[2] || 0) + (+m[3] || 0), skipped: +m[4] || 0 }) },
        { name: 'pytest-failed-first', re: /(\d+)\s+failed(?:,\s*(\d+)\s+passed)?/i,
          map: m => ({ passed: +m[2] || 0, failed: +m[1] || 0, skipped: 0 }) },
        // jest/vitest: "Tests:       2 failed, 5 passed, 7 total"
        { name: 'jest', re: /Tests:\s*(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/i,
          map: m => ({ passed: +m[2] || 0, failed: +m[1] || 0, skipped: 0, total: +m[3] || 0 }) },
        // mocha: "5 passing" / "2 failing"
        { name: 'mocha', re: /(\d+)\s+passing(?:[\s\S]*?(\d+)\s+failing)?/i,
          map: m => ({ passed: +m[1] || 0, failed: +m[2] || 0, skipped: 0 }) },
        // cargo test: "test result: FAILED. 3 passed; 1 failed; 0 ignored"
        { name: 'cargo', re: /test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/i,
          map: m => ({ passed: +m[1] || 0, failed: +m[2] || 0, skipped: +m[3] || 0 }) },
        // go test: "--- FAIL" / "ok  	pkg	0.5s" — count occurrences instead
        { name: 'go', re: /^(ok|FAIL)\s+\S+/m, map: () => null }
      ];
      for (const p of patterns) {
        const m = out.match(p.re);
        if (m) {
          const parsed = p.map(m);
          if (parsed) return { framework: p.name, ...parsed, total: parsed.total ?? (parsed.passed + parsed.failed) };
        }
      }
      // go test fallback: count PASS/FAIL/ok lines
      const goPass = (out.match(/^--- PASS/gm) || []).length;
      const goFail = (out.match(/^--- FAIL/gm) || []).length;
      if (goPass + goFail > 0) return { framework: 'go test', passed: goPass, failed: goFail, skipped: 0, total: goPass + goFail };
      return null;
    }


    /* ═══════════════ VIRTUAL SHELL ═══════════════ */
    async function execVirtual(rawCmd) {
      requireWorkspace(); if (typeof rawCmd !== 'string') return { output: 'Error: command must be a string' };
      const cmd = rawCmd.replace(/\0/g, '').trim(); if (!cmd) return { output: 'Error: empty command' };
      const tokens = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      const c = tokens[0]?.replace(/^["']|["']$/g, ''), args = tokens.slice(1).map(a => a.replace(/^["']|["']$/g, ''));
      try {
        const out = await (async () => {
          switch (c) {
            case 'pwd': return { output: state.dirName || '(none)' };
            case 'ls': {
              const f = args.filter(a => !a.startsWith('-')), fl = args.filter(a => a.startsWith('-')).join('');
              if (f[0]) sanitizePath(f[0]);
              return { output: await listDirSafe(f[0] || '', fl.includes('R') || fl.includes('r')) };
            }
            case 'cat': {
              if (!args.length) return { output: 'Usage: cat <file>' };
              const results = await Promise.all(args.map(a => { sanitizePath(a); return readFileSafe(a); }));
              return { output: results.map(r => r.output).join('\n---\n') };
            }
            case 'head': {
              let n = 10; const files = [];
              for (let i = 0; i < args.length; i++) { if (args[i] === '-n' && args[i + 1]) n = Math.min(parseInt(args[++i]) || 10, 500); else files.push(args[i]); }
              if (!files.length) return { output: 'Usage: head [-n N] <file>' };
              sanitizePath(files[0]);
              return { output: (await readFileLinesSafe(files[0], 1, n)).output };
            }
            case 'tail': {
              let n = 10; const files = [];
              for (let i = 0; i < args.length; i++) { if (args[i] === '-n' && args[i + 1]) n = Math.min(parseInt(args[++i]) || 10, 500); else files.push(args[i]); }
              if (!files.length) return { output: 'Usage: tail [-n N] <file>' };
              sanitizePath(files[0]);
              const h = await resolvePath(files[0]); if (h.kind !== 'file') return { output: '"' + files[0] + '" is not a file' };
              const t = await (await h.getFile()).text(); const lines = t.split('\n');
              return { output: lines.slice(-n).map((l, i) => `${String(lines.length - n + i + 1).padStart(4)} | ${l}`).join('\n') };
            }
            case 'wc': {
              if (!args.length) return { output: 'Usage: wc <file>' };
              sanitizePath(args[0]);
              const h = await resolvePath(args[0]); if (h.kind !== 'file') return { output: '"' + args[0] + '" is not a file' };
              const t = await (await h.getFile()).text();
              return { output: `  ${t.split('\n').length}  ${t.split(/\s+/).filter(Boolean).length}  ${t.length} ${args[0]}` };
            }
            case 'grep': return { output: (await grepSafe(args[0] || '', args[1] || '')).output };
            case 'find': {
              let np = '*', sp = '.';
              for (let i = 0; i < args.length; i++) { if (args[i] === '-name' && args[i + 1]) np = args[++i]; else if (!args[i].startsWith('-') && args[i] !== '.') sp = args[i]; }
              if (sp !== '.') sanitizePath(sp);
              return { output: await searchFilesSafe(np) };
            }
            case 'echo': return { output: args.join(' ') };
            case 'mkdir': {
              if (!args.length) return { output: 'Usage: mkdir <path>' };
              for (const p of args) { if (p === '-p') continue; const s = sanitizePath(p); let d = state.dirHandle; for (const seg of s) d = await d.getDirectoryHandle(seg, { create: true }); }
              return { output: 'Directory created' };
            }
            case 'touch': {
              if (!args.length) return { output: 'Usage: touch <file>' };
              for (const p of args) await writeFileSafe(p, '');
              return { output: 'Created: ' + args.join(', ') };
            }
            case 'rm': return { output: 'rm is disabled in virtual shell for safety. Start companion for real shell access.' };
            case 'move_file': {
              if (args.length < 2) return { output: 'Usage: move_file <source> <dest>' };
              return { output: await moveFileSafe(args[0], args[1]) };
            }
            case 'delete_file': {
              if (!args[0]) return { output: 'Error: no path' };
              return { output: await deleteFileSafe(args[0], args.includes('-r') || args.includes('--recursive')) };
            }
            case 'tree': {
              let md = 3;
              for (let i = 0; i < args.length; i++) { if (args[i] === '-L' && args[i + 1]) md = Math.min(parseInt(args[++i]) || 3, 8); }
              const tgt = args.find(a => !a.startsWith('-') && !/^\d+$/.test(a)) || '';
              if (tgt) sanitizePath(tgt);
              const dh = tgt ? await resolvePath(tgt) : state.dirHandle;
              if (dh.kind !== 'directory') return { output: '"' + tgt + '" is not a directory' };
              const lines = [];
              async function wt(h, pfx, d) {
                if (d > md) { lines.push(pfx + '...'); return; }
                const es = []; for await (const [n, kh] of h.entries()) { if (!SKIP.has(n)) es.push({ n, k: kh.kind, h: kh }); }
                es.sort((a, b) => a.k === b.k ? a.n.localeCompare(b.n) : a.k === 'directory' ? -1 : 1);
                for (let i = 0; i < es.length; i++) {
                  const last = i === es.length - 1;
                  lines.push(pfx + (last ? '└── ' : '├── ') + es[i].n + (es[i].k === 'directory' ? '/' : ''));
                  if (es[i].k === 'directory') await wt(es[i].h, pfx + (last ? '    ' : '│   '), d + 1);
                }
              }
              lines.push(tgt || '.'); await wt(dh, '', 0);
              return { output: lines.join('\n') };
            }
            case 'file': {
              if (!args.length) return { output: 'Usage: file <path>' };
              sanitizePath(args[0]);
              const h = await resolvePath(args[0]);
              if (h.kind === 'directory') return { output: args[0] + ': directory' };
              const f = await h.getFile();
              return { output: `${args[0]}: ${f.type || 'application/octet-stream'} (${f.size} bytes)` };
            }
            case 'diff': {
              if (args.length < 2) return { output: 'Usage: diff <f1> <f2>' };
              sanitizePath(args[0]); sanitizePath(args[1]);
              const [h1, h2] = await Promise.all([resolvePath(args[0]), resolvePath(args[1])]);
              if (h1.kind !== 'file') return { output: '"' + args[0] + '" is not a file' };
              if (h2.kind !== 'file') return { output: '"' + args[1] + '" is not a file' };
              const [c1, c2] = await Promise.all([(await h1.getFile()).text(), (await h2.getFile()).text()]);
              const d = generateDiffFromStrings(c1, c2);
              return { output: d.lines.map(l => l.text).join('\n') || (d.lines.length ? '' : 'Files are identical') };
            }
            default: return { output: `Unknown: ${c}\nVirtual shell supports: ls cat head tail wc grep find echo mkdir touch pwd tree file diff (these are virtual FSA commands, not OS-specific).\nStart companion for real OS shell + git + web search.` };
          }
        })();
        return out;
      } catch (e) { return { output: e.message.includes('traversal') ? `Security: ${e.message}` : `Error: ${e.message}` }; }
    }

    /* ═══════════════ SHELL SAFETY ═══════════════ */
    const DANGEROUS = [
      /\brm\s+(-[rfRF]+\s+)?\/\b/, /\brm\s+(-[rfRF]+\s+)?\*\b/,
      /\bdd\s+.*of=\/dev\/\w+/, /\bmkfs\b/, />\s*\/dev\/\w+/,
      /\bchmod\s+(-R\s+)?777\s+[\/.]/, /\bchown\s+(-R\s+)/,
      /\bgit\s+(reset\s+--hard|clean\s+-fdx|push\s+--force)\b/,
      /\b(shutdown|reboot|halt|poweroff)\b/, /\bsystemctl\s+(stop|disable|mask)\b/,
      /\bkill\s+(-9\s+)?1\b/, /\biptables\s+-F\b/,
      /\|\s*\b(ba)?sh\b/, /\b(curl|wget)\s+[^|]*\|\s*\b(ba)?sh\b/,
      /\bdrop\s+(table|database|schema)\b/i,
    ];
    function isDangerous(cmd) { return DANGEROUS.some(p => p.test(cmd)); }

    /* ═══════════════ COMPANION ═══════════════ */
    async function execViaCompanion(command, explicitTimeout, externalSignal, onLine, structured = false, toolCallId = null) {
      let timeout = Number(explicitTimeout || state.cmdTimeout);
      if (!explicitTimeout && /\b(?:pip3?|npm|pnpm|yarn|bun|cargo|gem|composer)\s+(?:install|add|build|require)\b/i.test(command)) timeout = Math.max(timeout, 300);
      timeout = Math.max(5, Math.min(600, timeout));
      const result = await executeCompanionJob(command, timeout, externalSignal, onLine, toolCallId);
      if (result.status === 'unknown' || (result.status === 'cancelled' && result.exitCode == null)) state.running = false;
      return structured ? result : result.output;
    }

    async function readNdjsonStream(res, signal, onLine) {
      const reader = res.body.getReader(); const dec = new TextDecoder();
      let buf = '', output = '', exitCode = 0;
      try {
        while (true) {
          if (signal?.aborted) { reader.cancel(); break; }
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          // Handle both \n and \r\n line endings
          const lines = buf.split(/\r?\n/);
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const m = JSON.parse(line);
              if (m.t === 'd') exitCode = parseInt(m.d) || 0;
              else if (m.t === 'o' || m.t === 'e') {
                output += m.d;
                try { onLine(m.d, m.t === 'e'); } catch {/* don't let UI errors kill the stream */ }
              }
            } catch {
              output += line + '\n';
              try { onLine(line + '\n', false); } catch { }
            }
          }
        }
      } catch (e) {
        if (!signal?.aborted) output += '\n[Stream error: ' + e.message + ']';
      }
      // Process remaining buffer
      if (buf.trim()) {
        try {
          const m = JSON.parse(buf);
          if (m.t === 'd') exitCode = parseInt(m.d) || 0;
          else { output += m.d; try { onLine(m.d, m.t === 'e'); } catch { }; }
        } catch {
          output += buf;
          try { onLine(buf, false); } catch { };
        }
      }
      if (exitCode != null && exitCode !== 0) output += '\n[exit code: ' + exitCode + ']';
      return output;
    }

    function streamToolResult(panel, text) {
      if (!panel?.el?.isConnected) return;
      const res = panel.el.querySelector('.tool-result');
      if (!res?.isConnected) return;
      res.textContent += text;
      panel.el._resultText = res.textContent;
      res.scrollTop = res.scrollHeight;
      scrollBottom();
    }

    async function fetchViaCompanion(url, maxBytes) {
      if (!url || typeof url !== 'string' || !url.trim()) return '[Error: No URL provided to fetch_url]';
      url = url.trim();
      if (!url.startsWith("http://") && !url.startsWith("https://")) return '[Error: URL must start with http:// or https://]';
      try {
        const res = await companionFetch(`${state.compUrl}/fetch`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, max_bytes: maxBytes || 500000, mode: 'text' }),
          signal: AbortSignal.timeout(20000)
        });
        if (!res.ok) {
          let t = await res.text().catch(() => '');
          try { const j = JSON.parse(t); t = j.error || j.message || t; } catch { }
          t = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
          return `[Fetch error: HTTP ${res.status} — ${t}]`;
        }
        const data = await res.json();
        if (data.error) return `[Fetch error: ${data.error}]\n${data.content || ''}`;
        return `URL: ${data.url}\nMode: ${data.mode}\nSize: ${data.size} bytes\n---\n${data.content}`;
      } catch (e) {
        return `[Fetch error: ${e.message}]`;
      }
    }


    const searchCache = new Map();
    const SEARCH_CACHE_TTL = 5 * 60 * 1000;
    const SEARCH_CACHE_MAX = 50;

    async function searchViaCompanion(query, numResults, fetchTop) {
      if (!query || typeof query !== 'string' || !query.trim()) return { query, error: 'No query provided', count: 0, results: [{ "error": "No query provided" }] };
      query = query.trim();
      const cacheKey = `${query.toLowerCase().slice(0, 200)}|${numResults || 8}|${fetchTop || 0}`;
      const cached = searchCache.get(cacheKey);
      if (cached && Date.now() - cached.time < SEARCH_CACHE_TTL) return cached.data;
      try {
        const res = await companionFetch(`${state.compUrl}/search`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, num_results: numResults || 8, fetch_top: fetchTop || 0 }),
          signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) {
          let t = await res.text().catch(() => '');
          try { const j = JSON.parse(t); t = j.error || j.message || t; } catch { }
          t = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
          const errData = { query, error: `HTTP ${res.status} — ${t}`, count: 0, results: [{ "error": `Companion HTTP ${res.status}: ${t}` }] };
          return errData;
        }
        const data = await res.json();
        if (SEARCH_CACHE_MAX <= searchCache.size) {
          const oldest = searchCache.keys().next().value;
          if (oldest !== undefined) searchCache.delete(oldest);
        }
        searchCache.set(cacheKey, { data, time: Date.now() });
        return data;
      } catch (e) {
        return { query, error: e.message, count: 0, results: [{ "error": `Search failed: ${e.message}` }] };
      }
    }

    // Consecutive failed 20s-interval probes required before we treat the
    // companion as actually down mid-task. A single dropped/slow request
    // (transient network blip, brief GC pause, etc.) shouldn't interrupt
    // the transcript with a disconnect/reconnect pair moments apart — that
    // adds noise without giving the user anything to act on. Requiring two
    // consecutive misses (~20-40s of real downtime) filters those out while
    // still catching genuine outages promptly.
    const COMPANION_FAIL_THRESHOLD = 2;

    async function checkCompanion() {
      if (state.running) {
        // Lighter-weight probe during an active run: skip the status-dot UI
        // update (would flicker mid-task) and MCP re-sync, just detect a
        // disconnect so it surfaces before every tool call silently fails
        // against a dead server. Debounced against transient blips (see
        // COMPANION_FAIL_THRESHOLD) so we only alert on a confirmed outage,
        // and only announce recovery if we actually announced the outage.
        let ok = false;
        try {
          const res = await companionFetch(`${state.compUrl}/status`, { signal: AbortSignal.timeout(3000) });
          if (!res.ok) throw new Error(res.statusText);
          ok = true;
        } catch (error) {
          ok = false;
          if(error.status===401) { state.compConnected=false; state.compInfo=null; }
          updateCompanionPairing(error.status===401?'unauthorized':error.status?'error':'offline',error.message);
        }

        if (ok) {
          updateCompanionPairing('connected');
          const wasConfirmedDown = state.compFailStreak >= COMPANION_FAIL_THRESHOLD;
          state.compFailStreak = 0;
          state.compConnected = true;
          if (wasConfirmedDown) {
            appendMsg('system', '✓ Companion server reconnected.');
          }
        } else {
          state.compFailStreak++;
          if (state.compFailStreak === COMPANION_FAIL_THRESHOLD) {
            // Confirmed outage (not a one-off blip) — surface it now, tied
            // to the actual failure, rather than a floating status ping.
            state.compConnected = false; state.compInfo = null;
            appendMsg('system', '⚠ Companion server disconnected mid-task — shell, git, and browser tools will fail until it reconnects. If you restarted it, enter its new session token in the connection banner.');
            notifyUser('Companion server disconnected', 'Shell, git, and browser tools will fail until it reconnects.');
          }
          // First miss: stay optimistic. Don't flip compConnected or notify
          // yet — let an in-flight tool call try its own request rather
          // than being pre-emptively blocked by a probe that may have just
          // been unlucky.
        }
        return ok;
      }
      const dot = document.getElementById('comp-dot'), txt = document.getElementById('comp-text'), info = document.getElementById('comp-info');
      dot.className = 'status-dot loading'; txt.textContent = 'Shell...';
      try {
        const res = await companionFetch(`${state.compUrl}/status`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(res.statusText); const data = await res.json();
        if (data.version !== '1.6.0' || !data.command_lifecycle) throw new Error('Companion version mismatch. Download and start the companion bundled with this HTML.');
        state.compConnected = true; state.compInfo = data; state.compFailStreak = 0;
        updateCompanionPairing('connected');
        dot.className = 'status-dot comp-on'; txt.textContent = 'Shell';
        let pythonLine = `<div><span>Python:</span> ${data.python} (${data.python_cmd || 'unknown'})</div>`;
        if (data.python_env) {
          const pe = data.python_env;
          let envNote = '';
          if (pe.is_venv) envNote = ' <span style="color:var(--green)">[venv]</span>';
          if (pe.type && pe.type !== 'none') envNote += ' <span style="color:var(--tx-4)">[' + pe.type + ']</span>';
          pythonLine += `<div><span>Env:</span> ${pe.prefix || '?'}${envNote}</div>`;
        }
        let nodeLine = '';
        if (data.node_env) nodeLine = `<div><span>Node:</span> ${data.node_env.version || '?'} (${data.node_env.path || '?'})</div>`;
        state.browserAvailable = !!data.playwright;
        const browserLine = data.playwright
          ? `<div><span>Playwright:</span> <span style="color:var(--green)">available</span>${data.browser_open ? ' · <span style="color:var(--cyan)">browser open</span>' : ''}</div>`
          : `<div><span>Playwright:</span> <span style="color:var(--tx-4)">not installed</span> <span style="color:var(--tx-4);font-size:9px">(npm init playwright@latest)</span></div>`;
        info.innerHTML = `<div><span>Status:</span> Connected</div><div><span>Platform:</span> ${data.platform} ${data.release}</div><div><span>Shell:</span> ${data.shell || 'default'}</div><div><span>CWD:</span> ${data.cwd}</div>${pythonLine}${nodeLine}${browserLine}`;
      } catch (e) {
        state.compConnected = false; state.compInfo = null;
        dot.className = 'status-dot off'; txt.textContent = 'Shell';
        info.innerHTML = '<div style="color:var(--tx-4)">' + esc(e.message || 'Not connected') + '</div>';
        updateCompanionPairing(e.status===401?'unauthorized':e.status || !/fetch|network|timeout|abort/i.test(e.message)?'error':'offline',e.message);
      }
      checkGitRepo();
      if (state.compConnected && (state.mcpConfig || document.getElementById('s-mcp-config')?.value)) {
        syncMcpServers();
      }
      renderToolList();
      return state.compConnected;
    }

    async function checkGitRepo() {
      state.isGitRepo = false;
      if (!state.compConnected) return;
      try {
        const result = await execViaCompanion('git rev-parse --is-inside-work-tree 2>&1', 10, null, null, true);
        state.isGitRepo = result.status === 'ok' && result.output.trim() === 'true';
      } catch { }
    }

    const toolHandlers = {
      'save_memory': async (args) => {
        if (!args.note || !String(args.note).trim()) return { output: 'Error: "note" is required for save_memory' };
        try {
          await appendProjectMemory(args.note);
          return { output: `Saved to ${getProjectMemoryFile()}. It will be shown to you at the start of future conversations in this workspace.` };
        } catch (e) {
          return { output: 'Error saving memory: ' + e.message };
        }
      },
      'update_plan': async (args) => {
        const items = Array.isArray(args.items) ? args.items : [];
        state.planItems = items.map(it => ({
          text: String(it.text || '').slice(0, 200),
          status: ['pending', 'in_progress', 'done'].includes(it.status) ? it.status : 'pending'
        }));
        renderTodoChecklist();
        const done = state.planItems.filter(i => i.status === 'done').length;
        return { output: `Plan updated (${done}/${state.planItems.length} done).` };
      },
      'update_beliefs': async (args) => {
        const hyps = Array.isArray(args.hypotheses) ? args.hypotheses : [];
        state.beliefs = hyps.map(h => ({
          text: String(h.text || '').slice(0, 240),
          confidence: Math.max(0, Math.min(100, Math.round(Number(h.confidence) || 0))),
          status: ['active', 'ruled_out', 'confirmed'].includes(h.status) ? h.status : 'active'
        }));
        state.beliefNextAction = String(args.next_action || '').slice(0, 300);
        renderTodoChecklist();
        const confirmed = state.beliefs.find(h => h.status === 'confirmed');
        const leading = confirmed || state.beliefs.filter(h => h.status === 'active').sort((a, b) => b.confidence - a.confidence)[0];
        return { output: leading ? `Beliefs updated. Leading: "${leading.text}" (${leading.confidence}%${leading.status === 'confirmed' ? ', confirmed' : ''}).` : 'Beliefs updated (no active hypotheses).' };
      },
      'set_invariants': async (args) => {
        const list = Array.isArray(args.invariants) ? args.invariants : [];
        state.invariants = list.map(s => String(s).slice(0, 200)).filter(Boolean);
        state._sysPromptCacheText = null; // invariants are injected into the system prompt, so force a rebuild
        renderTodoChecklist();
        return { output: state.invariants.length ? `Invariants set (${state.invariants.length}). These are now in your system prompt for the rest of this conversation.` : 'Invariants cleared.' };
      },
      'ask_user': async (args) => {
        if (!args.question) return { output: 'Error: "question" is required for ask_user' };
        const answer = await promptUserQuestion(args.question, Array.isArray(args.options) ? args.options : []);
        return { output: answer === false ? '[User dismissed the question without answering. Proceed using your best judgment, or try asking again more specifically.]' : `User answered: ${answer}` };
      },
      'read_file': async (args) => {
        if (args._parseError) return { output: 'Error: read_file received invalid arguments — ' + args._parseError + '\n\nFix: Provide "path" as valid JSON. Example:\nread_file({"path": "src/main.py"})' };
        if (!args.path) return { output: 'Error: "path" is required for read_file. Example: read_file({"path": "src/main.py"})\n\nDebug: received args: ' + esc(JSON.stringify(args).slice(0, 300)) };
        return await readFileSafe(args.path);
      },
      'read_file_summary': async (args) => {
        if (!args.path) return { output: 'Error: "path" is required' };
        return await readFileSummarySafe(args.path);
      },
      '/reindex': async () => {
        showToast('Re-indexing...', 'info');
        startIndexing().then(() => showToast('Indexed ' + semanticIndex.size + ' files', 'ok'));
        return { output: 'Re-indexing started. Will notify when complete.' };
      },
      'view_image': async (args) => {
        if (args._parseError) return { output: 'Error: view_image received invalid arguments — ' + args._parseError };
        if (!args.path) return { output: 'Error: "path" is required for view_image. Example: view_image({"path": "assets/logo.svg"})\n\nDebug: received args: ' + esc(JSON.stringify(args).slice(0, 300)) };
        return await viewImageSafe(args.path);
      },
      'read_file_lines': async (args) => {
        if (args._parseError) return { output: 'Error: read_file_lines received invalid arguments — ' + args._parseError };
        if (!args.path) return { output: 'Error: "path" is required for read_file_lines. Example: read_file_lines({"path": "src/main.py", "start_line": 1, "end_line": 50})\n\nDebug: received args: ' + esc(JSON.stringify(args).slice(0, 300)) };
        return await readFileLinesSafe(args.path, args.start_line, args.end_line);
      },
      'edit_file': async (args, signal) => {
        if (args._parseError) {
          const isTruncated = args._parseError.includes('truncated') || args._parseError.includes('empty');
          const pathHint = args.path ? ` (path: "${args.path}")` : '';
          const msg = isTruncated
            ? `TRUNCATED — edit_file JSON was cut off mid-stream${pathHint}. The edits array content was too large.\n\nThis usually happens when:\n- old_text or new_text contains a very large block of code\n- The path was placed AFTER the edits array and got cut off\n\nFix:\n1. Put "path" FIRST in the JSON object — before "edits"\n2. Keep each old_text under 20 lines / 500 chars\n3. Split large edits into multiple sequential edit_file calls\n\nExample:\nedit_file({"path":"index.html", "edits": [{"old_text":"short snippet", "new_text":"replacement"}]})`
            : `Error: edit_file received invalid arguments${pathHint} — ${args._parseError}\n\nExample:\nedit_file({"path": "src/example.py", "edits": [{"old_text": "old line", "new_text": "new line"}]})`;
          return { output: msg, _truncatedWrite: isTruncated };
        }
        if (!args.path) {
          return { output: 'Error: "path" is required for edit_file. Put "path" as the FIRST key in the JSON object (before "edits") so it is never truncated.\n\nExample:\nedit_file({"path": "src/example.py", "edits": [{"old_text":"old text", "new_text":"new text"}]})\n\nDebug: received args: ' + esc(JSON.stringify(args).slice(0, 300)) };
        }
        if (!Array.isArray(args.edits) || !args.edits.length) {
          return { output: 'Error: "edits" must be a non-empty array of {old_text, new_text} objects.\n\nExample:\nedit_file({"path": "src/example.py", "edits": [\n  {"old_text":"line to find", "new_text":"replacement line"},\n  {"old_text":"another line", "new_text":"another replacement"}\n]})\n\nDebug: received args: ' + esc(JSON.stringify(args).slice(0, 300)) };
        }
        let editsValid = true;
        for (let i = 0; i < args.edits.length; i++) {
          if (!args.edits[i].old_text) {
            return { output: 'Error: edits[' + i + '].old_text is missing or empty. Every edit must have an "old_text" field with the exact text to find.\n\nDebug: edits[' + i + '] = ' + esc(JSON.stringify(args.edits[i]).slice(0, 200)) };
          }
        }

        const result = await editFileSafe(args.path, args.edits, state.requireEditApproval);

        const editSucceeded = result
          && !result._pendingApproval
          && !String(result.output || '').includes('ERROR')
          && !String(result.output || '').includes('not found');

        if (editSucceeded) {
          debouncedFileTreeRefresh();
          debouncedEmbedUpdate(args.path);
          if (state.compConnected && (args.path || '').endsWith('.py')) {
            try {
              const check = await execViaCompanion(
                'python3 -m py_compile "' + args.path + '" || python -m py_compile "' + args.path + '"',
                15, signal
              );
              if (typeof check === 'string' && check.trim()) result.output += '\n\n⚠️ SYNTAX CHECK WARNING:\n' + check.trim();
            } catch (_) { }
          }
        }
        return result;
      },
      'write_file_chunked': async (args, signal, panel, argsStr) => {
        let wcArgs = args;
        let wasSalvaged = false;
        if (args._parseError && argsStr) {
          const rescued = { _parseError: args._parseError };
          const pathM = argsStr.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (pathM) rescued.path = pathM[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          const chunksStart = argsStr.indexOf('"chunks"');
          if (chunksStart !== -1) {
            const arrStart = argsStr.indexOf('[', chunksStart);
            if (arrStart !== -1) {
              const partial = argsStr.slice(arrStart);
              const salvaged = [];
              let i = 1;
              while (i < partial.length) {
                while (i < partial.length && /[\s,]/.test(partial[i])) i++;
                if (partial[i] !== '"') break;
                let j = i + 1, str = '', complete = false;
                while (j < partial.length) {
                  if (partial[j] === '\\' && j + 1 < partial.length) {
                    const escChar = partial[j + 1];
                    str += escChar === 'n' ? '\n' : escChar === 't' ? '\t' : escChar === 'r' ? '\r' : escChar === '"' ? '"' : escChar === '\\' ? '\\' : escChar;
                    j += 2;
                  } else if (partial[j] === '"') { complete = true; j++; break; }
                  else { str += partial[j]; j++; }
                }
                if (complete) { salvaged.push(str); i = j; }
                else break;
              }
              if (salvaged.length) { rescued.chunks = salvaged; wasSalvaged = true; }
            }
          }
          wcArgs = rescued;
        }

        if (!wcArgs.path) {
          return { output: 'Error: "path" is required for write_file_chunked. Put it first in the JSON.' };
        }
        if (!Array.isArray(wcArgs.chunks) || !wcArgs.chunks.length) {
          const errDetail = args._parseError
            ? `The JSON was truncated before any complete chunks could be parsed.\n\nIMPORTANT: Keep each chunk small — 50-80 lines max — so that all chunks fit within the token budget.\n\nFix:\nwrite_file_chunked({"path": "${wcArgs.path || 'YOUR_FILE'}", "chunks": ["lines 1-60 here", "lines 61-120 here", "lines 121-180 here", ...]})`
            : `"chunks" must be a non-empty array of strings.\n\nDebug: args.chunks = ${JSON.stringify(wcArgs.chunks)}, keys: ${Object.keys(wcArgs).join(', ')}`;
          return { output: 'Error: ' + errDetail };
        }

        const joined = wcArgs.chunks.join('');
        let result;
        if (wcArgs.append) {
          let existing = '';
          try {
            const segs2 = sanitizePath(wcArgs.path);
            let d2 = state.dirHandle;
            for (let i = 0; i < segs2.length - 1; i++) d2 = await d2.getDirectoryHandle(segs2[i], { create: false }).catch(() => null);
            if (d2) {
              const fh2 = await d2.getFileHandle(segs2[segs2.length - 1], { create: false }).catch(() => null);
              if (fh2) existing = await (await fh2.getFile()).text();
            }
          } catch { }
          result = await writeFileSafe(wcArgs.path, existing + joined, state.requireEditApproval);
        } else {
          result = await writeFileSafe(wcArgs.path, joined, state.requireEditApproval);
        }

        if (result && !result._pendingApproval && !String(result.output || '').includes('Error')) {
          const totalLines = joined.split('\n').length;
          if (wasSalvaged) {
            result.output = `⚠ PARTIAL WRITE (JSON was truncated mid-chunks):\n` +
              `Wrote ${wcArgs.chunks.length} chunk(s) / ${totalLines} lines / ${joined.length} bytes to "${wcArgs.path}".\n\n` +
              `The file is INCOMPLETE. Continue writing the rest using append mode:\n` +
              `write_file_chunked({"path": "${wcArgs.path}", "append": true, "chunks": ["...lines that come after what was written...", "...more lines..."]})\n\n` +
              `Keep each chunk ≤ 60 lines so all chunks fit in one tool call.`;
          } else {
            result.output = (result.output || 'OK') +
              ` [write_file_chunked: ${wcArgs.chunks.length} chunks, ${totalLines} lines, ${joined.length} bytes]`;
          }
          debouncedFileTreeRefresh();
          debouncedEmbedUpdate(wcArgs.path);
        }
        return result;
      },
      'write_file': async (args, signal, panel, argsStr) => {
        if (args._parseError) {
          const contentHint = argsStr.includes('"content"') ? 'The "content" field was present but the JSON was cut off — the file content was too long for a single tool call.' : 'Could not find a "content" field in the truncated JSON.';
          return {
            output: 'Error: write_file received invalid arguments — ' + args._parseError + '\n\n' + contentHint + '\n\nFix: Instead of one large write_file, either:\n1. Use edit_file with small search/replace blocks on an existing file\n2. Split into multiple smaller write_file calls\n3. Reduce the content size\n\nExample:\nwrite_file({"path": "src/example.py", "content": "print(\\"hello\\")"})\n\nIf the file is very large (>30KB), use edit_file instead.',
            _truncatedWrite: true
          };
        }
        if (!args.path) {
          return { output: 'Error: "path" is required for write_file.\n\nExample:\nwrite_file({"path": "src/example.py", "content": "your code here"})\n\nDebug: received args: ' + esc(JSON.stringify(args).slice(0, 300)) };
        }
        if (args.content === undefined || args.content === null) {
          return { output: 'Error: "content" is required for write_file. The JSON may have been truncated mid-content.\n\nExample:\nwrite_file({"path": "src/example.py", "content": "your code here"})\n\nDebug: received args keys: [' + Object.keys(args).join(', ') + ']' };
        }
        const result = await writeFileSafe(args.path, args.content, state.requireEditApproval);

        const writeSucceeded = result
          && !result._pendingApproval
          && !String(result.output || '').includes('Error');

        if (writeSucceeded) {
          debouncedFileTreeRefresh();
          debouncedEmbedUpdate(args.path);
          if (state.compConnected && (args.path || '').endsWith('.py')) {
            try {
              const check = await execViaCompanion(
                'python3 -m py_compile "' + args.path + '" || python -m py_compile "' + args.path + '"',
                15, signal
              );
              if (typeof check === 'string' && check.trim()) result.output += '\n\n⚠️ SYNTAX CHECK WARNING:\n' + check.trim();
            } catch (_) { }
          }
        }
        return result;
      },
      'list_directory': async (args) => {
        return { output: await listDirSafe(args.path || '', args.recursive || false) };
      },
      'search_files': async (args) => {
        if (!args.pattern) return { output: 'Error: "pattern" is required for search_files' };
        return { output: await searchFilesSafe(args.pattern) };
      },
      'grep': async (args) => {
        if (!args.pattern) return { output: 'Error: "pattern" is required for grep' };
        return await grepSafe(args.pattern, args.path || '', args.include || '', args.context_lines || 0);
      },
      'delete_file': async (args, signal, panel, argsStr) => {
        if (!args.path) return { output: 'Error: "path" is required for delete_file' };
        if (!args._confirmDelete) {
          return new Promise(resolve => {
            const isRec = !!args.recursive;
            const warn = isRec ? ' This will delete all contents.' : '';
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay open';
            overlay.style.zIndex = '150';
            const dialog = document.createElement('div');
            dialog.className = 'modal';
            dialog.style.width = '400px';
            dialog.innerHTML = `<div class="modal-hdr"><h2 style="display:flex;align-items:center;gap:6px"><i class="fas fa-triangle-exclamation" style="color:var(--red)"></i> Delete File</h2><button class="modal-close" id="df-close"><i class="fas fa-xmark"></i></button></div><div class="modal-body" style="gap:10px"><p style="font-size:13px;color:var(--tx-1);line-height:1.5;margin:0">Delete <code style="font-family:'JetBrains Mono',monospace;font-size:12px;background:var(--bg-3);padding:1px 5px;border-radius:3px;word-break:break-all">${esc(args.path)}</code>?${warn}</p><p style="font-size:11px;color:var(--tx-3);margin:0;font-style:italic">This cannot be undone.</p><div style="display:flex;gap:8px;justify-content:flex-end"><button class="sb-btn" id="df-cancel" style="padding:7px 14px;font-size:12px">Cancel</button><button class="sb-btn" id="df-ok" style="padding:7px 14px;font-size:12px;background:var(--red);color:white;border-color:var(--red)">Delete</button></div></div>`;
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            const cleanup = () => overlay.remove();
            dialog.querySelector('#df-close').onclick = cleanup;
            dialog.querySelector('#df-cancel').onclick = cleanup;
            overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });
            dialog.querySelector('#df-ok').onclick = () => {
              cleanup();
              resolve(executeTool('delete_file', JSON.stringify({ ...safeParseArgs(argsStr), _confirmDelete: true, recursive: args.recursive }), signal, panel));
            };
          });
        }
        const result = { output: await deleteFileSafe(args.path, args.recursive) };
        debouncedFileTreeRefresh();
        return result;
      },
      'move_file': async (args) => {
        if (!args.source) return { output: 'Error: "source" is required for move_file' };
        if (!args.destination) return { output: 'Error: "destination" is required for move_file' };
        const result = { output: await moveFileSafe(args.source, args.destination) };
        debouncedFileTreeRefresh();
        return result;
      },
      'semantic_search': async (args) => {
        if (!args.query) return { output: 'Error: "query" is required for semantic_search. Example: semantic_search({"query": "find the auth middleware"})' };
        try { return await doSemanticSearch(args.query, args.top_k || 8); }
        catch (e) { return { output: 'Error: ' + e.message }; }
      },
      'start_dev_server': async (args) => {
        if (!state.compConnected) return { output: 'start_dev_server requires the companion server.' };
        if (!args.command) return { output: 'Error: "command" is required. Example: start_dev_server({"command": "npm run dev", "port": 3000})' };
        const port = featureTask()?.port || parseInt(args.port) || 3000;
        try {
          const res = await companionFetch(`${state.compUrl}/dev_start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: args.command, port, cwd: null, taskId: featureTask()?.id }),
            signal: AbortSignal.timeout(15000)
          });
          const data = await res.json();
          if (data.error) return { output: `[Dev Server Error] ${data.error}` };
          state.devServer = { port, command: args.command, pollInterval: null, ready: false };
          switchRpTab('preview');
          updateDevPreviewUI('starting');
          pollDevServer(port);
          return { output: `Dev server starting: "${args.command}" → http://localhost:${port}\n\nPreview is loading in the Preview panel. The server runs in the background — you can continue coding while it starts.\n\nUse browser_screenshot to capture the preview, browser_console to check for errors, or fetch_url to read pages.` };
        } catch (e) {
          return { output: `[Dev Server Error] ${e.message}` };
        }
      },
      'execute_command': async (args, signal, panel) => {
        const cmd = String(args.command || '').trim();
        if (!cmd) return { output: 'Error: "command" is required for execute_command' };
        // Default is to always ask before running a real shell command. Commands
        // matching isDangerous() need BOTH shellAutoApprove and the explicit
        // shellAutoApproveDangerous override to skip confirmation; everything
        // else just needs shellAutoApprove.
        const cmdIsDangerous = isDangerous(cmd);
        const needsConfirm = state.compConnected && (
          cmdIsDangerous ? !(state.shellAutoApprove && state.shellAutoApproveDangerous) : !state.shellAutoApprove
        );
        if (needsConfirm) {
          return new Promise(resolve => {
            showShellConfirm(cmd, async modifiedCmd => {
              if (modifiedCmd) {
                rpTermStart(modifiedCmd);
                let streamedOutput = '';
                const onLine = (text) => { streamedOutput += text; if (panel) streamToolResult(panel, text); rpTermAppend(text); };
                const out = await execViaCompanion(modifiedCmd, args.timeout, signal, onLine, true, panel?.el?._toolCallId);
                const finalOutput = out.output || streamedOutput;
                rpTermEnd(finalOutput);
                resolve({ ...out, output: finalOutput });
              } else {
                resolve({ output: 'Command cancelled by user.' });
              }
            }, cmdIsDangerous ? 'Dangerous' : 'Confirm command', signal);
          });
        }
        if (state.compConnected) {
          rpTermStart(cmd);
          let streamedOutput = '';
          const onLine = (text) => { streamedOutput += text; if (panel) streamToolResult(panel, text); rpTermAppend(text); };
          const out = await execViaCompanion(cmd, args.timeout, signal, onLine, true, panel?.el?._toolCallId);
          const finalOutput = out.output || streamedOutput;
          rpTermEnd(finalOutput);
          return { ...out, output: finalOutput };
        } else { return await execVirtual(cmd); }
      },
      'screenshot': async (args) => {
        if (!state.visionCapable) return { output: 'Screenshot requires a vision-capable model.' };
        try {
          const reason = args.reason || 'agent requested';
          const dataUrl = navigator.mediaDevices?.getDisplayMedia ? await captureScreenRegion('SlopLobster wants to see your screen', reason) : await captureScreenshotFallback();
          if (!dataUrl) return { output: 'Screenshot cancelled by user.' };
          const sizeKB = Math.round((dataUrl.length * 3 / 4) / 1024);
          return { output: 'Screenshot captured (' + sizeKB + ' KB).', _screenshotDataUrl: dataUrl, _screenshotReason: reason, _screenshotPath: 'screen-capture' };
        } catch (e) { return { output: 'Screenshot failed: ' + e.message }; }
      },
      'web_search': async (args) => {
        if (!state.compConnected) return { output: 'web_search requires the companion server.', _searchData: null };
        if (!args.query) return { output: 'Error: "query" is required for web_search' };
        try {
          const data = await searchViaCompanion(args.query, args.num_results, args.fetch_top);
          let text = 'Search: "' + args.query + '"\nFound ' + data.count + ' results\n\n';
          data.results.forEach((r, i) => {
            if (r.error) {
              text += `${i + 1}. Error: ${r.error}\n\n`;
              return;
            }
            text += (i + 1) + '. ' + (r.title || '(no title)') + '\n   ' + r.url + '\n';
            if (r.snippet) text += '   ' + r.snippet + '\n'; if (r.content) text += '\n   --- Fetched content (' + (r.content_chars || r.content.length).toLocaleString() + ' chars) ---\n' + r.content.slice(0, 8000) + (r.content.length > 8000 ? '\n   ... (truncated)' : '') + '\n'; if (r.content_error) text += '   [Fetch failed: ' + r.content_error + ']\n'; text += '\n';
          });
          return { output: text, _searchData: data };
        } catch (e) { return { output: 'Search error: ' + e.message, _searchData: null }; }
      },
      'fetch_url': async (args) => {
        if (!state.compConnected) return { output: 'fetch_url requires the companion server.' };
        if (!args.url || typeof args.url !== 'string' || !args.url.trim()) return { output: 'Error: "url" is required for fetch_url' };
        if (!args.url.trim().startsWith('http://') && !args.url.trim().startsWith('https://')) return { output: 'Error: URL must start with http:// or https://' };
        return { output: await fetchViaCompanion(args.url.trim(), args.max_bytes) };
      },
      'http_request': async (args) => {
        if (!args.url || typeof args.url !== 'string' || !args.url.trim()) return { output: 'Error: "url" is required for http_request' };
        const url = args.url.trim();
        if (!url.startsWith('http://') && !url.startsWith('https://')) return { output: 'Error: URL must start with http:// or https://' };
        const method = (args.method || 'GET').toUpperCase();
        const timeoutMs = Math.max(1, Math.min(120, args.timeout || 30)) * 1000;
        try {
          const opts = { method, headers: args.headers || {}, signal: AbortSignal.timeout(timeoutMs) };
          if (args.body !== undefined && method !== 'GET' && method !== 'HEAD') opts.body = args.body;
          const started = performance.now();
          const res = await fetch(url, opts);
          const elapsedMs = Math.round(performance.now() - started);
          const ct = res.headers.get('content-type') || '';
          let bodyText = '';
          try { bodyText = await res.text(); } catch { }
          const MAX_BODY = 50000;
          const truncated = bodyText.length > MAX_BODY;
          if (truncated) bodyText = bodyText.slice(0, MAX_BODY) + `\n… [truncated, ${bodyText.length} bytes total]`;
          const headerLines = [];
          res.headers.forEach((v, k) => headerLines.push(`${k}: ${v}`));
          return { output: `HTTP ${res.status} ${res.statusText} (${elapsedMs}ms)\nContent-Type: ${ct}\n\nHeaders:\n${headerLines.join('\n')}\n\nBody:\n${bodyText}` };
        } catch (e) {
          const isCors = e instanceof TypeError;
          const hint = isCors
            ? '\n\nThis looks like a CORS/network block — the target API likely doesn\'t allow cross-origin browser requests. If a companion server is connected, try execute_command with curl instead.'
            : '';
          return { output: `Error: request failed — ${e.message}${hint}` };
        }
      },
      'run_tests': async (args, signal, panel) => {
        if (!state.compConnected) return { output: 'run_tests requires the companion server (needs a real shell to run test commands).' };
        const cmd = (args.command && args.command.trim()) || state.autoVerifyCommand;
        if (!cmd) return { output: 'Error: no "command" given and no auto-verify command configured in settings.' };
        const timeoutSec = Math.max(5, Math.min(600, args.timeout || 120));
        const result = await execViaCompanion(cmd, timeoutSec, signal, null, true, panel?.el?._toolCallId);
        const raw = result.output;
        const parsed = parseTestOutput(raw);
        const tail = raw.length > 4000 ? '…\n' + raw.slice(-4000) : raw;
        if (parsed) {
          const summary = `Command: ${cmd}\nFramework: ${parsed.framework}\nResult: ${parsed.failed > 0 ? 'FAILED' : 'PASSED'} — ${parsed.passed} passed, ${parsed.failed} failed${parsed.skipped ? `, ${parsed.skipped} skipped` : ''} (${parsed.total} total)`;
          // Only include raw output when something failed — no point spending context on a clean pass.
          return { ...result, status: result.status === 'ok' && parsed.failed > 0 ? 'error' : result.status,
            output: parsed.failed > 0 || result.status !== 'ok' ? `${summary}\n\n--- output (tail) ---\n${tail}` : summary };
        }
        return { ...result, output: `Command: ${cmd}\n(Could not parse a structured summary from this output — showing raw tail)\n\n${tail}` };
      },
      'git_status': async () => {
        return { output: await gitStatus() };
      },
      'git_diff': async (args) => {
        return { output: await gitDiff(args.staged, args.file) };
      },
      'git_log': async (args) => {
        return { output: await gitLog(args.count) };
      },
      'git_add': async (args) => {
        if (!args.paths) return { output: 'Error: "paths" is required for git_add' };
        return { output: await gitAdd(args.paths) };
      },
      'git_commit': async (args) => {
        if (!args.message) return { output: 'Error: "message" is required for git_commit' };
        if (!state.gitWriteAutoApprove) {
          return new Promise(resolve => {
            showActionConfirm('Confirm commit', args.message, msgOrFalse => {
              if (msgOrFalse === false) { resolve({ output: 'Commit cancelled by user.' }); return; }
              gitCommit(msgOrFalse).then(output => resolve({ output }));
            }, { editable: true, icon: 'fa-code-commit', yesLabel: 'Commit', subtitle: args.premortem ? 'If wrong: ' + args.premortem : null });
          });
        }
        return { output: await gitCommit(args.message) };
      },
      'git_push': async (args) => {
        // git_push always confirms, even with gitWriteAutoApprove on — it's the one
        // git action that touches a shared/remote history, not just the local repo.
        const label = `${args.remote || 'origin'} ${args.branch || '(current branch)'}${args.force ? ' --force-with-lease' : ''}`;
        return new Promise(resolve => {
          showActionConfirm('Confirm push', label, async valOrFalse => {
            if (valOrFalse === false) { resolve({ output: 'Push cancelled by user.' }); return; }
            resolve({ output: await gitPush(args.remote, args.branch, args.force) });
          }, { icon: 'fa-cloud-arrow-up', yesLabel: 'Push' });
        });
      },
      'git_checkout_branch': async (args) => {
        if (!args.branch) return { output: 'Error: "branch" is required for git_checkout_branch' };
        if (!state.gitWriteAutoApprove) {
          return new Promise(resolve => {
            showActionConfirm(args.create ? 'Confirm create+checkout' : 'Confirm checkout', args.branch, async valOrFalse => {
              if (valOrFalse === false) { resolve({ output: 'Checkout cancelled by user.' }); return; }
              resolve({ output: await gitCheckoutBranch(args.branch, args.create) });
            }, { icon: 'fa-code-branch', yesLabel: 'Checkout' });
          });
        }
        return { output: await gitCheckoutBranch(args.branch, args.create) };
      },
      'git_stash': async (args) => {
        const action = args.action || 'push';
        if (action !== 'push' && action !== 'pop' && action !== 'list') return { output: 'Error: "action" must be push, pop, or list' };
        if (action === 'list') return { output: await gitStash('list') };
        if (!state.gitWriteAutoApprove) {
          return new Promise(resolve => {
            showActionConfirm(action === 'pop' ? 'Confirm stash pop' : 'Confirm stash push', args.message || '(unnamed stash)', async valOrFalse => {
              if (valOrFalse === false) { resolve({ output: 'Stash cancelled by user.' }); return; }
              resolve({ output: await gitStash(action, args.message) });
            }, { icon: 'fa-box-archive', yesLabel: action === 'pop' ? 'Pop' : 'Stash' });
          });
        }
        return { output: await gitStash(action, args.message) };
      },
      'think': async (args) => {
        if (!args.thought) return { output: 'Error: "thought" is required for think' };
        return { output: args.thought };
      },
      'browser_launch': async (args) => {
        if (!state.compConnected) return { output: 'browser_launch requires the companion server.' };
        if (!state.browserAvailable) return { output: 'Playwright is not installed on the companion. Run: pip install playwright Then restart the companion server.' };
        return { output: await browserApi('/browser_launch', args) };
      },
      'browser_navigate': async (args) => {
        if (!args.url) return { output: 'Error: "url" is required for browser_navigate' };
        return { output: await browserApi('/browser_navigate', args) };
      },
      'browser_screenshot': async (args, signal, panel) => {
        return await handleBrowserScreenshot(args, panel);
      },
      'browser_console': async (args, signal, panel) => {
        return await handleBrowserConsole(args, panel);
      },
      'browser_click': async (args) => {
        if (!args.selector) return { output: 'Error: "selector" is required for browser_click' };
        if (!state.browserWriteAutoApprove) return await confirmBrowserAction('Confirm click', args.selector, () => browserApi('/browser_click', args));
        return { output: await browserApi('/browser_click', args) };
      },
      'browser_type': async (args) => {
        if (!args.selector || args.text === undefined) return { output: 'Error: "selector" and "text" are required for browser_type' };
        if (!state.browserWriteAutoApprove) return await confirmBrowserAction('Confirm typing', `${args.selector}: "${args.text}"${args.submit ? ' + Enter' : ''}`, () => browserApi('/browser_type', args));
        return { output: await browserApi('/browser_type', args) };
      },
      'browser_evaluate': async (args) => {
        if (!args.script) return { output: 'Error: "script" is required for browser_evaluate' };
        if (!state.browserWriteAutoApprove) return await confirmBrowserAction('Confirm JS', args.script, () => browserApi('/browser_evaluate', args));
        return { output: await browserApi('/browser_evaluate', args) };
      },
      'browser_get_content': async (args) => {
        return { output: await browserApi('/browser_get_content', args) };
      },
      'browser_wait_for': async (args) => {
        if (!args.selector) return { output: 'Error: "selector" is required for browser_wait_for' };
        return { output: await browserApi('/browser_wait_for', args) };
      },
      'browser_hover': async (args) => {
        if (!args.selector) return { output: 'Error: "selector" is required for browser_hover' };
        return { output: await browserApi('/browser_hover', args) };
      },
      'browser_select_option': async (args) => {
        if (!args.selector || !args.value) return { output: 'Error: "selector" and "value" are required for browser_select_option' };
        return { output: await browserApi('/browser_select_option', args) };
      },
      'browser_press_key': async (args) => {
        if (!args.key) return { output: 'Error: "key" is required for browser_press_key' };
        return { output: await browserApi('/browser_press_key', args) };
      },
      'browser_scroll': async (args) => {
        return { output: await browserApi('/browser_scroll', args) };
      },
      'browser_go_back': async () => {
        return { output: await browserApi('/browser_go_back', {}) };
      },
      'browser_go_forward': async () => {
        return { output: await browserApi('/browser_go_forward', {}) };
      },
      'browser_close': async () => {
        return { output: await browserApi('/browser_close', {}) };
      },
      'get_tool_schema': async (args) => {
        const name = args.tool_name;
        if (!name) return { output: 'Error: "tool_name" is required' };
        const all = getToolDefs(true);
        const def = all.find(t => t.function.name === name);
        if (!def) {
          const names = all.map(t => t.function.name).join(', ');
          return { output: `Tool "${name}" not found.\n\nAvailable tools: ${names}` };
        }
        (state.discoveredTools ||= new Set()).add(name);
        return { output: `Tool: ${name}\nDescription: \dots\n\nParameters:\n${JSON.stringify(def.function.parameters, null, 2)}`.replace('\dots', def.function.description) };
      },
      'swarm_history': async args => ({ status: 'ok', output: JSON.stringify(await swarmHistory(Number(args.limit) || 10, ['critic', 'check', 'isolated', 'criteria'].includes(args.group_by) ? args.group_by : 'critic'), null, 1) }),
      'spawn_swarm': async (args, signal, panel) => {
        if (!args.goal) return { output: 'Error: "goal" is required for spawn_swarm' };
        let swarmResult;
        try {
          swarmResult = await runSwarm(args.goal, args.workers, args.max_worker_iterations, signal, panel, { concurrency: args.concurrency, verifyCommand: args.verify_command, contract: args.contract, isolate: args.isolate === true });
        } catch (e) { return { status: 'error', error: 'invalid_swarm', retryable: true, output: 'Error: ' + e.message }; }
        const failed = swarmResult.outcome === 'blocked';
        return {
          status: failed ? 'error' : 'ok', error: failed ? 'swarm_blocked' : null, retryable: false,
          output: `[Swarm ${swarmResult.outcome.toUpperCase()}: ${swarmResult.workerResults.length} workers, ${swarmResult.totalIterations} total rounds, ${(swarmResult.duration / 1000).toFixed(1)}s]\n${swarmResult.workerResults.map(r => `- ${r.name}: ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`).join('\n')}${swarmResult.acceptance ? '\nAcceptance: ' + swarmResult.acceptance.criteria.map(c => c.id + ' ' + c.status.toUpperCase()).join(', ') : ''}\n\n${swarmResult.managerSummary}`,
          _swarmData: swarmResult
        };
      },
      'deep_research': async (args, signal, panel) => {
        if (!state.compConnected) return { output: 'deep_research requires the companion server to access web_search and fetch_url.' };
        if (!args.query) return { output: 'Error: "query" is required for deep_research.' };
        const depth = Math.min(Math.max(
          (typeof _drDepth !== 'undefined' ? _drDepth : null) || args.depth || 2,
          1), 3);
        const livePanel = createLiveResearchPanel(args.query);
        if (panel && panel.el) {
          panel.el.classList.add('screenshot-tool');
          panel.el.appendChild(livePanel);
          const resEl = panel.el.querySelector('.tool-result');
          if (resEl) resEl.style.display = 'none';
        }
        let result;
        try {
          result = await runDeepResearch(args.query, depth, signal, livePanel);
        } catch (drErr) {
          console.error('[deep_research] uncaught error:', drErr);
          const statusEl = livePanel.querySelector('.dr-status');
          if (statusEl) statusEl.textContent = '❌ ' + drErr.message;
          let dbgLog = livePanel.querySelector('.dr-debug-log');
          if (!dbgLog) {
            dbgLog = document.createElement('div');
            dbgLog.className = 'dr-debug-log';
            dbgLog.style.cssText = 'font-size:9px;font-family:JetBrains Mono,monospace;color:var(--red);padding:6px 8px;white-space:pre-wrap;';
            livePanel.querySelector('.dr-body')?.appendChild(dbgLog);
          }
          dbgLog.textContent += '\nUNCAUGHT: ' + (drErr.stack || drErr.message);
          result = { output: 'Deep research failed: ' + drErr.message, _sources: [], _researchData: null };
        }
        if (panel && panel.el) {
           panel.el._researchData = result._researchData;
        }
        return result;
      },
      'spawn_sub_agent': async (args, signal, panel) => {
        if (!args.task) return { output: 'Error: "task" is required for spawn_sub_agent' };
        if (isSkippedPath(args.task)) return { output: 'Task references a filtered file.' };
        const subResult = await runSubAgent(args.task, args.tools, args.max_iterations, signal, panel);
        return {
          output: `[Sub-agent: ${subResult.iterations} rounds, ${subResult.log.length} tool calls, ${(subResult.duration / 1000).toFixed(1)}s${subResult.extended ? ` — budget extended ${subResult.extended}× while progressing` : ''}${subResult.hitLimit ? ' — stopped at the round limit; partial report below' : ''}${subResult.stalled ? ' — stopped early: repeating without new results; partial report below' : ''}${subResult.incomplete ? ' — INCOMPLETE: continue or re-delegate what remains' : ''}${subResult.error ? ' — ERROR' : ''}]\n${subResult.summary}`,
          _subAgentData: subResult
        };
      }
    };

    /**
     * Resilient multi-tier JSON repair engine for local LLM outputs.
     * Repairs markdown fences, preamble/postscript noise, unescaped newlines/tabs,
     * single quotes, unquoted keys, trailing commas, unclosed braces/brackets/quotes,
     * and performs fallback regex parameter salvaging.
     */
    function repairAndParseJson(raw, toolName = '') {
      if (!raw || typeof raw !== 'string' || !raw.trim()) {
        return { success: false, error: 'empty arguments string', data: null };
      }

      let str = raw.trim();

      // Tier 0: Direct parse
      try {
        const data = JSON.parse(str);
        if (data && typeof data === 'object') return { success: true, data, repaired: false };
      } catch (_) {}

      // Tier 1: Strip markdown code block fences (e.g. ```json ... ``` or ``` ...)
      if (str.startsWith('```')) {
        str = str.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
        try {
          const data = JSON.parse(str);
          if (data && typeof data === 'object') return { success: true, data, repaired: true };
        } catch (_) {}
      }

      // Tier 2: Extract substring between first '{' and last '}' (or '[' and ']')
      const firstBrace = str.indexOf('{');
      const lastBrace = str.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const candidate = str.substring(firstBrace, lastBrace + 1);
        try {
          const data = JSON.parse(candidate);
          if (data && typeof data === 'object') return { success: true, data, repaired: true };
        } catch (_) {}
        str = candidate;
      }

      // Tier 3: Fix common LLM JSON corruptions
      let cleaned = str;

      // 3a. Escape raw unescaped newlines, carriage returns, and tabs inside double-quoted strings
      let inString = false;
      let escaped = false;
      let buf = '';
      for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (escaped) {
          buf += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          buf += ch;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          buf += ch;
          continue;
        }
        if (inString) {
          if (ch === '\n') buf += '\\n';
          else if (ch === '\r') buf += '\\r';
          else if (ch === '\t') buf += '\\t';
          else buf += ch;
        } else {
          buf += ch;
        }
      }
      cleaned = buf;

      try {
        const data = JSON.parse(cleaned);
        if (data && typeof data === 'object') return { success: true, data, repaired: true };
      } catch (_) {}

      // 3b. Fix single quotes to double quotes for keys and strings
      let singleQuoteFixed = cleaned.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => {
        return '"' + inner.replace(/"/g, '\\"') + '"';
      });
      try {
        const data = JSON.parse(singleQuoteFixed);
        if (data && typeof data === 'object') return { success: true, data, repaired: true };
      } catch (_) {}

      // 3c. Fix unquoted keys: e.g. { path: "foo", command: "bar" } -> { "path": "foo", "command": "bar" }
      let keyFixed = singleQuoteFixed.replace(/([{,]\s*)([a-zA-Z0-9_$-]+)\s*:/g, '$1"$2":');
      try {
        const data = JSON.parse(keyFixed);
        if (data && typeof data === 'object') return { success: true, data, repaired: true };
      } catch (_) {}

      // 3d. Remove trailing commas before } or ]
      let noTrailingCommas = keyFixed.replace(/,\s*([\}\]])/g, '$1');
      try {
        const data = JSON.parse(noTrailingCommas);
        if (data && typeof data === 'object') return { success: true, data, repaired: true };
      } catch (_) {}

      // 3e. Balance unclosed quotes, brackets, and braces (e.g. truncated tool call args)
      let balanced = noTrailingCommas;
      let quoteCount = 0;
      for (let i = 0; i < balanced.length; i++) {
        if (balanced[i] === '"' && (i === 0 || balanced[i-1] !== '\\')) quoteCount++;
      }
      if (quoteCount % 2 !== 0) balanced += '"';

      const openBraces = (balanced.match(/\{/g) || []).length;
      const closeBraces = (balanced.match(/\}/g) || []).length;
      if (openBraces > closeBraces) balanced += '}'.repeat(openBraces - closeBraces);

      const openBrackets = (balanced.match(/\[/g) || []).length;
      const closeBrackets = (balanced.match(/\]/g) || []).length;
      if (openBrackets > closeBrackets) balanced += ']'.repeat(openBrackets - closeBrackets);

      try {
        const data = JSON.parse(balanced);
        if (data && typeof data === 'object') return { success: true, data, repaired: true };
      } catch (_) {}

      // Tier 4: Fallback parameter salvage for standard tools via regex
      const salvaged = {};
      let foundAny = false;
      const knownKeys = ['path', 'content', 'old_text', 'new_text', 'command', 'query', 'task', 'goal', 'url', 'chunks', 'depth', 'top_k'];
      for (const key of knownKeys) {
        const re = new RegExp('"' + key + '"\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|(\\d+(?:\\.\\d+)?)|(true|false)|\\[([^\\]]*)\\])', 'i');
        const m = raw.match(re);
        if (m) {
          foundAny = true;
          if (m[1] !== undefined) {
            salvaged[key] = decodeJsonString(m[1]);
          } else if (m[2] !== undefined) {
            salvaged[key] = Number(m[2]);
          } else if (m[3] !== undefined) {
            salvaged[key] = m[3] === 'true';
          }
        }
      }

      if (foundAny && Object.keys(salvaged).length > 0) {
        return { success: true, data: salvaged, repaired: true, fallbackSalvaged: true };
      }

      return {
        success: false,
        error: 'malformed JSON could not be repaired',
        data: null,
        rawPreview: raw.length > 160 ? raw.slice(0, 70) + ' ... ' + raw.slice(-70) : raw
      };
    }

    /**
     * Validate parsed arguments against tool definition parameters schema.
     */
    function validateToolArgs(toolName, args) {
      const def = getToolDefs().find(t => t.function?.name === toolName);
      if (!def) return { valid: false, error: 'Tool is unavailable', schema: {} };
      const schema = def.function.parameters || { type: 'object' };
      const error = HarnessRuntime.validateSchema(args, schema);
      return { valid: !error, error, schema };
    }

    async function executeTool(name, argsStr, signal, panel) {
      const operationId = crypto.randomUUID();
      await recordRunEvent('tool.started', { operationId, toolCallId: panel?.el?._toolCallId, tool: name, arguments: name === 'think' ? '[reasoning omitted]' : argsStr });
      try {
        const result = await executeToolImpl(name, argsStr, signal, panel);
        noteVerificationMutation(name, result);
        await recordRunEvent('tool.completed', { operationId, tool: name, status: result.status || HarnessRuntime.normalizeResult(result).status,
          exitCode: result.exitCode, output: result.output, pendingApproval: !!result._pendingApproval });
        return result;
      } catch (error) {
        noteVerificationMutation(name, { status: 'error' });
        await recordRunEvent('tool.failed', { operationId, tool: name, error: error.message });
        throw error;
      }
    }

    async function executeToolImpl(name, argsStr, signal, panel) {
      let args;
      const parseRes = repairAndParseJson(argsStr, name);
      if (!parseRes.success) {
        args = { _parseError: parseRes.error + (parseRes.rawPreview ? '\nraw args: ' + parseRes.rawPreview : '') };
      } else {
        args = parseRes.data || {};
        if (parseRes.repaired && !HarnessRuntime.isReadOnly(name)) {
          return { status: 'error', error: 'malformed_mutation', retryable: true,
            output: 'Error: mutation arguments required JSON repair. No action was taken. Retry with complete valid JSON.' };
        }
        if (parseRes.repaired) {
          console.warn(`[executeTool] Auto-repaired malformed JSON arguments for tool "${name}"`);
        }
      }

      let _argLeakFields = [];
      if (args._parseError) {
        const def = (typeof getToolDefs === 'function' ? getToolDefs() : []).find(t => t.function?.name === name);
        const schemaStr = def?.function?.parameters ? JSON.stringify(def.function.parameters, null, 2) : '{}';
        return {
          output: `ERROR: Failed to parse arguments for tool "${name}".\n\nIssue: ${args._parseError}\n\nExpected Schema:\n${schemaStr}\n\nPlease retry calling "${name}" with valid JSON conforming to the schema.`
        };
      } else {
        const valRes = validateToolArgs(name, args);
        if (!valRes.valid) {
          return {
            output: `ERROR: Invalid parameters for tool "${name}".\n\nIssue: ${valRes.error}\n\nExpected Schema:\n${JSON.stringify(valRes.schema || {}, null, 2)}\n\nPlease correct the arguments and retry calling "${name}".`
          };
        }
        if (!HarnessRuntime.isReadOnly(name)) {
          const hasArtifacts = value => {
            if (typeof value === 'string') return stripLeakedModelArtifacts(value).stripped;
            if (Array.isArray(value)) return value.some(hasArtifacts);
            if (value && typeof value === 'object') return Object.values(value).some(hasArtifacts);
            return false;
          };
          if (hasArtifacts(args)) return { status: 'error', error: 'model_artifacts', retryable: true,
            output: 'Error: model control tokens were detected in mutation arguments. No action was taken. Retry with clean arguments.' };
        }
        const _isRootPath = args.path === '.' || args.path === './' || args.path === '/';
        if (args.path != null && args.path !== '' && !_isRootPath) {
          try { sanitizePath(args.path); } catch (e) { return { output: 'Security: ' + e.message }; }
        }
        if (args.source != null && args.source !== '') { try { sanitizePath(args.source); } catch (e) { return { output: 'Security: ' + e.message }; } }
        if (args.destination != null && args.destination !== '') { try { sanitizePath(args.destination); } catch (e) { return { output: 'Security: ' + e.message }; } }

        // ── Leaked-model-artifact guard (central choke point) ──
        // write_file/write_file_chunked ("content") and edit_file ("edits[].new_text")
        // already run their own copy of this check with a richer per-file warning, so
        // they're skipped here to avoid double-stripping/duplicate messages. Every OTHER
        // string-ish tool argument (shell commands, git commit messages, browser text
        // input, "thought" text, etc.) is just as exposed to a model hallucinating a
        // pseudo tool-call mid-string, so it gets the same guard here.
        const _skipKeys = new Set(name === 'write_file' || name === 'write_file_chunked' ? ['content', 'chunks']
          : name === 'edit_file' ? ['edits'] : []);
        for (const k of Object.keys(args)) {
          if (_skipKeys.has(k)) continue;
          const v = args[k];
          if (typeof v === 'string' && v.length > 20) {
            const r = stripLeakedModelArtifacts(v);
            if (r.stripped) { args[k] = r.text; _argLeakFields.push(k); }
          } else if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
              if (typeof v[i] === 'string' && v[i].length > 20) {
                const r = stripLeakedModelArtifacts(v[i]);
                if (r.stripped) { v[i] = r.text; _argLeakFields.push(`${k}[${i}]`); }
              }
            }
          }
        }
      }

      try {
        let handler = harnessFeatureHandler(name) || toolHandlers[name];
        if (!handler && state.mcpServerMap && state.mcpServerMap[name]) {
          const srvName = state.mcpServerMap[name];
          handler = async (mcpArgs) => {
            return await callMcpTool(srvName, name, mcpArgs);
          };
        }
        if (!handler) {
          return { output: 'Unknown tool: ' + name };
        }
        const result = HarnessRuntime.normalizeResult(await HarnessRuntime.withToolLock(name, () => {
          if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
          return handler(args, signal, panel, argsStr);
        }), name);
        recordHarnessTool(name, args, result, panel?.el?._toolCallId);
        if (_argLeakFields.length && result && typeof result.output === 'string') {
          result.output += '\n\n⚠️ Detected and removed leaked model control tokens from argument(s): ' + _argLeakFields.join(', ') + ' (the model kept generating past the intended value).';
        }
        if (result && typeof result.output === 'string' && (result.output.includes('0x80072747') || result.output.includes('WSAENOBUFS') || result.output.includes('lacked sufficient buffer space'))) {
          result.output += '\n\n[SYSTEM ADVISORY: Windows socket pool was exhausted (0x80072747). The companion server has reset its persistent shell pool and prioritized native Git Bash.]';
        }
        return result;
      } catch (e) {
        // FIX: If the user hit Esc or cancelled, don't turn it into a text error for the LLM to read.
        // Re-throw it so the agentLoop catches it and stops properly.
        if (e.name === 'AbortError' || signal?.aborted) throw e;

        return { output: 'Error: ' + e.message };
      }
    }
/* ═══════════════ PROJECT DETECTION ═══════════════ */
    async function detectProject() {
      if (!state.dirHandle) { state.projectType = null; state.projectMeta = null; document.getElementById('proj-badge-area').innerHTML = ''; return; }
      const detectors = [
        { name: 'pyproject.toml', type: 'python', parse: async f => { const t = await f.text(); return { name: t.match(/name\s*=\s*["']([^"']+)["']/)?.[1], raw: t }; } },
        { name: 'requirements.txt', type: 'python', parse: async f => ({ deps: (await f.text()).split('\n').filter(l => l && !l.startsWith('#')).slice(0, 10) }) },
        { name: 'setup.py', type: 'python', parse: async () => ({}) },
        { name: 'package.json', type: 'node', parse: async f => { const j = JSON.parse(await f.text()); return { name: j.name, deps: { ...j.dependencies, ...j.devDependencies }, scripts: j.scripts }; } },
        { name: 'Cargo.toml', type: 'rust', parse: async f => { const t = await f.text(); return { name: t.match(/name\s*=\s*"([^"]+)"/)?.[1], edition: t.match(/edition\s*=\s*"([^"]+)"/)?.[1] }; } },
        { name: 'go.mod', type: 'go', parse: async f => ({ module: (await f.text()).match(/module\s+(\S+)/)?.[1] }) },
      ];
      for (const d of detectors) {
        try {
          const h = await state.dirHandle.getFileHandle(d.name); const f = await h.getFile(); const meta = await d.parse(f);
          state.projectType = d.type; state.projectMeta = meta;
          const labels = { python: 'Python', node: 'Node.js', rust: 'Rust', go: 'Go' };
          const area = document.getElementById('proj-badge-area');
          area.innerHTML = `<div class="proj-badge ${d.type}"><i class="fab fa-${d.type === 'python' ? 'python' : d.type === 'node' ? 'node-js' : d.type === 'go' ? 'golang' : 'code'}"></i>${labels[d.type] || d.type}</div>`;
          if (meta.name) area.innerHTML += `<div style="font-size:10px;color:var(--tx-3);font-family:'JetBrains Mono',monospace;margin-top:2px">${esc(meta.name)}</div>`;
          return;
        } catch { }
      }
      state.projectType = null; state.projectMeta = null;
      document.getElementById('proj-badge-area').innerHTML = '<div class="proj-badge unknown">Unknown project type</div>';
    }

    /* ═══════════════ CHECKPOINT SYSTEM ═══════════════ */
    function saveCheckpoint(iteration, filesToSnapshot) {
      if (!state.checkpointEnabled || filesToSnapshot.size === 0) return;
      const snapshot = {};
      for (const path of filesToSnapshot) {
        const content = state.fileCache.get(path);
        if (content !== undefined) snapshot[path] = content;
      }
      if (!Object.keys(snapshot).length) return;

      // Build a meaningful description from recent tool calls
      const recent = toolCallHistory.slice(-5);
      const actions = recent.filter(r => r.success).map(r => {
        const m = r.sig.match(/^(\w+):(.{2,60})/);
        return m ? m[1] + ': ' + m[2].trim() : r.sig.slice(0, 50);
      });
      const desc = actions.length
        ? actions.reverse().join(' → ')
        : `${modifiedFiles.size} file${modifiedFiles.size > 1 ? 's' : ''} modified`;

      state.checkpoints.push({
        id: Date.now(),
        iteration,
        timestamp: Date.now(),
        description: desc,
        files: snapshot,
        messageCount: state.messages.length
      });
      if (state.checkpoints.length > 30) state.checkpoints.shift();
      updateCheckpointUI();
      updateCheckpointList();
    }

    async function rewindToCheckpoint(checkpointId) {
      const cp = state.checkpoints.find(c => c.id === checkpointId);
      if (!cp) return;
      if (state.running) { state.abortCtrl?.abort(); state.running = false; updateSendBtn(); }

      // 1. Restore all files in the checkpoint to their snapshot state
      for (const [path, content] of Object.entries(cp.files)) {
        try { await writeFileSafe(path, content); } catch (e) { showToast(`Rewind failed for ${path}: ${e.message}`, 'err'); }
      }

      // 2. Revert or delete files modified AFTER this checkpoint
      for (const path of allModified) {
        if (!cp.files[path]) {
          const originalContent = state.fileBackups.get(path);
          if (originalContent !== null && originalContent !== undefined) {
            // File existed before the session; restore its original content
            try { await writeFileSafe(path, originalContent); } catch (e) { /* ignore */ }
          } else {
            // File was created during the session; delete it
            try { await deleteFileSafe(path); } catch (e) { /* ignore */ }
          }
        }
      }

      state.messages = state.messages.slice(0, cp.messageCount);
      state.checkpoints = state.checkpoints.filter(c => c.id <= checkpointId);
      modifiedFiles.clear(); newFiles.clear();
      const parent = $msg(); while (parent.firstChild) parent.firstChild.remove();
      streamEl = null;
      if (state.messages.length) { switchToChat(); replayMessages(state.messages); updateContextMeter(); }
      else { document.getElementById('welcome').style.display = 'flex'; $msg().style.display = 'none'; }
      updateCheckpointUI(); saveCurrentConv();
      showToast(`Rewound to: ${cp.description}`, 'ok');
    }

    /* ═══════════════ PAUSE / RESUME ═══════════════
       Unlike Stop (hard AbortController.abort(), can cut a stream or tool call
       mid-flight), Pause sets a flag that's only checked between agentLoop
       iterations — i.e. after the current turn's response AND any tool calls it
       made have fully completed and been appended to state.messages. Nothing is
       cut off and no tokens already generated are thrown away. Resuming just
       calls agentLoop() again since state.messages already holds everything
       needed to continue exactly where it left off. */
    function pauseGeneration() {
      if (!state.running) return;
      state.pauseRequested = true;
      updatePauseBtn();
      showToast('Pausing after the current step finishes…', 'ok');
    }

    function updatePauseBtn() {
      const btn = document.getElementById('pause-btn');
      if (!btn) return;
      btn.style.display = state.running ? '' : 'none';
      btn.disabled = state.pauseRequested;
      btn.innerHTML = state.pauseRequested ? '<i class="fas fa-hourglass-half"></i>' : '<i class="fas fa-pause"></i>';
      btn.title = state.pauseRequested ? 'Pausing after current step…' : 'Pause (finishes the current step first, no tokens lost)';
    }

    function appendPauseMsg() {
      switchToChat();
      const el = document.createElement('div'); el.className = 'msg';
      el.innerHTML = `<div style="width:26px;flex-shrink:0"></div><div class="msg-body"><div class="msg-content" style="color:var(--tx-3);font-size:11px;font-style:italic;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span><i class="fas fa-pause" style="color:var(--accent);margin-right:4px"></i>Paused after finishing the last step — nothing was cut off.</span><button onclick="resumeAgent()" style="padding:3px 10px;font-size:11px;cursor:pointer;background:var(--accent);color:white;border:none;border-radius:3px;font-style:normal">Resume</button></div></div>`;
      $msg().appendChild(el); scrollBottom();
    }

    async function resumeInterruptedRun(convId) {
      await switchConv(convId);
      if (state.activeConvId !== convId || state.running) return;
      state.runController = null;
      state.verificationState = state.taskState?.verification || null;
      await agentLoop();
    }

    function beginRunApproval(detail = {}) {
      const run = state.runController;
      if (!run || !state.running) return async () => {};
      const operationId = crypto.randomUUID();
      const pending = recordRunEvent('approval.requested', { operationId, ...detail }).catch(error => ({ error }));
      state._pendingApprovals = (state._pendingApprovals || 0) + 1;
      if (run.snapshot().phase === 'running') run.transition('awaiting_approval');
      let finished = false;
      return async decision => {
        if (finished) return; finished = true;
        try {
          const started = await pending; if (started?.error) throw started.error;
          await recordRunEvent('approval.decided', { operationId, approved: !!decision, ...detail });
        } finally {
          state._pendingApprovals = Math.max(0, (state._pendingApprovals || 1) - 1);
          if (!state._pendingApprovals && run.snapshot().phase === 'awaiting_approval') run.transition('running');
        }
      };
    }

    async function resumeAgent() {
      if (state.running) return;
      await agentLoop();
    }

    /* ═══════════════ STEER: guide the agent without stopping it ═══════════════
       While the agent is running, the input box stays live. Enter (or the
       queue button) doesn't stop the loop — it queues the text and shows it
       as a pending chip. agentLoop drains the queue at the top of its next
       iteration (see the drain block above), turning each into a normal user
       turn, so the agent incorporates it in its very next response without
       any restart, resend, or lost context. */
    function queueSteerMessage() {
      const inp = document.getElementById('msg-input');
      const text = inp.value.trim();
      if (!text) return;
      state.pendingSteerMessages.push({ id: 'steer_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), text });
      inp.value = ''; inp.style.height = 'auto';
      updateSendBtn(); updateInputCounter();
      renderSteerQueue();
    }

    function removeSteerMessage(id) {
      state.pendingSteerMessages = state.pendingSteerMessages.filter(m => m.id !== id);
      renderSteerQueue();
    }

    function renderSteerQueue() {
      const bar = document.getElementById('steer-queue-bar');
      if (!bar) return;
      if (!state.pendingSteerMessages.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
      bar.style.display = 'flex';
      bar.innerHTML = state.pendingSteerMessages.map(m =>
        `<div class="steer-chip" title="${esc(m.text)}"><i class="fas fa-clock" style="font-size:9px;opacity:.7"></i><span>${esc(m.text.length > 60 ? m.text.slice(0, 60) + '…' : m.text)}</span><button onclick="removeSteerMessage('${m.id}')" title="Cancel"><i class="fas fa-xmark"></i></button></div>`
      ).join('');
    }

    /* ═══════════════ PLAN + BELIEFS PANEL (update_plan / update_beliefs tools) ═══════════════
       Shared panel for two complementary states: hypotheses (uncertain/exploratory
       work — update_beliefs) and a concrete checklist (known-shape work —
       update_plan). Both can be shown at once, in that order, modeling the natural
       lifecycle of diagnostic work: figure out what's true, THEN plan the fix. */
    function togglePlanPopup() {
      let popup = document.getElementById('plan-popup');
      if (!popup) { popup = renderPlanPopup(); document.body.appendChild(popup); }
      popup.classList.toggle('open');
      if (popup.classList.contains('open')) requestAnimationFrame(() => updatePlanList());
      if (!popup.classList.contains('open')) setTimeout(() => { if (popup.parentNode) popup.remove(); }, 250);
    }

    function renderPlanPopup() {
      const popup = document.createElement('div');
      popup.id = 'plan-popup';
      popup.className = 'cp-popup';
      popup.onclick = e => { if (e.target === popup) togglePlanPopup(); };
      popup.innerHTML = `<div class="cp-popup-hdr"><span id="plan-popup-title"><i class="fas fa-list-check" style="color:var(--accent);margin-right:6px"></i>Task Plan</span><button onclick="event.stopPropagation();clearPlan()" title="Clear"><i class="fas fa-trash"></i></button></div><div class="cp-list" id="plan-list"></div>`;
      return popup;
    }

    // Called from the update_plan and update_beliefs tool handlers, and also
    // safe to call any time either changes — keeps the header badge and any
    // open popup in sync. NOTE: named renderTodoChecklist (not renderPlanPanel)
    // to avoid colliding with the pre-existing renderPlanPanel(steps) used by
    // the separate structured "Plan Mode" feature (state.currentPlan) — that
    // name collision previously caused this function to be silently
    // overwritten and never run.
    function renderTodoChecklist() {
      const btn = document.getElementById('plan-btn');
      const badge = document.getElementById('plan-badge');
      const nPlan = state.planItems.length;
      const nBeliefs = state.beliefs.length;
      const nInvariants = state.invariants.length;
      const hasAny = nPlan > 0 || nBeliefs > 0 || nInvariants > 0;
      if (btn) {
        btn.style.display = hasAny ? '' : 'none';
        const icon = btn.querySelector('i');
        if (icon) icon.className = nBeliefs ? 'fas fa-brain' : nPlan ? 'fas fa-list-check' : 'fas fa-shield-halved';
        const parts = [];
        if (nInvariants) parts.push('invariants');
        if (nBeliefs) parts.push('hypotheses');
        if (nPlan) parts.push('task plan');
        btn.title = parts.length ? parts.join(' & ') : 'Task plan';
      }
      if (badge) {
        if (nBeliefs) {
          const confirmed = state.beliefs.find(h => h.status === 'confirmed');
          const leading = confirmed || state.beliefs.filter(h => h.status === 'active').sort((a, b) => b.confidence - a.confidence)[0];
          badge.textContent = leading ? `${leading.confidence}%` : '?';
        } else if (nPlan) {
          const done = state.planItems.filter(i => i.status === 'done').length;
          badge.textContent = `${done}/${nPlan}`;
        } else {
          badge.textContent = `${nInvariants}`;
        }
        badge.classList.toggle('hidden', !hasAny);
      }
      const title = document.getElementById('plan-popup-title');
      if (title) {
        const label = nBeliefs && nPlan ? 'Hypotheses & Plan' : nBeliefs ? 'Hypotheses' : nPlan ? 'Task Plan' : nInvariants ? 'Invariants' : 'Task Plan';
        const iconClass = nBeliefs ? 'fa-brain' : nPlan ? 'fa-list-check' : 'fa-shield-halved';
        title.innerHTML = `<i class="fas ${iconClass}" style="color:var(--accent);margin-right:6px"></i>${label}`;
      }
      updatePlanList();
    }

    function updatePlanList() {
      const list = document.getElementById('plan-list');
      if (!list) return;
      if (!state.planItems.length && !state.beliefs.length && !state.invariants.length) {
        list.innerHTML = `<div class="cp-empty"><i class="fas fa-info-circle" style="margin-bottom:4px;opacity:.5"></i>No active plan or hypotheses yet — the agent sets these via update_plan (known steps) or update_beliefs (still figuring out the approach)</div>`;
        return;
      }
      let html = '';
      if (state.invariants.length) {
        html += `<div class="invariants-block"><div class="invariants-hdr"><i class="fas fa-shield-halved"></i> Invariants</div>` +
          state.invariants.map(i => `<div class="invariant-item"><i class="fas fa-minus" style="font-size:7px;opacity:.6"></i>${esc(i)}</div>`).join('') +
          `</div>`;
        if (state.beliefs.length || state.planItems.length) html += `<div class="cp-divider"></div>`;
      }
      if (state.beliefs.length) {
        const statusColor = { active: 'var(--accent)', confirmed: 'var(--teal)', ruled_out: 'var(--tx-4)' };
        const statusIcon = { active: 'fa-circle-question', confirmed: 'fa-circle-check', ruled_out: 'fa-circle-xmark' };
        html += state.beliefs.slice().sort((a, b) => {
          const rank = { confirmed: 0, active: 1, ruled_out: 2 };
          if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
          return b.confidence - a.confidence;
        }).map(h => `
          <div class="belief-item ${h.status}">
            <div class="belief-row">
              <i class="fas ${statusIcon[h.status]}" style="color:${statusColor[h.status]}"></i>
              <span class="belief-text" style="${h.status === 'ruled_out' ? 'text-decoration:line-through;opacity:.55' : ''}">${esc(h.text)}</span>
              <span class="belief-conf" style="color:${statusColor[h.status]}">${h.confidence}%</span>
            </div>
            <div class="belief-bar-track"><div class="belief-bar-fill" style="width:${h.confidence}%;background:${statusColor[h.status]}"></div></div>
          </div>`).join('');
        if (state.beliefNextAction) {
          html += `<div class="belief-next-action"><i class="fas fa-arrow-right" style="margin-right:5px;opacity:.7"></i>${esc(state.beliefNextAction)}</div>`;
        }
        if (state.planItems.length) html += `<div class="cp-divider"></div>`;
      }
      if (state.planItems.length) {
        const icon = { pending: 'fas fa-circle', in_progress: 'fas fa-spinner fa-spin', done: 'fas fa-circle-check' };
        const color = { pending: 'var(--tx-4)', in_progress: 'var(--accent)', done: 'var(--teal)' };
        html += state.planItems.map(it => `<div class="cp-item" style="cursor:default"><i class="${icon[it.status]}" style="color:${color[it.status]};width:14px;text-align:center;flex-shrink:0"></i><span class="cp-desc" style="${it.status === 'done' ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(it.text)}</span></div>`).join('');
      }
      list.innerHTML = html;
    }

    function clearPlan() {
      state.planItems = [];
      state.beliefs = [];
      state.beliefNextAction = '';
      state.invariants = [];
      state._sysPromptCacheText = null;
      renderTodoChecklist();
      state.pendingSteerMessages = [];
      renderSteerQueue();
    }

    /* ═══════════════ ask_user TOOL: mid-task question prompt ═══════════════ */
    function promptUserQuestion(question, options) {
      return new Promise(resolve => {
        switchToChat();
        const el = document.createElement('div'); el.className = 'confirm-bar'; el.style.flexWrap = 'wrap'; el.style.flexDirection = 'column'; el.style.alignItems = 'stretch'; el.style.gap = '8px';
        const optsHtml = (options && options.length)
          ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${options.map(o => `<button class="ask-opt-btn" style="padding:4px 10px;font-size:11px;cursor:pointer;background:var(--bg-3);color:var(--tx-1);border:1px solid var(--border);border-radius:12px">${esc(o)}</button>`).join('')}</div>`
          : '';
        el.innerHTML =
          `<div style="display:flex;align-items:flex-start;gap:8px;width:100%"><i class="fas fa-circle-question" style="color:var(--accent);margin-top:2px"></i><b style="flex:1">${esc(question)}</b></div>` +
          optsHtml +
          `<div style="display:flex;gap:6px;width:100%"><input type="text" class="confirm-cmd-input" placeholder="Type your answer…" style="flex:1;background:var(--bg-3);color:var(--tx-1);border:1px solid var(--border);border-radius:3px;padding:5px 8px;font-size:12px;"><button class="confirm-yes" style="padding:5px 10px;font-size:11px;cursor:pointer;background:var(--accent);color:white;border:none;border-radius:3px">Send</button><button class="confirm-no" style="padding:5px 10px;font-size:11px;cursor:pointer;background:var(--bg-3);color:var(--tx-2);border:none;border-radius:3px">Skip</button></div>`;
        const input = el.querySelector('.confirm-cmd-input');
        const finish = val => { el.remove(); resolve(val); };
        el.querySelector('.confirm-yes').onclick = () => { if (input.value.trim()) finish(input.value.trim()); };
        el.querySelector('.confirm-no').onclick = () => finish(false);
        input.onkeydown = e => { if (e.key === 'Enter' && input.value.trim()) finish(input.value.trim()); };
        el.querySelectorAll('.ask-opt-btn').forEach(btn => btn.onclick = () => finish(btn.textContent));
        $msg().appendChild(el); scrollBottom();
        input.focus();
        notifyUser('Agent has a question', question, 'ask-user');
      });
    }

    function toggleCheckpointPopup() {
      const popup = document.getElementById('cp-popup') || renderCheckpointPopup();
      if (!popup.parentNode) document.body.appendChild(popup);
      popup.classList.toggle('open');
      if (popup.classList.contains('open')) {
        requestAnimationFrame(() => updateCheckpointList());
      }
      if (!popup.classList.contains('open')) setTimeout(() => { if (popup.parentNode) popup.remove(); }, 250);
    }

    function renderCheckpointPopup() {
      const popup = document.createElement('div');
      popup.id = 'cp-popup';
      popup.className = 'cp-popup';
      popup.onclick = e => { if (e.target === popup) toggleCheckpointPopup(); };
      popup.innerHTML = `<div class="cp-popup-hdr"><span><i class="fas fa-clock-rotate-left" style="color:var(--accent);margin-right:6px"></i>Checkpoints</span><button onclick="event.stopPropagation();clearCheckpoints()"><i class="fas fa-trash"></i></button></div><div class="cp-list" id="cp-list"></div>`;
      return popup;
    }

    function updateCheckpointUI() {
      const badge = document.getElementById('cp-badge');
      if (!badge) return;
      const n = state.checkpoints.length;
      badge.textContent = n;
      badge.classList.toggle('hidden', n === 0);
    }

    function updateCheckpointList() {
      const list = document.getElementById('cp-list');
      if (!list) return;
      if (!state.checkpoints.length) {
        const reason = !state.dirHandle ? 'Open a workspace first' : 'Checkpoints are saved automatically before each iteration when files are modified';
        list.innerHTML = `<div class="cp-empty"><i class="fas fa-info-circle" style="margin-bottom:4px;opacity:.5"></i>${reason}</div>`;
        return;
      }
      list.innerHTML = [...state.checkpoints].reverse().map(cp => {
        const ago = timeAgo(cp.timestamp);
        const isCurrent = cp.id === (state.checkpoints[state.checkpoints.length - 1]?.id);
        return `<div class="cp-item${isCurrent ? ' current' : ''}" onclick="event.stopPropagation(); rewindToCheckpoint(${cp.id})"><span class="cp-iter">#${cp.iteration}</span><span class="cp-desc" title="${esc(cp.description)}">${esc(cp.description)}</span><span class="cp-time">${ago}</span></div>`;
      }).join('');
    }

    function clearCheckpoints() {
      state.checkpoints = [];
      updateCheckpointUI(); updateCheckpointList();
      showToast('Checkpoints cleared', 'info');
    }

    /* ═══════════════ API CLIENT ═══════════════ */

    async function fetchModelInfo() {
      state.modelInfoMap.clear();
      // llama.cpp doesn't have /api/v0/models — only LM Studio does
      if (state.backendType !== 'lmstudio') return;
      try {
        const res = await fetch(`${state.apiUrl}/api/v0/models`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return;
        const data = await res.json();
        const models = data.data || data.availableModels || data.downloadedModels || [];
        if (!Array.isArray(models)) return;
        for (const m of models) {
          if (!m.id) continue;
          const isVlm = m.type === 'vlm';
          const hasToolUse = Array.isArray(m.capabilities) && m.capabilities.includes('tool_use');
          state.modelInfoMap.set(m.id, {
            vision: isVlm || !!m.vision,
            contextLength: m.max_context_length || m.maxContextLength || 0,
            loadedContextLength: m.loaded_context_length || 0,
            displayName: m.displayName || m.id,
            trainedForToolUse: hasToolUse || !!m.trainedForToolUse,
            architecture: m.arch || m.architecture || '',
            paramsString: m.paramsString || '',
            type: m.type || 'llm',
            state: m.state || 'not-loaded',
            publisher: m.publisher || '',
            quantization: m.quantization || '',
          });
        }
      } catch {
        /* /api/v0/models not available (non-LM-Studio backend) */
      }
    }

    async function testConnection(retry = 3) {
          const backendLabel = state.backendType === 'llamacpp' ? 'llama.cpp' : 'LM Studio';
          try {
            // ── Pre-flight: check /v1/models (supported by both LM Studio and llama.cpp) ──
            const testRes = await fetch(`${state.apiUrl}/v1/models`, {
              signal: AbortSignal.timeout(3000)
            });

            if (!testRes.ok) {
              const status = testRes.status;
              let hint = '';

              if (state.backendType === 'lmstudio') {
                if (status === 500) {
                  hint = '\n\n→ Open LM Studio, check the console for errors, restart the model, then try again.';
                } else if (status === 503) {
                  hint = '\n→ LM Studio is busy or restarting. Wait a moment and try again.';
                }
              } else {
                if (status === 500) hint = '\n→ llama.cpp server error — check your server console.';
                else if (status === 503) hint = '\n→ llama.cpp server unavailable. Is it running?';
              }
              if (!hint) {
                const errRaw = await testRes.text().catch(() => testRes.statusText);
                let err = errRaw;
                if (err.includes('<!DOCTYPE') || err.includes('<html')) {
                  const tmp = document.createElement('DIV'); tmp.innerHTML = err;
                  err = tmp.textContent || tmp.innerText || 'Unknown error';
                  err = err.trim().replace(/\s+/g, ' ');
                }
                if (err.length > 300) err = err.slice(0, 300) + '...';
                hint = '\n' + err;
              }

              showToast(`${backendLabel}: HTTP ${status}${hint}`, 'err');
              checkCompanion();
              return;
            }

            // ── Pre-flight passed — do the full model list refresh ──
            await refreshModels(true);
            const sel = document.getElementById('model-sel');
            const count = sel.options.length;
            if (!count) {
              state.connected = false;
              document.getElementById('llm-dot').className = 'status-dot off';
              document.getElementById('llm-text').textContent = 'LLM';
              showToast(`${backendLabel}: no models found`, 'warn');
              return;
            }

            state.connected = true;
            document.getElementById('llm-dot').className = 'status-dot on';
            document.getElementById('llm-text').textContent = 'LLM';

            if (state.backendType === 'lmstudio') {
              if (activeInstance?.identifier === state.model) {
                showToast(`Connected — ${state.model.split('/').pop()}`, 'ok');
              } else if (!activeInstance) {
                showToast(`Connected (${count} models) — couldn't verify loaded model`, 'warn');
              } else {
                showToast(`Loaded: ${activeInstance.identifier.split('/').pop()} — selector shows different model`, 'warn');
              }
            } else {
              // llama.cpp: probe /props for vision, then show connected toast
              probeLlamaCppVision().then(() => {
                const visionNote = state.llamacppVision ? ' · vision ✓' : '';
                showToast(`Connected to llama.cpp (${count} model${count !== 1 ? 's' : ''})${visionNote}`, 'ok');
              });
            }
          } catch (e) {
            if (e.name === 'AbortError') return; // user cancelled
            if (retry > 0) {
              const wait = Math.min(1000 * Math.pow(2, 3 - retry), 8000);
              showToast(`${backendLabel} unreachable (attempt ${4 - retry}). Retrying in ${(wait / 1000).toFixed(1)}s...`, 'warn');
              setTimeout(() => testConnection(retry - 1), wait);
              return;
            }
            showToast(`${backendLabel}: ${HarnessRuntime.connectionErrorHint(e, state.backendType)}`, 'err');
          }
          checkCompanion();
        }

    function decodeJsonString(s) {
      try { return JSON.parse('"' + s + '"'); }
      catch { return s.replace(/\\(.)/g, (_, c) =>
        c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c); }
    }

    function extractThinkText(argsStr, streaming = false) {
      try { const a = JSON.parse(argsStr); return a.thought || ''; } catch { }
      // Complete match
      const m = argsStr.match(/"thought"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) return decodeJsonString(m[1]);
      // Streaming: match everything after the opening quote
      const sm = argsStr.match(/"thought"\s*:\s*"((?:[^"\\]|\\.)*)/);
      if (sm) return decodeJsonString(sm[1]);
      return '';
    }

    /**
     * Route ONE parsed SSE chunk's delta into a mutable accumulator + callbacks.
     * This is the single place that understands provider-specific delta field
     * names (delta.content, delta.reasoning_content/reasoning, delta.tool_calls).
     * Every streaming call site in this file routes through this instead of
     * re-implementing its own copy of this parsing — that duplication is exactly
     * how the reasoning_content field went unhandled in five different places at
     * once (main chat, sub-agents, swarm workers, clarify flow, deep research).
     *
     * @param {object} chunk - already-JSON.parsed SSE payload
     * @param {{content:string, reasoning:string, toolCalls:Array, finishReason?:string}} acc - mutated in place
     * @param {{onContent?:(full:string)=>void, onReasoning?:(full:string)=>void, onToolCalls?:(arr)=>void, onUsage?:(usage)=>void}} [cb]
     */
    async function runSubAgent(task, allowedTools, maxIter, parentSignal, parentPanel) {
      const defaultTools = ['read_file', 'read_file_lines', 'list_directory', 'search_files', 'grep'];
      const tools = allowedTools && allowedTools.length ? allowedTools : defaultTools;
      // The requested rounds are a soft budget: extended while the agent makes progress, stopped early if it spins.
      const budget = SwarmCore.createRoundBudget({ limit: Math.min(Math.max(Number(maxIter) || 10, 4), 30), hardCap: 40, stallLimit: 4 });
      let maxIterations = budget.limit;
      const startTime = performance.now();

      // ── Validate tools against available tool definitions ──
      const validToolNames = new Set(getToolDefs(true).map(t => t.function.name));
      const invalidTools = tools.filter(t => !validToolNames.has(t));
      const effectiveTools = tools.filter(t => validToolNames.has(t));

      const hasWriteTools = effectiveTools.some(t =>
        ['edit_file', 'write_file', 'delete_file', 'move_file'].includes(t)
      );

      // ── Filter full tool definitions for the sub-agent ──
      const allToolDefs = getToolDefs(true);
      const filteredToolDefs = allToolDefs.filter(t => effectiveTools.includes(t.function.name));

      // ── Build messages (NO system prompt — subAgentChat adds it) ──
      const subMessages = [
        {
          role: 'user',
          content: task + (state.dirName ? '\n\nWorking directory: ' + state.dirName : '')
        }
      ];

      let iterations = 0;
      const log = [];
      const subAbort = new AbortController();

      // Propagate parent cancellation
      if (parentSignal) {
        parentSignal.addEventListener('abort', () => subAbort.abort(), { once: true });
      }

      function updatePanelStatus(text, cls) {
        if (!parentPanel || !parentPanel.el) return;
        const st = parentPanel.el.querySelector('.tool-status');
        if (st) {
          st.className = 'tool-status ' + cls;
          st.textContent = text;
        }
      }


      // ── Agent loop ──
      let stopReason = '';
      while (true) {
        if (subAbort.signal.aborted) break;
        const decision = budget.decide(iterations);
        maxIterations = budget.limit;
        if (decision === 'limit' || decision === 'stalled') { stopReason = decision; break; }
        if (decision === 'extended') subMessages.push({ role: 'user', content: `[SYSTEM] You are still making progress, so your round budget was extended to ${maxIterations}. Start converging on your findings.` });
        else if (decision === 'warn') subMessages.push({ role: 'user', content: '[SYSTEM] You have one round left. If you already have enough, stop calling tools and write your findings now.' });
        iterations++;
        updatePanelStatus(`Round ${iterations}/${maxIterations}`, 'run');
        const subStats = createCompressionStats();

        let content = '';
        let toolCalls = [];

        try {
          const result = await subAgentChat(subMessages, filteredToolDefs, subAbort.signal, (reasoningText) => {
            // Live progress while the sub-agent is reasoning — without this, a sub-agent
            // stuck in a long/looping reasoning phase looks frozen since its intermediate
            // output is otherwise hidden from the user until it finishes.
            const chars = reasoningText.length;
            const short = chars > 1000 ? (chars / 1000).toFixed(1) + 'k' : chars;
            updatePanelStatus(`Round ${iterations}/${maxIterations} · reasoning… (${short}c)`, 'run');
          });
          content = result.content;
          toolCalls = result.toolCalls;
        } catch (e) {
          if (e.name === 'AbortError') break;
          const duration = performance.now() - startTime;
          updatePanelStatus('Error', 'err');
          return {
            summary: 'Sub-agent error: ' + e.message,
            log,
            iterations,
            error: true,
            hitLimit: false,
            duration,
            tools: effectiveTools,
            invalidTools,
            task
          };
        }

        // ── Record assistant message ──
        const assistantMsg = { role: 'assistant', content: content || null };
        if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
        subMessages.push(assistantMsg);

        // ── Separate valid vs invalid tool calls ──
        const validTcs = toolCalls.filter(tc => effectiveTools.includes(tc.function.name));
        const invalidTcs = toolCalls.filter(tc => !effectiveTools.includes(tc.function.name));

        // If no valid tool calls, the sub-agent is done
        if (!validTcs.length) break;

        // ── Execute tool calls ──
        let roundOk = false;
        const results = await HarnessRuntime.runToolBatch(validTcs, async tc => {
          const name = tc.function.name;
          try {
            const result = await executeTool(name, tc.function.arguments, subAbort.signal, null);
            const outText = redactSecrets((typeof result === 'string') ? result : (result?.output || ''));
            log.push({
              tool: name,
              args: tc.function.arguments.slice(0, 120),
              output: outText.slice(0, 300),
              success: result.status === 'ok'
            });
            if (result.status === 'ok') roundOk = true;
            return { tc, output: outText };
          } catch (e) {
            log.push({
              tool: name,
              args: tc.function.arguments.slice(0, 120),
              output: e.message,
              success: false
            });
            return { tc, output: 'Error: ' + e.message };
          }
        });

        // ── Record tool results ──
        for (const r of results) {
          subMessages.push({
            role: 'tool',
            tool_call_id: r.tc.id,
            content: compressToolOutput(r.tc.function.name, r.output, subStats)
          });
        }

        budget.record(validTcs.map(tc => tc.function.name + ':' + tc.function.arguments), roundOk);

        // ── Record rejected tool calls ──
        for (const tc of invalidTcs) {
          log.push({
            tool: tc.function.name,
            args: '',
            output: 'Not allowed',
            success: false
          });
          subMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `Error: Tool "${tc.function.name}" is not in the allowed list for this sub-agent.`
          });
        }
      }

      let lastAssistant = [...subMessages].reverse().find(m => m.role === 'assistant');
      const endedWithTools = !!lastAssistant?.tool_calls?.some(tc => effectiveTools.includes(tc.function.name));
      // Whenever the loop was cut short, ask for a final report so the findings are never thrown away.
      let wrapped = '';
      if (!subAbort.signal.aborted && (stopReason || endedWithTools || !lastAssistant?.content)) {
        try {
          updatePanelStatus('Writing report…', 'run');
          subMessages.push({ role: 'user', content: '[SYSTEM] You must stop now' + (stopReason === 'stalled' ? ' (you are repeating work without new results)' : ' (your round budget is used up)') + '. Do NOT call any tools. Report: (1) what you found or did, with specifics (file paths, line numbers, names), and (2) anything you could not finish. Make the LAST line exactly "STATUS: COMPLETE" or "STATUS: INCOMPLETE - <what remains>".' });
          const wrap = await subAgentChat(subMessages, [], subAbort.signal, () => {});
          wrapped = (wrap.content || '').trim();
          if (wrapped) { subMessages.push({ role: 'assistant', content: wrapped }); lastAssistant = subMessages[subMessages.length - 1]; }
        } catch (e) { /* fall back to the activity digest below */ }
      }
      const duration = performance.now() - startTime;
      const digest = () => '(The sub-agent was stopped before it wrote a report. Its raw activity, most recent last:)\n' +
        log.slice(-12).map(e => `- ${e.tool}(${e.args}) → ${e.success ? '' : 'FAILED: '}${e.output.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
      const summary = wrapped || lastAssistant?.content || (log.length ? digest() : '(The sub-agent made no tool calls and wrote no report.)');
      const statusLine = /STATUS:\s*(COMPLETE|INCOMPLETE)\b/i.exec(summary);
      const reportedComplete = statusLine ? statusLine[1].toUpperCase() === 'COMPLETE' : !stopReason && !endedWithTools;
      const hitLimit = stopReason === 'limit', stalled = stopReason === 'stalled';
      const incomplete = !subAbort.signal.aborted && (!reportedComplete || (!wrapped && (hitLimit || stalled)));

      updatePanelStatus(stalled ? 'Stalled' : hitLimit ? 'Limit' : 'Done', stalled || hitLimit ? 'err' : 'ok');

      return {
        summary,
        log,
        iterations,
        error: false,
        hitLimit,
        stalled,
        incomplete,
        extended: budget.extensions,
        limit: maxIterations,
        duration,
        tools: effectiveTools,
        invalidTools,
        task
      };
    }

    function showSubAgentPanel(data) {
      const el = document.createElement('div');
      el.className = 'sub-agent-panel';

      const statusClass = data.error ? 'error' : (data.hitLimit || data.stalled) ? 'limit' : 'done';
      const statusText = data.error ? 'Error' : data.stalled ? 'Stalled' : data.hitLimit ? 'Limit' : data.incomplete ? 'Partial' : 'Done';
      const durationStr = (data.duration / 1000).toFixed(1) + 's';
      const taskDisplay = data.task.length > 80 ? data.task.slice(0, 77) + '...' : data.task;

      let logHtml = '';
      if (data.log && data.log.length) {
        logHtml = data.log.map(entry => {
          const cls = entry.success ? 'sub-agent-log-ok' : 'sub-agent-log-err';
          const icon = entry.success ? '✓' : '✗';
          return `<div class="sub-agent-log-entry"><span class="sub-agent-log-tool">${esc(entry.tool)}</span><span class="${cls}">${icon}</span><span class="sub-agent-log-output" title="${esc(entry.output)}">${esc(entry.output)}</span></div>`;
        }).join('');
      }

      el.innerHTML = `
        <div class="sub-agent-hdr" onclick="toggleSubAgentDetails(this)">
          <i class="fas fa-sitemap sub-agent-icon"></i>
          <span class="sub-agent-label">Sub-Agent</span>
          <span class="sub-agent-tools-tag">${data.tools.length} tools</span>
          <span class="sub-agent-task" title="${esc(data.task)}">"${esc(taskDisplay)}"</span>
          <span class="sub-agent-status ${statusClass}">${statusText}</span>
          <span class="sub-agent-meta">${data.iterations}r · ${data.log.length} calls · ${durationStr}</span>
          <button class="sub-agent-toggle">Details</button>
        </div>
        <div class="sub-agent-summary">${renderMd(data.summary)}</div>
        <div class="sub-agent-details"><div class="sub-agent-log">${logHtml || '<div style="padding:8px;color:var(--tx-4);font-style:italic">No tool calls logged</div>'}</div></div>`;

      $msg().appendChild(el);
      scrollBottom();

      el.querySelectorAll('.sub-agent-summary pre code').forEach(b => {
        if (!b.dataset.hljs) { hljs.highlightElement(b); b.dataset.hljs = '1'; }
      });
      addCopyBtns(el.querySelector('.sub-agent-summary'));
    }

    function toggleSubAgentDetails(hdrEl) {
      const panel = hdrEl.closest('.sub-agent-panel');
      const details = panel.querySelector('.sub-agent-details');
      const toggleBtn = hdrEl.querySelector('.sub-agent-toggle');
      details.classList.toggle('open');
      toggleBtn.textContent = details.classList.contains('open') ? 'Hide' : 'Details';
    }

    /* ════════════════════════════════════════════════════════
       MULTI-AGENT SWARM — dependency graph of workers with shared memory.
       Scheduling, ownership and memory live in SwarmCore (pure, unit-tested);
       this block wires them to the model, tools, UI and checkpoints.
       ════════════════════════════════════════════════════════ */

    const SwarmMemory = SwarmCore.SwarmMemory;
    const SWARM_STATUS_LABEL = { pending: 'Pending', running: 'Running…', done: 'Done', incomplete: 'Incomplete', error: 'Error', blocked: 'Blocked', skipped: 'Skipped' };
    const SWARM_COLORS = ['#f59e0b','#22d3ee','#a78bfa','#4ade80','#fb923c','#f472b6','#38bdf8','#a3e635'];
    const SWARM_PSEUDO_TOOLS = [
      { name: 'swarm_memory_write', description: 'Write a key/value pair (max 2000 chars) to the swarm\'s shared memory so other workers can read it. Entries are HYPOTHESES by default; mark one status "verified" only with evidence (file:line, a command and its result, or a source). For anything larger, write a file and store its path.',
        parameters: { type: 'object', properties: { key: { type: 'string', description: 'Short descriptive key, e.g. "api_endpoints"' }, value: { type: 'string', description: 'The value (max 2000 chars)' }, status: { type: 'string', enum: ['hypothesis', 'verified'], description: 'Default hypothesis. "verified" requires evidence.' }, evidence: { type: 'string', description: 'Provenance for a verified fact: file:line, command + result, or source (max 300 chars).' } }, required: ['key', 'value'] } },
      { name: 'swarm_memory_read', description: 'Read the full value of a shared-memory key (context shows only a 500-char preview). Omit key to list all keys.',
        parameters: { type: 'object', properties: { key: { type: 'string', description: 'Key to read; omit to list keys' } }, required: [] } },
      { name: 'swarm_message', description: 'Post a message (max 500 chars) to another worker by name, or "*" to broadcast. Recipients see it before their next round.',
        parameters: { type: 'object', properties: { to: { type: 'string', description: 'Target worker name or "*"' }, content: { type: 'string', description: 'Message content' } }, required: ['to', 'content'] } },
      { name: 'swarm_check_messages', description: 'Check for new messages from other workers. New messages are also delivered automatically between rounds.', parameters: { type: 'object', properties: {}, required: [] } }
    ].map(f => ({ type: 'function', function: f }));

    function buildVerifierSysPrompt(w, ctx) {
      return [
        'You are the INDEPENDENT VERIFIER of a multi-agent swarm. You did not do the work and you have not been shown the workers\' own accounts of it. Judge ONLY from the actual state of the project and from checks you run yourself.', '',
        '## Overall goal', ctx.goal, '',
        '## Rules',
        '- For every acceptance criterion, gather your own evidence: read the relevant files, run tests or other read-only checks (run_tests).',
        '- PASS requires concrete evidence you saw. If you cannot check a criterion, say UNVERIFIABLE with the reason. Never guess PASS.',
        '- You are read-only: do not modify files.',
        '- A failing scripted check, if one is given, is evidence but not the whole verdict; decide each criterion on its own.',
        '- For each FAIL, name the worker most responsible as "(owner: <name>)" using one of: ' + (ctx.ownerNames.join(', ') || '(none)') + '.', '',
        '## Output', 'End with exactly one line per criterion, nothing after them:', '  AC1: PASS - <evidence>', '  AC2: FAIL - <evidence> (owner: <worker>)', '  AC3: UNVERIFIABLE - <why>',
        ctx.env ? '\n## Environment\n' + ctx.env : ''
      ].join('\n');
    }

    function buildWorkerSysPrompt(w, ctx) {
      if (w.kind === 'verifier') return buildVerifierSysPrompt(w, ctx);
      const writes = ctx.toolNames.some(t => SwarmCore.WRITE_TOOLS.has(t));
      const lines = [
        `You are **${w.name}**, a specialised worker agent in a multi-agent swarm.`, '',
        '## Swarm Goal', ctx.goal, '',
        `## Your Role (worker ${w.index + 1} of ${ctx.total})`, w.role, '',
        '## Your Task', w.task, ''
      ];
      if (w.kind === 'critic') lines.push('## You are the CRITIC for worker "' + w.reviews + '"',
        '- Your job is to find REAL defects in that worker\'s output: wrong behaviour, missed requirements, bugs, broken edge cases, security problems, failing or missing tests.',
        '- Every issue needs evidence: a file and line, a command you ran, or a requirement it violates. Opinions without evidence do not count.',
        '- Run the project\'s checks yourself where possible (run_tests). Do not modify files; you are read-only.',
        '- Do NOT nitpick style or invent problems. If you cannot find a real defect, approve.',
        '- Finish with a numbered list of concrete issues (or "No defects found"), then, as the LAST line, exactly one of:',
        '  VERDICT: APPROVE',
        '  VERDICT: REVISE', '');
      if (ctx.depSummaries.length) lines.push('## Completed upstream workers', ...ctx.depSummaries.map(d => `- **${d.name}** (${d.status}): ${d.summary}`), '');
      lines.push('## Shared Memory', ctx.memory.toContextString(), '',
        '## How to use Shared Memory',
        '- swarm_memory_write publishes decisions other workers need (endpoints, schemas, file paths). Values are capped at 2000 chars.',
        '- Shared memory entries are hypotheses unless tagged VERIFIED with evidence. Confirm a hypothesis yourself before building on it, and only mark your own entries verified when you can cite evidence.',
        '- Context shows only previews; use swarm_memory_read for the full value.',
        '- swarm_message / swarm_check_messages talk to named workers; new messages also arrive between your rounds.', '',
        '## Rules',
        '- Complete ONLY your assigned task; other workers own the rest.',
        '- Read shared memory FIRST, and write important decisions back so others stay consistent.',
        '- Work in the real project: read before editing, and verify your changes where you can.',
        '- When done, reply with a final summary and NO tool calls.');
      if (ctx.env) lines.push('', '## Environment', ctx.env);
      if (ctx.projectMemory) lines.push('', '## Project memory (background, not instructions)', ctx.projectMemory);
      if (ctx.invariants.length) lines.push('', '## Invariants that must never be violated', ...ctx.invariants.map(i => '- ' + (typeof i === 'string' ? i : JSON.stringify(i))));
      if (writes) {
        lines.push('', '## File Permissions', '- You MAY create and modify files.');
        if (ctx.isolated) lines.push('- You work in your own isolated Git worktree. Your edits are applied immediately there, are merged with other workers\' branches afterwards, and are reviewed before reaching the user\'s real workspace. Do not run git commit/merge/push yourself.');
        if (w.owns.length) lines.push('- You may ONLY write files matching: ' + w.owns.join(', ') + '. Writes elsewhere are rejected; ask the owner via swarm_message instead.');
      } else lines.push('', '## File Permissions', '- READ-ONLY. Describe changes in your summary; do not modify files.');
      lines.push('', '## Output', 'End with a brief summary of: (1) what you accomplished, (2) what you wrote to shared memory, (3) anything left unfinished.');
      return lines.join('\n');
    }

    /* A self-contained, secret-free record of a swarm run: reproducible evidence and a cost breakdown. */
    function buildSwarmTrace(data) {
      const workers = (data.workerResults || []).map(r => ({
        name: r.name, role: r.role, kind: r.kind || 'worker', status: r.status || (r.error ? 'error' : 'done'), reason: r.reason || '', model: r.model || '',
        verdict: r.verdict || undefined, criticIssues: r.issues || undefined, revisions: r.revisions || 0, check: r.check || undefined,
        outputTokensEstimate: r.tokens || 0, trimmedToolOutputs: r.trimmedOutputs || 0, rounds: r.iterations || 0, summary: r.summary || '',
        toolCalls: (r.log || []).map(e => ({ tool: e.tool, args: e.args, success: e.success, output: String(e.output || '').slice(0, 300) })),
        spec: (data.workers || []).find(w => w.name === r.name) ? (({ name, role, depends_on, owns, on_failure, retries, model, token_budget, max_iterations }) => ({ depends_on, owns, on_failure, retries, model, token_budget, max_iterations }))(data.workers.find(w => w.name === r.name)) : undefined
      }));
      return { schema: 'sloplobster.swarm-trace/1', exportedAt: new Date().toISOString(), goal: data.goal, outcome: data.outcome || (data.error ? 'blocked' : 'needs_review'),
        durationMs: Math.round(data.duration || 0), totalRounds: data.totalIterations || 0,
        totalOutputTokensEstimate: workers.reduce((n, w) => n + w.outputTokensEstimate, 0),
        statuses: data.statuses || {}, notes: data.notes || [], verification: data.verification || null, isolation: data.isolation || null, contract: data.contract || null, acceptance: data.acceptance ? data.acceptance.criteria : null, metrics: data.metrics || null, events: data.events || [], memoryDetail: data.memoryDetail || [],
        workers, sharedMemory: data.memory || {}, messageBus: data.messageBus || [], managerSummary: data.managerSummary || '' };
    }
    function makeSwarmTraceButton(data) {
      const btn = document.createElement('button');
      btn.className = 'hdr-btn'; btn.type = 'button'; btn.style.cssText = 'margin-top:8px;font-size:11px';
      btn.innerHTML = '<i class="fas fa-download"></i> Export run trace';
      btn.onclick = e => {
        e.stopPropagation();
        const blob = new Blob([JSON.stringify(buildSwarmTrace(data), null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'swarm-trace-' + Date.now() + '.json'; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      };
      return btn;
    }

    // Run history feeds the stats below: verified rate, cost per verified result, latency, repair frequency.
    async function persistSwarmRun(goal, metrics) {
      try {
        await dbSet('agent_states', { id: 'swarm-run:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8), kind: 'swarm-run', ts: Date.now(), goal: String(goal).slice(0, 200), ...metrics });
        const all = (await dbGetAll('agent_states')).filter(r => r.kind === 'swarm-run').sort((x, y) => x.ts - y.ts);
        for (const old of all.slice(0, Math.max(0, all.length - 100))) await dbDelete('agent_states', old.id);
      } catch { /* history is best-effort */ }
    }
    async function swarmHistory(limit = 10, groupBy = 'critic') {
      const runs = (await dbGetAll('agent_states')).filter(r => r.kind === 'swarm-run').sort((x, y) => y.ts - x.ts);
      return { stats: SwarmCore.summarizeRuns(runs, groupBy), recent: runs.slice(0, Math.max(1, Math.min(25, limit))).map(r => ({ when: new Date(r.ts).toISOString(), goal: r.goal, outcome: r.outcome, tokens: r.tokens, seconds: Math.round(r.durationMs / 1000), workers: r.workers, failedWorkers: r.failedWorkers, revisions: r.revisions, repairs: r.repairs, criteria: r.criteriaTotal ? r.criteriaPassed + '/' + r.criteriaTotal : '' })) };
    }

    function swarmCheckpointKey() { return 'swarm:' + state.activeConvId; }

    async function runSwarm(goal, workerDefs, maxWorkerIter, parentSignal, parentPanel, options = {}) {
      const startTime = performance.now();
      const workers = SwarmCore.normalizeWorkers(workerDefs);
      const names = workers.map(w => w.name);
      const byName = new Map(workers.map(w => [w.name, w]));
      let memory = new SwarmMemory(names);
      const defaultMax = Math.min(Math.max(maxWorkerIter || 10, 1), 25);
      const allToolDefs = getToolDefs(true);
      const coordinatorTools = new Set(['spawn_swarm', 'spawn_sub_agent', 'ask_user']);
      const defaultWorkerToolNames = ['read_file', 'read_file_lines', 'list_directory', 'search_files', 'grep', 'edit_file', 'write_file', 'execute_command', 'think'];
      const criticToolNames = ['read_file', 'read_file_lines', 'list_directory', 'search_files', 'grep', 'think', 'run_tests'];
      // Critics are read-only by construction: they can inspect and run checks but never modify files.
      const toolNamesFor = w => (w.kind === 'critic' || w.kind === 'verifier') ? criticToolNames : ((w.tools && w.tools.length) ? w.tools : defaultWorkerToolNames).filter(t => !coordinatorTools.has(t));
      const writeCapable = w => toolNamesFor(w).some(t => SwarmCore.WRITE_TOOLS.has(t) || t === 'execute_command');
      const notes = [];
      // ── Task contract: what "done" means, the budget, and the deadline are fixed before any worker starts ──
      const contract = SwarmCore.normalizeContract(options.contract);
      SwarmCore.checkContractOwners(contract, workers);
      const events = SwarmCore.createEventLog();
      const emit = (type, data) => events.emit(type, data);
      const startMs = Date.now(), totalMs = contract.deadline_minutes * 60000;
      const workerDeadline = totalMs ? startMs + totalMs * (1 - contract.reserve) : 0, hardDeadline = totalMs ? startMs + totalMs : 0;
      const tokenPool = contract.token_budget ? Math.floor(contract.token_budget * (1 - contract.reserve)) : 0;
      const allocated = SwarmCore.allocateBudgets(workers, contract);
      for (const w of workers) if (!(w.tokenBudget > 0) && allocated[w.name]) w.tokenBudget = allocated[w.name];
      // Workers stop starting once the working share of the time or tokens is spent; the reserve is kept for verification.
      function stopLaunching() { return !!((workerDeadline && Date.now() > workerDeadline) || (tokenPool && swarmTokens >= tokenPool)); }
      const withinContract = () => !swarmCtl.signal.aborted && !(hardDeadline && Date.now() > hardDeadline) && !(contract.token_budget && swarmTokens >= contract.token_budget);
      const hasVerification = workers.some(w => w.kind === 'critic' || w.check_command) || !!(options.verifyCommand || '').trim() || contract.criteria.length > 0;
      for (const advice of SwarmCore.teamAdvice(workers, { hasVerification })) notes.push('Advice: ' + advice);
      if (contract.criteria.length || contract.token_budget || contract.deadline_minutes) notes.push('Contract: ' + [contract.criteria.length && contract.criteria.length + ' acceptance criteria', contract.token_budget && '~' + contract.token_budget + ' token budget', contract.deadline_minutes && contract.deadline_minutes + ' min deadline'].filter(Boolean).join(', ') + (contract.reserve ? ' (20% reserved for verification)' : ''));
      emit('contract', { criteria: contract.criteria.length, tokenBudget: contract.token_budget, deadlineMinutes: contract.deadline_minutes, workers: workers.length });
      const swarmCtl = new AbortController(), swarmCtl0 = swarmCtl;
      let swarmTokens = 0, metaBase = '';
      const updateMeta = () => { const el = document.getElementById('swarm-live-meta'); if (el && metaBase) el.textContent = metaBase + ' · ~' + (swarmTokens >= 1000 ? (swarmTokens / 1000).toFixed(1) + 'k' : swarmTokens) + ' tok'; };

      // ── Optional isolation: one Git worktree per worker plus an integration worktree ──
      const hf = harnessFeatureState;
      let iso = null;
      if (options.isolate) {
        const root = (hf.prefs.projectRoot || '').trim();
        if (!state.compConnected) notes.push('Isolation unavailable (companion not connected): workers shared the open workspace.');
        else if (!root) notes.push('Isolation unavailable (no Git project root set in Harness settings): workers shared the open workspace.');
        else if (featureTask()) notes.push('Isolation skipped: this conversation already works in an isolated task, which the workers shared.');
        else {
          try {
            const integration = await featureRequest('tasks/create', { root, title: 'Swarm: ' + goal.slice(0, 120) }, swarmCtl0.signal);
            iso = { root, integration, tasks: new Map(), caches: new Map([['__integration', new Map()]]), conflicts: [], kept: new Set() };
          } catch (e) { notes.push('Isolation unavailable (' + e.message + '): workers shared the open workspace.'); }
        }
      }

      // Workers may overlap only when every concurrent pair of writers owns disjoint paths
      // (isolated workers write to separate worktrees, so conflicts surface at merge time instead).
      let concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency || 1)));
      if (concurrency > 1 && !iso) {
        const conflicts = SwarmCore.concurrencyConflicts(workers, writeCapable);
        if (conflicts.length) {
          concurrency = 1;
          notes.push('Ran sequentially: concurrent writers need disjoint "owns" globs (conflicts: ' + conflicts.map(c => c.join('/')).join(', ') + ').');
        }
      }

      // ── Resume from a checkpoint of the same swarm (same goal and worker names) ──
      const results = {};
      const initial = {};
      let resumed = 0;
      try {
        const cp = await dbGet('agent_states', swarmCheckpointKey());
        if (cp && cp.goal === goal && JSON.stringify(cp.names) === JSON.stringify(names) && !!cp.isolation === !!iso) {
          memory = SwarmMemory.fromJSON(cp.memory, names);
          let live = null;
          if (iso) live = new Map((await featureRequest('tasks/list', { root: iso.root })).tasks.map(t => [t.id, t]));
          for (const n of names) if (cp.statuses?.[n] === 'done' && cp.results?.[n]) {
            // An isolated worker's output lives in its worktree: if that is gone, the work must be redone.
            const isCritic = workers.find(x => x.name === n).kind === 'critic'; // critics own no worktree
            const rec = iso && !isCritic && live.get(cp.isolation.tasks?.[n]);
            if (iso && !isCritic && !rec) continue;
            if (rec) { iso.tasks.set(n, rec); iso.caches.set(n, new Map()); }
            initial[n] = 'done'; results[n] = cp.results[n]; resumed++;
          }
          if (resumed) notes.push(`Resumed from checkpoint: ${resumed} worker(s) already done were not re-run.`);
        }
      } catch { /* checkpoints are best-effort */ }

      if (parentSignal) { if (parentSignal.aborted) swarmCtl.abort(); else parentSignal.addEventListener('abort', () => swarmCtl.abort(), { once: true }); }
      let budgetHit = false;
      const checkBudget = () => {
        if (state.tokenBudget > 0 && _sessionTotalOut >= state.tokenBudget) { budgetHit = true; swarmCtl.abort(); }
        return budgetHit;
      };

      function updateParentStatus(text, cls) {
        if (!parentPanel?.el) return;
        const st = parentPanel.el.querySelector('.tool-status');
        if (st) { st.className = 'tool-status ' + cls; st.textContent = text; }
      }

      // ── Live swarm UI panel ──
      const swarmLiveEl = document.createElement('div');
      swarmLiveEl.className = 'swarm-panel';
      swarmLiveEl._swarmMemory = memory;
      const goalDisplay = goal.length > 90 ? goal.slice(0, 87) + '…' : goal;
      swarmLiveEl.innerHTML = `
        <div class="swarm-hdr" onclick="toggleSwarmBody(this)">
          <i class="fas fa-network-wired swarm-icon"></i>
          <span class="swarm-label">Swarm</span>
          <span class="swarm-goal" title="${esc(goal)}">${esc(goalDisplay)}</span>
          <span class="swarm-status running" id="swarm-live-status">Running</span>
          <span class="swarm-meta" id="swarm-live-meta">${workers.length} workers${concurrency > 1 ? ' · ×' + concurrency : ''}${iso ? ' · isolated' : ''}</span>
        </div>
        <div class="swarm-body" id="swarm-live-body">
          <div class="swarm-mem" id="swarm-live-mem">
            <div class="swarm-mem-hdr" onclick="event.stopPropagation();toggleSwarmMem(this)">
              <i class="fas fa-database"></i> Shared Memory
              <span class="mem-count" id="swarm-mem-count">0 keys</span>
            </div>
            <div class="swarm-mem-body open" id="swarm-mem-body"><div class="swarm-mem-empty">No data written yet</div></div>
          </div>
          <div class="swarm-bus" id="swarm-live-bus" style="display:none">
            <div class="swarm-bus-hdr" onclick="event.stopPropagation();toggleSwarmBus(this)"><i class="fas fa-comments"></i> Message Bus</div>
            <div class="swarm-bus-body" id="swarm-bus-body"></div>
          </div>
          <div class="swarm-workers" id="swarm-live-workers">
            ${workers.map((w, i) => `<div class="swarm-worker pending" id="swarm-worker-${i}">
                <div class="swarm-worker-hdr" onclick="toggleSwarmWorker(this)">
                  <div class="swarm-worker-avatar" style="background:${SWARM_COLORS[i % SWARM_COLORS.length]}">${esc(w.name.slice(0, 2).toUpperCase())}</div>
                  <span class="swarm-worker-name">${esc(w.name)}</span>
                  <span class="swarm-worker-role" title="${esc(w.depends_on.length ? 'after: ' + w.depends_on.join(', ') : 'no dependencies')}">${esc(w.role)}</span>
                  <span class="swarm-worker-status pending" id="swarm-wstatus-${i}">Pending</span>
                  <span class="swarm-worker-iter" id="swarm-witer-${i}"></span>
                </div>
                <div class="swarm-worker-body" id="swarm-wbody-${i}"></div>
              </div>`).join('')}
          </div>
        </div>`;
      $msg().appendChild(swarmLiveEl);
      if (parentPanel?.el) parentPanel.el._swarmLiveEl = swarmLiveEl;
      scrollBottom();

      const logHtml = (log, n) => (n ? log.slice(-n) : log).map(e =>
        `<div class="swarm-worker-log-entry"><span class="swarm-worker-log-tool">${esc(e.tool)}</span><span class="${e.success ? 'swarm-worker-log-ok' : 'swarm-worker-log-err'}">${e.success ? '✓' : '✗'}</span><span class="swarm-worker-log-out" title="${esc(e.output)}">${esc(e.output)}</span></div>`).join('');
      function setWorkerUI(w, status, extra = {}) {
        const i = w.index;
        const el = document.getElementById(`swarm-worker-${i}`), st = document.getElementById(`swarm-wstatus-${i}`), it = document.getElementById(`swarm-witer-${i}`), body = document.getElementById(`swarm-wbody-${i}`);
        if (el) el.className = 'swarm-worker ' + status;
        if (st) { st.className = 'swarm-worker-status ' + status; st.textContent = extra.label || SWARM_STATUS_LABEL[status] || status; }
        if (it && extra.iter !== undefined) it.textContent = extra.iter;
        if (body && extra.html !== undefined) { body.innerHTML = extra.html; if (extra.open) body.classList.add('open'); }
      }
      function refreshMemoryUI() {
        const body = document.getElementById('swarm-mem-body'), count = document.getElementById('swarm-mem-count');
        if (!body) return;
        const entries = memory.entries();
        if (count) count.textContent = entries.length + ' key' + (entries.length !== 1 ? 's' : '');
        body.innerHTML = entries.length ? entries.map(e => `<div class="swarm-mem-entry"><span class="swarm-mem-key">${esc(e.key)}</span><span class="swarm-mem-val" title="${esc(e.value)}">${esc(String(e.value).slice(0, 100))}</span><span class="swarm-mem-writer">← ${esc(e.writer)}</span></div>`).join('') : '<div class="swarm-mem-empty">No data written yet</div>';
      }
      function refreshBusUI() {
        const busEl = document.getElementById('swarm-live-bus'), body = document.getElementById('swarm-bus-body');
        if (!body || !memory.bus.length) return;
        if (busEl) busEl.style.display = '';
        body.innerHTML = memory.bus.map(m => `<div class="swarm-bus-msg"><span class="swarm-bus-from">${esc(m.from)}</span><span class="swarm-bus-arrow">→</span><span class="swarm-bus-to">${esc(m.to)}</span><span class="swarm-bus-content">${esc(m.content.slice(0, 200))}</span></div>`).join('');
      }
      metaBase = `${workers.length} workers${concurrency > 1 ? ' · ×' + concurrency : ''}${iso ? ' · isolated' : ''}`; updateMeta();
      refreshMemoryUI(); refreshBusUI();
      for (const w of workers) if (initial[w.name] === 'done') {
        const r = results[w.name];
        setWorkerUI(w, 'done', { label: 'Done (resumed)', iter: `${r.iterations || 0}r`, html: `<div class="swarm-worker-summary">${renderMd(r.summary || '')}</div>` });
      }

      // The workspace lease swaps the active workspace for exactly one tool call at a time, so isolated
      // workers can generate in parallel but their file/command tools never see each other's worktree.
      let leaseTail = Promise.resolve();
      function withWorkspace(rec, cache, fn) {
        if (!iso || !rec) return fn();
        const run = leaseTail.then(async () => {
          if (swarmCtl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const saved = { dir: state.dirHandle, name: state.dirName, cache: state.fileCache, task: hf.currentTask, approve: state.requireEditApproval };
          state.dirHandle = new ManagedDirectoryHandle('', rec.id); state.dirName = rec.title + ' [' + rec.branch + ']';
          state.fileCache = cache || new Map(); hf.currentTask = rec;
          state.requireEditApproval = false; // edits land on a disposable branch that is reviewed before merging
          try { return await fn(); }
          finally { state.dirHandle = saved.dir; state.dirName = saved.name; state.fileCache = saved.cache; hf.currentTask = saved.task; state.requireEditApproval = saved.approve; }
        });
        leaseTail = run.catch(() => {});
        return run;
      }
      let absorbTail = Promise.resolve();
      const queueAbsorb = (targetId, sourceId) => { const run = absorbTail.then(() => featureRequest('tasks/absorb', { taskId: targetId, fromTaskId: sourceId }, swarmCtl.signal)); absorbTail = run.catch(() => {}); return run; };
      async function prepareWorkspace(w) {
        if (!iso) return { rec: null };
        if (w.kind === 'critic') return { rec: iso.tasks.get(w.reviews) || null }; // review inside the author's worktree
        if (w.kind === 'verifier') return { rec: iso.integration }; // verify the combined result
        let rec = iso.tasks.get(w.name);
        if (!rec) { rec = await featureRequest('tasks/create', { root: iso.root, title: 'swarm:' + w.name }, swarmCtl.signal); iso.tasks.set(w.name, rec); iso.caches.set(w.name, new Map()); }
        for (const d of w.depends_on) {
          const dep = iso.tasks.get(d);
          if (!dep || results[d]?.status !== 'done') continue;
          const r = await queueAbsorb(rec.id, dep.id);
          if (!r.ok) return { rec, conflict: r.files || [] };
        }
        return { rec };
      }
      if (iso) for (const n of Object.keys(initial)) if (iso.tasks.has(n)) await queueAbsorb(iso.integration.id, iso.tasks.get(n).id).catch(() => {});

      async function saveCheckpoint(statuses, finished) {
        try {
          if (finished) { await dbDelete('agent_states', swarmCheckpointKey()); return; }
          const slim = {};
          for (const [n, r] of Object.entries(results)) slim[n] = { ...r, log: (r.log || []).slice(-30) };
          await dbSet('agent_states', { id: swarmCheckpointKey(), kind: 'swarm', convId: state.activeConvId, goal, names, ts: Date.now(),
            statuses: Object.fromEntries(Object.entries(statuses).map(([n, s]) => [n, s === 'running' ? 'pending' : s])), results: slim, memory: memory.toJSON(), events: events.toJSON(),
            isolation: iso ? { root: iso.root, integration: iso.integration.id, tasks: Object.fromEntries([...iso.tasks].map(([n, t]) => [n, t.id])) } : null });
        } catch { /* best-effort */ }
      }

      // One streamed chat completion for a worker. Throws on transport/HTTP errors.
      async function workerStream(messages, tools, signal, onReasoning, model) {
        const result = await requestModel({ model: model || state.model, messages, stream: true,
          temperature: 0.2, max_tokens: Math.min(state.maxTokens, 8000), ...(tools?.length ? { tools } : {}) }, signal, { onReasoning });
        return { ...result, outTok: result.usage.out };
      }

      async function runWorker(w, attempt, extra = {}) {
        let ws;
        try { ws = await prepareWorkspace(w); }
        catch (e) { return { name: w.name, role: w.role, status: 'error', summary: '(not started) ' + e.message, reason: 'Could not prepare an isolated workspace: ' + e.message, log: [], iterations: 0, error: true, retryable: false }; }
        if (ws.conflict) { const why = 'Upstream workers changed the same files (' + ws.conflict.join(', ') + '); their work cannot be combined automatically.'; return { name: w.name, role: w.role, status: 'error', summary: '(not started) ' + why, reason: why, log: [], iterations: 0, error: true, retryable: false }; }
        const wsRec = ws.rec;
        const toolNames = toolNamesFor(w);
        const defs = allToolDefs.filter(t => toolNames.includes(t.function.name)).concat(SWARM_PSEUDO_TOOLS);
        let maxIter = Math.min(Math.max(w.max_iterations || defaultMax, 1), 25);
        const wsCache = iso?.caches.get(w.kind === 'critic' ? w.reviews : w.kind === 'verifier' ? '__integration' : w.name);
        const wb = SwarmCore.createRoundBudget({ limit: maxIter, hardCap: 40 });
        const depSummaries = w.depends_on.map(d => ({ name: d, status: results[d]?.status || 'done', summary: String(results[d]?.summary || '').slice(0, 600) }));
        const sysPrompt = buildWorkerSysPrompt(w, {
          memory, goal, total: workers.length, toolNames, depSummaries, isolated: !!iso, ownerNames: workers.filter(x => x.kind !== 'critic').map(x => x.name),
          env: [state.compInfo?.python_cmd ? `Python command: \`${state.compInfo.python_cmd}\` (use this exactly).` : '', state.compInfo?.shell ? `Shell: ${state.compInfo.shell}. ` + (state.compInfo.shell === 'cmd.exe' ? 'Use cmd.exe syntax.' : 'Use POSIX syntax: discard output with /dev/null, never "nul" (that would create a file called nul).') : ''].filter(Boolean).join(' '),
          projectMemory: (state.projectMemoryText || '').slice(0, 1500), invariants: state.invariants || []
        });
        let inboxCursor = 0;
        const first = memory.inbox(w.name, 0); inboxCursor = first.next;
        const subMessages = [{ role: 'user', content: w.task +
          (first.messages.length ? '\n\n## Messages from other workers\n' + first.messages.map(m => `- From **${m.from}**: ${m.content}`).join('\n') : '') +
          (extra.authorSummary ? '\n\n## The author\'s own summary of their work\n' + extra.authorSummary : '') +
          (extra.diff ? '\n\n## Changes to review (git diff against the project base)\n```diff\n' + extra.diff + '\n```' : '') +
          (extra.critique ? '\n\n## Critic feedback you must address (revision ' + extra.revision + ')\nA reviewer found these problems with your previous work. Fix each one that is real, verify, and say in your summary which you fixed and which you disagree with and why.\n' + extra.critique : '') +
          (extra.priorSummary ? '\n\n## Your previous summary\n' + extra.priorSummary : '') +
          (state.dirName ? '\n\nWorking directory: ' + state.dirName : '') }];
        const log = [];
        let iterations = 0, finishedNaturally = false, apiError = '', stallNudged = false, stalled = false, workerTokens = 0, overBudget = false, contextFull = false, trimmedTotal = 0, timedOut = false, swarmOver = false;
        // Budget the conversation at ~65% of the loaded context so there is room for the reply and tool schemas.
        const info = state.modelInfoMap?.get?.(w.model || state.model);
        const ctxTokens = info?.loadedContextLength || info?.contextLength || 0;
        const ctxBudget = Math.floor((ctxTokens || 32000) * 0.65);
        const recent = [];
        setWorkerUI(w, 'running', { label: attempt > 1 ? `Retry ${attempt - 1}…` : 'Running…', iter: '' });
        updateParentStatus(`Swarm: ${w.name}`, 'run');

        const rounds = async () => { while (true) {
          if (swarmCtl.signal.aborted || checkBudget()) break;
          // The verifier may use the reserved share of the contract; ordinary workers stop at the working share.
          const dl = w.kind === 'verifier' ? hardDeadline : workerDeadline, pool = w.kind === 'verifier' ? contract.token_budget : tokenPool;
          if (dl && Date.now() > dl) { timedOut = true; emit('deadline', { worker: w.name }); break; }
          if (pool && swarmTokens >= pool) { swarmOver = true; emit('swarm_budget', { worker: w.name }); break; }
          const decision = wb.decide(iterations); maxIter = wb.limit;
          if (decision === 'extended') emit('extended', { worker: w.name, limit: maxIter });
          if (decision === 'limit') break;
          if (decision === 'stalled') { stalled = true; emit('stalled', { worker: w.name }); break; }
          if (decision === 'extended') subMessages.push({ role: 'user', content: `[SYSTEM] You are still making progress, so your round budget was extended to ${maxIter}. Start converging on your result.` });
          else if (decision === 'warn') subMessages.push({ role: 'user', content: '[SYSTEM] You have one round left. If you have enough, stop calling tools and give your final summary now.' });
          if (w.tokenBudget && workerTokens >= w.tokenBudget) { overBudget = true; break; }
          const fit = SwarmCore.trimToolOutputs(subMessages, { budgetTokens: ctxBudget, reserveTokens: estimateTokens(sysPrompt) + 1500, estimate: estimateTokens });
          trimmedTotal += fit.trimmed;
          if (fit.over) { contextFull = true; break; }
          iterations++;
          setWorkerUI(w, 'running', { label: attempt > 1 ? `Retry ${attempt - 1}…` : 'Running…', iter: `${iterations}/${maxIter}r · ~${workerTokens}tok` });
          const stEl = document.getElementById(`swarm-wstatus-${w.index}`);
          let acc;
          try {
            acc = await workerStream([{ role: 'system', content: sysPrompt }, ...subMessages], defs, swarmCtl.signal,
              full => { if (stEl) stEl.textContent = `Reasoning… (${full.length > 1000 ? (full.length / 1000).toFixed(1) + 'k' : full.length}c)`; }, w.model);
            workerTokens += acc.outTok || 0; swarmTokens += acc.outTok || 0; updateMeta();
          } catch (e) {
            if (e.name === 'AbortError') break;
            apiError = HarnessRuntime.connectionErrorHint(e, state.backend);
            log.push({ tool: 'API', args: '', output: apiError, success: false });
            break;
          }
          const toolCalls = acc.toolCalls.filter(Boolean);
          toolCalls.forEach((tc, i) => { if (!tc.id) tc.id = `tc_${Date.now()}_${w.index}_${i}`; });
          const assistantMsg = { role: 'assistant', content: acc.content || null };
          if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
          subMessages.push(assistantMsg);
          if (!toolCalls.length) { finishedNaturally = true; break; }

          // Stall detection: the same call three times in a row is a loop, not progress.
          const sig = toolCalls.map(tc => tc.function.name + ':' + tc.function.arguments).join('|');
          recent.push(sig); if (recent.length > 5) recent.shift();
          const repeats = recent.filter(s => s === sig).length;

          const stats = createCompressionStats();
          let roundOk = false;
          for (const tc of toolCalls) {
            const name = tc.function.name;
            let outText = '', success = true;
            let a = null;
            try { a = JSON.parse(tc.function.arguments || '{}'); } catch { a = null; }
            try {
              if (name.startsWith('swarm_')) {
                if (!a) throw new Error('arguments must be valid JSON');
                if (name === 'swarm_memory_write') { memory.write(a.key, a.value, w.name, { status: a.status, evidence: a.evidence }); outText = `Written: ${a.key} (${String(a.value).length} chars, ${a.status === 'verified' ? 'verified' : 'hypothesis'})`; refreshMemoryUI(); }
                else if (name === 'swarm_memory_read') { outText = a.key ? (memory.read(a.key) ?? `No such key. Keys: ${memory.keys().join(', ') || '(none)'}`) : 'Keys: ' + (memory.keys().join(', ') || '(none)'); }
                else if (name === 'swarm_message') { memory.postMessage(w.name, a.to, a.content); outText = `Message posted to ${a.to}`; refreshBusUI(); }
                else if (name === 'swarm_check_messages') {
                  const inbox = memory.inbox(w.name, inboxCursor); inboxCursor = inbox.next;
                  outText = inbox.messages.length ? inbox.messages.map(m => `From ${m.from}: ${m.content}`).join('\n') : 'No new messages.';
                } else throw new Error('Unknown swarm tool');
                log.push({ tool: name, args: a?.key || a?.to || '', output: outText.slice(0, 200), success: true });
              } else {
                // Ownership is enforced centrally so a worker cannot write outside its lane.
                const guarded = SwarmCore.WRITE_TOOLS.has(name) && w.owns.length && a
                  ? [a.path, a.source, a.destination].filter(Boolean).find(p => !SwarmCore.pathAllowed(p, w.owns)) : null;
                if (guarded) { success = false; outText = `Error: "${guarded}" is outside your ownership (${w.owns.join(', ')}). Ask its owner via swarm_message.`; }
                else {
                  const res = await withWorkspace(wsRec, wsCache, () => executeTool(name, tc.function.arguments, swarmCtl.signal, null));
                  const norm = HarnessRuntime.normalizeResult(res, name);
                  outText = redactSecrets(norm.output);
                  success = norm.status === 'ok' && !res._pendingApproval;
                  if (res._pendingApproval) outText += '\n(Not applied: this edit needs user approval, which workers cannot request. Describe the change in your summary.)';
                  outText = compressToolOutput(name, outText, stats);
                }
                log.push({ tool: name, args: (tc.function.arguments || '').slice(0, 100), output: outText.slice(0, 200), success });
              }
            } catch (e) {
              if (e.name === 'AbortError') { outText = 'Cancelled.'; success = false; }
              else { outText = 'Error: ' + e.message; success = false; }
              log.push({ tool: name, args: '', output: outText.slice(0, 200), success: false });
            }
            if (success) roundOk = true;
            subMessages.push({ role: 'tool', tool_call_id: tc.id, content: outText });
          }
          wb.record(toolCalls.map(tc => tc.function.name + ':' + tc.function.arguments), roundOk);

          // Deliver anything other workers posted since the last round.
          const inbox = memory.inbox(w.name, inboxCursor); inboxCursor = inbox.next;
          if (inbox.messages.length) subMessages.push({ role: 'user', content: '[Messages from other workers]\n' + inbox.messages.map(m => `- From **${m.from}**: ${m.content}`).join('\n') });
          if (repeats >= 3 && !stallNudged) { stallNudged = true; subMessages.push({ role: 'user', content: '[SYSTEM] You repeated the same tool call 3 times with no progress. Change approach, or stop and explain what is blocking you.' }); }
          else if (repeats >= 5) { stalled = true; break; }
          setWorkerUI(w, 'running', { iter: `${iterations}/${maxIter}r · ~${workerTokens}tok`, html: `<div class="swarm-worker-log">${logHtml(log, 8)}</div>` });
        } };
        await rounds();

        // Per-worker completion check: a worker is not done until its own command passes. Failures go back to the worker.
        let checkInfo = null;
        while (finishedNaturally && w.check_command && w.kind !== 'critic' && !swarmCtl.signal.aborted) {
          setWorkerUI(w, 'running', { label: 'Checking…' });
          let passed = false, out = '';
          try {
            const res = await withWorkspace(wsRec, wsCache, () => executeTool('run_tests', JSON.stringify({ command: w.check_command }), swarmCtl.signal, null));
            const norm = HarnessRuntime.normalizeResult(res, 'run_tests');
            passed = norm.status === 'ok' && (norm.exitCode == null || norm.exitCode === 0); out = redactSecrets(norm.output);
          } catch (e) { if (e.name === 'AbortError') break; out = 'The check could not run: ' + e.message; }
          checkInfo = { command: w.check_command, passed, attempts: (checkInfo?.attempts || 0) + (passed ? 0 : 1), output: out.slice(-1500) };
          emit('check', { worker: w.name, passed, attempt: checkInfo.attempts });
          log.push({ tool: 'check', args: w.check_command.slice(0, 100), output: (passed ? 'passed' : 'FAILED: ' + out).slice(0, 200), success: passed });
          if (passed || checkInfo.attempts > w.check_retries) break;
          finishedNaturally = false; wb.grant(3); maxIter = wb.limit; stalled = false;
          subMessages.push({ role: 'user', content: '[CHECK FAILED] Your completion check `' + w.check_command + '` failed (attempt ' + checkInfo.attempts + ' of ' + (w.check_retries + 1) + '). Output:\n' + out.slice(-2000) + '\n\nFix the cause, re-run what you need to confirm, then finish with a new summary.' });
          await rounds();
        }

        // Out of rounds: one tool-free turn so the work is reported instead of silently dropped.
        let completedAtCap = false;
        if (!finishedNaturally && !apiError && !swarmCtl.signal.aborted && (iterations >= maxIter || stalled || overBudget || contextFull || timedOut || swarmOver)) {
          try {
            subMessages.push({ role: 'user', content: '[SYSTEM] You must stop now: ' + (timedOut ? 'the deadline was reached' : swarmOver ? 'the swarm token budget was reached' : contextFull ? 'out of context space' : overBudget ? 'out of token budget' : stalled ? 'you are repeating work without new results' : 'out of rounds') + '. Without calling any tools, give your final summary, including anything unfinished. End with exactly one line: "STATUS: COMPLETE" or "STATUS: INCOMPLETE - <reason>".' });
            const wrap = await workerStream([{ role: 'system', content: sysPrompt }, ...subMessages], null, swarmCtl.signal, null, w.model);
            subMessages.push({ role: 'assistant', content: wrap.content || null });
            completedAtCap = /STATUS:\s*COMPLETE\b/i.test(wrap.content || '');
          } catch { /* fall through with what we have */ }
        }
        const lastAssistant = [...subMessages].reverse().find(m => m.role === 'assistant' && m.content);
        const summary = lastAssistant?.content || '';
        let status = SwarmCore.workerStatusFromLoop({ aborted: swarmCtl.signal.aborted, apiError, summary,
          finishedNaturally: finishedNaturally || completedAtCap });
        // A worker that never got to act cannot have completed its task, whatever its wrap-up message claims.
        if (contextFull && iterations === 0 && status === 'done') status = 'incomplete';
        if (checkInfo && !checkInfo.passed && status === 'done') status = 'incomplete';
        if (stalled && status === 'done') status = 'incomplete';
        const reason = apiError ? apiError : stalled ? 'Stalled: repeated the same tool call' : (checkInfo && !checkInfo.passed) ? `Completion check still failing after ${checkInfo.attempts} attempt(s): ${w.check_command}` : status === 'incomplete' ? (timedOut ? 'Deadline reached before finishing' : swarmOver ? 'Swarm token budget reached before finishing' : contextFull ? 'Context window filled up even after trimming old tool output' : overBudget ? `Hit the worker token budget (${w.tokenBudget}) before finishing` : iterations >= maxIter ? `Hit the ${maxIter}-round limit before finishing` : 'Stopped without a summary') : '';
        return { name: w.name, role: w.role, model: w.model || state.model, kind: w.kind, check: checkInfo, tokens: workerTokens, trimmedOutputs: trimmedTotal, status, summary: summary || (reason ? `(no summary) ${reason}` : '(no summary produced)'), reason, log, iterations,
          error: status === 'error' || status === 'incomplete', retryable: status === 'error' && !!apiError && !/^API 4\d\d/.test(apiError) };
      }

      function paintWorker(w, status) {
          const r = results[w.name];
          setWorkerUI(w, status, { label: SWARM_STATUS_LABEL[status] + (r?.verdict ? ' · ' + r.verdict.toUpperCase() : '') + (r?.revisions ? ' · rev ' + r.revisions : ''), iter: r ? `${r.iterations}r · ${r.log.length} calls · ~${r.tokens || 0}tok` : '',
            html: r ? `<div class="swarm-worker-summary">${renderMd(r.summary)}</div>${r.reason && status !== 'done' ? `<div class="swarm-worker-summary" style="color:var(--red)">${esc(r.reason)}</div>` : ''}<div class="swarm-worker-log">${logHtml(r.log) || '<div style="padding:4px;color:var(--tx-4)">No tool calls</div>'}</div>` : '',
            open: status !== 'done' });          const body = document.getElementById(`swarm-wbody-${w.index}`);
          body?.querySelectorAll('pre code').forEach(b => { if (!b.dataset.hljs) { hljs.highlightElement(b); b.dataset.hljs = '1'; } });
      }

      // Sends a worker back with specific evidence, merges the result again, and keeps the artifact record consistent.
      async function reviseWorker(target, critique, revisionNo) {
        const prior = results[target.name] || {};
        emit('revision', { worker: target.name, revision: revisionNo });
        const rev = await runWorker(target, 1, { critique, revision: revisionNo, priorSummary: String(prior.summary || '').slice(0, 1200) });
        rev.revisions = (prior.revisions || 0) + 1; rev.tokens = (rev.tokens || 0) + (prior.tokens || 0);
        rev.log = (prior.log || []).concat(rev.log); rev.iterations = (prior.iterations || 0) + rev.iterations;
        results[target.name] = rev;
        if (rev.status === 'done' && iso?.tasks.has(target.name)) {
          try { const m = await queueAbsorb(iso.integration.id, iso.tasks.get(target.name).id); if (!m.ok) { iso.conflicts.push({ worker: target.name, files: m.files || [] }); rev.status = 'incomplete'; rev.error = true; rev.reason = 'Merge conflict after revision in: ' + (m.files || []).join(', '); } }
          catch (e) { rev.status = 'incomplete'; rev.error = true; rev.reason = 'Could not merge the revision: ' + e.message; }
        }
        emit('worker_finished', { worker: target.name, status: rev.status, revision: revisionNo, tokens: rev.tokens });
        paintWorker(target, rev.status);
        return rev;
      }

      // A critic reviews its author's work and may send it back for a bounded number of revisions.
      async function getDiffFor(target) {
        const rec = iso?.tasks.get(target.name);
        if (!rec) return '';
        try { return String((await featureRequest('tasks/diff', { taskId: rec.id }, swarmCtl.signal)).diff || '').slice(0, 12000); } catch { return ''; }
      }
      async function runCritic(w, attempt) {
        const target = byName.get(w.reviews);
        let round = 0, last;
        while (true) {
          round++;
          last = await runWorker(w, attempt, { diff: await getDiffFor(target), authorSummary: String(results[target.name]?.summary || '').slice(0, 1500) });
          last.rounds = round;
          if (last.status !== 'done') return last;
          const v = SwarmCore.parseVerdict(last.summary);
          last.verdict = v.verdict; last.issues = v.issues;
          emit('critic_verdict', { critic: w.name, target: target.name, verdict: v.verdict, round });
          if (v.verdict === 'approve') return last;
          if (v.verdict === 'unknown') { last.status = 'incomplete'; last.error = true; last.reason = 'The critic ended without a VERDICT line, so its review cannot be trusted.'; return last; }
          if (round > w.max_revisions) {
            last.status = 'incomplete'; last.error = true; last.reason = `Critic still requests changes after ${w.max_revisions} revision(s): ${v.issues.slice(0, 300)}`;
            if (iso) iso.kept.add(target.name);
            return last;
          }
          // Send the author back with the critic's evidence.
          const rev = await reviseWorker(target, v.issues, round);
          if (rev.status !== 'done') { last.status = 'incomplete'; last.error = true; last.reason = `The revision of ${target.name} did not complete: ${rev.reason || rev.status}`; if (iso) iso.kept.add(target.name); return last; }
        }
      }

      // ── Schedule the graph ──
      const sched = await SwarmCore.runSchedule(workers, async (w, attempt) => {
        emit('worker_started', { worker: w.name, attempt });
        const r = w.kind === 'critic' ? await runCritic(w, attempt) : await runWorker(w, attempt);
        results[w.name] = r;
        emit('worker_finished', { worker: w.name, status: r.status, reason: r.reason || '', tokens: r.tokens || 0, attempt });
        if (iso && r.status === 'done' && iso.tasks.has(w.name)) {
          try {
            const m = await queueAbsorb(iso.integration.id, iso.tasks.get(w.name).id);
            if (!m.ok) { iso.conflicts.push({ worker: w.name, files: m.files || [] }); emit('merge_conflict', { worker: w.name, files: m.files || [] }); r.status = 'incomplete'; r.reason = 'Merge conflict with already-merged workers in: ' + (m.files || []).join(', '); r.error = true; r.retryable = false; }
          } catch (e) { r.status = 'incomplete'; r.reason = 'Could not merge this worker\'s changes: ' + e.message; r.error = true; r.retryable = false; }
        }
        if (iso && r.status !== 'done' && iso.tasks.get(w.name)) iso.kept.add(w.name);
        return r;
      }, {
        concurrency, initial, signal: swarmCtl.signal, shouldStop: stopLaunching,
        onStatus: (w, status, all) => {
          if (status === 'running') { updateParentStatus(`Swarm: ${Object.values(all).filter(s => s === 'done').length}/${workers.length} done`, 'run'); return; }
          const r = results[w.name];
          if (status === 'pending') { setWorkerUI(w, 'pending', { label: 'Retrying…' }); return; }
          paintWorker(w, status);
          refreshMemoryUI(); refreshBusUI(); scrollBottom();
          saveCheckpoint(all, false);
        }
      });
      const statuses = sched.statuses;
      for (const w of workers) if (statuses[w.name] === 'blocked' || statuses[w.name] === 'skipped') {
        const why = statuses[w.name] === 'blocked' ? 'Not run: an upstream worker failed (' + w.depends_on.filter(d => ['error', 'incomplete', 'blocked', 'skipped'].includes(statuses[d])).join(', ') + ')' : (budgetHit ? 'Not run: session token budget reached' : stopLaunching() ? 'Not run: the contract\'s working deadline or token budget was reached' : 'Not run: swarm was cancelled');
        results[w.name] = results[w.name] || { name: w.name, role: w.role, status: statuses[w.name], summary: why, reason: why, log: [], iterations: 0, error: false };
        results[w.name].status = statuses[w.name];
        setWorkerUI(w, statuses[w.name], { label: SWARM_STATUS_LABEL[statuses[w.name]], html: `<div class="swarm-worker-summary">${esc(why)}</div>`, iter: '', open: true });
      }
      if (budgetHit) notes.push('Stopped: session output-token budget reached.');

      // ── Verification: executable evidence first, then an independent verifier judging the acceptance criteria ──
      let verification = null, acceptance = null, repairs = 0;
      const verifyCmd = (options.verifyCommand || '').trim();
      const allDone = () => Object.values(statuses).every(s => s === 'done');
      const canVerify = () => withinContract() && allDone();
      const doVerifyCommand = async () => {
        updateParentStatus('Verifying…', 'run');
        let v;
        try {
          const res = await withWorkspace(iso?.integration, iso?.caches.get('__integration'), () => executeTool('run_tests', JSON.stringify({ command: verifyCmd }), swarmCtl.signal, null));
          const norm = HarnessRuntime.normalizeResult(res, 'run_tests');
          v = { command: verifyCmd, verified: norm.status === 'ok' && (norm.exitCode == null || norm.exitCode === 0), output: norm.output.slice(0, 1500) };
        } catch (e) { v = { command: verifyCmd, verified: false, output: 'Verification could not run: ' + e.message }; }
        emit('verify_command', { passed: v.verified });
        return v;
      };
      // The verifier gets its own context: the goal, the criteria and the project itself, never the workers' narratives.
      const runVerifier = async () => {
        updateParentStatus('Independent verification…', 'run');
        const taskText = 'Verify the project against these acceptance criteria:\n' + contract.criteria.map(c => `${c.id}: ${c.text}`).join('\n') +
          (verification ? `\n\nA scripted check (${verification.command}) ${verification.verified ? 'PASSED' : 'FAILED'}:\n${verification.output}\n(This is one piece of evidence, not a verdict. Check the criteria yourself.)` : '') +
          '\n\nReply with one line per criterion, exactly: "AC1: PASS - <evidence>", "AC2: FAIL - <evidence> (owner: <worker name>)" or "AC3: UNVERIFIABLE - <why>".';
        const vw = { name: 'verifier', role: 'Independent verifier', task: taskText, kind: 'verifier', index: -1, depends_on: [], owns: [], tokenBudget: 0, model: contract.verifier_model, max_iterations: 10, check_command: '', check_retries: 0, retries: 0, on_failure: 'block', max_revisions: 0, reviews: '' };
        const r = await runWorker(vw, 1, {});
        const parsed = SwarmCore.parseCriteriaVerdicts(r.summary, contract.criteria);
        const known = new Set(workers.filter(x => x.kind !== 'critic').map(x => x.name));
        parsed.criteria.forEach(c => { if (c.owner && !known.has(c.owner)) c.owner = ''; });
        emit('acceptance', { passed: parsed.criteria.filter(c => c.status === 'pass').length, total: parsed.criteria.length });
        return { ...parsed, tokens: r.tokens || 0, raw: String(r.summary || '').slice(0, 3000), reason: r.reason || '' };
      };
      // Targeted repair: only the owning workers are sent back, with the verifier's evidence; accepted work is left alone.
      const repairFailures = async acc => {
        const failing = acc.criteria.filter(c => c.status === 'fail' || c.status === 'missing');
        const core = workers.filter(x => x.kind !== 'critic'), groups = new Map(), unassigned = [];
        for (const c of failing) { const owner = c.owner || (core.length === 1 ? core[0].name : ''); if (!owner) { unassigned.push(c.id); continue; } if (!groups.has(owner)) groups.set(owner, []); groups.get(owner).push(c); }
        let fixed = 0;
        for (const [owner, list] of [...groups].slice(0, 3)) {
          if (!withinContract()) break;
          const critique = 'An independent verifier checked the finished project and found these acceptance criteria NOT met:\n' + list.map(c => `- ${c.id} ${c.text}\n  Evidence: ${c.evidence}`).join('\n');
          emit('repair', { worker: owner, criteria: list.map(c => c.id) });
          const rev = await reviseWorker(byName.get(owner), critique, repairs + fixed + 1);
          if (rev.status === 'done') fixed++; else { statuses[owner] = rev.status === 'error' ? 'error' : 'incomplete'; if (iso) iso.kept.add(owner); }
        }
        return { fixed, unassigned };
      };
      if (canVerify()) {
        if (verifyCmd) verification = await doVerifyCommand();
        if (contract.criteria.length) {
          for (let round = 0; ; round++) {
            acceptance = await runVerifier();
            if (acceptance.allPass || round >= contract.repair_rounds || !canVerify()) break;
            const rep = await repairFailures(acceptance);
            if (rep.unassigned.length) notes.push('Could not route failing criteria (' + rep.unassigned.join(', ') + ') to a worker: set an owner on the criterion.');
            if (!rep.fixed) break;
            repairs += rep.fixed;
            if (verifyCmd && canVerify()) verification = await doVerifyCommand();
          }
        }
      } else if (verifyCmd || contract.criteria.length) notes.push('Verification was skipped: not every worker finished, or the contract\'s deadline or token budget was reached.');
      let isolation = null;
      if (iso) {
        const allDone = Object.values(statuses).every(s => s === 'done') && !iso.conflicts.length;
        isolation = { root: iso.root, integrationTaskId: iso.integration.id, branch: iso.integration.branch, changedFiles: [], conflicts: iso.conflicts, keptWorktrees: [] };
        try { isolation.changedFiles = (await featureRequest('tasks/diff', { taskId: iso.integration.id })).changedFiles || []; }
        catch (e) { notes.push('Could not summarise the combined changes: ' + e.message); }
        const discard = id => featureRequest('tasks/discard', { taskId: id, confirm: true }).catch(() => {});
        if (allDone) {
          for (const rec of iso.tasks.values()) await discard(rec.id);
          if (!isolation.changedFiles.length) { await discard(iso.integration.id); notes.push('Isolated swarm made no file changes.'); isolation.integrationTaskId = null; }
          else notes.push(`All changes (${isolation.changedFiles.length} files) are on branch ${iso.integration.branch}, NOT in your working tree. Open Harness → Isolation to review and merge.`);
        } else {
          isolation.keptWorktrees = [...iso.tasks].filter(([n]) => statuses[n] !== 'done' || iso.kept.has(n) || iso.conflicts.some(c => c.worker === n)).map(([n, t]) => ({ worker: n, taskId: t.id, branch: t.branch }));
          notes.push(`Isolated worktrees were kept for inspection (integration branch ${iso.integration.branch}). Review or discard them in Harness → Isolation.`);
        }
      }
      // "Verified" needs every configured gate to pass: the scripted check and every acceptance criterion.
      const hasGate = !!verifyCmd || contract.criteria.length > 0;
      const gatePassed = (!verifyCmd || !!verification?.verified) && (!contract.criteria.length || !!acceptance?.allPass);
      const outcome = SwarmCore.swarmOutcome(statuses, hasGate ? { verified: gatePassed } : null);
      emit('outcome', { outcome, repairs });
      const acceptanceText = acceptance ? 'Acceptance criteria (independent verifier):\n' + acceptance.criteria.map(c => `- ${c.id} ${c.status.toUpperCase()}: ${c.text} — ${c.evidence}`).join('\n') + '\n\n' : '';

      // ── Manager synthesis ──
      updateParentStatus('Manager synthesising…', 'run');
      const ordered = workers.map(w => results[w.name]);
      const fallback = ordered.map(r => `**${r.name}** (${r.status}): ${String(r.summary).slice(0, 400)}`).join('\n\n');
      let managerSummary = fallback;
      if (!swarmCtl.signal.aborted) {
        try {
          const data = await requestModelJSON({ model: state.model, stream: false, temperature: 0.3, max_tokens: 2000, messages: [
              { role: 'system', content: 'You are the manager of a multi-agent swarm. Synthesise the workers\' outputs into a final, cohesive summary for the user. Be concise and honest: lead with the overall outcome, name every worker that did not finish and why, report verification evidence if present, and list concrete next steps. Never claim work was done that a worker reports as incomplete, blocked or skipped.' },
              { role: 'user', content: `## Swarm Goal\n${goal}\n\n## Outcome\n${outcome}${verification ? `\nVerification (${verification.command}): ${verification.verified ? 'PASSED' : 'FAILED'}\n${verification.output}` : ''}\n${notes.length ? '\nNotes: ' + notes.join(' ') + '\n' : ''}\n${acceptanceText}## Shared Memory (final state)\n${memory.toContextString()}\n\n## Worker Results\n` +
                ordered.map((r, i) => `### ${i + 1}. ${r.name} — ${r.role} [${r.status}]\n${r.summary}`).join('\n\n') + '\n\nWrite the final synthesis.' }] }, parentSignal);
          managerSummary = data.choices?.[0]?.message?.content || fallback;
        } catch { /* deterministic fallback above */ }
      }

      const duration = performance.now() - startTime;
      const totalIterations = ordered.reduce((n, r) => n + (r.iterations || 0), 0);
      const failed = outcome === 'blocked';
      const metrics = SwarmCore.runMetrics({ outcome, durationMs: duration, tokens: swarmTokens, statuses, attempts: sched.attempts, results, repairs, acceptance,
        config: { critic: workers.some(w => w.kind === 'critic'), check: workers.some(w => w.check_command), isolated: !!iso, concurrency, criteria: contract.criteria.length > 0, workers: workers.length } });
      const resultData = { goal, contract, acceptance, metrics, events: events.toJSON(), memoryDetail: memory.entries(), workers, workerResults: ordered, managerSummary, memory: memory.readAll(), messageBus: memory.bus, totalIterations, duration,
        error: failed, outcome, statuses, verification, notes, isolation, attempts: sched.attempts };
      const liveStatus = document.getElementById('swarm-live-status'), liveMeta = document.getElementById('swarm-live-meta');
      if (liveStatus) { liveStatus.className = 'swarm-status ' + (failed ? 'error' : 'done'); liveStatus.textContent = { verified: 'Verified', needs_review: 'Needs review', blocked: 'Blocked' }[outcome]; }
      if (liveMeta) liveMeta.textContent = `${workers.length} workers · ${totalIterations} rounds · ~${swarmTokens} tok · ${(duration / 1000).toFixed(1)}s`;
      const swarmBody = document.getElementById('swarm-live-body');
      if (swarmBody) {
        const synthEl = document.createElement('div');
        synthEl.className = 'swarm-manager-summary';
        synthEl.innerHTML = `<div class="swarm-manager-label"><i class="fas fa-crown"></i> Manager Synthesis</div>${acceptance ? '<div class="swarm-worker-summary">' + acceptance.criteria.map(c => `${c.status === 'pass' ? '✓' : c.status === 'fail' || c.status === 'missing' ? '✗' : '?'} <strong>${esc(c.id)}</strong> ${esc(c.text)} — ${esc(c.evidence)}`).join('<br>') + '</div>' : ''}${notes.length ? `<p style="font-size:10px;color:var(--tx-3)">${esc(notes.join(' '))}</p>` : ''}${renderMd(managerSummary)}`;
        swarmBody.appendChild(synthEl);
        synthEl.querySelectorAll('pre code').forEach(b => { if (!b.dataset.hljs) { hljs.highlightElement(b); b.dataset.hljs = '1'; } });
        addCopyBtns(synthEl);
        synthEl.appendChild(makeSwarmTraceButton(resultData));
      }
      refreshMemoryUI(); scrollBottom();
      updateParentStatus(failed ? 'Blocked' : 'Done', failed ? 'err' : 'ok');
      // Unless every worker finished, keep the checkpoint so re-running the same call resumes instead of redoing work.
      await saveCheckpoint(statuses, Object.values(statuses).every(s => s === 'done'));

      if (!swarmCtl.signal.aborted) await persistSwarmRun(goal, metrics);
      return resultData;
    }

    /** Render a completed swarm data object into a panel (for message replay). */
    function showSwarmPanel(data, container) {
      const el = document.createElement('div');
      el.className = 'swarm-panel collapsed';
      const goalDisplay = (data.goal || '').length > 90 ? (data.goal || '').slice(0, 87) + '…' : (data.goal || '');
      const dur = data.duration ? (data.duration / 1000).toFixed(1) + 's' : '';
      const statusCls = data.error ? 'error' : 'done';
      const colors = ['#f59e0b','#22d3ee','#a78bfa','#4ade80','#fb923c','#f472b6','#38bdf8','#a3e635'];

      const memEntries = Object.entries(data.memory || {});
      const memHtml = memEntries.length
        ? memEntries.map(([k, v]) => `<div class="swarm-mem-entry"><span class="swarm-mem-key">${esc(k)}</span><span class="swarm-mem-val">${esc(String(v).slice(0,100))}</span></div>`).join('')
        : '<div class="swarm-mem-empty">No shared memory</div>';

      const busHtml = (data.messageBus || []).map(m =>
        `<div class="swarm-bus-msg"><span class="swarm-bus-from">${esc(m.from)}</span><span class="swarm-bus-arrow">→</span><span class="swarm-bus-to">${esc(m.to)}</span><span class="swarm-bus-content">${esc(m.content.slice(0,200))}</span></div>`
      ).join('');

      const workersHtml = (data.workerResults || []).map((w, i) => {
        const bg = colors[i % colors.length];
        const wStatusCls = w.status || (w.error ? 'error' : 'done');
        const logHtml = (w.log || []).map(e =>
          `<div class="swarm-worker-log-entry"><span class="swarm-worker-log-tool">${esc(e.tool)}</span><span class="${e.success ? 'swarm-worker-log-ok' : 'swarm-worker-log-err'}">${e.success ? '✓' : '✗'}</span><span class="swarm-worker-log-out" title="${esc(e.output)}">${esc(e.output)}</span></div>`
        ).join('');
        return `<div class="swarm-worker ${wStatusCls}">
          <div class="swarm-worker-hdr" onclick="toggleSwarmWorker(this)">
            <div class="swarm-worker-avatar" style="background:${bg}">${esc(w.name.slice(0,2).toUpperCase())}</div>
            <span class="swarm-worker-name">${esc(w.name)}</span>
            <span class="swarm-worker-role">${esc(w.role)}</span>
            <span class="swarm-worker-status ${wStatusCls}">${SWARM_STATUS_LABEL[wStatusCls] || wStatusCls}</span>
            <span class="swarm-worker-iter">${w.iterations}r · ${(w.log||[]).length} calls${w.tokens ? ' · ~' + w.tokens + 'tok' : ''}</span>
          </div>
          <div class="swarm-worker-body">
            <div class="swarm-worker-summary">${renderMd(w.summary || '')}</div>
            <div class="swarm-worker-log">${logHtml || '<div style="padding:4px;color:var(--tx-4)">No tool calls</div>'}</div>
          </div>
        </div>`;
      }).join('');

      el.innerHTML = `
        <div class="swarm-hdr" onclick="toggleSwarmBody(this)">
          <i class="fas fa-network-wired swarm-icon"></i>
          <span class="swarm-label">Swarm</span>
          <span class="swarm-goal" title="${esc(data.goal || '')}">${esc(goalDisplay)}</span>
          <span class="swarm-status ${statusCls}">${data.outcome === 'verified' ? 'Verified' : data.outcome === 'needs_review' ? 'Needs review' : data.error ? 'Blocked' : 'Done'}</span>
          <span class="swarm-meta">${(data.workerResults||[]).length} workers · ${data.totalIterations} rounds${dur ? ' · ' + dur : ''}</span>
        </div>
        <div class="swarm-body" style="display:none">
          <div class="swarm-mem">
            <div class="swarm-mem-hdr" onclick="event.stopPropagation();toggleSwarmMem(this)">
              <i class="fas fa-database"></i> Shared Memory <span class="mem-count">${memEntries.length} key${memEntries.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="swarm-mem-body">${memHtml}</div>
          </div>
          ${busHtml ? `<div class="swarm-bus"><div class="swarm-bus-hdr" onclick="event.stopPropagation();toggleSwarmBus(this)"><i class="fas fa-comments"></i> Message Bus</div><div class="swarm-bus-body">${busHtml}</div></div>` : ''}
          <div class="swarm-workers">${workersHtml}</div>
          ${data.managerSummary ? `<div class="swarm-manager-summary"><div class="swarm-manager-label"><i class="fas fa-crown"></i> Manager Synthesis</div>${renderMd(data.managerSummary)}</div>` : ''}
        </div>`;

      (container || $msg()).appendChild(el);
      el.querySelector('.swarm-manager-summary')?.appendChild(makeSwarmTraceButton(data));
      scrollBottom();
      el.querySelectorAll('pre code').forEach(b => { if (!b.dataset.hljs) { hljs.highlightElement(b); b.dataset.hljs = '1'; } });
      addCopyBtns(el);
    }

    function toggleSwarmBody(hdrEl) {
      const body = hdrEl.nextElementSibling;
      if (!body) return;
      const isHidden = body.style.display === 'none';
      body.style.display = isHidden ? 'flex' : 'none';
      hdrEl.closest('.swarm-panel')?.classList.toggle('collapsed', !isHidden);
    }
    function toggleSwarmMem(hdrEl) {
      const body = hdrEl.nextElementSibling;
      if (body) body.classList.toggle('open');
    }
    function toggleSwarmBus(hdrEl) {
      const body = hdrEl.nextElementSibling;
      if (body) body.classList.toggle('open');
    }
    function toggleSwarmWorker(hdrEl) {
      const workerEl = hdrEl.closest('.swarm-worker');
      const body = workerEl?.querySelector('.swarm-worker-body');
      if (body) body.classList.toggle('open');
    }


    function showCompactBanner(before, after) {
      const el = document.createElement('div'); el.className = 'compact-banner';
      el.innerHTML = `<i class="fas fa-compress"></i><span>Context compacted: ${formatTok(before)} → ${formatTok(after)} (${Math.round((1 - after / before) * 100)}% reduction)</span>`;
      $msg().appendChild(el); scrollBottom();
    }
    function formatTok(n) { return n < 1000 ? Math.round(n) + ' tok' : (n / 1000).toFixed(1) + 'k tok'; }


    /* ═══════════════ MODEL SYNC (LM Studio v0.3+) ═══════════════ */
    let activeInstance = null; // { instance_id, identifier, ... }

    async function fetchActiveModel(retries = 2) {
      // llama.cpp has no concept of active instance — skip the LM Studio-only endpoint
      if (state.backendType === 'llamacpp') {
        activeInstance = null;
        return null;
      }
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const timeout = attempt === 0 ? 5000 : 8000;
          const res = await fetch(`${state.apiUrl}/api/v0/models`, { signal: AbortSignal.timeout(timeout) });
          if (!res.ok) continue;
          const data = await res.json();
          const models = data.data || [];
          const loaded = models.find(m => m.state === 'loaded');
          if (loaded) {
            activeInstance = {
              instance_id: loaded.id,   // ← was: loaded.instanceId || ''
              identifier: loaded.id,
              state: 'loaded',
              contextLength: loaded.max_context_length || 0,
              loadedContextLength: loaded.loaded_context_length || 0,
            };
            return activeInstance;
          }
          activeInstance = null;
          return null;
        } catch {
          if (attempt === retries) { activeInstance = null; return null; }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      activeInstance = null;
      return null;
    }


    let _refreshing = false;
    let _queuedRefresh = false;
    async function refreshModels(forceReload) {
      if (_refreshing) { _queuedRefresh = _queuedRefresh || forceReload; return; }
      _refreshing = true;
      try {
        const sel = document.getElementById('model-sel');
        const meta = document.getElementById('model-meta');
        const dot = document.getElementById('llm-dot');
        const txt = document.getElementById('llm-text');

        let active = null;
        try { active = await fetchActiveModel(); } catch { activeInstance = null; }

        try {
          const res = await fetch(`${state.apiUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) throw new Error(res.statusText);
          const data = await res.json();
          await fetchModelInfo();

          if (forceReload) {
            try { active = await fetchActiveModel(); } catch { activeInstance = null; }
          }

          const prev = state.model;
          sel.innerHTML = '';

          if (!data.data?.length) {
            sel.innerHTML = '<option>No models found</option>';
            sel.disabled = true;
            state.connected = false;
            dot.className = 'status-dot off';
            txt.textContent = 'LLM';
            return;
          }

          state.connected = true;
          dot.className = 'status-dot on';
          txt.textContent = 'LLM';

          const activeId = active?.identifier || null;

          const sorted = [...data.data].sort((a, b) => {
            if (a.id === activeId) return -1;
            if (b.id === activeId) return 1;
            return a.id.localeCompare(b.id);
          });

          sorted.forEach(m => {
            const o = document.createElement('option');
            o.value = m.id;
            const isActive = m.id === activeId;
            const info = state.modelInfoMap.get(m.id);
            const tags = [];
            if (isActive) tags.push('✓ LOADED');
            else if (info?.contextLength) tags.push((info.contextLength / 1000).toFixed(0) + 'k ctx');
            if (info?.vision) tags.push('👁');
            if (info?.trainedForToolUse) tags.push('🔧');
            const suffix = tags.length ? '  [' + tags.join(' ') + ']' : '';
            o.textContent = (m.id.length > 50 ? m.id.slice(0, 47) + '...' : m.id) + suffix;
            if (isActive) o.style.color = 'var(--green)';
            sel.appendChild(o);
          });

          if (activeId) {
            state.model = activeId;
            sel.value = activeId;
          } else {
            state.model = sorted[0].id;
          }

          sel.disabled = false;
          sel.title = '';

          invalidateSubAgentPromptCache();
          updateVisionUI();
          updateModelMeta();
          updateWelcomeStatus();
          updateSendBtn();
          updateModelLoadBtn();

        } catch (e) {
          state.connected = false;
          dot.className = 'status-dot off';
          txt.textContent = 'LLM';
          sel.innerHTML = '<option>Connection failed</option>';
          sel.title = HarnessRuntime.connectionErrorHint(e, state.backendType);
          sel.disabled = true;
          updateVisionUI();
          updateSendBtn();
          updateWelcomeStatus();
          throw e;
        }
      } finally {
        _refreshing = false;
        if (_queuedRefresh) { const reload = _queuedRefresh; _queuedRefresh = false; setTimeout(() => refreshModels(reload), 0); }
      }
    }

    function updateModelMeta() {
      const meta = document.getElementById('model-meta');
      if (!meta) return;
      const info = state.modelInfoMap.get(state.model);

      // One-time warning when LM Studio's own metadata reports this model was NOT
      // trained for tool use. Such models are far more likely to hallucinate a
      // pseudo tool-call format (e.g. "<tool_call><function=...>") as plain text
      // instead of using the structured tool-calling API — which is exactly what
      // corrupted a user's SVG file. Warn once per model per session; the actual
      // prompt-side mitigation (stronger tool-call instructions) is injected in
      // the system prompt builder based on this same flag.
      if (info && info.trainedForToolUse === false && state.model) {
        if (!state._toolCapWarnedFor) state._toolCapWarnedFor = new Set();
        if (!state._toolCapWarnedFor.has(state.model)) {
          state._toolCapWarnedFor.add(state.model);
          showToast(`${state.model.split('/').pop()} isn't marked as tool-use trained — tool calls may be less reliable (garbled JSON, text-based function-call attempts).`, 'warn');
        }
      }

      // Always show what's actually loaded if we know it
      if (activeInstance?.identifier && activeInstance.identifier !== state.model) {
        const loadedShort = activeInstance.identifier.split('/').pop();
        meta.innerHTML = `<span style="color:var(--yellow)" title="Click the load button to switch">⚠ loaded: ${esc(truncate(loadedShort, 28))}</span>`;
      } else if (activeInstance?.identifier === state.model) {
        // Confirmed match — show model info
        const parts = [];
        if (info?.paramsString) parts.push(info.paramsString);
        if (info?.contextLength) parts.push((info.contextLength / 1000).toFixed(0) + 'k');
        if (info?.trainedForToolUse) parts.push('🔧');
        if (info?.vision) parts.push('👁');
        meta.textContent = parts.length ? parts.join(' · ') : '';
      } else {
        // Couldn't verify — show nothing or a subtle hint
        const parts = [];
        if (info?.paramsString) parts.push(info.paramsString);
        if (info?.vision) parts.push('👁');
        meta.innerHTML = parts.length ? parts.join(' · ') + ' <span style="color:var(--tx-4)">· unverified</span>' : '<span style="color:var(--tx-4)">unverified</span>';
      }
    }

    function updateModelLoadBtn() {
      const btn = document.getElementById('model-load-btn');
      if (!btn) return;
      // llama.cpp doesn't support model load/unload via API — hide the button
      if (state.backendType === 'llamacpp') { btn.style.display = 'none'; return; }
      const needsLoad = activeInstance?.identifier !== state.model;
      btn.style.display = needsLoad ? '' : 'none';
    }

    async function requestModelLoad(modelId) {
      if (state.backendType === 'llamacpp') {
        showToast('llama.cpp: model load/unload is not supported via API. Restart the server with a different model.', 'warn');
        return;
      }
      const dot = document.getElementById('llm-dot');
      const txt = document.getElementById('llm-text');
      const meta = document.getElementById('model-meta');
      const loadBtn = document.getElementById('model-load-btn');


      // Step 1: Unload old model if a different one is loaded
      if (activeInstance?.identifier && activeInstance.identifier !== modelId && activeInstance.instance_id) {
        dot.className = 'status-dot loading';
        txt.textContent = 'Unloading...';
        meta.innerHTML = `<span style="color:var(--tx-3)">⏳ Unloading ${esc(truncate(activeInstance.identifier, 25))}...</span>`;

        try {
          const unloadRes = await fetch(`${state.apiUrl}/api/v1/models/unload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instance_id: activeInstance.instance_id }),
            signal: AbortSignal.timeout(15000)
          });
          if (unloadRes.ok) {
            activeInstance = null;
          } else {
            const err = await unloadRes.text().catch(() => '');
            console.warn('[model] unload warning:', unloadRes.status, err);
          }
        } catch (e) {
          console.warn('[model] unload error (non-fatal):', e.message);
        }
      }

      // Step 2: Build load request body from settings
      dot.className = 'status-dot loading';
      txt.textContent = 'Loading...';
      meta.innerHTML = `<span style="color:var(--yellow)">⏳ Loading ${esc(truncate(modelId, 30))}...</span>`;

      const loadBody = { model: modelId, echo_load_config: true };
      if (!state.useModelLoadDefaults) {
        // Only override context_length when the user actually set an override —
        // previously this substituted state.ctxWindow (a harness-side setting
        // used for context-meter math, default 62768) even when the field was
        // left at 0, which contradicted its own "0 = model default" hint. Now
        // 0 genuinely omits the key, so LM Studio loads with the model's own
        // default/last-used/per-model-preset context length. The load-config
        // reconciliation a few lines below already syncs state.ctxWindow to
        // whatever context length actually got loaded, so nothing else needs
        // to change to keep the meter accurate.
        if (state.modelCtxOverride > 0) loadBody.context_length = state.modelCtxOverride;
        if (state.modelFlashAttn) loadBody.flash_attention = true;
        if (!state.modelKvOffload) loadBody.offload_kv_cache_to_gpu = false;
        if (state.modelNumExperts > 0) loadBody.num_experts = state.modelNumExperts;
        if (state.modelEvalBatch > 0) loadBody.eval_batch_size = state.modelEvalBatch;
      }
      // else: send nothing but the model id — LM Studio decides context length,
      // flash attention, KV offload, expert count, and eval batch size using
      // whatever its own per-model preset or last-used config was.

      const loadStart = performance.now();

      try {
        const res = await fetch(`${state.apiUrl}/api/v1/models/load`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(loadBody),
          signal: AbortSignal.timeout(300000)
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText);
          let parsed = '';
          try { parsed = JSON.parse(errText); parsed = parsed.error || parsed.message || errText; } catch { parsed = errText; }
          throw new Error(`HTTP ${res.status}: ${String(parsed).slice(0, 200)}`);
        }

        const data = await res.json();
        const loadTimeSec = data.load_time_seconds || ((performance.now() - loadStart) / 1000);

        // Step 3: Update activeInstance from load response
        activeInstance = {
          instance_id: data.instance_id || modelId,
          identifier: modelId,
          state: 'loaded',
          contextLength: data.load_config?.context_length || state.modelCtxOverride || 0,
        };

        // FIX: Sync state.ctxWindow to the actual context length LM Studio used.
        // LM Studio may clamp the requested value to the model's maximum or round it,
        // so the value we sent (state.modelCtxOverride or state.ctxWindow) may not
        // match what's actually loaded. Without this, the context meter, auto-compact
        // threshold, and iteration limits all operate against a stale/wrong number.
        const actualCtx = data.load_config?.context_length;
        if (actualCtx && actualCtx > 0 && actualCtx !== state.ctxWindow) {
          const was = state.ctxWindow;
          state.ctxWindow = actualCtx;
          document.getElementById('s-ctx-window').value = actualCtx;
          updateContextMeter();
          if (was !== actualCtx) {
            console.info(
              '[model] context window adjusted by LM Studio:',
              was, '→', actualCtx,
              '(model max may be lower than requested)'
            );
          }
        }

        dot.className = 'status-dot on';
        txt.textContent = 'LLM';

        // Build config summary for the meta badge
        const cfg = data.load_config || {};
        const cfgParts = [];
        if (cfg.context_length) cfgParts.push((cfg.context_length / 1000).toFixed(0) + 'k ctx');
        if (cfg.flash_attention === true) cfgParts.push('⚡flash');
        if (cfg.flash_attention === false) cfgParts.push('no-flash');
        if (cfg.offload_kv_cache_to_gpu === true) cfgParts.push('KV→GPU');
        if (cfg.offload_kv_cache_to_gpu === false) cfgParts.push('KV→RAM');
        if (cfg.num_experts) cfgParts.push(cfg.num_experts + 'exp');
        if (cfg.eval_batch_size) cfgParts.push('batch ' + cfg.eval_batch_size);
        const cfgStr = cfgParts.length ? cfgParts.join(' · ') : '';

        const timeStr = loadTimeSec < 1 ? (loadTimeSec * 1000).toFixed(0) + 'ms' : loadTimeSec.toFixed(1) + 's';
        meta.innerHTML = `<span style="color:var(--green)">✓ ${timeStr}</span>${cfgStr ? '<span style="color:var(--tx-4);margin-left:4px">[' + esc(cfgStr) + ']</span>' : ''}`;

        updateVisionUI();
        updateModelMeta();
        updateModelLoadBtn();
        updateSendBtn();

        showToast(`Loaded in ${timeStr}`, 'ok');

        // Rebuild dropdown to show ✓ LOADED on the now-active model
        try { await refreshModels(false); } catch { /* best effort */ }

        return true;

      } catch (e) {
        dot.className = 'status-dot off';
        txt.textContent = 'LLM';
        const isTimeout = e.message.includes('timed out') || e.message.includes('Timeout') || e.message.includes('AbortError');
        meta.innerHTML = `<span style="color:var(--red)">${isTimeout ? '⏰ Load timed out (5 min)' : '✗ Load failed'}</span>`;
        showToast(`Model load failed: ${e.message.slice(0, 80)}`, 'err');

        // Try to recover — see what LM Studio's actual state is now
        await fetchActiveModel();
        updateModelMeta();
        return false;
      }
    }

    function truncate(s, max) {
      return s.length > max ? s.slice(0, max - 2) + '..' : s;
    }

    async function manualModelRefresh() {
      const btn = document.getElementById('model-refresh-btn');
      btn.disabled = true;
      btn.querySelector('i').classList.add('fa-spin');
      try {
        await refreshModels(true);
        showToast('Model list refreshed', 'ok');
      } catch (e) {
        showToast('LM Studio unreachable: ' + e.message.slice(0, 60), 'err');
      } finally {
        btn.disabled = false;
        btn.querySelector('i').classList.remove('fa-spin');
      }
    }

    async function manualModelLoad() {
      if (!state.model || state.running) return;
      const btn = document.getElementById('model-load-btn');
      btn.disabled = true;
      await requestModelLoad(state.model);
      btn.disabled = false;
    }

    /* ═══════════════ SMART SCROLL ═══════════════ */
    function isNearBottom(el, threshold) { threshold = threshold || 100; return el.scrollHeight - el.scrollTop - el.clientHeight < threshold; }
    function isNearTop(el, threshold) { threshold = threshold || 100; return el.scrollTop < threshold; }

    let programmaticScroll = false;
    let scrollDebounce = null;

    let lastProgrammaticScroll = 0;
    function scrollBottom() {
      if (!state.autoScroll) return;
      lastProgrammaticScroll = Date.now();
      $msg().scrollTop = $msg().scrollHeight;
    }
    // In handler: if (Date.now() - lastProgrammaticScroll < 100) return;

    function scrollToBottomForce() {
      state.autoScroll = true; updateScrollLockBtn();
      programmaticScroll = true;
      $msg().scrollTop = $msg().scrollHeight;
      programmaticScroll = false;
      document.getElementById('scroll-bottom-btn').classList.remove('visible');
    }

    function scrollToTopForce() {
      // Scrolling away from the bottom on purpose implies the user wants to read
      // up, not have new output yank them back down — same as manual scrolling
      // already does via the scroll handler below, made explicit here since this
      // is a one-shot jump rather than a drag.
      state.autoScroll = false; updateScrollLockBtn();
      programmaticScroll = true;
      $msg().scrollTop = 0;
      programmaticScroll = false;
      document.getElementById('scroll-top-btn').classList.remove('visible');
    }

    function toggleAutoScroll() {
      state.autoScroll = !state.autoScroll; updateScrollLockBtn();
      if (state.autoScroll) scrollToBottomForce();
    }

    function updateScrollLockBtn() {
      const btn = document.getElementById('scroll-lock-btn');
      if (!btn) return;
      btn.className = 'scroll-lock-btn ' + (state.autoScroll ? 'following' : 'paused');
      btn.innerHTML = state.autoScroll
        ? '<i class="fas fa-arrow-down"></i><span>Following</span>'
        : '<i class="fas fa-pause"></i><span>Paused</span>';
    }

    function setupScrollDetection() {
      $msg().addEventListener('scroll', function () {
        const near = isNearBottom($msg(), 100);
        document.getElementById('scroll-bottom-btn').classList.toggle('visible', !near);
        // Only worth showing "scroll to top" once there's actually enough content
        // to scroll through — no point on a short conversation that already fits.
        const el = $msg();
        const hasEnoughContent = el.scrollHeight > el.clientHeight + 200;
        document.getElementById('scroll-top-btn').classList.toggle('visible', hasEnoughContent && !isNearTop(el, 100));
        if (near && !state.autoScroll) { state.autoScroll = true; updateScrollLockBtn(); }
        else if (!near && state.autoScroll) { state.autoScroll = false; updateScrollLockBtn(); }
        updatePlanScrollMarker();
      }, { passive: true });
      // Content can grow (streaming text, new messages) without a scroll event
      // firing — that's exactly when the plan panel's position changes, so
      // watch for it directly rather than relying on scroll events alone.
      const mo = new MutationObserver(() => updatePlanScrollMarker());
      mo.observe($msg(), { childList: true, subtree: false });
      window.addEventListener('resize', updatePlanScrollMarker, { passive: true });
    }

    /* ── Plan scroll marker: keeps a small bookmark on the right edge tracking
       where the inline Plan Mode panel sits along the scroll track, so it's
       easy to find again once later messages have pushed it out of view.
       Hidden entirely when the panel is already visible or doesn't exist. ── */
    function updatePlanScrollMarker() {
      const marker = document.getElementById('plan-scroll-marker');
      const panel = document.getElementById('plan-panel');
      const container = $msg();
      if (!marker) return;
      if (!panel || !container) { marker.classList.add('hidden'); return; }

      const viewTop = container.scrollTop;
      const viewBottom = viewTop + container.clientHeight;
      const panelTop = panel.offsetTop;
      const panelBottom = panelTop + panel.offsetHeight;
      const isVisible = panelBottom > viewTop && panelTop < viewBottom;

      if (isVisible) { marker.classList.add('hidden'); return; }

      const rect = container.getBoundingClientRect();
      const scrollable = Math.max(1, container.scrollHeight - container.clientHeight);
      const frac = Math.min(1, Math.max(0, panelTop / scrollable));
      const markerSize = 22;
      const top = rect.top + frac * Math.max(0, rect.height - markerSize);

      marker.classList.remove('hidden');
      marker.style.top = top + 'px';
      const above = panelBottom <= viewTop;
      marker.innerHTML = `<i class="fas fa-chevron-${above ? 'up' : 'down'}"></i>`;
      marker.title = `Jump to plan (${above ? 'scrolled above' : 'scrolled below'})`;
    }

    function jumpToPlan() {
      const panel = document.getElementById('plan-panel');
      if (!panel) return;
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(updatePlanScrollMarker, 350);
    }

    /* ═══════════════════════════════════════════════════════════
       TOKEN COMPRESSION PIPELINE
       All tool outputs pass through compressToolOutput() before
       being pushed to state.messages. Each compressor targets a
       specific output format and is skipped if not applicable.
       ═══════════════════════════════════════════════════════════ */

    const _TOKEN_BUDGET = {
      maxOutputChars: 40000,    // hard cap per tool result (~10k tokens)
      searchSnippet: 300,       // chars per search result snippet
      fetchMaxChars: 60000,     // max fetch_url content fed to model
    };

    /**
     * Strip HTML boilerplate from fetch_url content.
     * Removes: <script>, <style>, <nav>, <header>, <footer>, <aside>,
     * inline attrs, and collapses whitespace.
     * Preserves the actual page text content.
     */
    function _stripHtml(text) {
      if (!text || !text.includes('<')) return text;

      // 1. Remove full block elements
      text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
      text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
      text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
      text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
      text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');
      text = text.replace(/<!--[\s\S]*?-->/g, '');

      // 2. List items with bullets before generic block handling
      text = text.replace(/<li[^>]*>/gi, '\n• ');

      // 3. Block-level tags → newlines
      text = text.replace(/<\/?(p|div|br|h[1-6]|ul|ol|tr|td|th|table|blockquote|hr|section|article|main|figure|figcaption|details|summary)[^>]*>/gi, '\n');

      // 4. Strip all remaining tags
      text = text.replace(/<[^>]+>/g, '');

      // 5. Decode HTML entities
      text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));

      // 6. Normalise whitespace
      text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

      // 7. Collapse whitespace — preserve paragraph breaks
      text = text.replace(/[ \t]+/g, ' ');
      text = text.replace(/\n[ \t]+/g, '\n');
      text = text.replace(/\n{3,}/g, '\n\n');

      return text.trim();
    }

    function _compressSearchOutput(text) {
      if (!text.startsWith('Search:')) return text;
      // Extract header line
      const lines = text.split('\n');
      const header = lines[0]; // "Search: "..." / Found N results"
      const budget = _TOKEN_BUDGET.searchSnippet;
      // Re-parse the result blocks
      const blocks = text.split(/\n(?=\d+\. )/);
      const headerBlock = blocks.shift() || header;
      // TOON header — defined once
      const toon = [
        headerBlock.trim(),
        '# TOON format: num|title|url|snippet',
        ...blocks.map(b => {
          const numM = b.match(/^(\d+)\.\s+(.+)/);
          const urlM = b.match(/^\s+(https?:\/\/\S+)/m);
          const snipM = b.match(/^\s{3}(?!https?:\/\/)(.+)/m);
          const num = numM ? numM[1] : '?';
          const title = numM ? numM[2].trim().slice(0, 100) : '?';
          const url = urlM ? urlM[1].trim() : '';
          const snip = snipM ? snipM[1].trim().slice(0, budget) : '';
          // Inline fetched content if present
          const fetchM = b.match(/--- Fetched content \([\d,]+ chars\) ---\n([\s\S]+?)(?:\n\s*\.\.\.|$)/);
          const fetched = fetchM ? '\n  [fetched] ' + _stripHtml(fetchM[1]).slice(0, 3000).replace(/\n/g, '\n  ') : '';
          return `${num}|${title}|${url}|${snip}${fetched}`;
        })
      ];
      return toon.join('\n');
    }

    /**
     * Convert list_directory output to TOON format.
     * Before: "FILE src/app.js\nDIR src/components\n..."
     * After:  "# TOON type|path[|tag]\nF|src/app.js\nD|src/components\n..."
     * Saves ~25% of tokens on large directory listings.
     */
    function _compressDirectoryOutput(text) {
      if (!text.includes('FILE ') && !text.includes('DIR ')) return text;
      const lines = text.split('\n');
      const toon = ['# TOON type|path[|tag]'];
      let footer = '';
      for (const line of lines) {
        if (line.startsWith('FILE ') || line.startsWith('DIR ')) {
          const isDir = line.startsWith('DIR ');
          const rest = isDir ? line.slice(4) : line.slice(5); // strip "FILE " or "DIR  "
          const tagM = rest.match(/^(.+?)(\s+\[(IMAGE|PDF)\])?$/);
          const path = tagM ? tagM[1] : rest;
          const tag = tagM && tagM[2] ? '|' + tagM[3] : '';
          toon.push((isDir ? 'D' : 'F') + '|' + path + tag);
        } else if (line.startsWith('[')) {
          footer = line; // keep the "N entries skipped" note
        }
      }
      if (footer) toon.push(footer);
      // Only use TOON if it's actually shorter
      const toonStr = toon.join('\n');
      return toonStr.length < text.length ? toonStr : text;
    }

    /**
     * Hard-cap any tool output that's too large.
     * Keeps head + tail so structural info is preserved.
     */
    function _capOutputSize(text, toolName) {
      const max = _TOKEN_BUDGET.maxOutputChars;
      if (text.length <= max) return text;
      const head = Math.floor(max * 0.6);
      const tail = max - head;
      const truncMsg = `\n\n[... TRUNCATED: output was ${text.length} chars, showing first ${head} + last ${tail}. Use read_file_lines or grep to read specific sections. ...]\n\n`;
      return text.slice(0, head) + truncMsg + text.slice(-tail);
    }

    /** Creates an isolated stats object for tracking compression */
    /** Master pipeline — call before pushing any tool result to state.messages */
    function compressToolOutput(toolName, outText, stats) {
      if (!outText || typeof outText !== 'string') return outText;
      let t = outText;

      // Per-tool compressors
      if (toolName === 'web_search') t = _compressSearchOutput(t);
      else if (toolName === 'list_directory') t = _compressDirectoryOutput(t);
      else if (toolName === 'fetch_url') {
        const sepIdx = t.indexOf('\n---\n');
        if (sepIdx !== -1) {
          const header = t.slice(0, sepIdx + 5);
          const body = _stripHtml(t.slice(sepIdx + 5));
          t = header + body.slice(0, _TOKEN_BUDGET.fetchMaxChars) +
            (body.length > _TOKEN_BUDGET.fetchMaxChars ? '\n\n[... fetch content truncated ...]' : '');
        }
      }

      // Universal size cap
      t = _capOutputSize(t, toolName);

      // Track savings in the provided stats object
      if (stats) {
        stats.original += outText.length;
        stats.compressed += t.length;
      }

      return t;
    }

    function getCompressionStats(stats) {
      if (!stats || stats.original === 0) return null;
      const saved = stats.original - stats.compressed;
      const pct = Math.round(saved / stats.original * 100);
      return { saved, pct, original: stats.original, compressed: stats.compressed };
    }

    /* ══════════════════════════════════════════════════════════= */

    function getProgressFile(convId) {
      return `.sloplobster-progress-${convId || 'default'}.md`;
    }

    /* ═══════════════ PROJECT MEMORY (cross-session, per-workspace) ═══════════════
       Distinct from the progress file: the progress file is scoped to recovering
       ONE conversation after compaction and is hidden from read/edit/listing.
       Project memory is a small, durable, human-reviewable file the agent can add
       to via the save_memory tool, loaded into every new conversation's system
       prompt for as long as the same workspace folder is open. Deliberately NOT
       filtered by isSkippedPath — the user should be able to see and edit it. */
    function getProjectMemoryFile() {
      return '.sloplobster-memory.md';
    }

    async function loadProjectMemory() {
      state.projectMemoryText = '';
      if (!state.dirHandle) return;
      try {
        const res = await readFileSafe(getProjectMemoryFile());
        if (res && typeof res.output === 'string' && !/^File ".*" not found/i.test(res.output) && !res.output.startsWith('Error')) {
          state.projectMemoryText = res.output.trim().slice(0, 8000);
        }
      } catch { /* no memory file yet — fine */ }
      state._sysPromptCacheText = null; // force rebuild so the section picks up new content
    }

    async function appendProjectMemory(note) {
      requireWorkspace();
      const file = getProjectMemoryFile();
      const existing = state.projectMemoryText || '';
      const stamp = new Date().toISOString().slice(0, 10);
      const entry = `- [${stamp}] ${String(note).trim()}`;
      const updated = (existing ? existing + '\n' : '# Project Memory\n\nDurable notes carried across conversations in this workspace.\n\n') + entry;
      await writeFileSafe(file, updated, false);
      state.projectMemoryText = updated.trim().slice(0, 8000);
      state._sysPromptCacheText = null;
      return updated;
    }

    function safeParseArgs(argsStr) {
      if (!argsStr || typeof argsStr !== 'string' || !argsStr.trim()) return { _parseError: 'empty arguments' };
      const parsed = repairAndParseJson(argsStr);
      if (parsed.success) return parsed.data;

      const trimmed = argsStr.trim();
      const opens  = (trimmed.match(/\{/g) || []).length;
      const closes = (trimmed.match(/\}/g) || []).length;
      const bracketOpens  = (trimmed.match(/\[/g) || []).length;
      const bracketCloses = (trimmed.match(/\]/g) || []).length;
      const isTruncated = opens > closes || bracketOpens > bracketCloses;

      const rescued = {};
      for (const m of trimmed.matchAll(/"(path|model|type|command|query|task)":\s*"((?:[^"\\]|\\.)*)"/g)) {
        rescued[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      if (Object.keys(rescued).length) {
        return {
          ...rescued,
          _parseError: isTruncated
            ? 'truncated JSON — arguments were cut off mid-stream.'
            : 'malformed JSON — ' + (parsed.error || 'could not parse arguments')
        };
      }

      if (isTruncated) {
        return { _parseError: 'truncated JSON — arguments were cut off mid-stream. The file content was likely too large for a single tool call. Split into smaller writes or use edit_file instead.' };
      }
      return { _parseError: 'malformed JSON — ' + (parsed.error || 'could not parse arguments') };
    }

    function findParentToolCall(toolMsgOrIndex) {
      const idx = typeof toolMsgOrIndex === 'number'
        ? toolMsgOrIndex
        : state.messages.indexOf(toolMsgOrIndex);
      if (idx < 0) return null;

      for (let i = idx - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m.role !== 'assistant' || !m.tool_calls) continue;
        const tc = m.tool_calls.find(tc => tc.id === state.messages[idx].tool_call_id);
        if (tc) return tc;
      }
      return null;
    }

    function buildProgressSummary(reason) {
      const lines = ['# SlopLobster Progress', '> ' + new Date().toLocaleString() + ' — ' + reason, ''];
      const firstUser = state.messages.find(m => m.role === 'user' && m.content);
      if (firstUser) lines.push('## Task', '', '> ' + firstUser.content.split('\n')[0], '');

      const tcMap = new Map();
      for (const m of state.messages) {
        if (m.tool_calls) m.tool_calls.forEach(tc => tcMap.set(tc.id, tc));
      }

      const actions = [], diffs = [], errors = [];
      for (const m of state.messages) {
        if (m.role !== 'tool') continue;
        const tc = tcMap.get(m.tool_call_id);
        if (!tc) continue;
        const name = tc.function.name, args = safeParseArgs(tc.function.arguments);

        if (name === 'edit_file') {
          const ok = !m.content.includes('ERROR');
          actions.push('- `edit_file` `' + (args.path || '?') + '`: ' + (ok ? '✓' : '✗') + ' ' + m.content.split('\n')[0]);
          if (m._diff && !diffs.find(d => d.path === m._diff.path)) diffs.push(m._diff);
        } else if (name === 'write_file') {
          actions.push('- `write_file` `' + (args.path || '?') + '`: ' + (m.content.includes('Created') ? 'created' : 'wrote') + ' (' + (args.content || '').length + ' chars)');
          if (m._diff && !diffs.find(d => d.path === m._diff.path)) diffs.push(m._diff);
        } else if (name === 'execute_command') {
          const cmd = (args.command || '').slice(0, 100);
          const failed = m.content.includes('[exit code:');
          if (failed) { errors.push({ cmd, out: m.content.slice(0, 200) }); actions.push('- `exec` `' + cmd + '`: ✗'); }
          else actions.push('- `exec` `' + cmd + '`: ✓ ' + m.content.split('\n')[0].slice(0, 60));
        } else if (name === 'web_search') {
          actions.push('- `search` `' + (args.query || '') + '`');
        } else if (name === 'delete_file') {
          actions.push('- `delete_file` `' + (args.path || '') + '`');
        } else if (name === 'move_file') {
          actions.push('- `move_file` `' + (args.source || '') + '` → `' + (args.destination || '') + '`');

        } else if (name === 'read_file') {
          const ok = !m.content.includes('Error');
          if (m._imageDataUrl) {
            actions.push('- `read_file` `' + (args.path || '?') + '`: viewed as image ✓');
          } else {
            actions.push('- `read_file` `' + (args.path || '?') + '`: ' + (ok ? '✓' : '✗'));
          }
        } else if (name === 'screenshot') {
          actions.push('- `screenshot`: captured (' + (args.reason || 'agent requested') + ')');
        }
      }

      if (actions.length) { lines.push('## Actions', '', ...actions.slice(-30), ''); }

      if (diffs.length) {
        lines.push('## Changes');
        for (const diff of diffs.slice(-8)) {
          lines.push('', '### ' + diff.path, '');
          const changed = diff.lines.filter(l => l.type !== 'ctx').slice(0, 50);
          for (const l of changed) lines.push(l.text);
          const total = diff.lines.filter(l => l.type !== 'ctx').length;
          if (total > 50) lines.push('  ... (' + (total - 50) + ' more changed lines)');
          lines.push('');
        }
      }

      if (errors.length) {
        lines.push('## Errors', '');
        for (const e of errors.slice(-5)) lines.push('- `' + e.cmd + '` — ' + (e.out.split('\n').find(l => l.trim()) || ''));
        lines.push('');
      }

      const lastAsst = [...state.messages].reverse().find(m => m.role === 'assistant' && m.content && m.content.length > 20);
      if (lastAsst) lines.push('## State', '', lastAsst.content.slice(-500), '');

      lines.push('---', '_Delete this file when the task is complete._');
      const r = lines.join('\n');
      return r.length > 8000 ? r.slice(0, 8000) + '\n\n... (truncated)' : r;
    }

    async function saveProgressToWorkspace(reason) {
      if (!state.dirHandle) return false;
      try { await writeFileSafe(getProgressFile(), buildProgressSummary(reason)); return true; }
      catch (e) { console.warn('[progress] save failed:', e.message); return false; }
    }

    async function progressCompact(progressSaved) {
      await recordRunEvent('compaction.started', { operationId: 'compact:' + state.runController?.snapshot().iterations, progressSaved });
      const previousMessages = state.messages;
      state.taskState = HarnessRuntime.captureTaskState(state);
      await dbSet('agent_states', { id: 'task:' + state.activeConvId, taskState: state.taskState, messages: previousMessages, timestamp: Date.now() });
      const compactModel = (state.memoryAgentModel && state.memoryAgentModel.trim()) || state.model;
      const usingOverrideModel = compactModel !== state.model;
      appendMsg('system', (progressSaved
        ? 'Memory agent compacting context... Progress saved to `' + getProgressFile() + '`'
        : 'Memory agent compacting context...') + (usingOverrideModel ? ' (using ' + compactModel + ')' : ''));

      const sysPrompt = 'Summarize this conversation for another instance of yourself to continue the work. Preserve, in this priority order:\n' +
        '1. Environment/tooling corrections discovered (e.g. "use X not Y here", a command that only works one specific way, a version quirk, a path convention). These are the easiest things to lose and the most expensive to rediscover — call them out explicitly, even a one-line one, never fold them into a generic "errors and resolutions" bucket.\n' +
        '2. The core task and current state (what\'s done, what\'s left).\n' +
        '3. Key decisions and their reasoning.\n' +
        '4. Files modified, with a brief description of each change.\n' +
        '5. Other errors and their resolutions.\n' +
        (state.projectMemoryText ? '\nNote: the facts below are ALREADY saved to durable project memory and will be shown to the continuing instance separately — do not spend summary budget repeating them verbatim, only reference them if directly relevant to current state:\n' + state.projectMemoryText.slice(0, 1500) + '\n' : '') +
        '\nBe concise — under 600 tokens total.';
      const convText = state.messages.map(m => {
        let text = '';
        if (m._images?.length) {
          text += `\n[${m._images.length} image(s) were attached and analyzed]\n`;
        }
        if (m.role === 'user') return text + '[User]: ' + (m.content || '');
        if (m.role === 'assistant') {
          let t = text + '[Agent]: ' + (m.content || '');
          if (m.tool_calls) {
            t += '\n[Tools Called]: ' + m.tool_calls.map(tc => {
              const args = safeParseArgs(tc.function.arguments);
              return tc.function.name + '(' + Object.entries(args).map(([k, v]) => k + '=' + String(v).slice(0, 60)).join(', ') + ')';
            }).join(', ');
          }
          return t;
        }
        if (m.role === 'tool') return text + '[Tool Result]: ' + m.content.slice(0, 150) + '...';
        return '';
      }).filter(Boolean).join('\n');

      try {
        if (!state.running) state.abortCtrl = new AbortController();
        const data = await requestModelJSON({ model: compactModel, messages: [
          { role: 'system', content: sysPrompt }, { role: 'user', content: convText }
        ], temperature: 0.1, max_tokens: 2000 }, state.abortCtrl.signal);
        const summary = data.choices?.[0]?.message?.content;
        const nextMessages = HarnessRuntime.compactMessages(state.taskState, summary, progressSaved ? getProgressFile() : null);
        const before = estimateConvTokens();

        await recordRunEvent('compaction.completed', { operationId: 'compact:' + state.runController?.snapshot().iterations, summary });
        state.messages = nextMessages;
        _totalOriginalChars = 0; _totalCompressedChars = 0;

        const after = estimateConvTokens();
        const parent = $msg(); while (parent.firstChild) parent.firstChild.remove(); streamEl = null; switchToChat();
        showCompactBanner(before, after);
        if (progressSaved) {
          const el = document.createElement('div'); el.className = 'compact-banner';
          el.style.background = 'rgba(34,211,238,.06)';
          el.style.borderColor = 'rgba(34,211,238,.15)';
          el.style.color = 'var(--cyan)';
          el.innerHTML = '<i class="fas fa-file-lines"></i><span>Progress saved to <code style="font-family:JetBrains Mono,monospace;font-size:11px;background:var(--bg-3);padding:1px 4px;border-radius:3px">' + getProgressFile() + '</code> — agent reads it for full context after compact</span>';
          $msg().appendChild(el);
        }
        if (state.currentPlan && state.currentPlan.steps.length) {
          renderPlanPanel(state.currentPlan.steps);
          state.currentPlan.steps.forEach((s, i) => {
            if (s.status !== 'pending') updatePlanStep(i, s.status);
          });
          updatePlanProgress();
        }
        updateContextMeter(); saveCurrentConv();
      } catch (e) {
        state.messages = previousMessages;
        state.running = false;
        await recordRunEvent('compaction.failed', { operationId: 'compact:' + state.runController?.snapshot().iterations, error: e.message }).catch(() => {});
        appendMsg('system', 'Compaction failed (' + e.message + '). Full conversation preserved; task paused. Retry compaction or change memory model settings before resuming.');
        updateContextMeter(); saveCurrentConv();
      }
    }

    /* ═══════════════ AGENT LOOP ═══════════════ */
    let agentStopwatch = null;

    /** Creates an isolated stats object for tracking compression */
    function createCompressionStats() {
      return { original: 0, compressed: 0 };
    }

    /* ── Show completion summary when agent finishes ── */
    function showCompletionSummary() {
      const out = tokenTracker.totalOutputTokens;
      if (out < 10) return;
      const elapsed = agentStopwatch ? ((performance.now() - agentStopwatch) / 1000) : null;
      const timeStr = elapsed ? (elapsed < 60 ? elapsed.toFixed(1) + 's' : (elapsed / 60).toFixed(1) + 'min') : '';
      const parts = [formatTok(out) + ' out' + ' (est)'];
      if (timeStr) parts.push(timeStr);
      const el = document.createElement('div');
      el.className = 'compact-banner';
      el.style.background = 'rgba(34,211,238,.06)';
      el.style.borderColor = 'rgba(34,211,238,.15)';
      el.style.color = 'var(--cyan)';
      const estimateLabel = '';
      el.innerHTML = '<i class="fas fa-chart-bar" style="font-size:11px"></i><span>' + parts.join(' · ') + estimateLabel + '</span>';
      $msg().appendChild(el);
      scrollBottom();
    }


    /* ═══════════════ LIVE THINK BLOCK ═══════════════ */
    function createLiveThinkBlock() {
      const el = document.createElement('div'); el.className = 'think-block';
      el.innerHTML = `<div class="think-hdr" onclick="toggleThinkContent(this)"><i class="fas fa-chevron-down think-chevron collapsed"></i><div class="think-label"><i class="fas fa-brain think-icon"></i> Thinking</div><span class="think-badge streaming">streaming</span><button class="think-stop-btn" title="Stop generation" onclick="event.stopPropagation(); handleSend();" style="margin-left:auto;background:none;border:none;color:var(--tx-4);cursor:pointer;padding:2px 6px;font-size:11px" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--tx-4)'"><i class="fas fa-stop"></i></button></div><div class="think-content collapsed streaming-cursor"></div>`;
      el._collapsed = true; return el;
    }
    function updateLiveThinkBlock(el, text) {
      // Coalesce to one DOM write per animation frame instead of writing +
      // reflowing on every single SSE delta. During a long reasoning phase
      // a model can emit hundreds of small token deltas per second; without
      // this, each one did a synchronous textContent write immediately
      // followed by a synchronous scrollBottom() (which forces a layout
      // read via scrollHeight) — classic write/read layout-thrashing. That
      // floods the main thread badly enough that the panel visibly stops
      // updating for stretches, even though the fetch stream underneath
      // (and the backend generating it) is still running fine; it just
      // looks like it "stopped in the middle."
      el._text = text;
      if (el._rAF) return;
      el._rAF = requestAnimationFrame(() => {
        el._rAF = null;
        if (!el.isConnected) return;
        const content = el.querySelector('.think-content');
        content.textContent = el._text;
        if (!el._collapsed) content.scrollTop = content.scrollHeight;
        scrollBottom();
      });
    }
    function finalizeLiveThinkBlock(el) {
      if (el._rAF) { cancelAnimationFrame(el._rAF); el._rAF = null; }
      const content = el.querySelector('.think-content'); const badge = el.querySelector('.think-badge');
      content.textContent = el._text ?? content.textContent; // flush any pending frame's text first
      content.classList.remove('streaming-cursor');
      const charCount = content.textContent.length;
      const shortCount = charCount > 1000 ? (charCount / 1000).toFixed(1) + 'k' : charCount;
      badge.className = 'think-badge done'; badge.textContent = 'done';
      const lenBadge = document.createElement('span'); lenBadge.className = 'think-badge len'; lenBadge.textContent = shortCount + ' chars';
      badge.parentNode.insertBefore(lenBadge, badge.nextSibling);
      el.querySelector('.think-stop-btn')?.remove();
      el._finalText = content.textContent;
    }
    function renderStaticThinkBlock(text) {
      const el = document.createElement('div'); el.className = 'think-block';
      const charCount = text.length; const shortCount = charCount > 1000 ? (charCount / 1000).toFixed(1) + 'k' : charCount;
      el.innerHTML = `<div class="think-hdr" onclick="toggleThinkContent(this)"><i class="fas fa-chevron-down think-chevron collapsed"></i><div class="think-label"><i class="fas fa-brain think-icon"></i> Thinking</div><span class="think-badge done">done</span><span class="think-badge len">${shortCount} chars</span></div><div class="think-content collapsed">${esc(text)}</div>`;
      el._collapsed = true; $msg().appendChild(el);
    }

    function toggleThinkContent(hdrEl) {
      const block = hdrEl.closest('.think-block'); const content = block.querySelector('.think-content'); const chevron = block.querySelector('.think-chevron');
      block._collapsed = !block._collapsed;
      content.classList.toggle('collapsed', block._collapsed);
      chevron.classList.toggle('collapsed', block._collapsed);
    }

    function toggleSvgView(btn) {
      const preview = btn.closest('.svg-preview');
      const imgEl = preview.querySelector('.svg-preview-img');
      const codeEl = preview.querySelector('.svg-code-view');
      if (!imgEl || !codeEl) return;
      const showingCode = codeEl.style.display !== 'none';
      if (showingCode) {
        codeEl.style.display = 'none';
        imgEl.style.display = 'block';
        btn.textContent = 'View Code';
        btn.classList.remove('active');
      } else {
        imgEl.style.display = 'none';
        codeEl.style.display = 'block';
        btn.textContent = 'View Image';
        btn.classList.add('active');
        const codeBlock = codeEl.querySelector('code');
        if (codeBlock && !codeBlock.dataset.hljs) { hljs.highlightElement(codeBlock); codeBlock.dataset.hljs = '1'; }
      }
    }

    function renderHtmlFilePreview(f) {
      const emptyEl = document.getElementById('rp-files-empty');
      const previewEl = document.getElementById('rp-file-preview');

      const MAX_PREVIEW_SIZE = 500 * 1024; // 500KB

      // Guard: f.content and f.lines must be valid strings/arrays
      if (!f || typeof f.content !== 'string') {
        previewEl.innerHTML = `<div class="rp-empty-state"><i class="fas fa-exclamation-triangle" style="color:var(--red)"></i><span>Could not read file content</span></div>`;
        emptyEl.style.display = 'none';
        previewEl.style.display = 'block';
        return;
      }
      if (!Array.isArray(f.lines)) f.lines = f.content.split('\n');

      // ── Skip preview for oversized files ──
      if (f.content.length > MAX_PREVIEW_SIZE) {
        const sizeKB = Math.round(f.content.length / 1024);
        const linesHtml = f.lines.map((line, i) => {
          let highlighted;
          try { highlighted = hljs.highlight(line, { language: 'html' }).value; }
          catch { highlighted = esc(line); }
          return '<div class="rp-file-line">' +
            '<span class="rp-file-line-num" data-line="' + (i + 1) + '">' + (i + 1) + '</span>' +
            '<span class="rp-file-line-text">' + highlighted + '</span></div>';
        }).join('');

        previewEl.innerHTML =
          '<div class="rp-file-header">' +
            '<span class="rp-file-name"><i class="fas fa-globe" style="color:var(--accent);margin-right:4px"></i>' + esc(f.path) + '</span>' +
            '<span class="rp-file-meta">' + f.lines.length + ' lines · ' + sizeKB + ' KB</span>' +
            '<div class="rp-file-actions">' +
              '<button class="rp-file-act" onclick="rpCopyFile()" title="Copy source"><i class="fas fa-copy"></i></button>' +
            '</div>' +
          '</div>' +
          '<div class="html-preview-size-warn"><i class="fas fa-triangle-exclamation"></i> Large file (' + sizeKB + ' KB) — showing code only. Rendered preview unavailable for files over 500 KB.</div>' +
          '<div id="html-code-view">' +
          '<div class="rp-file-code">' + linesHtml + '</div>' +
          '</div>' +
          (f.truncated ? '<div class="rp-file-truncated">File was truncated — preview may be incomplete</div>' : '');

        emptyEl.style.display = 'none';
        previewEl.style.display = 'block';
        return;
      }

      // ── Skip preview for files with relative resource references ──
      const hasRelativeRefs = /(?:src|href)\s*=\s*["'](?:\.\/|\.\.\/)/.test(f.content);
      if (hasRelativeRefs) {
        const linesHtml = f.lines.map((line, i) => {
          let highlighted;
          try { highlighted = hljs.highlight(line, { language: 'html' }).value; }
          catch { highlighted = esc(line); }
          return '<div class="rp-file-line">' +
            '<span class="rp-file-line-num" data-line="' + (i + 1) + '">' + (i + 1) + '</span>' +
            '<span class="rp-file-line-text">' + highlighted + '</span></div>';
        }).join('');

        previewEl.innerHTML =
          '<div class="rp-file-header">' +
            '<span class="rp-file-name"><i class="fas fa-globe" style="color:var(--accent);margin-right:4px"></i>' + esc(f.path) + '</span>' +
            '<span class="rp-file-meta">' + f.lines.length + ' lines · ' + Math.round(f.content.length / 1024) + ' KB</span>' +
            '<div class="rp-file-actions">' +
              '<button class="rp-file-act" onclick="rpCopyFile()" title="Copy source"><i class="fas fa-copy"></i></button>' +
            '</div>' +
          '</div>' +
          '<div class="html-preview-size-warn"><i class="fas fa-triangle-exclamation"></i> Preview unavailable — HTML references local resources (<code>src=</code>, <code>href=</code> with relative paths) that cannot be resolved in file-system preview. Use the dev server for full rendering.</div>' +
          '<div id="html-code-view">' +
          '<div class="rp-file-code">' + linesHtml + '</div>' +
          '</div>' +
          (f.truncated ? '<div class="rp-file-truncated">File was truncated — preview may be incomplete</div>' : '');

        emptyEl.style.display = 'none';
        previewEl.style.display = 'block';
        return;
      }

      // ── Normal case: standalone HTML — use Blob URL for better compatibility ──
      const linesHtml = f.lines.map((line, i) => {
        let highlighted;
        try { highlighted = hljs.highlight(line, { language: 'html' }).value; }
        catch { highlighted = esc(line); }
        return '<div class="rp-file-line">' +
          '<span class="rp-file-line-num" data-line="' + (i + 1) + '">' + (i + 1) + '</span>' +
          '<span class="rp-file-line-text">' + highlighted + '</span></div>';
      }).join('');

      const sizeKB = Math.round(f.content.length / 1024);

      previewEl.innerHTML =
        '<div class="rp-file-header">' +
          '<span class="rp-file-name"><i class="fas fa-globe" style="color:var(--accent);margin-right:4px"></i>' + esc(f.path) + '</span>' +
          '<span class="rp-file-meta">' + f.lines.length + ' lines · ' + sizeKB + ' KB</span>' +
          '<div class="rp-file-actions">' +
            '<button class="rp-file-act html-toggle-btn active" id="html-toggle-btn" onclick="toggleHtmlPreview()" title="Switch between code and rendered preview"><i class="fas fa-code"></i> Code</button>' +
            '<button class="rp-file-act" id="html-refresh-btn" onclick="refreshHtmlPreview()" title="Refresh preview" style="display:none"><i class="fas fa-rotate"></i></button>' +
            '<button class="rp-file-act" onclick="rpCopyFile()" title="Copy source"><i class="fas fa-copy"></i></button>' +
          '</div>' +
        '</div>' +
        '<div class="html-preview-bar" id="html-preview-bar" style="display:flex">' +
          '<span style="font-size:9px;color:var(--tx-4);font-family:JetBrains Mono,monospace;margin-right:auto">Viewport:</span>' +
          '<button class="device-btn active" data-width="100%" onclick="setHtmlPreviewWidth(this, \'100%\')"><i class="fas fa-desktop" style="font-size:9px"></i> Desktop</button>' +
          '<button class="device-btn" data-width="768px" onclick="setHtmlPreviewWidth(this, \'768px\')"><i class="fas fa-tablet-screen-button" style="font-size:9px"></i> Tablet</button>' +
          '<button class="device-btn" data-width="375px" onclick="setHtmlPreviewWidth(this, \'375px\')"><i class="fas fa-mobile-screen-button" style="font-size:9px"></i> Mobile</button>' +
        '</div>' +
        '<div id="html-preview-view">' +
          '<div class="html-preview-iframe-wrap" id="html-iframe-wrap">' +
            '<iframe id="html-preview-iframe" sandbox="allow-scripts allow-modals allow-forms allow-popups allow-top-navigation" style="width:100%;height:100%;border:none;background:white;"></iframe>' +
          '</div>' +
        '</div>' +
        '<div id="html-code-view" style="display:none">' +
          '<div class="rp-file-code">' + linesHtml + '</div>' +
        '</div>' +
        (f.truncated ? '<div class="rp-file-truncated">File was truncated — preview may be incomplete</div>' : '');

      emptyEl.style.display = 'none';
      previewEl.style.display = 'block';

      // ── Set iframe content via Blob URL (not srcdoc) ──
      requestAnimationFrame(() => {
        const iframe = document.getElementById('html-preview-iframe');
        if (iframe) {
          try {
            if (_prevHtmlPreviewUrl) URL.revokeObjectURL(_prevHtmlPreviewUrl);
            const blob = new Blob([f.content], { type: 'text/html; charset=utf-8' });
            const url = URL.createObjectURL(blob);
            _prevHtmlPreviewUrl = url;
            iframe.src = url;
          } catch(e) {
            console.warn('[preview] blob URL failed, falling back to srcdoc:', e.message);
            iframe.srcdoc = f.content;
          }
        }
      });
    }

    let _htmlPreviewWidth = null;
    function setHtmlPreviewWidth(btn, width) {
      const wrap = document.getElementById('html-iframe-wrap');
      if (!wrap) return;
      _htmlPreviewWidth = width;
      const iframe = document.getElementById('html-preview-iframe');
      if (iframe) iframe.style.maxWidth = width === '100%' ? 'none' : width;
      wrap.style.maxWidth = width === '100%' ? 'none' : width;
      wrap.style.margin = width === '100%' ? '0' : '0 auto';

      document.querySelectorAll('.html-preview-bar .device-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }

    function toggleHtmlPreview() {
      const previewView = document.getElementById('html-preview-view');
      const codeView = document.getElementById('html-code-view');
      const toggleBtn = document.getElementById('html-toggle-btn');
      const refreshBtn = document.getElementById('html-refresh-btn');
      const bar = document.getElementById('html-preview-bar');

      if (!previewView || !codeView) return;

      const showingPreview = previewView.style.display !== 'none';

      if (showingPreview) {
        previewView.style.display = 'none';
        codeView.style.display = 'block';
        bar.style.display = 'none';
        toggleBtn.innerHTML = '<i class="fas fa-eye"></i> Preview';
        toggleBtn.classList.remove('active');
        refreshBtn.style.display = 'none';
      } else {
        codeView.style.display = 'none';
        previewView.style.display = 'block';
        bar.style.display = 'flex';
        toggleBtn.innerHTML = '<i class="fas fa-code"></i> Code';
        toggleBtn.classList.add('active');
        refreshBtn.style.display = '';
        refreshHtmlPreview();
      }
    }

    function refreshHtmlPreview() {
      const iframe = document.getElementById('html-preview-iframe');
      const f = rpState.activeFile;
      if (!iframe || !f || !f.isHtml) return;
      /* Use Blob URL for consistent sandboxing (matches renderHtmlFilePreview) */
      try {
        if (_prevHtmlPreviewUrl) URL.revokeObjectURL(_prevHtmlPreviewUrl);
        const blob = new Blob([f.content], { type: 'text/html; charset=utf-8' });
        const url = URL.createObjectURL(blob);
        _prevHtmlPreviewUrl = url;
        iframe.src = url;
      } catch(e) {
        iframe.srcdoc = '';
        requestAnimationFrame(() => { iframe.srcdoc = f.content; });
      }
    }

    /* ═══════════════ UI RENDERING ═══════════════ */
    const $msg = () => document.getElementById('messages');
    function switchToChat() { document.getElementById('welcome').style.display = 'none'; $msg().style.display = 'flex'; }
    function timestamp() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

    function showThinking() { switchToChat(); const el = document.createElement('div'); el.className = 'thinking-indicator'; el.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div> Thinking...'; $msg().appendChild(el); scrollBottom(); return el; }
    function showParallelBadge(n) { const el = document.createElement('div'); el.className = 'thinking-indicator'; el.innerHTML = `<span class="tool-parallel-badge"><i class="fas fa-bolt"></i> ${n} tools in parallel</span>`; $msg().appendChild(el); setTimeout(() => el.remove(), 1500); scrollBottom(); }

    let _sessionTotalOut = Number(sessionStorage.getItem('SlopLobster_sessionOutput')) || 0;

    function _updateSessionTok(outTok) {
      if (!outTok) return;
      _sessionTotalOut += outTok;
      try { sessionStorage.setItem('SlopLobster_sessionOutput', String(_sessionTotalOut)); } catch { }
      const el = document.getElementById('session-tok-total');
      if (el) {
        el.style.display = '';
        el.textContent = formatTok(_sessionTotalOut) + ' session';
        el.title = `Total output tokens generated this session: ${_sessionTotalOut.toLocaleString()}`;
      }
    }

    let streamEl = null;
    let _streamStartTime = null;
    let _streamTokenCount = 0;
    let _streamTimerEl = null;
    let _streamTimerInterval = null;

    function _startStreamTimer() {
      _streamStartTime = performance.now();
      _streamTokenCount = 0;
      if (_streamTimerInterval) clearInterval(_streamTimerInterval);
      _streamTimerInterval = setInterval(() => {
        if (!streamEl) { clearInterval(_streamTimerInterval); _streamTimerInterval = null; return; }
        const elapsed = ((performance.now() - _streamStartTime) / 1000).toFixed(1);
        const hdr = streamEl.querySelector('.msg-header');
        let timerEl = hdr.querySelector('.stream-timer');
        if (!timerEl) {
          timerEl = document.createElement('span');
          timerEl.className = 'stream-timer msg-tok';
          timerEl.style.cssText = 'color:var(--yellow);animation:pulse 1s infinite';
          hdr.insertBefore(timerEl, hdr.querySelector('.msg-actions'));
        }
        timerEl.textContent = elapsed + 's';
      }, 200);
    }

    function updateStreamingMsg(t) {
      switchToChat();
      if (!streamEl) {
        streamEl = createMsgEl('agent', t, true);
        streamEl._streaming = true;
        streamEl._lastRenderedLen = 0;
        streamEl._lastBlockText = '';
        $msg().appendChild(streamEl);
        _startStreamTimer();
      }
      streamEl._text = t;
      const c = streamEl.querySelector('.msg-content');
      const delta = t.slice(streamEl._lastRenderedLen);
      streamEl._lastRenderedLen = t.length;
      if (!streamEl._rAF) {
        const _el = streamEl, _c = c;
        streamEl._rAF = requestAnimationFrame(() => {
          _el._rAF = null;
          if (!_el.parentNode) return;
          _c.innerHTML = renderMd(_el._text || '');
          c.querySelectorAll('pre code').forEach(b => {
            if (!b.dataset.hljs) { hljs.highlightElement(b); b.dataset.hljs = '1'; }
          });
          addCopyBtns(c);
          scrollBottom();
        });
      }
      scrollBottom();
    }

    function finalizeStreamingMsg(t, usage) {
      if (_streamTimerInterval) { clearInterval(_streamTimerInterval); _streamTimerInterval = null; }
      const elapsed = _streamStartTime ? (performance.now() - _streamStartTime) / 1000 : 0;
      _streamStartTime = null;

      if (!streamEl) { if (t) appendMsg('assistant', t); return; }
      if (streamEl._rAF) cancelAnimationFrame(streamEl._rAF);
      const c = streamEl.querySelector('.msg-content');
      c.classList.remove('streaming-cursor');
      c.innerHTML = renderMd(t);
      c.querySelectorAll('pre code').forEach(b => {
        if (!b.dataset.hljs) { hljs.highlightElement(b); b.dataset.hljs = '1'; }
      });
      addCopyBtns(c);

      const hdr = streamEl.querySelector('.msg-header');
      // Remove timer and any stale token elements
      hdr.querySelectorAll('.msg-tok, .stream-timer').forEach(el => el.remove());

      const outTok = (usage && usage.out && usage.out > 0) ? usage.out : (tokenTracker._callOut > 0 ? tokenTracker._callOut : 0);
      const isExact = !!(usage && usage.out && usage.out > 0);
      const tps = (outTok > 0 && elapsed > 0.5) ? Math.round(outTok / elapsed) : 0;

      if (outTok > 0) {
        const tokEl = document.createElement('span');
        tokEl.className = 'msg-tok';
        const prefix = isExact ? '' : '~';
        const tpsStr = tps > 0 ? ` · ${tps} t/s` : '';
        const timeStr = elapsed > 0.5 ? ` · ${elapsed.toFixed(1)}s` : '';
        tokEl.textContent = prefix + formatTok(outTok) + ' out' + tpsStr + timeStr;
        tokEl.title = (isExact ? 'Output tokens (exact)' : 'Output tokens (estimated)') + (tps > 0 ? ` · ${tps} tokens/sec · ${elapsed.toFixed(1)}s total` : '');
        if (tps >= 30) tokEl.classList.add('fast');
        hdr.insertBefore(tokEl, hdr.querySelector('.msg-actions'));
      }

      streamEl._streaming = false;
      streamEl._text = t;
      streamEl = null;
      scrollBottom();
    }

    function createMsgEl(role, text, streaming) {
      const isUser = role === 'user';
      const isAgent = role === 'assistant' || role === 'agent';
      const el = document.createElement('div');
      el.className = 'msg';
      el._role = role;
      el._time = new Date().toLocaleTimeString();
      el._msgIndex = state.messages.length;
      el._text = text;
      const gid = 'ag_' + Math.random().toString(36).substr(2, 9);
      const wordCount = isUser && text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
      const wordBadge = isUser && wordCount > 0 ? `<span class="msg-tok" title="${wordCount} words" style="cursor:default">${wordCount}w</span>` : '';
      el.innerHTML = `<div class="msg-avatar ${isUser ? 'user' : 'agent'}">${isUser ? '<i class="fas fa-user" style="font-size:10px"></i>' : '<svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px"><defs><linearGradient id="' + gid + '" x1="2" y1="2" x2="26" y2="26" gradientUnits="userSpaceOnUse"><stop stop-color="#f5b742"/><stop offset="1" stop-color="#a06e10"/></linearGradient></defs><rect width="28" height="28" rx="6" fill="url(#' + gid + ')"/><ellipse cx="14" cy="18" rx="5.5" ry="4" fill="#08080a" opacity=".9"/><path d="M14 22L12 26M14 22L14 26.5M14 22L16 26" stroke="#08080a" stroke-width="1.2" stroke-linecap="round" opacity=".85"/><circle cx="14" cy="13" r="3.2" fill="#08080a" opacity=".9"/><path d="M8.5 17Q4.5 15 3 11Q2.5 9.5 4 9.5Q5.5 9.5 6.5 11.5Q7.5 13.5 8.5 15" fill="#08080a" opacity=".85"/><path d="M19.5 17Q23.5 15 25 11Q25.5 9.5 24 9.5Q22.5 9.5 21.5 11.5Q20.5 13.5 19.5 15" fill="#08080a" opacity=".85"/><circle cx="12.2" cy="12" r="1" fill="#f5b742"/><circle cx="15.8" cy="12" r="1" fill="#f5b742"/><path d="M12.5 10.2Q10 7 9 5" stroke="#08080a" stroke-width="1" stroke-linecap="round" opacity=".8"/><path d="M15.5 10.2Q18 7 19 5" stroke="#08080a" stroke-width="1" stroke-linecap="round" opacity=".8"/><circle cx="9" cy="5" r=".8" fill="#08080a" opacity=".8"/><circle cx="19" cy="5" r=".8" fill="#08080a" opacity=".8"/><path d="M10 19L8 21.5M11 19.5L9.5 22M13 20L12 22.5M15 20L16 22.5M17 19.5L18.5 22M18 19L20 21.5" stroke="#08080a" stroke-width=".9" stroke-linecap="round" opacity=".7"/></svg>'}</div><div class="msg-body"><div class="msg-header"><span class="msg-name">${isUser ? 'You' : 'SlopLobster'}</span><span class="msg-time" title="${new Date().toLocaleString()}">${el._time}</span>${wordBadge}<div class="msg-actions">${isAgent ? '<button class="msg-act" onclick="copyMsgText(this)" title="Copy plain text"><i class="fas fa-copy"></i></button><button class="msg-act copy-md" onclick="copyMsgMarkdown(this)" title="Copy as Markdown"><i class="fas fa-markdown"></i></button><button class="msg-act" onclick="pruneMsg(this)" title="Prune out of context"><i class="fas fa-scissors"></i></button><button class="msg-act" onclick="retryMsg(this)" title="Retry from here"><i class="fas fa-rotate-right"></i></button>' : ''}${isUser ? '<button class="msg-act" onclick="editMsg(this)" title="Edit & resend"><i class="fas fa-pen"></i></button><button class="msg-act" onclick="copyMsgText(this)" title="Copy"><i class="fas fa-copy"></i></button><button class="msg-act" onclick="pruneMsg(this)" title="Prune out of context"><i class="fas fa-scissors"></i></button>' : ''}</div></div><div class="msg-content ${streaming ? 'streaming-cursor' : ''}">${isUser ? esc(text) : renderMd(text)}</div></div>`;
      if (isAgent && !streaming) { el.querySelector('.msg-content').querySelectorAll('pre code').forEach(b => hljs.highlightElement(b)); addCopyBtns(el.querySelector('.msg-content')); }
      return el;
    }

    function appendMsg(role, content) {
      switchToChat();
      if (role === 'system') {
        const el = document.createElement('div'); el.className = 'msg';
        const isWarn = content.includes('Security') || content.includes('traversal') || content.includes('cancelled') || content.includes('failed') || content.includes('Error');
        el.innerHTML = `<div style="width:26px;flex-shrink:0"></div><div class="msg-body"><div class="msg-content" style="color:${isWarn ? 'var(--yellow)' : 'var(--tx-3)'};font-size:11px;font-style:italic">${esc(content)}</div></div>`;
        $msg().appendChild(el); scrollBottom(); return;
      }
      const el = createMsgEl(role, content); $msg().appendChild(el); scrollBottom();
    }

    function copyMsgText(btn) {
      const msgEl = btn.closest('.msg');
      const text = msgEl._text || '';

      if (!text) {
        showToast('No text content to copy', 'warn');
        return;
      }

      navigator.clipboard.writeText(text).then(() => {
        btn.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1200);
      });
    }

    function copyMsgMarkdown(btn) {
      const msgEl = btn.closest('.msg');
      // Directly use the reliably stored raw text
      const md = msgEl._text || '';

      if (!md) {
        showToast('No Markdown content to copy', 'warn');
        return;
      }

      navigator.clipboard.writeText(md).then(() => {
        btn.classList.add('copied');
        btn.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '<i class="fas fa-markdown"></i>';
        }, 1400);
      });
    }

    function pruneMsg(btn) {
      if (!confirm('Prune this message from LLM context? (This does not undo any file changes)')) return;
      const msgEl = btn.closest('.msg');
      if (msgEl && msgEl._msgIndex !== undefined) {
        state.messages.splice(msgEl._msgIndex, 1);
        for (const child of document.getElementById('messages').children) {
          if (child._msgIndex > msgEl._msgIndex) child._msgIndex--;
        }
        msgEl.style.opacity = '0';
        setTimeout(() => {
          msgEl.remove();
          updateContextMeter();
          saveCurrentConv();
        }, 150);
      }
    }

    function retryMsg(btn) {
      if (state.running) return;
      const msgEl = btn.closest('.msg');
      if (!msgEl || msgEl._msgIndex == null) return;

      const cutIndex = msgEl._msgIndex;
      state.messages = state.messages.slice(0, cutIndex);

      /* Remove all DOM elements after (and including) the target message */
      const children = [...$msg().children];
      const targetDomIdx = children.indexOf(msgEl);
      for (let i = children.length - 1; i >= targetDomIdx; i--) {
        children[i].remove();
      }

      streamEl = null;
      agentLoop();
    }


    function editMsg(btn) {
      if (state.running) return; const msgEl = btn.closest('.msg'); const body = msgEl.querySelector('.msg-body'); const contentEl = body.querySelector('.msg-content'); const origText = msgEl._text || '';
      contentEl.style.display = 'none';
      const wrap = document.createElement('div'); wrap.className = 'edit-wrap';
      wrap.innerHTML = `<textarea rows="2">${esc(origText)}</textarea><div class="edit-btns"><button class="primary" onclick="submitEdit(this)">Save & Resend</button><button onclick="cancelEdit(this)">Cancel</button></div>`;
      body.appendChild(wrap); wrap.querySelector('textarea').focus();
    }
    function submitEdit(btn) {
      const wrap = btn.closest('.edit-wrap'); const msgEl = wrap.closest('.msg'); const newText = wrap.querySelector('textarea').value.trim();
      if (!newText) { cancelEdit(btn); return; }
      const idx = [...$msg().children].indexOf(msgEl);
      let msgCount = 0; for (let i = 0; i < idx; i++) { const c = $msg().children[i]; if (c._role === 'user' || c._role === 'agent' || c._role === 'assistant') msgCount++; }
      if (state.messages[msgCount]) state.messages[msgCount].content = newText;
      while ($msg().children.length > idx + 1) $msg().removeChild($msg().lastChild);
      const contentEl = msgEl.querySelector('.msg-content'); contentEl.textContent = newText; contentEl.style.display = ''; msgEl._text = newText; wrap.remove();
      state.messages = state.messages.slice(0, msgCount + 1); streamEl = null; agentLoop();
    }
    function cancelEdit(btn) { const wrap = btn.closest('.edit-wrap'); const msgEl = wrap.closest('.msg'); msgEl.querySelector('.msg-content').style.display = ''; wrap.remove(); }

    // Generic confirm bar for dangerous-but-not-shell actions (git commits, browser
    // interactions) whose auto-approval is gated by a settings toggle rather than
    // the DANGEROUS pattern list. Set opts.editable to let the user tweak the value.
    function showActionConfirm(label, detail, callback, opts) {
      opts = opts || {};
      const signal = opts.signal || (state.running ? state.abortCtrl?.signal : null);
      switchToChat();
      const el = document.createElement('div'); el.className = 'confirm-bar'; el.style.flexWrap = 'wrap';
      const detailHtml = opts.editable
        ? `<input type="text" class="confirm-cmd-input" value="${esc(detail)}" style="flex:1;background:var(--bg-3);color:var(--tx-1);border:1px solid var(--border);border-radius:3px;padding:4px 6px;font-family:'JetBrains Mono',monospace;font-size:11px;">`
        : `<span style="flex:1;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--tx-1);white-space:pre-wrap;word-break:break-all">${esc(detail)}</span>`;
      const subtitleHtml = opts.subtitle
        ? `<div style="width:100%;font-size:10.5px;color:var(--tx-3);font-style:italic;padding-left:22px;margin-top:2px"><i class="fas fa-triangle-exclamation" style="margin-right:4px;opacity:.7"></i>${esc(opts.subtitle)}</div>`
        : '';
      el.innerHTML = `<div style="display:flex;align-items:center;width:100%;gap:8px"><i class="fas ${opts.icon || 'fa-triangle-exclamation'}"></i><b>${esc(label)}:</b> ${detailHtml}<button class="confirm-yes" style="padding:4px 8px;font-size:11px;cursor:pointer;background:var(--accent);color:white;border:none;border-radius:3px">${esc(opts.yesLabel || 'Proceed')}</button><button class="confirm-no" style="padding:4px 8px;font-size:11px;cursor:pointer;background:var(--bg-3);color:var(--tx-2);border:none;border-radius:3px">Cancel</button></div>${subtitleHtml}`;
      const input = el.querySelector('.confirm-cmd-input');
      const endApproval = beginRunApproval({ label, detail: typeof detail === 'string' ? detail : cmd });
      let decided = false;
      const finish = async val => {
        if (decided) return; decided = true;
        try { await endApproval(val !== false); }
        catch (error) { val = false; appendMsg('system', 'Approval could not be saved: ' + error.message); }
        signal?.removeEventListener('abort', cancel); el.remove(); callback(val);
      };
      const cancel = () => finish(false);
      el.querySelector('.confirm-yes').onclick = () => finish(input ? input.value : detail);
      el.querySelector('.confirm-no').onclick = cancel;
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      $msg().appendChild(el); scrollBottom();
      if (input) input.focus();
      notifyUser('Confirmation needed', label + ': ' + detail, 'action-confirm');
    }

    // Wraps a browser write-action (click/type/evaluate) in a confirm-bar, gated
    // by state.browserWriteAutoApprove (off by default). doer() performs the call.
    function confirmBrowserAction(label, detail, doer) {
      return new Promise((resolve, reject) => {
        showActionConfirm(label, detail, async valOrFalse => {
          if (valOrFalse === false) { resolve({ output: 'Action cancelled by user.' }); return; }
          try { resolve({ output: await doer() }); } catch (error) { reject(error); }
        }, { icon: 'fa-hand', yesLabel: 'Proceed' });
      });
    }

    function showShellConfirm(cmd, callback, label, toolSignal) {
      const signals = [toolSignal, state.running ? state.abortCtrl?.signal : null].filter(Boolean);
      const signal = signals.length ? AbortSignal.any(signals) : null;
      switchToChat(); const el = document.createElement('div'); el.className = 'confirm-bar'; el.style.flexWrap = 'wrap';
      el.innerHTML = `<div style="display:flex;align-items:center;width:100%;gap:8px"><i class="fas fa-triangle-exclamation"></i><b>${esc(label || 'Dangerous')}:</b> <input type="text" class="confirm-cmd-input" value="${esc(cmd)}" style="flex:1;background:var(--bg-3);color:var(--tx-1);border:1px solid var(--border);border-radius:3px;padding:4px 6px;font-family:'JetBrains Mono',monospace;font-size:11px;"><button class="confirm-yes" style="padding:4px 8px;font-size:11px;cursor:pointer;background:var(--accent);color:white;border:none;border-radius:3px">Execute</button><button class="confirm-no" style="padding:4px 8px;font-size:11px;cursor:pointer;background:var(--bg-3);color:var(--tx-2);border:none;border-radius:3px">Cancel</button></div>`;
      const input = el.querySelector('.confirm-cmd-input');
      const endApproval = beginRunApproval({ label, detail: typeof detail === 'string' ? detail : cmd });
      let decided = false;
      const finish = async val => {
        if (decided) return; decided = true;
        try { await endApproval(val !== false); }
        catch (error) { val = false; appendMsg('system', 'Approval could not be saved: ' + error.message); }
        signal?.removeEventListener('abort', cancel); el.remove(); callback(val);
      };
      const cancel = () => finish(false);
      el.querySelector('.confirm-yes').onclick = () => finish(input.value);
      el.querySelector('.confirm-no').onclick = cancel;
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      $msg().appendChild(el); scrollBottom();
      input.focus();
      notifyUser('Confirmation needed', (label || 'Dangerous') + ': ' + cmd, 'shell-confirm');
    }

    function showToolPanel(name, argsStr, status, onStopClick, toolCallId) {
          if (argsStr == null || typeof argsStr !== 'string') argsStr = '{}';

          let prev = '';
          try {
            const a = JSON.parse(argsStr);
            prev = Object.entries(a).map(([k, v]) => {
              let display;
              if (Array.isArray(v)) {
                // edits is an array of {old_text, new_text} objects
                display = v.map((item, idx) => {
                  if (typeof item === 'object' && item !== null) {
                    const keys = Object.keys(item);
                    return keys.map(key => {
                      const val = String(item[key]);
                      const truncated = val.length > 80 ? val.slice(0, 77) + '...' : val;
                      return key + ': "' + truncated.replace(/"/g, '\\"') + '"';
                    }).join(', ');
                  }
                  return String(item);
                }).join('\n');
                if (display.length > 300) display = display.slice(0, 297) + '...';
              } else if (typeof v === 'object' && v !== null) {
                display = JSON.stringify(v);
                if (display.length > 120) display = display.slice(0, 117) + '...';
              } else {
                display = String(v);
                if (display.length > 120) display = display.slice(0, 117) + '...';
              }
              return '<span>' + esc(k) + '</span>: ' + esc(display);
            }).join('<br>');
          } catch {
            prev = esc(argsStr?.slice(0, 200) || '');
          }
      const el = document.createElement('div'); el.className = 'tool-panel';
      el._toolCallId = toolCallId || null;
      el._toolName = name; el._toolArgs = argsStr; el._screenshotDataUrl = null; el._imageDataUrl = null; el._imagePath = null; el._imageReason = null; el._imageType = null; el._resultText = ''; el._collapsed = false;
      el.innerHTML = `<div class="tool-hdr"><i class="fas fa-bolt tool-icon"></i><span class="tool-name">${esc(name)}</span><span class="tool-status ${status}">${status === 'run' ? 'Running...' : status === 'ok' ? 'Done' : 'Error'}</span><div class="tool-actions">${onStopClick ? '<button class="tool-stop" title="Stop"><i class="fas fa-stop"></i> Stop</button>' : ''}<button class="tool-act-btn" onclick="copyToolOutput(this)" title="Copy output"><i class="fas fa-copy"></i></button><button class="tool-act-btn tool-expand-btn" onclick="toggleToolExpand(this)" title="Expand/Collapse" style="display:none"><i class="fas fa-expand"></i></button></div></div><div class="tool-params">${prev}</div><div class="tool-result loading"></div>`;
      if (onStopClick) el.querySelector('.tool-stop').onclick = (e) => { e.stopPropagation(); onStopClick(); };
      $msg().appendChild(el); scrollBottom(); return { el };
    }



    function updateToolStatus(w, s) {
      const el = w?.el || w;
      if (!el || !el.querySelector) return;
      const st = el.querySelector('.tool-status');
      if (!st) return;
      st.className = 'tool-status ' + s;
      st.textContent = s === 'ok' ? 'Done' : s === 'err' ? 'Error' : 'Running...';
      const stopBtn = el.querySelector('.tool-stop');
      if (stopBtn) stopBtn.style.display = s === 'run' ? '' : 'none';
      const expandBtn = el.querySelector('.tool-expand-btn');
      if (expandBtn && s !== 'run') expandBtn.style.display = '';
      /* Only show retry button on error, and only for edit_file / write_file
        (not for "file not found" errors — those need a different fix, not a retry) */
        if (s === 'err') {
          const existing = el.querySelector('.tool-retry-btn');
          if (existing) existing.remove();
          const retryBtn = document.createElement('button');
          retryBtn.className = 'msg-act tool-retry-btn';
          retryBtn.innerHTML = '<i class="fas fa-rotate-right"></i> Retry';
          retryBtn.title = 'Retry this tool call';
          retryBtn.onclick = (e) => { e.stopPropagation(); retrySingleTool({ el, _toolCallId: el._toolCallId, _toolName: el._toolName, _toolArgs: el._toolArgs, _resultText: el._resultText || '' }); };
          el.querySelector('.tool-hdr').appendChild(retryBtn);

          const existingExp = el.querySelector('.tool-explain-btn');
          if (existingExp) existingExp.remove();
          const explainBtn = document.createElement('button');
          explainBtn.className = 'msg-act tool-explain-btn';
          explainBtn.style.color = 'var(--cyan)';
          explainBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Explain';
          explainBtn.title = 'Ask agent to explain and diagnose this error';
          explainBtn.onclick = (e) => {
            e.stopPropagation();
            const errOutput = el._resultText || el.querySelector('.tool-result')?.textContent || 'Error in tool execution';
            explainError(`Tool [${el._toolName || 'tool'}] failed with output:\n${errOutput}`);
          };
          el.querySelector('.tool-hdr').appendChild(explainBtn);
        }
      }


    function updateToolResult(w, r) {
      if (!w || !w.el) return;
      const el = w.el;
      const res = el.querySelector('.tool-result');
      if (!res) return;
      res.classList.remove('loading');
      res.style.background = '';
      res.style.animation = '';

      const text = (r != null) ? String(r) : '(no output)';

      res.textContent = text;
      w._resultText = text;

      const isTruncated = text.length > 500 && text.includes('[Truncated');
      if (isTruncated) {
        res.classList.add('truncated');
        const eb = el.querySelector('.tool-expand-btn');
        if (eb) eb.style.display = '';
      }

      el.querySelector('.tool-hdr').onclick = () => {
        w._collapsed = !w._collapsed;
        res.style.display = w._collapsed ? 'none' : '';
        const ic = el.querySelector('.tool-expand-btn i');
        if (ic) ic.className = w._collapsed ? 'fas fa-compress' : 'fas fa-expand';
      };

      scrollBottom();
    }

    function copyToolOutput(btn) {
      const panel = btn.closest('.tool-panel'); const text = panel._resultText || panel.querySelector('.tool-result')?.textContent || '';
      navigator.clipboard.writeText(text).then(() => { btn.classList.add('copied'); btn.innerHTML = '<i class="fas fa-check"></i>'; setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1200); });
    }
    function toggleToolExpand(btn) {
      const panel = btn.closest('.tool-panel'); const res = panel.querySelector('.tool-result');
      panel._collapsed = !panel._collapsed; res.style.display = panel._collapsed ? 'none' : '';
      btn.querySelector('i').className = panel._collapsed ? 'fas fa-compress' : 'fas fa-expand';
    }

    /* ═══════════════ DIFF PANEL (compact by default) ═══════════════ */
    function showDiffPanel(diff) {
      const el = document.createElement('div'); el.className = 'diff-panel';
      const { compact: displayLines, hidden } = compactDiffLines(diff.lines, 2, 2);
      const hasCtx = diff.lines.some(l => l.type === 'ctx');
      const showAllHidden = hidden > 0 && hasCtx;

      let linesHtml = displayLines.map(l => {
        if (l.type === 'ellipsis') return `<div class="diff-line ellipsis">··· ${hidden} unchanged lines hidden</div>`;
        return `<div class="diff-line ${l.type}">${esc(l.text)}</div>`;
      }).join('');
      if (diff.lines.length > 200 && hidden === 0) linesHtml += '<div class="diff-line ellipsis">··· showing first 200 of ' + diff.lines.length + ' lines</div>';

      const toggleBtn = showAllHidden ? `<button class="diff-toggle" onclick="toggleDiffExpand(this)"><i class="fas fa-expand"></i> Show all</button>` : '';

      el.innerHTML = `<div class="diff-hdr"><i class="fas fa-code-compare"></i> ${esc(diff.path)} <span style="margin-left:6px;color:var(--green)">+${diff.stats.additions}</span> <span style="color:var(--red)">-${diff.stats.deletions}</span>${toggleBtn}</div><div class="diff-content">${linesHtml}</div>`;

      if (showAllHidden) {
        el._fullLines = diff.lines;
        el._compactLines = displayLines;
        el._hidden = hidden;
      }

      $msg().appendChild(el); scrollBottom();
      return el;
    }

    function showDiffApproval(pendingItems, signal) {
      return new Promise((resolve, reject) => {
        const decisions = new Map();
        let done = false;
        pendingItems.forEach(item => {
          const bar = document.createElement('div');
          bar.className = 'diff-approval-bar';
          const label = item.result._pendingIsNewFile ? 'Create this file?' : 'Apply this edit?';
          bar.innerHTML = `<span class="da-label">${label}</span><button class="da-btn accept"><i class="fas fa-check"></i> Accept</button><button class="da-btn reject"><i class="fas fa-xmark"></i> Reject</button>`;
          bar.querySelector('.da-btn.accept').onclick = () => { if (done) return; decisions.set(item.index, true); bar.innerHTML = '<span class="da-label" style="color:var(--green)">✓ Accepted</span>'; checkDone(); };
          bar.querySelector('.da-btn.reject').onclick = () => { if (done) return; decisions.set(item.index, false); bar.innerHTML = '<span class="da-label" style="color:var(--red)">✗ Rejected</span>'; checkDone(); };
          (item.diffEl || item.toolPanel.el).appendChild(bar);
        });
        function checkDone() { if (decisions.size === pendingItems.length) { done = true; resolve(decisions); } }
        if (signal) { const h = () => { if (!done) { done = true; reject(new DOMException('Aborted', 'AbortError')); } signal.removeEventListener('abort', h); }; signal.addEventListener('abort', h); }
        scrollBottom();
      });
    }

    async function applyPendingEdit(pr) {
      requireWorkspace();
      const segs = sanitizePath(pr._pendingPath);
      let dir = state.dirHandle;
      for (let i = 0; i < segs.length - 1; i++) dir = await dir.getDirectoryHandle(segs[i]);
      const fh = await dir.getFileHandle(segs[segs.length - 1], { create: false });

      // Verify file hasn't changed since dry-run
      const current = await (await fh.getFile()).text();
      const expectedOld = pr._originalContent ?? '';
      if (current !== expectedOld) {
        return {
          status: 'error', error: 'stale_preview', retryable: true,
          output: '⚠ Edit rejected — file was modified since preview. Tool call returned stale data.\n' +
                  'The file may have been changed by a parallel tool or another process.',
          diff: null
        };
      }

      const w = await fh.createWritable();
      await w.write(pr._pendingNewContent);
      await w.close();
      state.fileCache.set(pr._pendingPath, pr._pendingNewContent);
      modifiedFiles.add(pr._pendingPath);
      if (pr._pendingIsNewFile) newFiles.add(pr._pendingPath);
      let vm = '';
      if (state.verifyWrites) {
        try {
          const v = await (await fh.getFile()).text();
          vm = v === pr._pendingNewContent ? '\n✓ Write verified' : '\n✗ WRITE VERIFICATION FAILED';
        } catch { }
      }
      return { output: '✓ Approved — ' + pr.output.replace('[PENDING APPROVAL] ', '') + vm, diff: pr.diff };
    }

    async function applyPendingWrite(pr) {
      requireWorkspace();
      const segs = sanitizePath(pr._pendingPath);
      let dir = state.dirHandle;
      for (let i = 0; i < segs.length - 1; i++) dir = await dir.getDirectoryHandle(segs[i], { create: true });
      let current = null;
      try { current = await (await (await dir.getFileHandle(segs[segs.length - 1])).getFile()).text(); }
      catch (e) { if (e.name !== 'NotFoundError') throw e; }
      if (current !== pr._originalContent) return { status: 'error', error: 'stale_preview', output: 'Error: file changed since preview; request a fresh diff before writing.' };
      const fh = await dir.getFileHandle(segs[segs.length - 1], { create: true });
      const w = await fh.createWritable(); await w.write(pr._pendingNewContent); await w.close();
      state.fileCache.set(pr._pendingPath, pr._pendingNewContent); modifiedFiles.add(pr._pendingPath);
      if (pr._pendingIsNewFile) newFiles.add(pr._pendingPath);
      let vm = '';
      if (state.verifyWrites) { try { const v = await (await fh.getFile()).text(); vm = v === pr._pendingNewContent ? '\n✓ Write verified' : '\n✗ WRITE VERIFICATION FAILED'; } catch { } }
      const op = pr._pendingIsNewFile ? 'Created' : 'Overwrote';
      return { output: `✓ Approved — ${op} ${pr._pendingPath} (${pr._pendingNewContent.length} chars)${vm}`, diff: pr.diff };
    }

    async function autoRouteFileError(toolName, output, toolPanel) {
      if (!output || typeof output !== 'string') return output;
      const fileTools = ['read_file', 'read_file_lines', 'edit_file', 'view_image', 'delete_file', 'move_file', 'grep'];
      if (!fileTools.includes(toolName)) return output;

      /* Extract the missing file name from SlopLobster's actual error formats */
      let missing = null;
      const patterns = [
        /Error:\s*"([^"]+)"\s+not found/i,           // read_file: "utils.py" not found
        /Error:\s*"(?:\/)?([^"\\]+)"\s+not found/i,  // with leading slash
        /"([^"]+)"\s+not found/i,                    // bare: "utils.py" not found
        /cannot find\s+"([^"]+)"/i,                  // alternative wording
        /"([^"]+)"\s+does not exist/i,               // alternative wording
        /no such file.*"([^"]+)"/i,                  // POSIX-style
        /"([^"]+)"\s+is not a file/i,                // directory given instead of file
      ];
      for (const p of patterns) {
        const m = output.match(p);
        if (m) { missing = m[1]; break; }
      }

      if (!missing) return output;

      /* Extract just the filename for fuzzy matching */
      const fn = missing.split('/').pop().split('\\').pop();
      if (!fn || fn.length < 2) return output;

      if (!state.dirHandle) return output;

      try {
        const sr = await searchFilesSafe(fn);
        if (sr.includes('No files found')) return output;
        const suggestions = sr.split('\n').slice(0, 5);

        /* Show hint below the tool panel */
        if (toolPanel && toolPanel.el) {
          const hint = document.createElement('div');
          hint.className = 'auto-route-hint';
          hint.textContent = suggestions.join('\n');
          toolPanel.el.appendChild(hint);
          scrollBottom();
        }

        return output + '\n\n[AUTO-SEARCH: File not found. Similar files — use one of these exact paths:]\n' + suggestions.join('\n');
      } catch { return output; }
    }

    function toggleDiffExpand(btn) {
      const panel = btn.closest('.diff-panel');
      const content = panel.querySelector('.diff-content');
      if (panel._expanded) {
        content.innerHTML = panel._compactLines.map(l => {
          if (l.type === 'ellipsis') return '<div class="diff-line ellipsis">··· ' + panel._hidden + ' unchanged lines hidden</div>';
          return '<div class="diff-line ' + l.type + '">' + esc(l.text) + '</div>';
        }).join('');
        btn.innerHTML = '<i class="fas fa-expand"></i> Show all';
        panel._expanded = false;
      } else {
        /* Show changed lines with 2 lines of context */
        const { compact: expanded } = compactDiffLines(panel._fullLines, 2, 2);
        let html = expanded.map(l => {
          if (l.type === 'ellipsis') return '<div class="diff-line ellipsis">···</div>';
          return '<div class="diff-line ' + l.type + '">' + esc(l.text) + '</div>';
        }).join('');
        if (panel._fullLines.length > 200) html += '<div class="diff-line ellipsis">··· showing first 200 lines</div>';
        content.innerHTML = html;
        btn.innerHTML = '<i class="fas fa-compress"></i> Compact';
        panel._expanded = true;
      }
    }

    /* ═══════════════ SEARCH PANEL ═══════════════ */
    function showSearchPanel(data) {
      if (!data || !data.results || !data.results.length) {
        const el = document.createElement('div'); el.className = 'tool-panel';
        el.innerHTML = `<div class="tool-hdr"><i class="fas fa-globe tool-icon" style="color:var(--red)"></i><span class="tool-name" style="color:var(--red)">web_search</span><span class="tool-status err">No results</span></div><div class="tool-result">${esc(data?.results?.[0]?.error || 'No results found')}</div>`;
        $msg().appendChild(el); scrollBottom(); return;
      }

      const validResults = data.results.filter(r => !r.error);
      const errorResults = data.results.filter(r => r.error);

      // If every result is an error, show a consolidated error panel
      if (!validResults.length) {
        const el = document.createElement('div'); el.className = 'tool-panel';
        const errorMessages = errorResults.map(r => r.error).filter(Boolean);
        const combinedError = errorMessages.length === 1
          ? errorMessages[0]
          : errorMessages.slice(0, 3).join('\n') + (errorMessages.length > 3 ? '\n... (' + errorMessages.length + ' total errors)' : '');
        el.innerHTML = `<div class="tool-hdr"><i class="fas fa-globe tool-icon" style="color:var(--red)"></i><span class="tool-name" style="color:var(--red)">web_search</span><span class="tool-status err">Search failed</span></div><div class="tool-result">${esc(combinedError || 'All search results returned errors')}</div>`;
        $msg().appendChild(el); scrollBottom(); return;
      }

      const el = document.createElement('div'); el.className = 'search-panel';
      const resultsHtml = validResults.map((r, i) => {
        let html = `<div class="search-result"><div class="search-result-title"><span class="sr-idx">${i + 1}</span><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title || '(no title)')}</a></div><div class="search-result-url">${esc(r.url)}</div>`;
        if (r.snippet) html += `<div class="search-result-snippet">${esc(r.snippet)}</div>`;
        if (r.content) html += `<div class="search-result-content-label"><i class="fas fa-file-lines"></i> Fetched content${r.content_truncated ? ' (truncated)' : ''}</div><div class="search-result-content">${esc(r.content.slice(0, 12000))}${r.content.length > 12000 ? '\n\n... (truncated for display)' : ''}</div>`;
        if (r.content_error) html += `<div style="font-size:10px;color:var(--yellow);margin-top:4px"><i class="fas fa-exclamation-triangle"></i> Fetch failed: ${esc(r.content_error)}</div>`;
        html += `</div>`;
        return html;
      }).join('');

      // Show suppressed-error hint if some results were errors but others succeeded
      const errorHint = errorResults.length
        ? `<div style="padding:6px 12px;font-size:10px;color:var(--yellow);font-family:'JetBrains Mono',monospace;background:rgba(234,179,8,.04);border-top:1px solid var(--border)"><i class="fas fa-triangle-exclamation" style="margin-right:4px"></i>${errorResults.length} result${errorResults.length > 1 ? 's' : ''} failed: ${errorResults.map(r => r.error).filter(Boolean).slice(0, 2).map(e => e.split('\n')[0].slice(0, 80)).join('; ')}${errorResults.length > 2 ? '...' : ''}</div>`
        : '';

      el.innerHTML = `<div class="search-hdr"><i class="fas fa-globe"></i><div class="search-q">${esc(data.query)}</div><span class="search-meta">${validResults.length} result${validResults.length !== 1 ? 's' : ''}${errorResults.length ? ' · ' + errorResults.length + ' error' + (errorResults.length > 1 ? 's' : '') : ''}</span></div><div class="search-results">${resultsHtml}</div>${errorHint}`;
      $msg().appendChild(el); scrollBottom();
    }

    function showChangeSummary(changes) {
      const el = document.createElement('div'); el.className = 'change-summary';
      const modC = changes.modified.size, creC = changes.created.size, delC = changes.deleted.size, movC = changes.moved.length;
      const total = modC + creC + delC + movC;
      const statsHtml = `<span style="color:var(--yellow)">+${creC} created</span><span style="color:var(--orange)">~${modC} modified</span>${delC ? '<span style="color:var(--red)">-' + delC + ' deleted</span>' : ''}${movC ? '<span style="color:var(--cyan)">→' + movC + ' moved</span>' : ''}`;
      el.innerHTML = `<div class="change-summary-hdr" onclick="this.nextElementSibling.classList.toggle('open')"><i class="fas fa-list-check"></i><span class="cs-label">Session Changes</span><div class="cs-stats">${statsHtml}</div></div><div class="change-summary-body">`;
      const body = el.querySelector('.change-summary-body');
      const allFiles = [
        ...[...changes.created].map(f => ({ f, op: 'created', icon: 'fa-plus', cls: 'created' })),
        ...[...changes.modified].map(f => ({ f, op: 'modified', icon: 'fa-pen', cls: 'modified' })),
        ...[...changes.deleted].map(f => ({ f, op: 'deleted', icon: 'fa-trash', cls: 'deleted' })),
        ...changes.moved.map(m => ({ f: m.from + ' → ' + m.to, op: 'moved', icon: 'fa-arrow-right', cls: 'moved' }))
      ];

      if (!allFiles.length) { body.innerHTML = '<div class="cs-empty">No file changes in this session</div>'; }
      else { body.innerHTML = allFiles.map(({ f, op, icon, cls }) => `<div class="cs-file" onclick="insertPath(&quot;${esc(f.split(' → ')[0] || f)}&quot;)"><span class="cs-op ${cls}">${op}</span><i class="fas ${icon}"></i>${esc(f)}</div>`).join(''); }
      $msg().appendChild(el); scrollBottom();
    }

    function renderMd(t) {
      if (!t) return '';
      // Strip thinking blocks (Gemma 4, Qwen <think>) before markdown parsing
      t = stripThinkingBlocks(t);
      try {
        const raw = marked.parse(t, { breaks: true, gfm: true });
        // Allow images, links, code blocks, tables — block everything else
        return DOMPurify.sanitize(raw, {
          ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'a', 'code', 'pre', 'ul', 'ol', 'li',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'thead', 'tbody',
            'tr', 'th', 'td', 'hr', 'del', 'sup', 'sub', 'span', 'div', 'img'],
          ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'id', 'src', 'alt'],
          FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'style'],
          ALLOWED_URI_REGEXP: /^(?:(?:(?:https?|data|mailto|tel|ftp):|[^a-z\]])[a-z0-9\-._~!$&'()*+,;=:@%/]+)?>?$|^#$/i,
          ADD_ATTR: ['target'],
        });
      } catch (e) {
        console.error('[renderMd]', e);
        return esc(t); // fallback to escaped text
      }
    }

    function addCopyBtns(c) {
      c.querySelectorAll('pre').forEach(pre => {
        if (pre.parentElement.classList.contains('code-block')) return;
        const code = pre.querySelector('code'); const lang = (code?.className?.match(/language-(\w+)/) || [])[1] || '';
        const w = document.createElement('div'); w.className = 'code-block';
        const h = document.createElement('div'); h.className = 'code-hdr';
        const isRunnable = ['bash', 'sh', 'shell', 'zsh', 'fish', 'console'].includes(lang);
        const runBtn = isRunnable && state.compConnected
          ? `<button class="run-btn" onclick="runCodeInShell(this)" title="Run in shell"><i class="fas fa-play"></i> Run</button>`
          : '';
        h.innerHTML = `<span>${lang || 'code'}</span>${runBtn}<button onclick="copyCode(this)"><i class="fas fa-copy"></i> Copy</button>`;
        pre.parentNode.insertBefore(w, pre); w.appendChild(h); w.appendChild(pre);
      });
    }

    function runCodeInShell(btn) {
      const code = btn.closest('.code-block').querySelector('code');
      const text = code?.textContent || '';
      if (!text.trim()) return;
      const inp = document.getElementById('msg-input');
      inp.value = text.trim();
      inp.style.height = 'auto';
      inp.style.height = Math.min(inp.scrollHeight, 150) + 'px';
      updateSendBtn();
      inp.focus();
      showToast('Command loaded — press Enter to execute', 'ok');
    }

    function copyCode(btn) {
      const code = btn.closest('.code-block').querySelector('code');
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.innerHTML = '<i class="fas fa-check"></i> Copied'; setTimeout(() => btn.innerHTML = '<i class="fas fa-copy"></i> Copy', 1500);
      });
    }

    function updateSendBtn() {
      const btn = document.getElementById('send-btn'), inp = document.getElementById('msg-input');
      if (state.running) { btn.className = 'send-btn stop'; btn.innerHTML = '<i class="fas fa-stop"></i>'; btn.disabled = false; }
      else { btn.className = 'send-btn send'; btn.innerHTML = '<i class="fas fa-arrow-up"></i>'; btn.disabled = !(state.connected && state.model && inp.value.trim()); }
      if (!state.running) state.pauseRequested = false;
      updatePauseBtn();
      const steerBtn = document.getElementById('steer-btn');
      if (steerBtn) { steerBtn.style.display = state.running ? '' : 'none'; steerBtn.disabled = !inp.value.trim(); }
      if (state.running) inp.placeholder = "Type to guide the agent — sent before its next step, doesn't stop it";
      else if (inp.placeholder.startsWith('Type to guide')) inp.placeholder = 'Ask SlopLobster to do something... (@ mention files, / commands, Ctrl+K palette)';
    }

    function updateWelcomeStatus() {
      const el = document.getElementById('welcome-status'); const parts = [];
      if (state.connected && state.model) parts.push(`<span style="color:var(--green)"><i class="fas fa-circle" style="font-size:6px"></i> LLM: ${esc(state.model)}</span>`);
      else parts.push(`<span style="color:var(--tx-4)"><i class="fas fa-circle" style="font-size:6px"></i> LLM: disconnected</span>`);
      if (state.compConnected) parts.push(`<span style="color:var(--orange)"><i class="fas fa-circle" style="font-size:6px"></i> Shell+Search: ${state.compInfo?.platform || ''}</span>`);
      else parts.push(`<span style="color:var(--tx-4)"><i class="fas fa-circle" style="font-size:6px"></i> Shell: virtual</span>`);
      if (state.dirName) parts.push(`<span style="color:var(--teal)"><i class="fas fa-folder" style="font-size:8px"></i> ${esc(state.dirName)}</span>`);
      el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
    }

    function renderReferenceSites() {
      const el = document.createElement('div');
      el.className = 'sb-section';
      el.innerHTML = '<div class="sb-title">Reference Sites</div>';
      const list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-direction:column;gap:1px;max-height:180px;overflow-y:auto;';
      for (const cat of REFERENCE_SITES) {
        for (const s of cat.sites.slice(0, 6)) { /* limit to prevent overflow */
          const item = document.createElement('div');
          item.className = 'ft-item';
          item.style.cursor = 'pointer';
          item.title = s.use;
          item.innerHTML = `<span class="dot default" style="background:${s.fetch ? 'var(--green)' : s.search ? 'var(--cyan)' : 'var(--tx-4)'}"></span>${s.name}`;
          item.onclick = () => {
            if (s.search) {
              const q = prompt(`Search ${s.name} for:`);
              if (q) window.open(s.url + encodeURIComponent(q), '_blank');
            } else {
              window.open(s.url, '_blank');
            }
          };
          list.appendChild(item);
        }
      }
      el.appendChild(list);
      document.getElementById('tools-list').parentNode.appendChild(el);
    }

    /* ═══════════════ FILE TREE ═══════════════ */
    function getDotCls(n) { const e = n.split('.').pop().toLowerCase(); return { js: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', py: 'py', html: 'html', htm: 'html', css: 'css', scss: 'css', json: 'json', md: 'md', png: 'img', jpg: 'img', gif: 'img', svg: 'img', webp: 'img', rs: 'rs', go: 'go', toml: 'json', lock: 'json', yaml: 'json', yml: 'json', pdf: 'pdf' }[e] || 'default'; }

    async function refreshFileTree() {
      if (!state.dirHandle) { document.getElementById('file-tree').innerHTML = ''; return; }
      const tree = []; let fileCount = 0;
      async function walk(h, pfx, d) {
        if (d > 4) return; const es = [];
        for await (const [n, kh] of h.entries()) { if (!SKIP.has(n)) es.push({ n, k: kh.kind, h: kh }); }
        es.sort((a, b) => a.k === b.k ? a.n.localeCompare(b.n) : a.k === 'directory' ? -1 : 1);
        for (const e of es) { const p = pfx ? pfx + '/' + e.n : e.n; tree.push({ n: e.n, k: e.k, p, d }); if (e.k === 'file') fileCount++; if (e.k === 'directory') await walk(e.h, p, d + 1); }
      }
      await walk(state.dirHandle, '', 0);
      state.fileTree = tree;
      const _newCount = newFiles.size;
      const _modCount = [...modifiedFiles].filter(p => !newFiles.has(p)).length;
      const _changeStr = [
        _newCount ? `<span style="color:var(--yellow)">${_newCount} new</span>` : '',
        _modCount ? `<span style="color:var(--accent)">${_modCount} modified</span>` : ''
      ].filter(Boolean).join(' · ');
      const header = fileCount > 0 ? `<div style="padding:2px 6px;font-size:9px;color:var(--tx-4);font-family:'JetBrains Mono',monospace">${tree.filter(f => f.k === 'directory').length} dirs, ${fileCount} files${_changeStr ? ' · ' + _changeStr : ''}</div>` : '';
      document.getElementById('file-tree').innerHTML = header + tree.map(f => {
        const isNew = f.k === 'file' && newFiles.has(f.p);
        const isMod = f.k === 'file' && !isNew && modifiedFiles.has(f.p);

        const pEsc = esc(f.p);
        const clickFn = f.k === 'directory' ? `insertPath(&quot;${pEsc}&quot;)` : `previewFile(&quot;${pEsc}&quot;)`;
        let ext = '';
        if (f.k === 'file') {
          ext = `<div class="ft-acts"><button title="View" onclick="event.stopPropagation();previewFile(&quot;${pEsc}&quot;)"><i class="fas fa-eye"></i></button><button title="Copy path" onclick="event.stopPropagation();navigator.clipboard.writeText(&quot;${pEsc}&quot;);showToast('Copied to clipboard', 'ok')"><i class="fas fa-copy"></i></button><button title="Delete" onclick="event.stopPropagation();if(confirm('Delete ${pEsc}?')){deleteFileSafe(&quot;${pEsc}&quot;, false).then(()=>debouncedFileTreeRefresh())}"><i class="fas fa-trash"></i></button></div>`;
        }
        const dotCls = isNew || isMod ? '' : (f.k === 'directory' ? 'dir' : getDotCls(f.n));
        const dotInlineStyle = isNew
          ? 'background:#eab308;box-shadow:0 0 6px #eab308'
          : isMod ? 'background:var(--accent);box-shadow:0 0 5px var(--accent)' : '';
        const nameInlineStyle = isNew
          ? 'color:#eab308;font-weight:600'
          : isMod ? 'color:var(--accent);font-weight:600' : '';
        const titleSuffix = isNew ? ' (new)' : isMod ? ' (modified)' : '';
        return `<div class="ft-item" style="padding-left:${6 + f.d * 12}px" onclick="${clickFn}" title="${f.p}${titleSuffix}"><div class="ft-main"><span class="dot ${dotCls}" style="${dotInlineStyle}"></span><span class="ft-name" style="${nameInlineStyle}">${esc(f.n)}</span></div>${ext}</div>`;
      }).join('');
    }

    function insertPath(p) { const i = document.getElementById('msg-input'), pos = i.selectionStart; i.value = i.value.slice(0, pos) + p + i.value.slice(pos); i.focus(); i.selectionStart = i.selectionEnd = pos + p.length; updateSendBtn(); }

    /* ═══════════════ CONVERSATIONS ═══════════════ */
    /* ═══════════════ CONVERSATIONS (IndexedDB + Workspace + Cache) ═══════════════ */
    const STORAGE_KEY = 'SlopLobster_conversations', SETTINGS_KEY = 'SlopLobster_settings';


    const DELETED_CONVS_KEY = 'SlopLobster_deletedConversations';
    const deletedConvIds = new Set((() => {
      try { const ids = JSON.parse(localStorage.getItem(DELETED_CONVS_KEY) || '[]'); return Array.isArray(ids) ? ids : []; }
      catch { return []; }
    })());
    let convDatabaseSaveChain = Promise.resolve();
    let convWorkspaceSaveChain = Promise.resolve();
    function conversationWorkspaceHandle() {
      return state.dirHandle?._managedTaskId ? harnessFeatureState.baseHandle : state.dirHandle;
    }

    async function loadConversations() {
      // 1. Fast initial populate from lightweight localStorage cache
      try {
        const cacheRaw = localStorage.getItem('SlopLobster_convCache');
        if (cacheRaw) {
          const cache = JSON.parse(cacheRaw);
          if (cache.titles && Array.isArray(cache.titles) && cache.titles.length) {
            state.conversations = cache.titles.filter(t => !deletedConvIds.has(t.id)).map(t => ({
              id: t.id,
              title: t.title,
              messages: [],
              created: t.created,
              updated: t.updated
            }));
            if (cache.activeConvId) state.activeConvId = cache.activeConvId;
          }
        }
      } catch (_) {}

      // 2. Load complete records from IndexedDB
      try {
        const idbConvs = await dbGetAll('conversations');
        if (idbConvs && idbConvs.length) {
          state.conversations = idbConvs.filter(c => !deletedConvIds.has(c.id)).sort((a, b) => (b.updated || 0) - (a.updated || 0));
        } else {
          // One-time automatic migration from legacy localStorage
          const r = localStorage.getItem(STORAGE_KEY);
          if (r) {
            const parsed = JSON.parse(r);
            if (Array.isArray(parsed) && parsed.length) {
              state.conversations = parsed.filter(c => !deletedConvIds.has(c.id));
              for (const c of state.conversations) {
                await dbSet('conversations', c);
              }
              localStorage.removeItem(STORAGE_KEY);
              console.info(`[DB] Migrated ${parsed.length} conversations from localStorage to IndexedDB`);
            }
          }
        }
      } catch (e) {
        console.error('[conv] IndexedDB load failed:', e);
      }

      if (!Array.isArray(state.conversations)) state.conversations = [];
      const savedActive = localStorage.getItem('SlopLobster_activeConvId');
      if (savedActive && state.conversations.some(c => c.id === savedActive)) {
        state.activeConvId = savedActive;
      } else if (state.conversations.length && !state.activeConvId) {
        state.activeConvId = state.conversations[0].id;
      }

      if (state.activeConvId) {
        const c = state.conversations.find(c => c.id === state.activeConvId);
        if (c) {
          if (c._originalTask) state.originalTask = c._originalTask;
          await restoreHarnessConversation(c);
          state.taskState = c._taskState || null;
      state.runController = null;
      state.verificationState = state.taskState?.verification || null;
          if (c.messages && c.messages.length) {
            state.messages = c.messages;
            switchToChat();
            replayMessages(state.messages);
            updateContextMeter();
            scheduleRealTokenSync();
          }
        }
      }
      renderConvList();
    }

    function saveConversations() {
      convDatabaseSaveChain = convDatabaseSaveChain.catch(() => {}).then(async () => {
      // 1. Persist to IndexedDB
      try {
        for (const c of state.conversations) {
          if (deletedConvIds.has(c.id)) continue;
          await dbSet('conversations', c);
        }
      } catch (e) {
        console.error('[DB] saveConversations error:', e);
      }

      // 2. Update lightweight cache in localStorage (titles & metadata only)
      try {
        const cache = {
          activeConvId: state.activeConvId,
          titles: state.conversations.map(c => ({
            id: c.id, title: c.title || 'Untitled',
            created: c.created, updated: c.updated,
            pinned: !!c.pinned
          }))
        };
        localStorage.setItem('SlopLobster_convCache', JSON.stringify(cache));
      } catch (_) {}
      });
      return convDatabaseSaveChain;
    }

    function saveCurrentConv() {
      if (!state.activeConvId) return;
      const c = state.conversations.find(c => c.id === state.activeConvId); if (!c) return;
      c.messages = state.messages.map(m => ({ ...m }));
      c.updated = Date.now();
      c._originalTask = state.originalTask;
      state.taskState = HarnessRuntime.captureTaskState(state);
      c._taskState = state.taskState;
      if (!c.title || c.title === 'New conversation') {
        const raw = (state.originalTask || '').trim();
        if (raw && raw !== '[Image(s) attached]' && !raw.startsWith('[')) {
          c.title = raw.slice(0, 60) + (raw.length > 60 ? '...' : '');
        } else {
          const f = state.messages.find(m =>
            m.role === 'user' &&
            m.content &&
            m.content !== '[Image(s) attached]' &&
            !m.content.startsWith('[')
          );
          if (f) c.title = f.content.slice(0, 60) + (f.content.length > 60 ? '...' : '');
        }
      }
      try {
        saveConversations();
        renderConvList();
        scheduleRealTokenSync();
      } catch (e) {
        console.error('[conv] save failed:', e);
      }
    }

    async function doNewConversation() {
      if (!state.running) releaseManagedWorkspace();
      _wsWarningDismissed = false;
      _totalOriginalChars = 0;
      _totalCompressedChars = 0;
      updateWorkspaceBanner();

      if (state.messages.length > 0 && state.activeConvId) {
        clearTimeout(_convSaveTimer);
        const prev = state.conversations.find(c => c.id === state.activeConvId);
        if (prev) await saveConvToWorkspace(prev);
      }

      const oldProgressFile = state.activeConvId
        ? `.sloplobster-progress-${state.activeConvId}.md` : null;
      if (state.dirHandle && oldProgressFile) {
        try { await deleteFileSafe(oldProgressFile, false); } catch { }
      }

      const id = 'conv_' + Date.now();
      state.conversations.unshift({
        id, title: 'New conversation',
        messages: [], created: Date.now(), updated: Date.now()
      });
      state.activeConvId = id;
      localStorage.setItem('SlopLobster_activeConvId', state.activeConvId);
      state.messages = [];
      state.fileCache.clear();
      modifiedFiles.clear(); newFiles.clear();
      state.fileBackups.clear();
      state.pendingImages = [];
      state.originalTask = null;
      state.taskState = null;
      state.runController = null;
      state.verificationState = state.taskState?.verification || null;
      state.currentPlan = null;
      state.planExecuting = false;
      state.planStepIndex = -1;
      state.planItems = [];
      state.beliefs = [];
      state.beliefNextAction = '';
      state.invariants = [];
      renderTodoChecklist();
      toolCallHistory.length = 0;
      state._autoVerifyRetries = 0;
      textLoopBuffer.length = 0;
      addImageAttachmentsToInputArea();
      rpState.clearChanges();
      rpState.activeFile = null;
      document.getElementById('rp-files-empty').style.display = '';
      document.getElementById('rp-file-preview').style.display = 'none';

      $msg().innerHTML = '';
      streamEl = null;
      document.getElementById('welcome').style.display = 'flex';
      $msg().style.display = 'none';
      saveConversations();
      renderConvList();
      updateContextMeter();
      refreshFileTree();
      saveConvToWorkspace(state.conversations[0]);
      scheduleConvIndexSave();
    }

    async function switchConv(id) {
      if (state.running) return;
      _totalOriginalChars = 0;
      _totalCompressedChars = 0;

      // Flush pending save
      if (state.activeConvId) {
        clearTimeout(_convSaveTimer);
        const prev = state.conversations.find(c => c.id === state.activeConvId);
        if (prev) await saveConvToWorkspace(prev);
      }

      const c = state.conversations.find(c => c.id === id);
      if (!c) return;

      // If conversation was loaded from cache only (no messages), try loading from workspace
      if (c.messages.length === 0 && !c._loadError && state.dirHandle) {
        try {
          await ensureConvDir();
          const slopDir = await conversationWorkspaceHandle().getDirectoryHandle('.sloplobster');
          const convDir = await slopDir.getDirectoryHandle('conversations');
          const convFile = await convDir.getFileHandle(id + '.json');
          const data = JSON.parse(await (await convFile.getFile()).text());
          if (data.messages && data.messages.length) {
            c.messages = data.messages;
            c._originalTask = data._originalTask || null;
            c._taskState = data._taskState || null;
            c._harness = data._harness || null;
          }
        } catch { /* not found, stay empty */ }
      }

      state.activeConvId = id;
      state.messages = c.messages || [];
      state.fileCache.clear();
      modifiedFiles.clear(); newFiles.clear();
      state.fileBackups.clear();
      state.pendingImages = [];
      addImageAttachmentsToInputArea();
      state.originalTask = c._originalTask || null;
      state.taskState = c._taskState || null;
      state.runController = null;
      state.verificationState = state.taskState?.verification || null;
      await restoreHarnessConversation(c);
      state.planItems = [];
      state.beliefs = [];
      state.beliefNextAction = '';
      state.invariants = [];
      renderTodoChecklist();
      state.pendingSteerMessages = [];
      renderSteerQueue();
      toolCallHistory.length = 0;
      textLoopBuffer.length = 0;
      rpState.clearChanges();
      rpState.activeFile = null;
      document.getElementById('rp-files-empty').style.display = '';
      document.getElementById('rp-file-preview').style.display = 'none';

      // Replay changes from history into right panel
      for (const m of state.messages) {
        if (m.role !== 'tool') continue;
        const tc = findParentToolCall(m); if (!tc) continue;
        if ((tc.function.name === 'edit_file' || tc.function.name === 'write_file') && m._diff) {
          rpState.addChange(m._diff.path, tc.function.name === 'write_file' ? 'created' : 'modified', m._diff);
        }
        if (tc.function.name === 'delete_file') { const a = safeParseArgs(tc.function.arguments); if (a.path) rpState.addChange(a.path, 'deleted', null); }
        if (tc.function.name === 'move_file') { const a = safeParseArgs(tc.function.arguments); if (a.destination) rpState.addChange(a.destination, 'moved', null); }
      }

      $msg().innerHTML = '';
      streamEl = null;
      if (state.messages.length) { switchToChat(); replayMessages(state.messages); updateContextMeter(); }
      else { document.getElementById('welcome').style.display = 'flex'; $msg().style.display = 'none'; }
      renderConvList();
    }


    async function forkConv(id, e) {
      if (e) e.stopPropagation();
      if (state.running) return;
      const src = state.conversations.find(c => c.id === id);
      if (!src || !src.messages.length) return;
      const newId = 'conv_' + Date.now();
      const fork = { ...src, id: newId, title: '(fork) ' + (src.title || 'Untitled'), created: Date.now(), updated: Date.now() };
      state.conversations.unshift(fork);
      if (state.dirHandle) {
        await ensureConvDir();  // fire-and-forget is fine here, saveConvToWorkspace checks again
        await saveConvToWorkspace(fork);
        scheduleConvIndexSave();
      }
      switchConv(newId);
      showToast('Conversation forked', 'ok');
    }

    async function deleteConv(id, e) {
      e?.stopPropagation();
      if (state.running || (typeof hfBusy === 'function' && hfBusy())) {
        showToast('Stop the current run before deleting a conversation', 'info'); return;
      }
      if (!state.conversations.some(c => c.id === id)) return;
      clearTimeout(_convSaveTimer);
      clearTimeout(_convIndexTimer);
      const root = conversationWorkspaceHandle();
      let deleted = false;
      deletedConvIds.add(id);
      try {
        // Drain saves before removing their files or database records.
        await convWorkspaceSaveChain;
        await convDatabaseSaveChain;
        if (root) {
          try {
            const slopDir = await root.getDirectoryHandle('.sloplobster');
            const convDir = await slopDir.getDirectoryHandle('conversations');
            await convDir.removeEntry(id + '.json');
          } catch (error) {
            if (error.name !== 'NotFoundError') throw new Error('Workspace file could not be deleted: ' + error.message);
          }
        }
        if (typeof deleteRunJournalsForConversation === 'function') await deleteRunJournalsForConversation(id);
        if (!(await dbDelete('conversations', id))) throw new Error('Browser database could not be updated');
        // A stale workspace index or legacy cache must never restore a deleted ID.
        localStorage.setItem(DELETED_CONVS_KEY, JSON.stringify([...deletedConvIds]));
        const legacy = localStorage.getItem(STORAGE_KEY);
        if (legacy) {
          const records = JSON.parse(legacy);
          if (Array.isArray(records)) localStorage.setItem(STORAGE_KEY, JSON.stringify(records.filter(c => c.id !== id)));
        }
        deleted = true;
        state.conversations = state.conversations.filter(c => c.id !== id);
        if (state.activeConvId === id) {
          state.activeConvId = null;
          state.messages = [];
          localStorage.removeItem('SlopLobster_activeConvId');
          if (state.conversations.length) await switchConv(state.conversations[0].id);
          else await doNewConversation();
        }
        await saveConversations();
        renderConvList();
        scheduleConvIndexSave();
        showToast('Conversation permanently deleted', 'info');
      } catch (error) {
        if (!deleted) deletedConvIds.delete(id);
        showToast('Delete failed: ' + error.message, 'err');
        console.warn('[conv] delete failed:', error);
      }
    }

    function filterConversations(query) { state.convSearchQuery = query.toLowerCase().trim(); renderConvList(); }

    function renderConvList() {
      const el = document.getElementById('conv-list');
      let convs = [...state.conversations];
      if (state.convSearchQuery) convs = convs.filter(c => (c.title || '').toLowerCase().includes(state.convSearchQuery));
      convs.sort((a, b) => {
        if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
        return (b.updated || 0) - (a.updated || 0);
      });

      const status = getConvStorageStatus();

      let header = '';
      if (!state.dirHandle) {
        header = '<div style="padding:4px 8px;font-size:9px;color:var(--yellow);font-family:JetBrains Mono,monospace;background:rgba(234,179,8,.06);border:1px solid rgba(234,179,8,.12);border-radius:4px;margin:0 0 4px"><i class="fas fa-triangle-exclamation" style="margin-right:3px"></i>Open workspace to persist conversations</div>';
      } else if (status.count > 0) {
        header = '<div style="padding:2px 8px;font-size:9px;color:var(--tx-4);font-family:JetBrains Mono,monospace">' + status.count + ' saved</div>';
      }

      if (!convs.length) {
        el.innerHTML = header + `<div style="padding:8px 12px;font-size:10px;color:var(--tx-4)">${state.convSearchQuery ? 'No matches' : 'No conversations yet'}</div>`;
        return;
      }
      el.innerHTML = header + convs.map(c => {
        const a = c.id === state.activeConvId ? 'active' : '';
        const ago = timeAgo(c.updated);
        const msgCount = c.messages ? c.messages.filter(m => m.role === 'user').length : 0;
        const isGhost = !c.messages.length && !c._loadError;
        const opacity = isGhost ? 'opacity:.5' : '';
        const pinBorder = c.pinned ? 'border-left:2px solid var(--accent-d);' : '';
        return `<div class="conv-item ${a}" style="${opacity}${pinBorder}" onclick="switchConv('${c.id}')">
          <i class="fas ${c.pinned ? 'fa-thumbtack' : 'fa-message'}" style="font-size:9px;color:${c.pinned ? 'var(--accent)' : 'var(--tx-4)'};flex-shrink:0"></i>
          <span class="conv-title" ondblclick="renameConv('${c.id}',event)" title="Double-click to rename">${esc(c.title || 'Untitled')}${c._loadError ? ' ⚠' : ''}</span>
          ${msgCount > 0 ? `<span style="font-size:8px;color:var(--tx-4);flex-shrink:0;font-family:'JetBrains Mono',monospace">${msgCount}m</span>` : ''}
          <span style="font-size:9px;color:var(--tx-4);flex-shrink:0;font-family:'JetBrains Mono',monospace">${ago}</span>
          <button class="conv-fork" onclick="pinConv('${c.id}',event)" title="${c.pinned ? 'Unpin' : 'Pin to top'}" style="color:${c.pinned ? 'var(--accent)' : ''}"><i class="fas fa-thumbtack"></i></button>
          <button class="conv-fork" onclick="forkConv('${c.id}',event)" title="Fork"><i class="fas fa-code-branch"></i></button>
          <button class="conv-del" onclick="deleteConv('${c.id}',event)" title="Delete"><i class="fas fa-xmark"></i></button>
        </div>`;
      }).join('');
    }

    function timeAgo(ts) {
      const s = Math.floor((Date.now() - ts) / 1000);
      if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm';
      if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd';
    }

    function pinConv(id, event) {
      event.stopPropagation();
      const c = state.conversations.find(c => c.id === id);
      if (!c) return;
      c.pinned = !c.pinned;
      saveConversations();
      renderConvList();
      showToast(c.pinned ? 'Pinned' : 'Unpinned', 'ok');
    }

    function renameConv(id, event) {
      event.stopPropagation();
      const c = state.conversations.find(c => c.id === id);
      if (!c) return;
      const titleEl = event.target;
      const oldTitle = c.title || 'Untitled';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = oldTitle;
      input.style.cssText = 'flex:1;background:var(--bg-3);color:var(--tx-0);border:1px solid var(--accent-d);border-radius:3px;padding:1px 5px;font-size:11px;font-family:inherit;outline:none;min-width:0;width:0';
      titleEl.replaceWith(input);
      input.focus();
      input.select();
      const commit = () => {
        const newTitle = input.value.trim() || oldTitle;
        c.title = newTitle;
        c.updated = Date.now();
        saveConversations();
        scheduleConvIndexSave();
        renderConvList();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = oldTitle; input.blur(); }
        e.stopPropagation();
      });
    }

    /* ═══════════════ REPLAY MESSAGES ═══════════════ */
    function replayMessages(msgs) {
      let pendingThinkText = null;
      for (let mi = 0; mi < msgs.length; mi++) {
        const m = msgs[mi];
        if (m.role === 'user') {
          if (pendingThinkText !== null) { renderStaticThinkBlock(pendingThinkText); pendingThinkText = null; }
          const el = createMsgEl('user', m.content);
          if (m._images && m._images.length) {
            const imgHtml = m._images.map(img => showMsgImage(img.image_url?.url || '', '')).join('');
            el.querySelector('.msg-content').innerHTML += (m.content ? '\n\n' : '') + '<div class="msg-img-grid">' + imgHtml + '</div>';
          }
          $msg().appendChild(el); scrollBottom();

        } else if (m.role === 'assistant') {
          if (pendingThinkText !== null) { renderStaticThinkBlock(pendingThinkText); pendingThinkText = null; }
          if (m.content) appendMsg('assistant', m.content);
          if (m.tool_calls) {
            for (const tc of m.tool_calls) {
              if (tc.function.name === 'think') continue;
              if (tc.function.name === 'web_search') {
                const toolMsg = msgs.find((tm, ti) => ti > mi && tm.role === 'tool' && tm.tool_call_id === tc.id);
                if (toolMsg && toolMsg._searchData) {
                  showSearchPanel(toolMsg._searchData);
                } else {
                  const panel = showToolPanel(tc.function.name, tc.function.arguments, 'ok', null, tc.id);
                  const tm2 = msgs.find((tm, ti) => ti > mi && tm.role === 'tool' && tm.tool_call_id === tc.id);
                  if (tm2) {
                    updateToolStatus(panel, 'ok');
                    updateToolResult(panel, tm2.content);
                  } else {
                    updateToolStatus(panel, 'err');
                    updateToolResult(panel, '[Tool result not found in saved conversation]');
                  }
                }
                continue;
              }
              const panel = showToolPanel(tc.function.name, tc.function.arguments, 'ok', null, tc.id);
              const toolMsg = msgs.find((tm, ti) => ti > mi && tm.role === 'tool' && tm.tool_call_id === tc.id);
              if (toolMsg) {
                updateToolStatus(panel, 'ok');
                updateToolResult(panel, toolMsg.content);
                if (toolMsg._diff) showDiffPanel(toolMsg._diff);

                // Replay image previews from file reads
                if (toolMsg._imageDataUrl && !toolMsg._screenshotDataUrl) {
                  panel.el.classList.add('screenshot-tool');
                  const preview = document.createElement('div');
                  preview.className = 'screenshot-preview';
                  preview.innerHTML = '<div style="font-size:10px;color:var(--tx-3);margin-bottom:4px;font-family:\'JetBrains Mono\',monospace"><i class="fas fa-image" style="color:var(--accent)"></i> ' + esc(toolMsg._imagePath || 'image') + '</div><img src="' + toolMsg._imageDataUrl + '" onclick="openImgViewer(this.src)" alt="image">';
                  panel.el.appendChild(preview);
                }

                /* ── SVG preview replay ── */
                if (toolMsg._svgPreviewUrl && !panel.el.querySelector('.svg-preview')) {
                  panel.el.classList.add('screenshot-tool');
                  const prev = document.createElement('div');
                  prev.className = 'svg-preview';
                  const path = esc(toolMsg._svgPath || 'file.svg');
                  prev.innerHTML =
                    '<div class="svg-toggle-row">' +
                    '<span><i class="fas fa-bezier-curve" style="color:var(--accent);margin-right:4px"></i>' + path + '</span>' +
                    '<button class="svg-toggle-btn" onclick="toggleSvgView(this)">View Code</button>' +
                    '</div>' +
                    '<img class="svg-preview-img" src="' + toolMsg._svgPreviewUrl + '" onclick="openImgViewer(this.src)" alt="' + path + '">' +
                    '<div class="svg-code-view"><pre><code class="language-xml">' + esc(toolMsg._svgText || '') + '</code></pre></div>';
                  panel.el.appendChild(prev);
                }

                /* ── Non-vision raster preview replay ── */
                if (toolMsg._previewDataUrl && !toolMsg._imageDataUrl && !panel.el.querySelector('.image-preview-only')) {
                  panel.el.classList.add('screenshot-tool');
                  const prev = document.createElement('div');
                  prev.className = 'image-preview-only';
                  const path = esc(toolMsg._previewPath || 'image');
                  prev.innerHTML =
                    '<div class="img-label"><i class="fas fa-image" style="color:var(--accent)"></i>' + path + '</div>' +
                    '<img src="' + toolMsg._previewDataUrl + '" onclick="openImgViewer(this.src)" alt="' + path + '">';
                  panel.el.appendChild(prev);
                }

                // Handle reloaded conversations that had image previews
                if (toolMsg._hadImagePreview && !toolMsg._imageDataUrl) {
                  panel.el.classList.add('screenshot-tool');
                  const preview = document.createElement('div');
                  preview.className = 'screenshot-preview';
                  preview.innerHTML = '<div style="font-size:10px;color:var(--tx-4);padding:12px;text-align:center"><i class="fas fa-image" style="margin-right:4px"></i>Image preview not available (page was reloaded)</div>';
                  panel.el.appendChild(preview);
                }

                /* ── Sub-agent panel replay ── */
                if (toolMsg._subAgentData) {
                  showSubAgentPanel(toolMsg._subAgentData);
                  const res = panel.el.querySelector('.tool-result');
                  if (res) res.style.display = 'none';
                }


                /* ── Swarm panel replay ── */
                if (toolMsg._swarmData) {
                  showSwarmPanel(toolMsg._swarmData, panel.el);
                  const res = panel.el.querySelector('.tool-result');
                  if (res) res.style.display = 'none';
                }

                /* ── Deep Research panel replay ── */
                if (toolMsg._researchData) {
                  showResearchPanel(toolMsg._researchData, panel.el);
                  const res = panel.el.querySelector('.tool-result');
                  if (res) res.style.display = 'none';
                }
              } else {
                // Tool result message was not found (corrupted/truncated localStorage)
                updateToolStatus(panel, 'err');
                updateToolResult(panel, '[Tool result not found in saved conversation data]');
              }
            }
          }

        } else if (m.role === 'tool') {
          const parentMsg = msgs[mi - 1];
          if (parentMsg?.tool_calls) {
            const tc = parentMsg.tool_calls.find(tc => tc.id === m.tool_call_id);
            if (tc && tc.function.name === 'think') { pendingThinkText = m.content; continue; }
          }
          if (pendingThinkText !== null) { renderStaticThinkBlock(pendingThinkText); pendingThinkText = null; }
        }
      }
      if (pendingThinkText !== null) renderStaticThinkBlock(pendingThinkText);
    }

    /* ═══════════════ SETTINGS PROFILES (safety/tools bundles) ═══════════════ */
    const BUILTIN_SAFETY_PROFILES = {
      'Balanced (default)': {
        disabledTools: [],
        shellAutoApprove: false, shellAutoApproveDangerous: false,
        gitWriteAutoApprove: false, browserWriteAutoApprove: false,
        requireEditApproval: true, allowAskUser: true
      },
      'Fully Autonomous': {
        disabledTools: [],
        shellAutoApprove: true, shellAutoApproveDangerous: true,
        gitWriteAutoApprove: true, browserWriteAutoApprove: true,
        requireEditApproval: false, allowAskUser: false
      },
      'Review Only (no writes)': {
        disabledTools: ['edit_file', 'write_file', 'write_file_chunked', 'delete_file', 'move_file', 'execute_command', 'run_tests', 'start_dev_server', 'git_add', 'git_commit', 'git_push', 'git_checkout_branch', 'git_stash', 'browser_click', 'browser_type', 'browser_evaluate', 'browser_select_option', 'browser_press_key', 'browser_scroll', 'browser_hover', 'browser_go_back', 'browser_go_forward', 'http_request', 'save_memory'],
        shellAutoApprove: false, shellAutoApproveDangerous: false,
        gitWriteAutoApprove: false, browserWriteAutoApprove: false,
        requireEditApproval: true, allowAskUser: true
      },
      'Minimal / Low-Context': {
        disabledTools: ['think'], compactTools: true, compactPrompt: true,
        shellAutoApprove: false, shellAutoApproveDangerous: false,
        gitWriteAutoApprove: false, browserWriteAutoApprove: false,
        requireEditApproval: true, allowAskUser: true
      }
    };

    function renderSafetyProfiles() {
      const sel = document.getElementById('s-safety-profile');
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">Custom (current settings)</option>';
      const addGroup = (label, names) => {
        const grp = document.createElement('optgroup'); grp.label = label;
        for (const name of names) { const opt = document.createElement('option'); opt.value = name; opt.textContent = name; grp.appendChild(opt); }
        sel.appendChild(grp);
      };
      addGroup('Built-in', Object.keys(BUILTIN_SAFETY_PROFILES));
      if (Object.keys(state.safetyProfiles || {}).length) addGroup('Custom', Object.keys(state.safetyProfiles));
      sel.value = current || '';
    }

    function getSafetyProfileByName(name) {
      return BUILTIN_SAFETY_PROFILES[name] || (state.safetyProfiles || {})[name] || null;
    }

    // Applies a profile's settings to `state` and, if the settings modal is open,
    // reflects them into the visible checkboxes too. Persists immediately —
    // choosing a profile is a deliberate action, not a draft edit.
    function applySafetyProfile(profile) {
      state.disabledTools = new Set(profile.disabledTools || []);
      state.compactTools = !!profile.compactTools; state.compactPrompt = !!profile.compactPrompt;
      state.discoveredTools = new Set();
      state.shellAutoApprove = !!profile.shellAutoApprove;
      state.shellAutoApproveDangerous = !!profile.shellAutoApproveDangerous;
      state.gitWriteAutoApprove = !!profile.gitWriteAutoApprove;
      state.browserWriteAutoApprove = !!profile.browserWriteAutoApprove;
      state.requireEditApproval = profile.requireEditApproval !== false;
      state.allowAskUser = profile.allowAskUser !== false;

      const set = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
      set('s-shell-autoapprove', state.shellAutoApprove);
      set('s-shell-autoapprove-dangerous', state.shellAutoApproveDangerous);
      const dangerCb = document.getElementById('s-shell-autoapprove-dangerous'); if (dangerCb) dangerCb.disabled = !state.shellAutoApprove;
      set('s-git-autoapprove', state.gitWriteAutoApprove);
      set('s-browser-autoapprove', state.browserWriteAutoApprove);
      set('s-require-approval', state.requireEditApproval);
      set('s-allow-ask-user', state.allowAskUser);
      set('s-compact-tools', state.compactTools); set('s-compact-prompt', state.compactPrompt);
      renderToolToggleList();
      renderToolList();
      persistSettings();
    }

    window.applySafetyProfileByName = function (name) {
      if (!name) return; // "Custom" selected — leave settings as-is
      const profile = getSafetyProfileByName(name);
      if (!profile) return;
      applySafetyProfile(profile);
      showToast(`Applied profile: ${name}`, 'ok');
    };

    window.saveSafetyProfile = function () {
      const name = prompt('Name for this settings profile:');
      if (!name || !name.trim()) return;
      const trimmed = name.trim();
      if (BUILTIN_SAFETY_PROFILES[trimmed]) { showToast('That name is reserved for a built-in profile — pick another.', 'err'); return; }
      state.safetyProfiles = state.safetyProfiles || {};
      state.safetyProfiles[trimmed] = {
        disabledTools: Array.from(state.disabledTools || []),
        compactTools: state.compactTools, compactPrompt: state.compactPrompt,
        shellAutoApprove: state.shellAutoApprove,
        shellAutoApproveDangerous: state.shellAutoApproveDangerous,
        gitWriteAutoApprove: state.gitWriteAutoApprove,
        browserWriteAutoApprove: state.browserWriteAutoApprove,
        requireEditApproval: state.requireEditApproval,
        allowAskUser: state.allowAskUser
      };
      renderSafetyProfiles();
      document.getElementById('s-safety-profile').value = trimmed;
      persistSettings();
      showToast(`Saved profile: ${trimmed}`, 'ok');
    };

    window.deleteSafetyProfile = function () {
      const sel = document.getElementById('s-safety-profile');
      const name = sel.value;
      if (!name) return;
      if (BUILTIN_SAFETY_PROFILES[name]) { showToast('Built-in profiles can\'t be deleted.', 'err'); return; }
      delete (state.safetyProfiles || {})[name];
      renderSafetyProfiles();
      sel.value = '';
      persistSettings();
    };

    function renderSysProfiles() {
      const sel = document.getElementById('s-sys-profile');
      if (!sel) return;
      sel.innerHTML = '<option value="default">Default</option>';
      for (const name of Object.keys(state.sysPromptProfiles)) {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        sel.appendChild(opt);
      }
    }
    window.loadSysProfile = function () {
      const p = document.getElementById('s-sys-profile').value;
      if (p === 'default') document.getElementById('s-sys-prompt').value = DEFAULT_SYS;
      else if (state.sysPromptProfiles[p]) document.getElementById('s-sys-prompt').value = state.sysPromptProfiles[p];
    }
    window.saveSysProfile = function () {
      const name = prompt('Name for this system prompt preset:');
      if (!name) return;
      state.sysPromptProfiles[name] = document.getElementById('s-sys-prompt').value;
      renderSysProfiles();
      document.getElementById('s-sys-profile').value = name;
      persistSettings();
    }
    window.deleteSysProfile = function () {
      const p = document.getElementById('s-sys-profile').value;
      if (p === 'default') return;
      delete state.sysPromptProfiles[p];
      renderSysProfiles();
      loadSysProfile();
      persistSettings();
    }

    /* ═══════════════ SETTINGS ═══════════════ */
    function loadSettings() {
      state.compToken = sessionStorage.getItem('SlopLobster_compToken:' + state.compUrl) || '';
      try {
        const r = localStorage.getItem(SETTINGS_KEY); if (!r) return; const s = JSON.parse(r);
        if (s.apiUrl) state.apiUrl = s.apiUrl; if (s.compUrl) state.compUrl = s.compUrl;
        state.compToken = sessionStorage.getItem('SlopLobster_compToken:' + state.compUrl) || '';
        if (s.backendType) state.backendType = s.backendType;
        if (s.llamacppVision !== undefined) state.llamacppVision = s.llamacppVision;
        for (const key of ['maxRunMinutes', 'streamIdleSeconds', 'compactTools', 'compactPrompt', 'journalEnabled']) if (s[key] !== undefined) state[key] = s[key];
        if (s.temp !== undefined) state.temp = s.temp;
        if (s.topP !== undefined) state.topP = s.topP;
        if (s.topK !== undefined) state.topK = s.topK;
        if (s.minP !== undefined) state.minP = s.minP;
        if (s.repeatPenalty !== undefined) state.repeatPenalty = s.repeatPenalty;
        if (s.useServerSampling !== undefined) state.useServerSampling = s.useServerSampling;
        if (s.frequencyPenalty !== undefined) state.frequencyPenalty = s.frequencyPenalty;
        if (s.seed !== undefined) state.seed = s.seed;
        if (s.dryMultiplier !== undefined) state.dryMultiplier = s.dryMultiplier;
        if (s.dryBase !== undefined) state.dryBase = s.dryBase;
        if (s.dryAllowedLength !== undefined) state.dryAllowedLength = s.dryAllowedLength;
        if (s.drySequenceBreakers !== undefined) state.drySequenceBreakers = s.drySequenceBreakers;
        if (s.xtcProbability !== undefined) state.xtcProbability = s.xtcProbability;
        if (s.xtcThreshold !== undefined) state.xtcThreshold = s.xtcThreshold;
        if (s.mirostat !== undefined) state.mirostat = s.mirostat;
        if (s.mirostatTau !== undefined) state.mirostatTau = s.mirostatTau;
        if (s.mirostatEta !== undefined) state.mirostatEta = s.mirostatEta;
        if (s.enforceJsonSchema !== undefined) state.enforceJsonSchema = s.enforceJsonSchema;
        if (s.maxTokens) state.maxTokens = s.maxTokens;
        if (s.maxReadKB) state.maxReadKB = s.maxReadKB; if (s.cmdTimeout) state.cmdTimeout = s.cmdTimeout;
        if (s.ctxWindow) state.ctxWindow = s.ctxWindow; if (s.autoCompactPct) state.autoCompactPct = s.autoCompactPct;
        if (s.memoryAgentEnabled !== undefined) state.memoryAgentEnabled = s.memoryAgentEnabled;
        if (s.compactTokenThreshold !== undefined) state.compactTokenThreshold = s.compactTokenThreshold;
        if (s.memoryAgentModel !== undefined) state.memoryAgentModel = s.memoryAgentModel;
        if (s.maxIters) state.maxIters = s.maxIters;
        if (s.verifyWrites !== undefined) state.verifyWrites = s.verifyWrites;
        if (s.modelCtxOverride !== undefined) state.modelCtxOverride = s.modelCtxOverride;
        if (s.modelFlashAttn !== undefined) state.modelFlashAttn = s.modelFlashAttn;
        if (s.modelKvOffload !== undefined) state.modelKvOffload = s.modelKvOffload;
        if (s.modelNumExperts !== undefined) state.modelNumExperts = s.modelNumExperts;
        if (s.modelEvalBatch !== undefined) state.modelEvalBatch = s.modelEvalBatch;
        if (s.useModelLoadDefaults !== undefined) state.useModelLoadDefaults = s.useModelLoadDefaults;
        if (s.sysPrompt) document.getElementById('s-sys-prompt').value = s.sysPrompt;
        if (s.sysPromptProfiles) state.sysPromptProfiles = s.sysPromptProfiles;
        if (s.safetyProfiles) state.safetyProfiles = s.safetyProfiles;
        if (s.requireEditApproval !== undefined) state.requireEditApproval = s.requireEditApproval;
        if (s.clarifyMode !== undefined) state.clarifyMode = s.clarifyMode;
        if (s.allowAskUser !== undefined) state.allowAskUser = s.allowAskUser;
        if (s.notificationsEnabled !== undefined) state.notificationsEnabled = s.notificationsEnabled;
        if (s.experimentalMode !== undefined) state.experimentalMode = s.experimentalMode;
        if (s.clarifyCount !== undefined) state.clarifyCount = s.clarifyCount;
        if (s.autoVerifyCommand !== undefined) state.autoVerifyCommand = s.autoVerifyCommand;
        if (s.autoVerifyMaxRetries !== undefined) state.autoVerifyMaxRetries = s.autoVerifyMaxRetries;
        if (s.smartContextThreshold !== undefined) state.smartContextThreshold = s.smartContextThreshold; else state.smartContextThreshold = 150;
        if (s.tokenBudget !== undefined) state.tokenBudget = s.tokenBudget;
        if (s.qwenEnableThinking !== undefined) document.getElementById('s-qwen-enable-thinking').checked = s.qwenEnableThinking;
        if (s.qwenPreserveThinking !== undefined) document.getElementById('s-qwen-preserve-thinking').checked = s.qwenPreserveThinking;
        if (s.wsWarningDismissed !== undefined) _wsWarningDismissed = s.wsWarningDismissed;
        if (s.mcpConfig) {
          state.mcpConfig = s.mcpConfig;
          const _mcInp = document.getElementById('s-mcp-config');
          if (_mcInp) _mcInp.value = s.mcpConfig;
        }
        if (s.mcpConfigProfiles) state.mcpConfigProfiles = s.mcpConfigProfiles;
        if (s.mcpConfigHistory) state.mcpConfigHistory = s.mcpConfigHistory;
        if (s.shellAutoApprove !== undefined) state.shellAutoApprove = s.shellAutoApprove;
        if (s.shellAutoApproveDangerous !== undefined) state.shellAutoApproveDangerous = s.shellAutoApproveDangerous;
        if (s.gitWriteAutoApprove !== undefined) state.gitWriteAutoApprove = s.gitWriteAutoApprove;
        if (s.browserWriteAutoApprove !== undefined) state.browserWriteAutoApprove = s.browserWriteAutoApprove;
        if (Array.isArray(s.disabledTools)) state.disabledTools = new Set(s.disabledTools);
      } catch { }
      renderSysProfiles();
      renderSafetyProfiles();
      renderMcpProfiles();
      document.getElementById('s-ctx-window').value = state.ctxWindow;
      updateContextMeter();
      const _shellCb = document.getElementById('s-shell-autoapprove'); if (_shellCb) _shellCb.checked = state.shellAutoApprove;
      const _shellDangerCb = document.getElementById('s-shell-autoapprove-dangerous'); if (_shellDangerCb) { _shellDangerCb.checked = state.shellAutoApproveDangerous; _shellDangerCb.disabled = !state.shellAutoApprove; }
      const _gitCb = document.getElementById('s-git-autoapprove'); if (_gitCb) _gitCb.checked = state.gitWriteAutoApprove;
      const _browserCb = document.getElementById('s-browser-autoapprove'); if (_browserCb) _browserCb.checked = state.browserWriteAutoApprove;
      renderToolToggleList();
    }

    function exportSettingsFile() {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) { showToast('No settings to export yet', 'warn'); return; }
      const blob = new Blob([raw], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'sloplobster-settings.json';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      showToast('Settings exported', 'ok');
    }

    function importSettingsFile(input) {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a settings object');
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
          loadSettings();
          showToast('Settings imported', 'ok');
        } catch (e) {
          showToast('Invalid settings file: ' + e.message, 'err');
        } finally {
          input.value = ''; // allow re-importing the same file later
        }
      };
      reader.onerror = () => { showToast('Could not read file', 'err'); input.value = ''; };
      reader.readAsText(file);
    }

    function persistSettings() {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
          apiUrl: state.apiUrl,
          compUrl: state.compUrl,
          backendType: state.backendType,
          llamacppVision: state.llamacppVision,
          temp: state.temp,
          topP: state.topP,
          topK: state.topK,
          minP: state.minP,
          repeatPenalty: state.repeatPenalty,
          useServerSampling: state.useServerSampling,
          frequencyPenalty: state.frequencyPenalty,
          seed: state.seed,
          dryMultiplier: state.dryMultiplier,
          dryBase: state.dryBase,
          dryAllowedLength: state.dryAllowedLength,
          drySequenceBreakers: state.drySequenceBreakers,
          xtcProbability: state.xtcProbability,
          xtcThreshold: state.xtcThreshold,
          mirostat: state.mirostat,
          mirostatTau: state.mirostatTau,
          mirostatEta: state.mirostatEta,
          enforceJsonSchema: state.enforceJsonSchema,
          maxTokens: state.maxTokens,
          maxReadKB: state.maxReadKB,
          cmdTimeout: state.cmdTimeout,
          ctxWindow: state.ctxWindow,
          autoCompactPct: state.autoCompactPct,
          memoryAgentEnabled: state.memoryAgentEnabled,
          compactTokenThreshold: state.compactTokenThreshold,
          memoryAgentModel: state.memoryAgentModel,
          maxIters: state.maxIters,
          journalEnabled: state.journalEnabled,
          maxRunMinutes: state.maxRunMinutes, streamIdleSeconds: state.streamIdleSeconds,
          compactTools: state.compactTools, compactPrompt: state.compactPrompt,
          verifyWrites: state.verifyWrites,
          modelCtxOverride: state.modelCtxOverride,
          modelFlashAttn: state.modelFlashAttn,
          modelKvOffload: state.modelKvOffload,
          modelNumExperts: state.modelNumExperts,
          modelEvalBatch: state.modelEvalBatch,
          useModelLoadDefaults: state.useModelLoadDefaults,
          sysPrompt: document.getElementById('s-sys-prompt').value,
          sysPromptProfiles: state.sysPromptProfiles,
          safetyProfiles: state.safetyProfiles,
          requireEditApproval: state.requireEditApproval,
          clarifyMode: state.clarifyMode,
          allowAskUser: state.allowAskUser,
          notificationsEnabled: state.notificationsEnabled,
          experimentalMode: state.experimentalMode,
          clarifyCount: state.clarifyCount,
          autoVerifyCommand: state.autoVerifyCommand,
          autoVerifyMaxRetries: state.autoVerifyMaxRetries,
          wsWarningDismissed: _wsWarningDismissed,
          smartContextThreshold: state.smartContextThreshold,
          tokenBudget: state.tokenBudget,
          qwenEnableThinking: document.getElementById('s-qwen-enable-thinking')?.checked ?? true,
          qwenPreserveThinking: document.getElementById('s-qwen-preserve-thinking')?.checked ?? true,
          mcpConfig: document.getElementById('s-mcp-config')?.value || '',
          mcpConfigProfiles: state.mcpConfigProfiles || {},
          mcpConfigHistory: state.mcpConfigHistory || [],
          shellAutoApprove: state.shellAutoApprove,
          shellAutoApproveDangerous: state.shellAutoApproveDangerous,
          gitWriteAutoApprove: state.gitWriteAutoApprove,
          browserWriteAutoApprove: state.browserWriteAutoApprove,
          disabledTools: Array.from(state.disabledTools || [])
        }));
      } catch { }
    }

    function switchSettingsTab(tabName) {
      const tabs = ['general', 'sampling', 'tools', 'prompt', 'advanced'];
      tabs.forEach(t => {
        const btn = document.getElementById('stab-btn-' + t);
        const panel = document.getElementById('stab-' + t);
        if (btn) btn.classList.toggle('active', t === tabName);
        if (panel) panel.classList.toggle('active', t === tabName);
      });
    }

    function exportConversationsJson() {
      const json = JSON.stringify(state.conversations, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `SlopLobster-backup-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('All conversations exported to JSON', 'ok');
    }

    function clearTokenCountCache() {
      _tokenCountCache.clear();
      state._realConvTokens = 0;
      scheduleRealTokenSync();
      showToast('Token cache cleared and refreshed', 'ok');
    }

    function onBackendTypeChange(val, silent) {
      const hint = document.getElementById('s-backend-hint');
      const urlInp = document.getElementById('s-api-url');
      const modelLoadSection = document.querySelector('.modal [style*="Model Load Settings"]')?.closest('[style*="border-top"]');
      const visionField = document.getElementById('s-llamacpp-vision-field');
      if (val === 'llamacpp') {
        if (hint) hint.textContent = 'llama.cpp server: no model load/unload via API. Uses /v1/models & /v1/chat/completions. Default port 8080.';
        if (urlInp && urlInp.value === 'http://localhost:1234') urlInp.value = 'http://localhost:8080';
        if (modelLoadSection) modelLoadSection.style.opacity = '0.4';
        if (visionField) visionField.style.display = '';
      } else {
        if (hint) hint.textContent = 'LM Studio: full model load/unload support. Default port 1234.';
        if (urlInp && urlInp.value === 'http://localhost:8080') urlInp.value = 'http://localhost:1234';
        if (modelLoadSection) modelLoadSection.style.opacity = '';
        if (visionField) visionField.style.display = 'none';
      }
    }

    function openSettings(defaultTab) {
      if (defaultTab) switchSettingsTab(defaultTab);
      const _shellCb2 = document.getElementById('s-shell-autoapprove'); if (_shellCb2) _shellCb2.checked = state.shellAutoApprove;
      const _shellDangerCb2 = document.getElementById('s-shell-autoapprove-dangerous'); if (_shellDangerCb2) { _shellDangerCb2.checked = state.shellAutoApproveDangerous; _shellDangerCb2.disabled = !state.shellAutoApprove; }
      const _gitCb2 = document.getElementById('s-git-autoapprove'); if (_gitCb2) _gitCb2.checked = state.gitWriteAutoApprove;
      const _browserCb2 = document.getElementById('s-browser-autoapprove'); if (_browserCb2) _browserCb2.checked = state.browserWriteAutoApprove;
      renderToolToggleList();
      renderSafetyProfiles();
      document.getElementById('s-api-url').value = state.apiUrl; document.getElementById('s-comp-url').value = state.compUrl;
      document.getElementById('s-comp-token').value = state.compToken;
      document.getElementById('s-backend-type').value = state.backendType || 'lmstudio';
      onBackendTypeChange(state.backendType || 'lmstudio', true);
      const _lcvCb = document.getElementById('s-llamacpp-vision'); if (_lcvCb) _lcvCb.checked = !!state.llamacppVision;
      document.getElementById('s-temp').value = state.temp; document.getElementById('s-temp-val').textContent = state.temp;
      const _sTopP = document.getElementById('s-top-p'); if (_sTopP) { _sTopP.value = state.topP !== undefined ? state.topP : 0.95; document.getElementById('s-top-p-val').textContent = (state.topP !== undefined ? state.topP : 0.95).toFixed(2); }
      const _sTopK = document.getElementById('s-top-k'); if (_sTopK) { _sTopK.value = state.topK !== undefined ? state.topK : 40; document.getElementById('s-top-k-val').textContent = state.topK !== undefined ? state.topK : 40; }
      const _sMinP = document.getElementById('s-min-p'); if (_sMinP) { _sMinP.value = state.minP !== undefined ? state.minP : 0.05; document.getElementById('s-min-p-val').textContent = (state.minP !== undefined ? state.minP : 0.05).toFixed(2); }
      const _sRepP = document.getElementById('s-repeat-penalty'); if (_sRepP) { _sRepP.value = state.repeatPenalty !== undefined ? state.repeatPenalty : 1.1; document.getElementById('s-repeat-penalty-val').textContent = (state.repeatPenalty !== undefined ? state.repeatPenalty : 1.1).toFixed(2); }
      const _sUseServerSampling = document.getElementById('s-use-server-sampling');
      if (_sUseServerSampling) {
        _sUseServerSampling.checked = !!state.useServerSampling;
        const _samplingGroup = document.getElementById('sampling-sliders-group');
        const _advSamplingGroup = document.getElementById('advanced-samplers-group');
        const _qwenGroup = document.getElementById('qwen-thinking-group');
        if (_samplingGroup) { _samplingGroup.style.opacity = state.useServerSampling ? '.35' : ''; _samplingGroup.style.pointerEvents = state.useServerSampling ? 'none' : ''; }
        if (_advSamplingGroup) { _advSamplingGroup.style.opacity = state.useServerSampling ? '.35' : ''; _advSamplingGroup.style.pointerEvents = state.useServerSampling ? 'none' : ''; }
        if (_qwenGroup) { _qwenGroup.style.opacity = state.useServerSampling ? '.35' : ''; _qwenGroup.style.pointerEvents = state.useServerSampling ? 'none' : ''; }
      }
      const _sUseModelLoadDefaults = document.getElementById('s-use-model-load-defaults');
      if (_sUseModelLoadDefaults) {
        _sUseModelLoadDefaults.checked = !!state.useModelLoadDefaults;
        const _loadOverridesGroup = document.getElementById('model-load-overrides-group');
        if (_loadOverridesGroup) { _loadOverridesGroup.style.opacity = state.useModelLoadDefaults ? '.35' : ''; _loadOverridesGroup.style.pointerEvents = state.useModelLoadDefaults ? 'none' : ''; }
      }
      const _sFreqP = document.getElementById('s-freq-penalty'); if (_sFreqP) { _sFreqP.value = state.frequencyPenalty || 0; document.getElementById('s-freq-penalty-val').textContent = (state.frequencyPenalty || 0).toFixed(2); }
      const _sSeed = document.getElementById('s-seed'); if (_sSeed) _sSeed.value = state.seed !== undefined ? state.seed : -1;
      const _sDryMult = document.getElementById('s-dry-multiplier'); if (_sDryMult) { _sDryMult.value = state.dryMultiplier || 0; document.getElementById('s-dry-multiplier-val').textContent = (state.dryMultiplier || 0).toFixed(1); }
      const _sDryBase = document.getElementById('s-dry-base'); if (_sDryBase) _sDryBase.value = state.dryBase !== undefined ? state.dryBase : 1.75;
      const _sDryAllowed = document.getElementById('s-dry-allowed-length'); if (_sDryAllowed) _sDryAllowed.value = state.dryAllowedLength !== undefined ? state.dryAllowedLength : 2;
      const _sXtcProb = document.getElementById('s-xtc-prob'); if (_sXtcProb) { _sXtcProb.value = state.xtcProbability || 0; document.getElementById('s-xtc-prob-val').textContent = (state.xtcProbability || 0).toFixed(2); }
      const _sXtcThresh = document.getElementById('s-xtc-threshold'); if (_sXtcThresh) _sXtcThresh.value = state.xtcThreshold !== undefined ? state.xtcThreshold : 0.1;
      const _sMirostat = document.getElementById('s-mirostat'); if (_sMirostat) _sMirostat.value = state.mirostat || 0;
      const _sMirostatTau = document.getElementById('s-mirostat-tau'); if (_sMirostatTau) _sMirostatTau.value = state.mirostatTau !== undefined ? state.mirostatTau : 5.0;
      const _sMirostatEta = document.getElementById('s-mirostat-eta'); if (_sMirostatEta) _sMirostatEta.value = state.mirostatEta !== undefined ? state.mirostatEta : 0.1;
      const _sEjs = document.getElementById('s-enforce-json-schema'); if (_sEjs) _sEjs.checked = state.enforceJsonSchema !== undefined ? state.enforceJsonSchema : true;
      document.getElementById('s-max-tokens').value = state.maxTokens; document.getElementById('s-max-read').value = state.maxReadKB;
      document.getElementById('s-cmd-timeout').value = state.cmdTimeout; document.getElementById('s-ctx-window').value = state.ctxWindow;
      document.getElementById('s-auto-compact').value = state.autoCompactPct; document.getElementById('s-verify-writes').checked = state.verifyWrites;
      const _memAgentCb = document.getElementById('s-memory-agent-enabled'); if (_memAgentCb) _memAgentCb.checked = state.memoryAgentEnabled;
      const _compactTokEl = document.getElementById('s-compact-token-threshold'); if (_compactTokEl) _compactTokEl.value = state.compactTokenThreshold;
      const _memAgentModelEl = document.getElementById('s-memory-agent-model'); if (_memAgentModelEl) _memAgentModelEl.value = state.memoryAgentModel;
      document.getElementById('s-model-ctx').value = state.modelCtxOverride;
      document.getElementById('s-model-flash').checked = state.modelFlashAttn;
      document.getElementById('s-model-kv').checked = state.modelKvOffload;
      document.getElementById('s-model-experts').value = state.modelNumExperts;
      document.getElementById('s-model-eval').value = state.modelEvalBatch;
      document.getElementById('s-max-iters').value = state.maxIters;
      document.getElementById('s-run-minutes').value = state.maxRunMinutes;
      document.getElementById('s-run-journal').checked = state.journalEnabled;
      document.getElementById('s-stream-idle').value = state.streamIdleSeconds;
      document.getElementById('s-compact-tools').checked = state.compactTools;
      document.getElementById('s-compact-prompt').checked = state.compactPrompt;
      document.getElementById('s-require-approval').checked = state.requireEditApproval;
      document.getElementById('s-clarify-mode').checked = state.clarifyMode;
      const _allowAskCb = document.getElementById('s-allow-ask-user'); if (_allowAskCb) _allowAskCb.checked = state.allowAskUser;
      const _notifCb = document.getElementById('s-notifications'); if (_notifCb) _notifCb.checked = state.notificationsEnabled;
      const _expCb = document.getElementById('s-experimental-mode'); if (_expCb) _expCb.checked = state.experimentalMode;
      document.getElementById('s-clarify-count').value = state.clarifyCount;
      document.getElementById('s-auto-verify').value = state.autoVerifyCommand || '';
      document.getElementById('s-auto-verify-retries').value = state.autoVerifyMaxRetries;
      document.getElementById('s-smart-context').value = state.smartContextThreshold;
      document.getElementById('s-token-budget').value = state.tokenBudget;
      const _mcpInp = document.getElementById('s-mcp-config');
      if (_mcpInp) _mcpInp.value = state.mcpConfig || '';
      renderMcpProfiles();
      syncMcpHighlight();
      if (!document.getElementById('s-sys-prompt').value) document.getElementById('s-sys-prompt').value = DEFAULT_SYS;

      document.getElementById('settings-modal').classList.add('open');
    }
    function closeSettings() { document.getElementById('settings-modal').classList.remove('open'); }
    function openShortcuts() { document.getElementById('shortcuts-modal').classList.add('open'); }
    function closeShortcuts() { document.getElementById('shortcuts-modal').classList.remove('open'); }

    function saveSettings() {
      state.journalEnabled = document.getElementById('s-run-journal').checked;
      state.maxRunMinutes = Math.max(0, Number(document.getElementById('s-run-minutes').value) || 0);
      state.streamIdleSeconds = Math.max(1, Number(document.getElementById('s-stream-idle').value) || 120);
      state.maxIters = Math.max(1, Math.min(500, Number(document.getElementById('s-max-iters').value) || 50));
      state.compactTools = document.getElementById('s-compact-tools').checked;
      state.compactPrompt = document.getElementById('s-compact-prompt').checked;
      _cachedReferenceSection = '';
      state._sysPromptCacheKey = null;
      state._sysPromptCacheText = null;
      invalidateSubAgentPromptCache();
      const u = document.getElementById('s-api-url').value.replace(/\/+$/, '');
      if (!/^https?:\/\/.+/.test(u)) { showToast('Invalid API URL', 'warn'); return; }
      state.apiUrl = u;
      state.backendType = document.getElementById('s-backend-type').value || 'lmstudio';
      if (state.backendType === 'llamacpp') { state.llamacppVision = document.getElementById('s-llamacpp-vision')?.checked ?? false; updateVisionUI(); }
      const cu = document.getElementById('s-comp-url').value.replace(/\/+$/, '');
      if (!/^https?:\/\/.+/.test(cu)) { showToast('Invalid companion URL', 'warn'); return; }
      state.compUrl = cu;
      state.compToken = document.getElementById('s-comp-token').value.trim();
      sessionStorage.setItem('SlopLobster_compToken:' + cu, state.compToken);
      state.temp = parseFloat(document.getElementById('s-temp').value);
      const _topPInp = document.getElementById('s-top-p'); if (_topPInp) state.topP = parseFloat(_topPInp.value);
      const _topKInp = document.getElementById('s-top-k'); if (_topKInp) state.topK = parseInt(_topKInp.value) || 0;
      const _minPInp = document.getElementById('s-min-p'); if (_minPInp) state.minP = parseFloat(_minPInp.value);
      const _repPInp = document.getElementById('s-repeat-penalty'); if (_repPInp) state.repeatPenalty = parseFloat(_repPInp.value);
      const _sUseServerSampling2 = document.getElementById('s-use-server-sampling'); if (_sUseServerSampling2) state.useServerSampling = _sUseServerSampling2.checked;
      const _sFreqP2 = document.getElementById('s-freq-penalty'); if (_sFreqP2) state.frequencyPenalty = parseFloat(_sFreqP2.value) || 0;
      const _sSeed2 = document.getElementById('s-seed'); if (_sSeed2) { state.seed = parseInt(_sSeed2.value); if (isNaN(state.seed)) state.seed = -1; }
      const _sDryMult2 = document.getElementById('s-dry-multiplier'); if (_sDryMult2) state.dryMultiplier = parseFloat(_sDryMult2.value) || 0;
      const _sDryBase2 = document.getElementById('s-dry-base'); if (_sDryBase2) state.dryBase = parseFloat(_sDryBase2.value) || 1.75;
      const _sDryAllowed2 = document.getElementById('s-dry-allowed-length'); if (_sDryAllowed2) state.dryAllowedLength = parseInt(_sDryAllowed2.value) || 2;
      const _sXtcProb2 = document.getElementById('s-xtc-prob'); if (_sXtcProb2) state.xtcProbability = parseFloat(_sXtcProb2.value) || 0;
      const _sXtcThresh2 = document.getElementById('s-xtc-threshold'); if (_sXtcThresh2) state.xtcThreshold = parseFloat(_sXtcThresh2.value) || 0.1;
      const _sMirostat2 = document.getElementById('s-mirostat'); if (_sMirostat2) state.mirostat = parseInt(_sMirostat2.value) || 0;
      const _sMirostatTau2 = document.getElementById('s-mirostat-tau'); if (_sMirostatTau2) state.mirostatTau = parseFloat(_sMirostatTau2.value) || 5.0;
      const _sMirostatEta2 = document.getElementById('s-mirostat-eta'); if (_sMirostatEta2) state.mirostatEta = parseFloat(_sMirostatEta2.value) || 0.1;
      const _ejsInp = document.getElementById('s-enforce-json-schema'); if (_ejsInp) state.enforceJsonSchema = _ejsInp.checked;
      state.maxTokens = Math.max(256, parseInt(document.getElementById('s-max-tokens').value) || 8192);
      state.maxReadKB = Math.max(10, parseInt(document.getElementById('s-max-read').value) || 500);
      state.cmdTimeout = Math.max(5, parseInt(document.getElementById('s-cmd-timeout').value) || 60);
      state.ctxWindow = Math.max(1024, parseInt(document.getElementById('s-ctx-window').value) || 32768);
      state.autoCompactPct = Math.max(50, Math.min(99, parseInt(document.getElementById('s-auto-compact').value) || 85));
      const _memAgentCb2 = document.getElementById('s-memory-agent-enabled'); if (_memAgentCb2) state.memoryAgentEnabled = _memAgentCb2.checked;
      const _compactTokEl2 = document.getElementById('s-compact-token-threshold'); if (_compactTokEl2) state.compactTokenThreshold = Math.max(0, parseInt(_compactTokEl2.value) || 0);
      const _memAgentModelEl2 = document.getElementById('s-memory-agent-model'); if (_memAgentModelEl2) state.memoryAgentModel = _memAgentModelEl2.value.trim();
      state.verifyWrites = document.getElementById('s-verify-writes').checked;
      state.requireEditApproval = document.getElementById('s-require-approval').checked;
      state.clarifyMode = document.getElementById('s-clarify-mode').checked;
      const _allowAskCb2 = document.getElementById('s-allow-ask-user'); if (_allowAskCb2) state.allowAskUser = _allowAskCb2.checked;
      const _notifCb2 = document.getElementById('s-notifications'); if (_notifCb2) state.notificationsEnabled = _notifCb2.checked;
      const _expCb2 = document.getElementById('s-experimental-mode'); if (_expCb2) state.experimentalMode = _expCb2.checked;
      state.clarifyCount = Math.min(5, Math.max(1, parseInt(document.getElementById('s-clarify-count').value) || 3));
      state.autoVerifyCommand = document.getElementById('s-auto-verify').value.trim();
      state.autoVerifyMaxRetries = Math.max(1, parseInt(document.getElementById('s-auto-verify-retries').value) || 3);
      state.smartContextThreshold = Math.max(0, parseInt(document.getElementById('s-smart-context').value) || 0);
      state.tokenBudget = Math.max(0, parseInt(document.getElementById('s-token-budget').value) || 0);
      state.mcpConfig = document.getElementById('s-mcp-config')?.value || '';
      if (state.mcpConfig.trim()) pushMcpHistory(state.mcpConfig.trim());
      const _shellCb = document.getElementById('s-shell-autoapprove'); if (_shellCb) state.shellAutoApprove = _shellCb.checked;
      const _shellDangerCb = document.getElementById('s-shell-autoapprove-dangerous'); if (_shellDangerCb) state.shellAutoApproveDangerous = _shellDangerCb.checked && state.shellAutoApprove;
      const _gitCb = document.getElementById('s-git-autoapprove'); if (_gitCb) state.gitWriteAutoApprove = _gitCb.checked;
      const _sUseModelLoadDefaults2 = document.getElementById('s-use-model-load-defaults'); if (_sUseModelLoadDefaults2) state.useModelLoadDefaults = _sUseModelLoadDefaults2.checked;
      // These previously were populated INTO the UI from state whenever the
      // modal opened, but were never read back OUT of the UI here — so
      // editing Flash Attention / KV offload / context override / experts /
      // eval batch and clicking Save had no effect at all; requestModelLoad()
      // only ever saw whatever was loaded from localStorage at startup.
      const _sModelCtx2 = document.getElementById('s-model-ctx'); if (_sModelCtx2) state.modelCtxOverride = Math.max(0, parseInt(_sModelCtx2.value) || 0);
      const _sModelFlash2 = document.getElementById('s-model-flash'); if (_sModelFlash2) state.modelFlashAttn = _sModelFlash2.checked;
      const _sModelKv2 = document.getElementById('s-model-kv'); if (_sModelKv2) state.modelKvOffload = _sModelKv2.checked;
      const _sModelExperts2 = document.getElementById('s-model-experts'); if (_sModelExperts2) state.modelNumExperts = Math.max(0, parseInt(_sModelExperts2.value) || 0);
      const _sModelEval2 = document.getElementById('s-model-eval'); if (_sModelEval2) state.modelEvalBatch = Math.max(0, parseInt(_sModelEval2.value) || 0);
      const _browserCb = document.getElementById('s-browser-autoapprove'); if (_browserCb) state.browserWriteAutoApprove = _browserCb.checked;
      persistSettings(); closeSettings(); showToast('Settings saved', 'ok');
      testConnection(); updateContextMeter();
      syncMcpServers();
      renderToolList();
      // Sync quick temp slider
      const _tqs = document.getElementById('temp-quick-slider');
      const _tqv = document.getElementById('temp-quick-val');
      if (_tqs) {
        _tqs.value = state.temp;
        const _v = parseFloat(state.temp);
        _tqv.textContent = _v.toFixed(2);
        _tqv.style.color = _v <= 0.3 ? 'var(--cyan)' : _v <= 0.8 ? 'var(--tx-4)' : _v <= 1.3 ? 'var(--yellow)' : 'var(--red)';
      }
    }

    /* ═══════════════ MODEL CONTEXT PROTOCOL (MCP) CLIENT ═══════════════ */
    state.mcpServerMap = {}; // tool_name -> server_name

    function sanitizeMcpJson(raw) {
      if (!raw || typeof raw !== 'string') return '{}';
      let s = raw.trim();
      if (!s) return '{}';
      // Auto-repair Windows backslashes in paths within JSON strings
      // e.g. "C:\Users\John\..." -> "C:/Users/John/..."
      s = s.replace(/"((?:[^"\\]|\\.)*)"/g, (match, strVal) => {
        const fixed = strVal.replace(/\\(?!["\\/bfnrtu]|u[0-9a-fA-F]{4})/g, '/');
        return JSON.stringify(fixed);
      });
      return s;
    }

    /* ═══════════════ MCP JSON SYNTAX HIGHLIGHTING ═══════════════
       Cheap regex-based tokenizer just for visual clarity in the settings
       textarea — not a real parser, so it's fine if it's slightly off on
       pathological input. Rendered into a <pre> sitting behind a transparent
       textarea with a matching font/size so caret position lines up. */
    function highlightMcpJson(text) {
      if (!text) return '';
      let out = esc(text);
      // Keys: quoted strings immediately followed by a colon
      out = out.replace(/"(?:\\.|[^"\\])*"(?=\s*:)/g, m => '<span class="mcp-json-key">' + m + '</span>');
      // String values: quoted strings after a colon
      out = out.replace(/:(\s*)"(?:\\.|[^"\\])*"/g, m => {
        const i = m.indexOf('"');
        return m.slice(0, i) + '<span class="mcp-json-string">' + m.slice(i) + '</span>';
      });
      // Numbers
      out = out.replace(/:(\s*)(-?\d+\.?\d*)/g, (m, sp, num) => ':' + sp + '<span class="mcp-json-number">' + num + '</span>');
      // Booleans / null
      out = out.replace(/\b(true|false|null)\b/g, '<span class="mcp-json-bool">$1</span>');
      // Punctuation
      out = out.replace(/([{}\[\],])/g, '<span class="mcp-json-punct">$1</span>');
      return out;
    }
    function syncMcpHighlight() {
      const ta = document.getElementById('s-mcp-config');
      const hl = document.getElementById('s-mcp-config-highlight');
      if (!ta || !hl) return;
      hl.innerHTML = highlightMcpJson(ta.value) + '\n';
      hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
    }

    /* ═══════════════ MCP CONFIG PRESETS / HISTORY ═══════════════
       Named saves (state.mcpConfigProfiles) plus an automatic rolling history
       of the last 10 distinct configs actually synced (state.mcpConfigHistory),
       both persisted via persistSettings()/loadSettings(). */
    function renderMcpProfiles() {
      const sel = document.getElementById('s-mcp-profile');
      if (!sel) return;
      sel.innerHTML = '<option value="">— Load a saved or recent config —</option>';
      const savedNames = Object.keys(state.mcpConfigProfiles || {});
      if (savedNames.length) {
        const grp = document.createElement('optgroup'); grp.label = 'Saved';
        savedNames.forEach(name => {
          const opt = document.createElement('option');
          opt.value = 'saved:' + name; opt.textContent = name;
          grp.appendChild(opt);
        });
        sel.appendChild(grp);
      }
      const hist = state.mcpConfigHistory || [];
      if (hist.length) {
        const grp = document.createElement('optgroup'); grp.label = 'Recent';
        hist.forEach((h, i) => {
          const opt = document.createElement('option');
          opt.value = 'hist:' + i;
          const preview = h.config.replace(/\s+/g, ' ').trim().slice(0, 42);
          opt.textContent = new Date(h.ts).toLocaleString() + ' — ' + preview + (h.config.length > 42 ? '…' : '');
          grp.appendChild(opt);
        });
        sel.appendChild(grp);
      }
    }
    window.loadMcpProfile = function () {
      const sel = document.getElementById('s-mcp-profile');
      const val = sel?.value;
      if (!val) return;
      let cfg = null;
      if (val.startsWith('saved:')) cfg = (state.mcpConfigProfiles || {})[val.slice(6)];
      else if (val.startsWith('hist:')) cfg = (state.mcpConfigHistory || [])[parseInt(val.slice(5), 10)]?.config;
      if (cfg == null) return;
      const ta = document.getElementById('s-mcp-config');
      if (ta) { ta.value = cfg; syncMcpHighlight(); }
    };
    window.saveMcpProfile = function () {
      const ta = document.getElementById('s-mcp-config');
      if (!ta || !ta.value.trim()) { showToast('Nothing to save', 'warn'); return; }
      const name = prompt('Name for this MCP config:');
      if (!name || !name.trim()) return;
      state.mcpConfigProfiles = state.mcpConfigProfiles || {};
      state.mcpConfigProfiles[name.trim()] = ta.value;
      persistSettings(); renderMcpProfiles();
      const sel = document.getElementById('s-mcp-profile');
      if (sel) sel.value = 'saved:' + name.trim();
      showToast('Saved MCP config: ' + name.trim(), 'ok');
    };
    window.deleteMcpProfile = function () {
      const sel = document.getElementById('s-mcp-profile');
      const val = sel?.value;
      if (!val || !val.startsWith('saved:')) { showToast('Select a saved config to delete', 'warn'); return; }
      delete (state.mcpConfigProfiles || {})[val.slice(6)];
      persistSettings(); renderMcpProfiles(); sel.value = '';
    };
    function pushMcpHistory(cfg) {
      if (!cfg || !cfg.trim()) return;
      state.mcpConfigHistory = (state.mcpConfigHistory || []).filter(h => h.config !== cfg);
      state.mcpConfigHistory.unshift({ ts: Date.now(), config: cfg });
      if (state.mcpConfigHistory.length > 10) state.mcpConfigHistory.length = 10;
      persistSettings(); renderMcpProfiles();
    }

    async function syncMcpServers(showNotification = false) {
      const cfgArea = document.getElementById('s-mcp-config');
      const statusArea = document.getElementById('mcp-status-area');
      const rawCfg = cfgArea?.value || state.mcpConfig || '';

      if (!rawCfg.trim()) {
        state.mcpTools = [];
        state.mcpServerMap = {};
        if (statusArea) statusArea.innerHTML = '<span style="color:var(--tx-4)">No MCP servers configured</span>';
        return;
      }

      let parsed;
      try {
        const sanitized = sanitizeMcpJson(rawCfg);
        parsed = JSON.parse(sanitized);
      } catch (err) {
        if (statusArea) statusArea.innerHTML = `<span style="color:var(--red)"><i class="fas fa-triangle-exclamation"></i> MCP JSON Syntax Error: ${esc(err.message)}</span>`;
        if (showNotification) showToast('MCP JSON syntax error: ' + err.message, 'err');
        return;
      }
      pushMcpHistory(rawCfg.trim());

      let serversObj = {};
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && item.name) {
            serversObj[item.name] = {
              command: item.command || 'python3',
              args: item.args || [],
              cwd: item.cwd || undefined,
              env: item.env || undefined
            };
          }
        }
      } else if (parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        serversObj = parsed.mcpServers;
      } else if (parsed && typeof parsed === 'object') {
        serversObj = parsed;
      }

      if (!state.compConnected) {
        if (statusArea) statusArea.innerHTML = '<span style="color:var(--yellow)"><i class="fas fa-circle-exclamation"></i> Companion server not connected — start companion to launch MCP servers</span>';
        if (showNotification) showToast('Companion server required for MCP', 'warn');
        return;
      }

      if (statusArea) statusArea.innerHTML = '<span style="color:var(--cyan)"><i class="fas fa-spinner fa-spin"></i> Connecting to MCP servers...</span>';

      try {
        const res = await companionFetch(`${state.compUrl}/api/mcp/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mcpServers: serversObj })
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Companion HTTP ${res.status}: ${errText}`);
        }

        const data = await res.json();
        state.mcpTools = [];
        state.mcpServerMap = {};
        const statusLines = [];

        let totalTools = 0;
        for (const [srvName, srvData] of Object.entries(data.servers || {})) {
          if (srvData.status === 'connected' && Array.isArray(srvData.tools)) {
            const toolNames = [];
            for (const t of srvData.tools) {
              if (!t || !t.name) continue;
              totalTools++;
              toolNames.push(t.name);
              state.mcpTools.push({
                type: 'function',
                function: {
                  name: t.name,
                  description: `[MCP: ${srvName}] ${t.description || ''}`,
                  parameters: t.inputSchema || { type: 'object', properties: {} }
                }
              });
              state.mcpServerMap[t.name] = srvName;
            }
            statusLines.push(`<div style="color:var(--green);margin-top:2px"><i class="fas fa-circle-check"></i> <b>${esc(srvName)}</b>: ${srvData.tools.length} tool(s) loaded (${toolNames.map(n => esc(n)).join(', ')})</div>`);
          } else {
            statusLines.push(`<div style="color:var(--red);margin-top:2px"><i class="fas fa-circle-xmark"></i> <b>${esc(srvName)}</b>: ${esc(srvData.error || 'Failed to initialize')}</div>`);
          }
        }

        if (statusArea) statusArea.innerHTML = statusLines.join('') || '<span style="color:var(--tx-4)">0 servers loaded</span>';
        if (showNotification) showToast(`MCP synced: ${totalTools} tool(s) registered`, 'ok');
      } catch (e) {
        if (statusArea) statusArea.innerHTML = `<span style="color:var(--red)"><i class="fas fa-triangle-exclamation"></i> MCP Sync Error: ${esc(e.message)}</span>`;
        if (showNotification) showToast('MCP Sync failed: ' + e.message, 'err');
      }
    }

    async function callMcpTool(serverName, toolName, args) {
      if (!state.compConnected) {
        return { output: `Error: Cannot call MCP tool "${toolName}" — companion server is disconnected.` };
      }
      try {
        const res = await companionFetch(`${state.compUrl}/api/mcp/call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            server: serverName,
            tool: toolName,
            arguments: args || {},
            timeout: state.cmdTimeout || 120
          })
        });
        if (!res.ok) {
          const errText = await res.text();
          return { output: `MCP Error (HTTP ${res.status}): ${errText}` };
        }
        const data = await res.json();
        if (data.error) {
          return { output: `MCP Tool Error [${toolName}]: ${data.error}` };
        }
        return { output: data.output || '(empty result)' };
      } catch (err) {
        return { output: `MCP Call Failed [${toolName}]: ${err.message}` };
      }
    }

    /* ═══════════════ COMMAND PALETTE (Ctrl+K) ═══════════════ */
    let _cmdPaletteSelectedIndex = 0;
    let _cmdPaletteFiltered = [];

    const COMMANDS = [
      { id: 'new_conv', title: 'New Conversation', icon: 'fa-plus', key: 'Ctrl+Shift+N', action: () => doNewConversation() },
      { id: 'settings', title: 'Open Settings', icon: 'fa-gear', key: 'Ctrl+,', action: () => openSettings('general') },
      { id: 'settings_sampling', title: 'Model Sampling & Generation Settings', icon: 'fa-sliders', key: '', action: () => openSettings('sampling') },
      { id: 'settings_mcp', title: 'Configure MCP & Agent Tools', icon: 'fa-plug', key: '', action: () => openSettings('tools') },
      { id: 'compact', title: 'Compact Context (/compact)', icon: 'fa-compress', key: '', action: () => smartCompact() },
      { id: 'toggle_plan', title: 'Toggle Plan Mode', icon: 'fa-list-check', key: '', action: () => togglePlanMode() },
      { id: 'export_md', title: 'Export Conversation (Markdown)', icon: 'fa-file-arrow-down', key: 'Ctrl+Shift+E', action: () => exportConversation() },
      { id: 'export_json', title: 'Export All Conversations (JSON)', icon: 'fa-database', key: '', action: () => exportConversationsJson() },
      { id: 'test_conn', title: 'Test LLM & Companion Connection', icon: 'fa-plug-circle-bolt', key: '', action: () => testConnection() },
      { id: 'refresh_files', title: 'Refresh Workspace File Tree', icon: 'fa-arrows-rotate', key: '', action: () => refreshFileTree() },
      { id: 'clear_tokens', title: 'Clear Real Token Count Cache', icon: 'fa-trash', key: '', action: () => clearTokenCountCache() }
    ];

    function openCommandPalette() {
      const modal = document.getElementById('cmd-palette-modal');
      const input = document.getElementById('cmd-palette-input');
      if (!modal || !input) return;
      input.value = '';
      _cmdPaletteSelectedIndex = 0;
      renderCommandPalette('');
      modal.classList.add('open');
      input.focus();
    }

    function closeCommandPalette() {
      const modal = document.getElementById('cmd-palette-modal');
      if (modal) modal.classList.remove('open');
    }

    function renderCommandPalette(query) {
      const listEl = document.getElementById('cmd-palette-list');
      if (!listEl) return;
      const q = (query || '').toLowerCase().trim();

      // 1. Filter commands
      const matchedCmds = COMMANDS.filter(c => !q || c.title.toLowerCase().includes(q) || c.id.includes(q));

      // 2. Filter recent conversations
      const matchedConvs = state.conversations
        .filter(c => !q || (c.title || '').toLowerCase().includes(q))
        .slice(0, 5)
        .map(c => ({
          id: 'conv_' + c.id,
          title: `Switch: ${c.title || 'Untitled'}`,
          icon: 'fa-message',
          key: '',
          action: () => switchConv(c.id)
        }));

      _cmdPaletteFiltered = [...matchedCmds, ...matchedConvs];
      if (_cmdPaletteSelectedIndex >= _cmdPaletteFiltered.length) _cmdPaletteSelectedIndex = 0;

      if (!_cmdPaletteFiltered.length) {
        listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--tx-4);font-size:12px">No commands or conversations match "' + esc(query) + '"</div>';
        return;
      }

      listEl.innerHTML = _cmdPaletteFiltered.map((item, idx) => `
        <div class="cmd-item ${idx === _cmdPaletteSelectedIndex ? 'selected' : ''}" onclick="executePaletteItem(${idx})">
          <div class="cmd-icon"><i class="fas ${item.icon}"></i></div>
          <span style="font-weight:500">${esc(item.title)}</span>
          ${item.key ? `<span class="cmd-key">${item.key}</span>` : ''}
        </div>
      `).join('');
    }

    function executePaletteItem(index) {
      const item = _cmdPaletteFiltered[index];
      if (item && item.action) {
        closeCommandPalette();
        item.action();
      }
    }

    /* ═══════════════ EXPLAIN THIS ERROR ═══════════════ */
    function explainError(errorText) {
      const inp = document.getElementById('msg-input');
      if (!inp) return;
      inp.value = `Please explain the following error in detail and provide the exact fix:\n\n\`\`\`\n${errorText.trim()}\n\`\`\``;
      inp.style.height = 'auto';
      inp.style.height = Math.min(inp.scrollHeight, 150) + 'px';
      updateSendBtn();
      inp.focus();
      handleSend();
    }

    /* ═══════════════ FILE MENTIONS ENGINE (@) ═══════════════ */
    let _mentionSelectedIndex = 0;
    let _mentionFilteredFiles = [];
    let _mentionMatchStart = -1;

    async function getAllWorkspaceFiles() {
      const files = new Set();
      if (typeof semanticIndex !== 'undefined' && semanticIndex.size) {
        for (const p of semanticIndex.keys()) files.add(p);
      }
      if (state.fileCache && state.fileCache.size) {
        for (const p of state.fileCache.keys()) files.add(p);
      }
      document.querySelectorAll('#file-tree .ft-item').forEach(el => {
        const title = el.getAttribute('title');
        if (title && !title.endsWith('/')) files.add(title);
      });
      if (state.compConnected && files.size < 5) {
        try {
          const res = await companionFetch(state.compUrl + '/api/dir/list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: '.', recursive: true, max_depth: 4 })
          });
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.entries)) {
              data.entries.forEach(e => { if (e.type === 'file') files.add(e.path); });
            }
          }
        } catch (_) {}
      }
      return Array.from(files);
    }

    async function handleMentionInput(inp) {
      const popup = document.getElementById('file-mention-popup');
      if (!popup) return;
      const val = inp.value;
      const pos = inp.selectionStart;
      const textBefore = val.slice(0, pos);
      const match = textBefore.match(/(?:^|\s)@([a-zA-Z0-9_\-\.\/\\]*)$/);
      if (!match) {
        popup.classList.remove('open');
        _mentionFilteredFiles = [];
        _mentionMatchStart = -1;
        return;
      }

      const query = match[1].toLowerCase();
      _mentionMatchStart = pos - match[1].length - 1; // index of '@'
      const allFiles = await getAllWorkspaceFiles();
      _mentionFilteredFiles = allFiles
        .filter(f => !query || f.toLowerCase().includes(query))
        .slice(0, 8);

      if (!_mentionFilteredFiles.length) {
        popup.classList.remove('open');
        return;
      }

      _mentionSelectedIndex = 0;
      renderMentionPopup();
      popup.classList.add('open');
    }

    function renderMentionPopup() {
      const popup = document.getElementById('file-mention-popup');
      if (!popup) return;
      popup.innerHTML = _mentionFilteredFiles.map((f, idx) => `
        <div class="file-mention-item ${idx === _mentionSelectedIndex ? 'selected' : ''}" onclick="insertMentionIndex(${idx})">
          <i class="fas fa-file-code" style="color:var(--accent);font-size:11px"></i>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f)}</span>
        </div>
      `).join('');
    }

    function insertMentionIndex(idx) {
      const file = _mentionFilteredFiles[idx];
      if (!file) return;
      const inp = document.getElementById('msg-input');
      if (!inp) return;
      const pos = inp.selectionStart;
      const before = inp.value.slice(0, _mentionMatchStart);
      const after = inp.value.slice(pos);
      const inserted = `@${file} `;
      inp.value = before + inserted + after;
      const newPos = before.length + inserted.length;
      inp.selectionStart = inp.selectionEnd = newPos;
      inp.focus();
      document.getElementById('file-mention-popup')?.classList.remove('open');
      _mentionFilteredFiles = [];
      _mentionMatchStart = -1;
      updateSendBtn();
    }

    /* ═══════════════ EXPORT ═══════════════ */
    function exportConversation() {
      if (!state.messages.length) { showToast('Nothing to export', 'warn'); return; }
      let md = `# SlopLobster Conversation\n\nExported: ${new Date().toISOString()}\nModel: ${state.model || 'unknown'}\nWorkspace: ${state.dirName || 'none'}\nProject: ${state.projectType || 'unknown'}\n\n---\n\n`;
      for (const m of state.messages) {
        if (m.role === 'user') {
          let text = m.content || '[Image(s)]';
          if (m._images) text += ' [' + m._images.length + ' image(s) attached]';
          md += '## You\n\n' + text + '\n\n';
        }
        else if (m.role === 'assistant' && m.content) md += `## SlopLobster\n\n${m.content}\n\n`;
        else if (m.role === 'tool') {
          const parentIdx = state.messages.indexOf(m) - 1; const parent = state.messages[parentIdx];
          const isThink = parent?.tool_calls?.some(tc => tc.id === m.tool_call_id && tc.function.name === 'think');
          const isSearch = parent?.tool_calls?.some(tc => tc.id === m.tool_call_id && tc.function.name === 'web_search');
          md += `<details${isThink ? ' open' : ''}><summary>${isThink ? 'Thinking' : isSearch ? 'Web Search' : 'Tool Result'}</summary>\n\n\`\`\`\n${m.content}\n\`\`\`\n\n</details>\n\n`;
        }
      }
      const blob = new Blob([md], { type: 'text/markdown' }); const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = `SlopLobster-${Date.now()}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Exported as Markdown', 'ok');
    }

    async function smartCompact() {
      if (state.running) { showToast('Wait for current response', 'warn'); return; }
      if (state.messages.length < 4) { showToast('Not enough messages', 'warn'); return; }
      const saved = await saveProgressToWorkspace('manual compact');
      await progressCompact(saved);
    }

    function saveCompanionScript() {
      const blob = new Blob([COMPANION_SCRIPT], { type: 'text/x-python' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'SlopLobster-companion.py';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Saved SlopLobster-companion.py', 'ok');
    }

    async function processFilesForInput(files) {
      if (!files || !files.length) return;
      const inp = document.getElementById('msg-input');
      let added = [];
      let imgAdded = [];

      for (const f of files) {
        if (f.type.startsWith('image/')) {
          try {
            const dataUrl = await fileToBase64(f);
            const sizeKB = Math.round((dataUrl.length * 3 / 4) / 1024);
            imgAdded.push({ dataUrl, name: f.name, size: sizeKB + ' KB' });
          } catch { showToast('Cannot read ' + f.name, 'err'); }
          continue;
        }
        if (f.size > 2 * 1024 * 1024) { showToast(f.name + ' too large (max 2MB)', 'warn'); continue; }
        try { const text = await f.text(); added.push('--- File: ' + f.name + ' (' + (f.size / 1024).toFixed(1) + ' KB) ---\n' + text); }
        catch { showToast('Cannot read ' + f.name, 'err'); }
      }

      if (imgAdded.length) {
        state.pendingImages.push(...imgAdded);
        addImageAttachmentsToInputArea();
        showToast(imgAdded.length + ' image(s) attached', 'ok');
      }
      if (added.length) {
        inp.value = inp.value ? inp.value + '\n\n' + added.join('\n\n') : added.join('\n\n');
        inp.style.height = 'auto';
        inp.style.height = Math.min(inp.scrollHeight, 150) + 'px';
        showToast(added.length + ' file(s) attached', 'ok');
      }
      updateSendBtn();
    }

    async function handleFileAttach(files) {
      await processFilesForInput(files);
      /* Reset the input so the same file can be re-attached */
      document.getElementById('file-input').value = '';
    }

    /* ═══════════════ FILE DROP ═══════════════ */
    function setupFileDrop() {
      const area = document.getElementById('input-area');
      const overlay = document.getElementById('file-drop-overlay');
      const wrap = document.getElementById('input-wrap');
      let dragCounter = 0;
      area.addEventListener('dragenter', e => { e.preventDefault(); dragCounter++; overlay.classList.add('visible'); wrap.classList.add('drag-over'); });
      area.addEventListener('dragleave', e => {
        e.preventDefault();
        dragCounter = Math.max(0, dragCounter - 1);  // ← clamp
        if (dragCounter <= 0) {
          dragCounter = 0;
          overlay.classList.remove('visible');
          wrap.classList.remove('drag-over');
        }
      });

      area.addEventListener('dragover', e => e.preventDefault());
      area.addEventListener('drop', async e => {
        e.preventDefault(); dragCounter = 0; overlay.classList.remove('visible'); wrap.classList.remove('drag-over');
        const files = [...e.dataTransfer.files];
        await processFilesForInput(files);
      });
    }

    /* ═══════════════ EVENTS ═══════════════ */
    async function openDirectory() {
      if (hfBusy()) { showToast('Stop the current run before changing workspaces', 'info'); return; }
      if (!window.showDirectoryPicker) { showToast('File System Access Access API requires Chrome/Edge', 'err'); return; }
      try {
        const picked = await window.showDirectoryPicker({ mode: 'readwrite' });
        clearTimeout(_convSaveTimer);
        const previous = state.conversations.find(c=>c.id===state.activeConvId);
        if(previous) await saveConvToWorkspace(previous);
        releaseManagedWorkspace();
        state.dirHandle = picked;
        state.dirName = picked.name;
        if(['isolation','evidence','recipes','queue','knowledge'].some(k=>harnessFeatureState.prefs[k])) await ensureFeatureWorkspace();
        state.dirName = state.dirHandle.name;
        document.getElementById('dir-name').textContent = state.dirName;
        showToast(`Workspace: ${state.dirName}`, 'ok');
        _wsWarningDismissed = false;
        updateWorkspaceBanner();

        // The new folder owns its conversation list and active context.
        state.conversations=[]; state.activeConvId=null; state.messages=[];
        const loaded = await loadConversationsFromWorkspace();

        // One-time import from localStorage
        await importFromLocalStorage();

        if (loaded || state.conversations.length) {
          // Reload current active conversation into view
          const c = state.conversations.find(c => c.id === state.activeConvId);
          if (c && c.messages.length) {
            state.messages = c.messages;
            state.originalTask = c._originalTask || null;
      state.taskState = c._taskState || null;
      state.runController = null;
      state.verificationState = state.taskState?.verification || null;
      await restoreHarnessConversation(c);
            toolCallHistory.length = 0;
            textLoopBuffer.length = 0;
            $msg().innerHTML = '';
            streamEl = null;
            switchToChat();
            replayMessages(state.messages);
            updateContextMeter();
          } else if (state.conversations.length) {
            $msg().innerHTML = '';
            streamEl = null;
            document.getElementById('welcome').style.display = 'flex';
            $msg().style.display = 'none';
          }
          renderConvList();
        } else await doNewConversation();

        await refreshFileTree();
        await detectProject();
        checkGitRepo();
        updateWelcomeStatus();
        await loadProjectMemory();


      } catch (e) { if (e.name !== 'AbortError') showToast(e.message, 'err'); }
    }

    /**
     * Pre-flight clarifying questions flow.
     * Streams a quick API call asking the model to generate N targeted
     * questions about the user's task. Renders them as interactive inputs.
     * Returns a promise that resolves with the augmented task string
     * once the user submits answers (or skips).
     */
    async function runClarifyFlow(task, nQuestions) {
      return new Promise(async (resolve) => {
        // ── Build the panel ──────────────────────────────────────────
        const panel = document.createElement('div');
        panel.className = 'clarify-panel';
        panel.innerHTML = `
          <div class="clarify-hdr">
            <i class="fas fa-circle-question"></i>
            A few quick questions
            <span class="clarify-skip" onclick="this.closest('.clarify-panel')._skip()">Skip &amp; proceed now</span>
          </div>
          <div class="clarify-dots"><span></span><span></span><span></span></div>
          <div class="clarify-status" style="font-size:10px;color:var(--tx-4);font-family:'JetBrains Mono',monospace;margin-top:4px;display:none"></div>`;
        $msg().appendChild(panel);
        scrollBottom();

        // ── Skip helper ──────────────────────────────────────────────
        panel._skip = () => {
          panel.remove();
          resolve(task);
        };

        // ── Stream questions from the model ──────────────────────────
        const sysMsg = `You are a clarification assistant. The user has given a task to an AI coding agent. Your job is to identify the ${nQuestions} most important ambiguities or missing details that, if known, would significantly improve the agent's output quality.

Rules:
- Ask ONLY ${nQuestions} questions, numbered 1 to ${nQuestions}
- Each question must be specific and actionable — not generic ("what is your goal?")
- Focus on: technical constraints, preferred approach, output format, scope limits, existing code style
- If the task is already fully clear and specific, write: CLEAR — no questions needed
- Output ONLY the numbered questions, nothing else. No preamble, no explanation.

Format:
1. <question>
2. <question>
...`;

        let questionsText = '';
        try {
          const statusEl = panel.querySelector('.clarify-status');
          const result = await requestModel({ model: state.model, messages: [
            { role: 'system', content: sysMsg }, { role: 'user', content: task }
          ], stream: true, temperature: 0.3, max_tokens: 600 }, state.abortCtrl?.signal, {
            onReasoning: full => { if (statusEl) { statusEl.textContent = 'Reasoning (' + full.length + ' chars)'; statusEl.style.display = 'block'; } }
          });
          questionsText = result.content;
        } catch (e) {
          // API failed — skip clarification silently
          panel.remove();
          resolve(task);
          return;
        }

        questionsText = questionsText.trim();

        // If model says task is clear, skip the UI entirely
        if (questionsText.toUpperCase().startsWith('CLEAR')) {
          panel.remove();
          resolve(task);
          return;
        }

        // ── Parse questions ──────────────────────────────────────────
        const qLines = questionsText
          .split('\n')
          .map(l => l.replace(/^\d+\.\s*/, '').trim())
          .filter(Boolean);

        if (!qLines.length) {
          panel.remove();
          resolve(task);
          return;
        }

        // ── Render question inputs ───────────────────────────────────
        const answers = new Array(qLines.length).fill('');
        const dotsEl = panel.querySelector('.clarify-dots');
        dotsEl.remove();

        qLines.forEach((q, i) => {
          const qEl = document.createElement('div');
          qEl.className = 'clarify-question';
          qEl.innerHTML = `
            <div class="clarify-q-text">
              <span class="clarify-q-num">Q${i + 1}.</span>${esc(q)}
            </div>
            <div class="clarify-input-row">
              <input class="clarify-ans" type="text" placeholder="Your answer… (or leave blank to skip)"
                data-idx="${i}" autocomplete="off">
              <span class="clarify-skip-tag" data-idx="${i}">Skip</span>
            </div>`;
          panel.appendChild(qEl);

          const inp = qEl.querySelector('.clarify-ans');
          const skipTag = qEl.querySelector('.clarify-skip-tag');

          inp.addEventListener('input', () => {
            answers[i] = inp.value.trim();
          });
          inp.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              answers[i] = inp.value.trim();
              inp.classList.add('answered');
              // Focus next unanswered
              const next = panel.querySelector(`.clarify-ans[data-idx="${i + 1}"]`);
              if (next) next.focus(); else proceedBtn.focus();
            }
          });
          skipTag.addEventListener('click', () => {
            answers[i] = '';
            inp.value = '';
            inp.classList.remove('answered');
            inp.placeholder = '(skipped)';
            inp.disabled = true;
          });
        });

        // ── Proceed button ───────────────────────────────────────────
        const proceedRow = document.createElement('div');
        proceedRow.className = 'clarify-proceed';
        proceedRow.innerHTML = `<button class="clarify-proceed-btn" id="clarify-proceed-btn">Proceed →</button>`;
        panel.appendChild(proceedRow);
        const proceedBtn = proceedRow.querySelector('#clarify-proceed-btn');

        // Focus first input
        const firstInput = panel.querySelector('.clarify-ans');
        if (firstInput) setTimeout(() => firstInput.focus(), 50);

        scrollBottom();

        proceedBtn.addEventListener('click', () => {
          // Collect all current input values
          panel.querySelectorAll('.clarify-ans').forEach((inp, i) => {
            if (!inp.disabled) answers[i] = inp.value.trim();
          });

          // Build augmented task
          const answered = qLines
            .map((q, i) => answers[i] ? `Q: ${q}\nA: ${answers[i]}` : null)
            .filter(Boolean);

          const augmented = answered.length
            ? task + '\n\n--- Clarifications ---\n' + answered.join('\n\n')
            : task;

          // Replace panel with a compact answered summary
          const summary = document.createElement('div');
          summary.className = 'clarify-panel';
          summary.style.cssText = 'opacity:.7;padding:10px 14px;gap:5px';
          summary.innerHTML = `
            <div class="clarify-hdr" style="margin-bottom:0">
              <i class="fas fa-circle-check" style="color:var(--green)"></i>
              Clarifications collected — proceeding
            </div>
            ${answered.map(a => `<div style="font-size:11px;color:var(--tx-3);padding-left:18px">${esc(a.replace('\n', ' → '))}</div>`).join('')}`;
          panel.replaceWith(summary);
          scrollBottom();

          resolve(augmented);
        });
      });
    }

    async function handleSend() {
      if (state.running) {
        harnessStopRequested();
        state.abortCtrl?.abort();
        state.running = false;
        state.planExecuting = false;
        state.pendingSteerMessages = [];
        renderSteerQueue();
        updateSendBtn();
        return;
      }

      const inp = document.getElementById('msg-input');
      const t = inp.value.trim();

      if (!t && !state.pendingImages.length) return;
      if (t.startsWith('/') && !state.pendingImages.length) { handleCmd(t); inp.value = ''; inp.style.height = 'auto'; updateSendBtn(); return; }

      if (state.pendingImages.length && !state.visionCapable) {
        showToast('Current model does not support images', 'warn');
        state.pendingImages = [];
        addImageAttachmentsToInputArea();
        return;
      }

      const images = state.pendingImages.splice(0);
      inp.value = ''; inp.style.height = 'auto';
      if (t && t !== inputHistory[0]) { inputHistory.unshift(t); if (inputHistory.length > 100) inputHistory.pop(); }
      inputHistoryIdx = -1; inputDraft = '';
      addImageAttachmentsToInputArea();

      if (!state.activeConvId) {
        try { await doNewConversation(); } catch (e) { showToast('Could not create conversation: ' + e.message, 'err'); return; }
      }

      state.runController = HarnessRunState.create();
      state.verificationState = null;
      const msg = { role: 'user', content: t || '[Image(s) attached]' };
      if (images.length && state.visionCapable) {
        msg._images = images.map(img => ({ type: 'image_url', image_url: { url: img.dataUrl } }));
      }

      switchToChat();
      const el = createMsgEl('user', t || '[Image(s) attached]');
      if (images.length) {
        const imgHtml = images.map(img => showMsgImage(img.dataUrl, images.length > 1)).join('');
        el.querySelector('.msg-content').innerHTML += (t ? '\n\n' : '') + `<div class="msg-img-grid">${imgHtml}</div>`;
      }
      $msg().appendChild(el); scrollBottom();
      state.messages.push(msg);
      if (!state.originalTask && t) state.originalTask = t;
      updateSendBtn(); updateContextMeter();

      /* ── Clarifying questions — runs before both plan mode and agent ── */
      if (state.clarifyMode && t && state.messages.length === 1) {
        const augmented = await runClarifyFlow(t, state.clarifyCount);
        if (augmented !== t) {
          state.messages[state.messages.length - 1] = { role: 'user', content: augmented };
          if (state.originalTask === t) state.originalTask = augmented;
        }
      }

      /* ── Swarm mode: append spawn_swarm instruction (runs before plan so plan sees the swarm goal) ── */
      if (_swarmInputMode && t) {
        // User's actual goal comes FIRST, not the boilerplate instruction — this message
        // becomes the conversation's history entry (title generation + transcript replay
        // both read the start of the first user message), so burying it after a ~150-char
        // instruction wrapper meant every swarm conversation showed the same generic
        // "Use the spawn_swarm tool..." title/preview with the real goal never visible.
        const swarmInstruction = `${t}\n\n---\nUse the spawn_swarm tool to tackle the above goal with multiple specialist agents working in parallel. Design appropriate worker roles, set up shared memory keys for inter-agent communication, and have the Manager synthesise their outputs into a final answer.`;
        state.messages[state.messages.length - 1] = { role: 'user', content: swarmInstruction };
      }

      /* ── Plan mode: generate plan instead of executing ── */
      if (state.planMode && (t || state.pendingImages.length)) {
        const taskText = state.messages[state.messages.length - 1]?.content || t;
        await handlePlanRequest(taskText);
        return;
      }

      /* ── Deep Research mode: inject instruction ── */
      if (_deepResearchInputMode && t) {
        // Same fix as swarm mode above — real topic first, instruction wrapper after.
        const depthLabel = _drDepth === 1 ? 'quick' : _drDepth === 3 ? 'exhaustive' : 'standard';
        const researchInstruction = `${t}\n\n---\nUse the deep_research tool with depth=${_drDepth} to perform a ${depthLabel} investigation on the above topic. Provide a comprehensive, well-synthesized report with citations.`;
        state.messages[state.messages.length - 1] = { role: 'user', content: researchInstruction };
      }

      agentLoop();
    }

    async function userScreenshot() {
      if (!state.visionCapable) { showToast('Current model does not support images', 'warn'); return; }
      try {
        const dataUrl = navigator.mediaDevices?.getDisplayMedia
          ? await captureScreenRegion('Select an area to capture', 'This image will be sent to the model')
          : await captureScreenshotFallback();
        if (!dataUrl) { showToast('Screenshot cancelled', 'info'); return; }
        const sizeKB = Math.round((dataUrl.length * 3 / 4) / 1024);
        state.pendingImages.push({ dataUrl, name: 'screenshot.jpg', size: sizeKB + ' KB' });
        addImageAttachmentsToInputArea();
        updateSendBtn();
        showToast('Screenshot attached — press Enter to send', 'ok');
        document.getElementById('msg-input').focus();
      } catch (e) { showToast('Screenshot failed: ' + e.message, 'err'); }
    }

    function handleCmd(c) {
      const p = c.split(/\s+/); const rest = c.slice(p[0].length).trim();
      switch (p[0]) {
        case '/help': {
          const helpRows = [
            ['/help', 'Show this help'],
            ['/new or /clear', 'Start a new conversation'],
            ['/compact', 'Smart-compress conversation context'],
            ['/dir', 'Open a workspace directory'],
            ['/model', 'List available models'],
            ['/tools', 'List available agent tools'],
            ['/shell', 'Check shell companion status'],
            ['/status', 'Full status: model, context, shell, dir'],
            ['/export', 'Export conversation as markdown'],
          ];
          const shortcuts = [
            ['Ctrl+B', 'Toggle sidebar'],
            ['Ctrl+F', 'Search in conversation'],
            ['Ctrl+Shift+N', 'New conversation'],
            ['Ctrl+Shift+P', 'Toggle plan mode'],
            ['Ctrl+,', 'Open settings'],
            ['Escape', 'Stop / focus input'],
            ['↑ / ↓', 'Input history'],
            ['/', 'Focus input from anywhere'],
          ];
          const table = helpRows.map(([cmd, desc]) => `  ${cmd.padEnd(22)} ${desc}`).join('\n');
          const sc = shortcuts.map(([k, d]) => `  ${k.padEnd(22)} ${d}`).join('\n');
          appendMsg('system', `Commands:\n${table}\n\nKeyboard shortcuts:\n${sc}`);
          break;
        }
        case '/clear': case '/new': doNewConversation(); break;
        case '/compact': smartCompact(); break;
        case '/dir': openDirectory(); break;
        case '/model': { const ms = [...document.getElementById('model-sel').options].map(o => o.value).filter(Boolean); appendMsg('system', `Models: ${ms.join(', ') || 'none'}`); break; }
        case '/tools': appendMsg('system', 'Tools: think, read_file, read_file_lines, edit_file, write_file, list_directory, search_files, grep' + (state.compConnected ? ', web_search, fetch_url, execute_command, git_status, git_diff, git_log, git_add, git_commit' : '')); break;
        case '/shell': checkCompanion().then(() => appendMsg('system', state.compConnected ? `Shell+Search: ${state.compInfo?.platform}` : 'Not running.')); break;
        case '/status': appendMsg('system', `LLM: ${state.connected ? state.model : 'off'} | Shell: ${state.compConnected ? state.compInfo?.platform : 'virtual'} | Project: ${state.projectType || 'none'} | Dir: ${state.dirName || 'none'} | Tokens: ~${estimateConvTokens()} (${Math.round(getContextPct())}%)${_sessionTotalOut > 0 ? ' | Session out: ~' + formatTok(_sessionTotalOut) : ''}`); break;
        case '/export': exportConversation(); break;
        default: appendMsg('system', `Unknown: ${c}. /help for commands.`);
      }
    }

    function prefill(t) {
      const inp = document.getElementById('msg-input'), wrap = document.getElementById('input-wrap');
      inp.value = t;
      inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 150) + 'px';
      wrap.classList.remove('input-flash'); void wrap.offsetWidth; wrap.classList.add('input-flash');
      updateSendBtn(); inp.focus();
      showToast('Prompt ready — edit the description and press Enter', 'info');
    }

    /* ═════════════════ PLAN MODE ═══════════════ */

    function togglePlanMode() {
      state.planMode = !state.planMode;
      const btn = document.getElementById('plan-toggle-btn');
      btn.classList.toggle('active', state.planMode);
      const inp = document.getElementById('msg-input');
      inp.placeholder = state.planMode
        ? 'Describe a task to plan (steps will be generated before execution)...'
        : (_swarmInputMode ? 'Describe a goal for the swarm (multiple agents will tackle it in parallel)...' : 'Ask SlopLobster to do something... (drop files or paste images)');
      showToast(state.planMode ? 'Plan mode ON — your task will be broken into steps' : 'Plan mode OFF', 'info');
    }

    /**
     * Infer which optional system-prompt sections a plan actually needs, based on
     * simple keyword scanning of the step descriptions. Used to trim the system
     * prompt (browser/git/search sections carry the most boilerplate) for the
     * ENTIRE plan run — computed once at plan-generation time and reused for every
     * step, rather than varying per-step. Varying the system prompt per step would
     * invalidate the local inference server's prompt-prefix KV cache on every
     * step transition, which is likely to cost more than the trimmed tokens save;
     * keeping it fixed for the whole run avoids that while still cutting the
     * sections a plan clearly has no use for.
     * @param {Array<{description:string}>} steps
     * @returns {{needsBrowser:boolean, needsGit:boolean, needsSearch:boolean}}
     */
    function inferPlanPromptProfile(steps) {
      const allText = (steps || []).map(s => s.description).join(' ').toLowerCase();
      return {
        needsBrowser: /\bbrowser|screenshot|playwright|navigate|webpage|web page|\bclick\b|\bui\b|browser_/.test(allText),
        needsGit: /\bgit\b|commit|\bstage\b|\bbranch\b|pull request|\bpr\b|\bmerge\b|checkout|\.git\b/.test(allText),
        needsSearch: /\bsearch|research|look up|lookup|documentation|docs for|latest version|changelog|fetch_url|web_search/.test(allText),
      };
    }

    async function handlePlanRequest(userText) {
      const thinkingEl = showThinking();
      thinkingEl.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div> Generating plan...';

      const _isQwen = isQwen();
      const _isGemma = isGemma();
      const toolNames = getToolDefs().map(t => t.function.name).join(', ');

      const planSysPrompt = `You are a planning assistant. Break the user's task into specific, actionable steps.

    Available tools: ${toolNames}

    Rules:
    - Each step must be a single, focused action
    - Include specific file paths when relevant
    - Order logically: read before edit, edit before test
    - Typically 3-12 steps
    - Do NOT include a final "done" or "summary" step

    Output ONLY steps in this EXACT format (one per line):
    STEP: <description>
    STEP: <description>

    Example:
    STEP: Read src/auth.py to understand current authentication
    STEP: Add validate_jwt() function to src/auth.py
    STEP: Update /login endpoint in src/routes.py to use validate_jwt
    STEP: Run pytest to verify changes`;

      try {
        state.abortCtrl = new AbortController();
        state.running = true;
        updateSendBtn();

        const body = {
          model: state.model,
          messages: [
            { role: 'system', content: planSysPrompt },
            { role: 'user', content: userText + (state.dirName ? '\n\nWorking directory: ' + state.dirName : '') }
          ],
          stream: false,
          max_tokens: Math.min(state.maxTokens, 3000),
          tools: [],
        };

        // Same server-sampling deference as the main chat loop: when on, don't
        // send a temperature override or force Qwen's thinking-mode kwargs —
        // let the server's own loaded config decide.
        if (!state.useServerSampling) {
          body.temperature = _isGemma ? 1.0 : _isQwen ? 0.7 : 0.3;
        }
        if (_isQwen && !state.useServerSampling) {
          body.chat_template_kwargs = {
            enable_thinking: document.getElementById('s-qwen-enable-thinking')?.checked ?? true,
            preserve_thinking: false,
          };
        }

        const data = await requestModelJSON(body, state.abortCtrl?.signal);
        let text = data.choices?.[0]?.message?.content || '';

        if (thinkingEl.parentNode) thinkingEl.remove();

        // Strip thinking blocks for Qwen/Gemma models
        text = stripThinkingBlocks(text);

        // Parse steps
        const steps = [];
        const regex = /^STEP:\s*(.+)$/gm;
        let match;
        while ((match = regex.exec(text)) !== null) {
          steps.push({ description: match[1].trim(), status: 'pending' });
        }

        if (steps.length === 0) {
          const regex2 = /^##\s*Step\s+\d+:\s*(.+)$/gm;
          while ((match = regex2.exec(text)) !== null) {
            steps.push({ description: match[1].trim(), status: 'pending' });
          }
        }

        if (steps.length === 0) {
          const regex3 = /^\d+[.)]\s+(.+)$/gm;
          while ((match = regex3.exec(text)) !== null) {
            const desc = match[1].trim();
            if (desc.length > 5 && desc.length < 200) {
              steps.push({ description: desc, status: 'pending' });
            }
          }
        }

        if (steps.length < 2) {
          const isEmpty = !text.trim();
          const isJustThinking = text.trim().length < 50;

          let hint = '';
          if (isEmpty) hint = 'The model returned empty output — it may have crashed or be overloaded.';
          else if (isJustThinking) hint = 'The model only produced thinking output (Qwen/Gemma). Try Settings → Model Load → disable "enable_thinking".';
          else hint = 'Could not parse steps from output. Try a clearer task description.';

          appendMsg('system', 'Could not generate a structured plan (' + steps.length + ' step' + (steps.length !== 1 ? 's' : '') + '). ' + hint);

          if (text.trim().length > 0) appendMsg('assistant', text);
          return;
        }

        state.currentPlan = { steps, originalText: text, promptProfile: inferPlanPromptProfile(steps) };
        renderPlanPanel(steps);
        showToast('Plan generated — ' + steps.length + ' steps', 'ok');

      } catch (e) {
        if (thinkingEl.parentNode) thinkingEl.remove();
        if (e.name === 'AbortError') { appendMsg('system', 'Plan generation cancelled.'); return; }
        appendMsg('system', 'Plan generation failed: ' + e.message);
      } finally {
        state.running = false;
        state.planExecuting = false;
        updateSendBtn();
      }
    }

    function renderPlanPanel(steps) {
      /* Remove old plan panel if exists */
      const old = document.getElementById('plan-panel');
      if (old) old.remove();

      const el = document.createElement('div');
      el.className = 'plan-panel';
      el.id = 'plan-panel';

      let stepsHtml = '';
      steps.forEach((s, i) => {
        stepsHtml += `<div class="plan-step" id="plan-step-${i}">
          <div class="plan-step-indicator" id="plan-ind-${i}"></div>
          <span class="plan-step-num">${i + 1}</span>
          <span class="plan-step-desc" id="plan-desc-${i}" contenteditable="true" spellcheck="false" data-orig="${esc(s.description)}" oninput="markPlanStepModified(${i})" onkeydown="planDescKeydown(event, ${i})" title="Click to edit this step's description">${esc(s.description)}</span>
          <button class="plan-step-run" id="plan-run-${i}" onclick="executeSinglePlanStep(${i})" title="Run just this step"><i class="fas fa-play"></i></button>
          <button class="plan-step-regen" id="plan-regen-${i}" onclick="regeneratePlanStep(${i})" title="Ask LLM to regenerate this step"><i class="fas fa-rotate"></i></button>
        </div>`;
      });

      const trimmed = [];
      if (state.currentPlan?.promptProfile) {
        const p = state.currentPlan.promptProfile;
        if (!p.needsBrowser) trimmed.push('browser');
        if (!p.needsGit) trimmed.push('git');
        if (!p.needsSearch) trimmed.push('search');
      }
      const trimBanner = trimmed.length
        ? `<div class="plan-slim-banner plan-trim-banner" style="display:flex" title="These sections are shortened in the system prompt for this plan run since no step appears to need them. They'll expand back automatically if you edit a step to need one."><i class="fas fa-compress"></i> System prompt trimmed (${trimmed.join(', ')} not needed for this plan)</div>`
        : '';

      el.innerHTML = `<div class="plan-header">
        <span class="plan-title"><i class="fas fa-list-check"></i> Plan <span id="plan-count">(${steps.length} steps)</span></span>
        <div class="plan-header-actions">
          <button class="plan-btn execute" id="plan-execute-btn" onclick="executeAllPlanSteps()"><i class="fas fa-play"></i> Execute All</button>
          <button class="plan-btn cancel" onclick="discardPlan()" title="Discard plan"><i class="fas fa-xmark"></i></button>
        </div>
      </div>
      <div class="plan-progress"><div class="plan-progress-fill" id="plan-progress-fill"></div></div>
      <div class="plan-steps">${stepsHtml}</div>
      ${trimBanner}
      <div class="plan-slim-banner" id="plan-slim-banner" style="display:none"><i class="fas fa-compress"></i> Context slimmed between steps for efficiency</div>`;

      $msg().appendChild(el);
      scrollBottom();
      updatePlanScrollMarker();
    }

    /**
     * Refresh the "prompt trimmed" banner in place (no full panel re-render, so it
     * doesn't steal focus from an in-progress edit) after promptProfile changes.
     */
    function updatePlanTrimBanner() {
      const panel = document.getElementById('plan-panel');
      if (!panel || !state.currentPlan?.promptProfile) return;
      const p = state.currentPlan.promptProfile;
      const trimmed = [];
      if (!p.needsBrowser) trimmed.push('browser');
      if (!p.needsGit) trimmed.push('git');
      if (!p.needsSearch) trimmed.push('search');
      let el = panel.querySelector('.plan-trim-banner');
      if (!trimmed.length) { el?.remove(); return; }
      const html = `<i class="fas fa-compress"></i> System prompt trimmed (${trimmed.join(', ')} not needed for this plan)`;
      if (el) { el.innerHTML = html; return; }
      el = document.createElement('div');
      el.className = 'plan-slim-banner plan-trim-banner';
      el.style.display = 'flex';
      el.title = "These sections are shortened in the system prompt for this plan run since no step appears to need them. They'll expand back automatically if you edit a step to need one.";
      el.innerHTML = html;
      panel.querySelector('.plan-steps')?.insertAdjacentElement('afterend', el);
    }

    /* ── Track user edits on plan steps ── */
    function markPlanStepModified(idx) {
      if (!state.currentPlan) return;
      const step = state.currentPlan.steps[idx];
      const descEl = document.getElementById('plan-desc-' + idx);
      if (step && descEl) {
        const isModified = descEl.textContent.trim() !== descEl.dataset.orig;
        step._modified = isModified;
        step.description = descEl.textContent.trim();
        descEl.style.color = isModified ? 'var(--accent)' : '';
        descEl.style.borderBottom = isModified ? '1px dashed var(--accent-d)' : '';
        descEl.style.paddingBottom = isModified ? '2px' : '';
        // Keep the trimmed-prompt profile in sync with edited step text — e.g. if
        // the user adds "take a screenshot" to a step, the browser section should
        // come back for the rest of this plan run.
        state.currentPlan.promptProfile = inferPlanPromptProfile(state.currentPlan.steps);
        updatePlanTrimBanner();
      }
    }

    /* ── Enter key in editable step: blur to save, don't create newlines ── */
    function planDescKeydown(e, idx) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.currentTarget.blur();
      }
    }

    /* ── Regenerate a single plan step using the LLM ── */
    async function regeneratePlanStep(idx) {
      if (state.running || !state.currentPlan) return;

      const step = state.currentPlan.steps[idx];
      const plan = state.currentPlan;

      /* Build context: the full plan with status markers */
      const stepsCtx = plan.steps.map((s, i) => {
        const icons = { pending: '○', running: '⟳', done: '✓', failed: '✗', stopped: '⏸' };
        const mod = s._modified ? ' [edited]' : '';
        const marker = i === idx ? '→' : ' ';
        return `${marker}${icons[s.status] || '○'} Step ${i + 1}: ${s.description}${mod}`;
      }).join('\n');

      const prompt = `You are refining a plan step. The user wants to regenerate step ${idx + 1}.

    FULL PLAN (→ marks the target step):
    ${stepsCtx}

    ORIGINAL:
    ${step.description}

    Rules:
    - Output ONLY the new description for step ${idx + 1}, nothing else
    - Keep it focused and actionable (one tool call, one file, one change)
    - Consider dependencies with adjacent steps
    - If the step was already completed, think about what needs to change or re-verify
    - Do NOT add "STEP:" prefix or step number`;

      /* Show loading state on the step */
      const descEl = document.getElementById('plan-desc-' + idx);
      const regenBtn = document.getElementById('plan-regen-' + idx);
      if (descEl) {
        descEl.contentEditable = 'false';
        descEl.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:10px"></i> Regenerating...';
      }
      if (regenBtn) regenBtn.disabled = true;

      try {
        state.abortCtrl = new AbortController();
        const data = await requestModelJSON({
            model: state.model,
            messages: [
              { role: 'system', content: 'Regenerate a plan step. Output ONLY the new description text, no prefix, no numbering.' },
              { role: 'user', content: prompt }
            ],
            temperature: 0.4,
            max_tokens: 300,
            stream: false
          }, state.abortCtrl?.signal);
        const text = data.choices?.[0]?.message?.content || step.description;

        /* Update the step */
        step.description = text.trim();
        step.status = 'pending';
        step._modified = true;
        state.currentPlan.promptProfile = inferPlanPromptProfile(state.currentPlan.steps);
        updatePlanTrimBanner();

        /* Re-render this step's description */
        if (descEl) {
          descEl.textContent = step.description;
          descEl.contentEditable = 'true';
          descEl.dataset.orig = step.description;
          descEl.style.color = 'var(--accent)';
          descEl.style.borderBottom = '1px dashed var(--accent-d)';
          descEl.style.paddingBottom = '2px';
        }
        if (regenBtn) regenBtn.disabled = false;

        showToast('Step ' + (idx + 1) + ' regenerated', 'ok');

      } catch (e) {
        /* Restore original on error */
        if (descEl) {
          descEl.textContent = step.description;
          descEl.contentEditable = 'true';
          descEl.dataset.orig = step.description;
          descEl.style.color = '';
          descEl.style.borderBottom = '';
          descEl.style.paddingBottom = '';
        }
        if (regenBtn) regenBtn.disabled = false;
        showToast('Failed: ' + e.message, 'err');
      } finally {
        state.abortCtrl = null;
      }
    }

    function updatePlanStep(idx, status) {
      if (!state.currentPlan) return;
      state.currentPlan.steps[idx].status = status;

      const stepEl = document.getElementById('plan-step-' + idx);
      const indEl = document.getElementById('plan-ind-' + idx);
      const runBtn = document.getElementById('plan-run-' + idx);
      const regenBtn = document.getElementById('plan-regen-' + idx);
      if (!stepEl || !indEl) return;

      stepEl.className = 'plan-step ' + status;
      indEl.className = 'plan-step-indicator ' + status;

      if (status === 'done') indEl.innerHTML = '<i class="fas fa-check"></i>';
      else if (status === 'running') indEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      else if (status === 'failed') indEl.innerHTML = '<i class="fas fa-xmark"></i>';
      else if (status === 'stopped') indEl.innerHTML = '<i class="fas fa-pause"></i>';
      else indEl.innerHTML = '';

      if (runBtn) runBtn.disabled = (status !== 'pending');
      if (regenBtn) regenBtn.disabled = (status === 'running');

      updatePlanProgress();
      scrollBottom();
    }

    function updatePlanProgress() {
      if (!state.currentPlan) return;
      const total = state.currentPlan.steps.length;
      const done = state.currentPlan.steps.filter(s => s.status === 'done').length;
      const fill = document.getElementById('plan-progress-fill');
      if (fill) {
        fill.style.width = (done / total * 100) + '%';
        if (done === total) fill.classList.add('complete');
        else fill.classList.remove('complete');
      }
    }

    function discardPlan() {
      if (state.planExecuting) {
        state.abortCtrl?.abort();
        state.running = false;
        state.planExecuting = false;
        updateSendBtn();
      }
      const panel = document.getElementById('plan-panel');
      if (panel) panel.remove();
      updatePlanScrollMarker();
      state.currentPlan = null;
      state.planStepIndex = -1;
      /* Remove the user message that triggered planning (last one) */
      if (state.messages.length && state.messages[state.messages.length - 1].role === 'user') {
        state.messages.pop();
      }
      updateContextMeter();
      saveCurrentConv();
      showToast('Plan discarded', 'info');
    }

    function slimStepMessages(startIdx, endIdx) {
      let slimmed = 0;
      for (let i = Math.max(0, startIdx); i < Math.min(endIdx, state.messages.length); i++) {
        const m = state.messages[i];
        if (m.role !== 'tool' || m._slimmed) continue;

        const parent = findParentToolCall(i);
        if (!parent) continue;
        const name = parent.function.name;
        const args = safeParseArgs(parent.function.arguments);
        const orig = m.content || '';

        let summary = '';
        if (name === 'read_file' || name === 'read_file_lines') {
          const lineCount = orig.split('\n').length;
          summary = 'read_file ' + (args.path || '?') + ': reviewed (' + lineCount + ' lines)';
        } else if (name === 'edit_file') {
          summary = orig.includes('ERROR') ? 'edit_file ' + (args.path || '?') + ': FAILED' : 'edit_file ' + (args.path || '?') + ': applied';
        } else if (name === 'write_file') {
          summary = 'write_file ' + (args.path || '?') + ': created (' + (args.content || '').length + ' chars)';
        } else if (name === 'execute_command') {
          const em = orig.match(/\[exit code:\s*(\d+)\]/);
          summary = 'exec "' + (args.command || '').slice(0, 80) + '": exit ' + (em ? em[1] : '?');
        } else if (name === 'list_directory') {
          summary = 'list_directory: ' + orig.split('\n').filter(l => l.trim()).length + ' entries';
        } else if (name === 'grep' || name === 'search_files') {
          summary = name + ' "' + (args.pattern || args.query || '').slice(0, 60) + '": results found';
        } else if (name === 'web_search') {
          summary = 'search "' + (args.query || '').slice(0, 60) + '": results found';
        } else if (name === 'fetch_url') {
          summary = 'fetch_url ' + (args.url || '?').slice(0, 80) + ': fetched';
        } else if (name === 'think') {
          summary = '(thought: ' + orig.length + ' chars)';
        } else {
          summary = name + ': ' + (orig.length > 120 ? orig.slice(0, 120) + '...' : orig);
        }

        m.content = summary;
        m._slimmed = true;
        slimmed++;
      }

      const banner = document.getElementById('plan-slim-banner');
      if (banner && slimmed > 0) {
        banner.style.display = 'flex';
        const saved = estimateConvTokens();
        updateContextMeter();
        const after = estimateConvTokens();
        if (saved - after > 100) {
          banner.innerHTML = '<i class="fas fa-compress"></i> Slimmed ' + slimmed + ' tool results — saved ~' + formatTok(saved - after);
        }
      }
    }

    async function executeSinglePlanStep(idx) {
      if (state.running || !state.currentPlan) return;
      state.planExecuting = true;
      updateSendBtn();

      updatePlanStep(idx, 'running');
      const stepMsgIdx = state.messages.length;

      state.messages.push({
        role: 'user',
        content: '[PLAN STEP ' + (idx + 1) + ' of ' + state.currentPlan.steps.length + ']\n' +
                 'Task: ' + state.currentPlan.steps[idx].description + '\n\n' +
                 'Complete ONLY this step. When done, briefly summarize what you did.'
      });
      updateContextMeter();

      await agentLoop();

      if (state.planExecuting) {
        updatePlanStep(idx, 'done');
        slimStepMessages(stepMsgIdx, state.messages.length);
      }

      state.planExecuting = false;
      updateSendBtn();
      saveCurrentConv();
      updatePlanProgress();
    }

    async function executeAllPlanSteps() {
      if (!state.currentPlan || state.planExecuting) return;
      const plan = state.currentPlan;
      const startIdx = plan.steps.findIndex(s => s.status === 'pending');
      if (startIdx < 0) return;

      state.planExecuting = true;
      updateSendBtn();

      const execBtn = document.getElementById('plan-execute-btn');
      if (execBtn) { execBtn.disabled = true; execBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Executing...'; }

      for (let i = startIdx; i < plan.steps.length; i++) {
        if (!state.planExecuting) {
          updatePlanStep(i, 'stopped');
          break;
        }

        updatePlanStep(i, 'running');
        const stepMsgIdx = state.messages.length;

        /* Build completed-steps summary for context continuity */
        const completed = plan.steps.slice(0, i).filter(s => s.status === 'done');
        const completedText = completed.length
          ? 'Previously completed:\n' + completed.map((s, j) => {
              const origIdx = plan.steps.indexOf(s);
              return '  \u2713 Step ' + (origIdx + 1) + ': ' + s.description;
            }).join('\n') + '\n\n'
          : '';

        state.messages.push({
          role: 'user',
          content: '[PLAN STEP ' + (i + 1) + ' of ' + plan.steps.length + ']\n' +
                   'Task: ' + plan.steps[i].description + '\n\n' +
                   completedText +
                   'Complete ONLY this step. When done, briefly summarize. Do NOT proceed to the next step.'
        });
        updateContextMeter();

        /* Run agent loop — exits when LLM stops calling tools */
        try {
          await agentLoop();
        } catch (e) {
          console.error('[plan] agentLoop error at step', i + 1, e);
          updatePlanStep(i, 'failed');
          appendMsg('system', 'Plan failed at step ' + (i + 1) + ': ' + e.message);
          break;
        }

        if (!state.planExecuting) {
          updatePlanStep(i, 'stopped');
          break;
        }

        updatePlanStep(i, 'done');

        /* Slim tool results from this step to save context for next step */
        slimStepMessages(stepMsgIdx, state.messages.length);

        /* Context management between steps */
        if (i < plan.steps.length - 1) {
          const pct = getContextPct();
          if (pct > state.autoCompactPct * 0.8) {
            const saved = await saveProgressToWorkspace('plan step context limit (' + Math.round(pct) + '%)');
            await progressCompact(saved);
            state.messages.push({
              role: 'user',
              content: '[PLAN CONTINUED — step ' + (i + 1) + ' of ' + plan.steps.length + ' completed. Continue with remaining steps. Do NOT re-do completed steps.]'
            });
          }
        }
      }

      state.planExecuting = false;
      updateSendBtn();
      saveCurrentConv();

      /* Update UI */
      const panel = document.getElementById('plan-panel');
      const allDone = plan.steps.every(s => s.status === 'done');
      if (allDone && panel) {
        panel.classList.add('completed');
        if (execBtn) { execBtn.innerHTML = '<i class="fas fa-check"></i> Complete'; execBtn.disabled = true; }
        updatePlanProgress();
        appendMsg('system', 'Plan completed — all ' + plan.steps.length + ' steps finished.');
      } else if (execBtn) {
        const remaining = plan.steps.filter(s => s.status === 'pending').length;
        if (remaining > 0) {
          execBtn.disabled = false;
          execBtn.innerHTML = '<i class="fas fa-play"></i> Resume (' + remaining + ' left)';
          execBtn.onclick = () => executeAllPlanSteps();
        } else {
          execBtn.disabled = true;
          execBtn.innerHTML = '<i class="fas fa-check"></i> Done';
        }
      }
    }


    function toggleSidebar() { document.getElementById('sidebar').classList.toggle('collapsed'); }

    let _wsWarningDismissed = false;

    function updateWorkspaceBanner() {
      const el = document.getElementById('ws-warning');
      if (!el) return;
      if (state.dirHandle || _wsWarningDismissed) {
        el.style.display = 'none';
      } else {
        el.style.display = 'flex';
      }
    }

    function dismissWorkspaceWarning() {
      _wsWarningDismissed = true;
      persistSettings();
      document.getElementById('ws-warning').style.display = 'none';
    }

    /* ═══════════════ DESKTOP NOTIFICATIONS ═══════════════ */
    async function enableNotifications() {
      if (typeof Notification === 'undefined') { showToast('Notifications not supported in this browser', 'warn'); return false; }
      if (Notification.permission === 'denied') { showToast('Notifications blocked — enable them in your browser\'s site settings', 'warn'); return false; }
      if (Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { showToast('Notification permission not granted', 'warn'); return false; }
      }
      return true;
    }

    // Only actually shows a notification if the tab is hidden/unfocused — no
    // point interrupting someone who's already looking at the screen.
    function notifyUser(title, body, tag) {
      if (!state.notificationsEnabled) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      if (document.visibilityState === 'visible' && document.hasFocus()) return;
      try {
        const n = new Notification(title, { body: body ? body.slice(0, 200) : '', tag: tag || undefined });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* some platforms throw if notifications are unsupported despite permission */ }
    }

    async function onNotificationsToggle(cb) {
      if (cb.checked) {
        const ok = await enableNotifications();
        if (!ok) { cb.checked = false; state.notificationsEnabled = false; return; }
      }
      state.notificationsEnabled = cb.checked;
    }

    function showToast(msg, type = 'info') {
      const el = document.createElement('div'); el.className = `toast ${type}`;
      const icons = { ok: 'check-circle', err: 'exclamation-circle', info: 'info-circle', warn: 'triangle-exclamation' };
      el.innerHTML = `<i class="fas fa-${icons[type] || 'info-circle'}"></i><span>${msg}</span>`;
      document.getElementById('toasts').appendChild(el);
      setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 4000);
    }

    /* ═══════════════ WELCOME GRID ═══════════════ */
    function renderWelcomeGrid() {
      const el = document.getElementById('welcome-grid');
      const cards = [
        { icon: 'fa-folder-open', label: 'Open Workspace', desc: 'Select a project directory', cls: 'action', action: 'openDirectory()' },
        { icon: 'fa-terminal', label: 'Setup Companion', desc: 'Save & start the shell server', cls: 'action', action: 'saveCompanionScript()' },
        { icon: 'fa-code', label: 'Iterative Development', desc: 'Plan, build, test, refine in small steps', cls: 'template', prompt: 'I want to build: [describe what you want — a feature, tool, app, script, etc.]\n\n## Rules\n- Start by reading existing code to understand what’s already there before writing anything\n- Plan the approach using the think tool before making any changes\n- Work in small, verifiable increments — make one thing work before adding the next\n- After each change, verify it works (run it, test it, read back the file)\n- If something breaks, read the error carefully and fix the specific issue — don’t rewrite everything\n- If you’re unsure about the project structure or dependencies, search for existing patterns first\n- When adding new files, consider where they fit in the existing architecture\n- Commit working states with git periodically so we can roll back if needed' },
        { icon: 'fa-magnifying-glass-chart', label: 'Analyze Codebase', desc: 'Structure, deps, entry points', cls: 'template', color: 'var(--cyan)', prompt: TEMPLATES[0].prompt },
        { icon: 'fa-bug', label: 'Find & Fix Bugs', desc: 'Run tests, apply targeted fixes', cls: 'template', color: 'var(--red)', prompt: TEMPLATES[1].prompt },
        { icon: 'fa-arrows-rotate', label: 'Refactor Code', desc: 'Improve structure, preserve behavior', cls: 'template', color: 'var(--teal)', prompt: TEMPLATES[2].prompt },
        { icon: 'fa-flask-vial', label: 'Write Tests', desc: 'Cover edge cases and failures', cls: 'template', color: 'var(--green)', prompt: TEMPLATES[3].prompt },
        { icon: 'fa-book', label: 'Generate Docs', desc: 'README, inline docs, API docs', cls: 'template', color: 'var(--accent)', prompt: TEMPLATES[4].prompt },
        { icon: 'fa-lightbulb', label: 'Explain Code', desc: 'Step-by-step walkthrough', cls: 'template', color: 'var(--yellow)', prompt: TEMPLATES[5].prompt },
      ];
      el.innerHTML = ''; // Clear container

      cards.forEach(c => {
        const btn = document.createElement('button');
        btn.className = 'w-card';

        if (c.action) {
          const actionMap = { 'openDirectory()': openDirectory, 'saveCompanionScript()': saveCompanionScript, 'doNewConversation()': doNewConversation, 'openSettings()': () => { document.getElementById('settings-modal').style.display = 'flex' } };
          btn.onclick = actionMap[c.action] || (() => console.warn('Unknown action:', c.action));
        } else {
          btn.onclick = () => prefill(c.prompt);
        }

        btn.innerHTML = `<div class="wc-icon ${c.cls}"><i class="fas ${c.icon}" style="color:${c.color || 'var(--cyan)'}"></i></div><span>${c.label}</span><small>${c.desc}</small>`;
        el.appendChild(btn);
      });
    }

    /* ═══════════════ UNDO LOGIC ═══════════════ */
    async function revertFile(path) {
      if (!state.fileBackups || !state.fileBackups.has(path)) { showToast('No backup found for ' + path, 'err'); return; }
      const backup = state.fileBackups.get(path);
      try {
        await writeFileSafe(path, backup);
        state.fileBackups.delete(path);
        rpState.changes = rpState.changes.filter(c => c.path !== path);
        rpState.renderChanges(); rpState.updateBadge();
        showToast('Reverted ' + path.split('/').pop() + ' to original state', 'ok');
      } catch (e) {
        showToast('Failed to revert ' + path + ': ' + e.message, 'err');
      }
    }

    /* ═══════════════ RIGHT PANEL ═══════════════ */
    const rpState = {
      activeTab: 'files',
      activeFile: null,
      changes: [],
      terminalEntries: [],
      _termCurrentId: null,
      addChange(path, type, diff) {
        const existing = this.changes.find(c => c.path === path);
        if (existing) { existing.type = type; existing.diff = diff; existing.stats = diff?.stats || existing.stats; existing.timestamp = Date.now(); }
        else this.changes.push({ path, type, diff, stats: diff?.stats || null, timestamp: Date.now() });
        this.renderChanges(); this.updateBadge();
      },
      updateBadge() {
        const b = document.getElementById('rp-changes-badge'); if (!b) return;
        const n = this.changes.length; b.style.display = n ? '' : 'none'; b.textContent = n;
      },
      renderChanges() {
        const empty = document.getElementById('rp-changes-empty'), list = document.getElementById('rp-changes-list');
        if (!this.changes.length) { empty.style.display = ''; list.innerHTML = ''; return; }
        empty.style.display = 'none';
        let adds = 0, dels = 0;
        this.changes.forEach(c => { if (c.stats) { adds += c.stats.additions || 0; dels += c.stats.deletions || 0; } });
        let html = `<div class="rp-changes-header"><span class="rp-changes-title">Session Changes</span><div class="rp-changes-stats"><span style="color:var(--green)">+${adds}</span><span style="color:var(--red)">-${dels}</span><span>${this.changes.length} files</span></div></div>`;
        this.changes.forEach((c, i) => {
          const opIcons = { modified: '~', created: '+', deleted: '-', moved: '→' };
          const statStr = c.stats ? `<span class="rp-change-stat" style="color:var(--green)">+${c.stats.additions}</span><span class="rp-change-stat" style="color:var(--red)">-${c.stats.deletions}</span>` : '';
          const revertBtn = state.fileBackups && state.fileBackups.has(c.path) ? `<button class="rp-revert-btn" onclick="event.stopPropagation(); revertFile(&quot;${esc(c.path)}&quot;)" title="Revert to original content" style="margin-left:auto;background:none;border:none;color:var(--tx-3);cursor:pointer;"><i class="fas fa-undo"></i></button>` : '';
          html += `<div class="rp-change-item" onclick="rpToggleChangeDiff(${i})"><span class="rp-change-op ${c.type}">${opIcons[c.type] || '?'}</span><span class="rp-change-path">${esc(c.path)}</span>${statStr}${revertBtn}</div>`;
          if (c.diff) {
            const changed = c.diff.lines.filter(l => l.type !== 'ctx');
            const { compact: displayLines } = compactDiffLines(c.diff.lines, 1, 1);
            html += `<div class="rp-change-diff" id="rp-cd-${i}">${displayLines.map(l => `<div class="diff-line ${l.type}">${l.type === 'ellipsis' ? '···' : esc(l.text)}</div>`).join('')}${changed.length > 80 ? '<div class="diff-line ellipsis">··· showing first 80 changed lines</div>' : ''}</div>`;
          }
        });
        list.innerHTML = html;
      },
      clearChanges() { this.changes = []; this.renderChanges(); this.updateBadge(); }
    };

    function toggleRightPanel() { document.getElementById('right-panel').classList.toggle('collapsed'); }

    function switchRpTab(name) {
      rpState.activeTab = name;
      document.querySelectorAll('.rp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
      document.querySelectorAll('.rp-pane').forEach(p => p.classList.toggle('active', p.id === 'rp-' + name));
      if (name === 'git') updateGitPanel();
    }

    function rpToggleChangeDiff(idx) {
      const el = document.getElementById('rp-cd-' + idx); if (el) el.classList.toggle('open');
    }

    function renderFilePreview() {
      const f = rpState.activeFile;
      if (!f) return;
      if (f.isHtml) {
        renderHtmlFilePreview(f);
        return;
      }

      const ext = f.path.split('.').pop();
      const langMap = {
        py: 'python', js: 'javascript', ts: 'typescript', rs: 'rust',
        go: 'go', html: 'xml', css: 'css', json: 'json', md: 'markdown',
        sh: 'bash', jsx: 'javascript', tsx: 'typescript',
        yaml: 'yaml', yml: 'yaml', toml: 'ini', xml: 'xml',
        sql: 'sql', r: 'r', rb: 'ruby', java: 'java', cpp: 'cpp',
        c: 'c', h: 'c', cs: 'csharp', php: 'php', swift: 'swift',
        kt: 'kotlin', dart: 'dart', lua: 'lua', pl: 'perl',
        dockerfile: 'dockerfile', makefile: 'makefile', cmake: 'cmake'
      };
      const lang = langMap[ext] || '';
      const hlLine = f.highlightLine;

      const lineHtml = f.lines.map((line, i) => {
        let highlighted;
        if (lang && hljs.getLanguage(lang)) {
          try {
            highlighted = hljs.highlight(line, { language: lang }).value;
          } catch {
            highlighted = esc(line);
          }
        } else {
          highlighted = esc(line);
        }
        const isHl = hlLine != null && i + 1 === hlLine;
        return `<div class="rp-file-line${isHl ? ' highlight' : ''}">` +
          `<span class="rp-file-line-num" data-line="${i + 1}">${i + 1}</span>` +
          `<span class="rp-file-line-text">${highlighted}</span></div>`;
      }).join('');

      const previewEl = document.getElementById('rp-file-preview');
      previewEl.innerHTML =
        `<div class="rp-file-header">` +
          `<span class="rp-file-name">${esc(f.path)}</span>` +
          `<span class="rp-file-meta">${f.lines.length} lines</span>` +
          `<div class="rp-file-actions">` +
            `<button class="rp-file-act" data-action="copy-file" title="Copy file"><i class="fas fa-copy"></i></button>` +
          `</div>` +
        `</div>` +
        `<div class="rp-file-code">${lineHtml}</div>` +
        (f.truncated ? '<div class="rp-file-truncated">File was truncated when read</div>' : '');

      /* ── Event delegation (no inline onclick) ── */
      previewEl.onclick = function(e) {
        const lineNum = e.target.closest('.rp-file-line-num');
        if (lineNum) {
          const num = parseInt(lineNum.dataset.line, 10);
          if (num > 0 && num <= f.lines.length) {
            navigator.clipboard.writeText(f.lines[num - 1]).then(() => {
              lineNum.style.color = 'var(--green)';
              setTimeout(() => { lineNum.style.color = ''; }, 800);
            });
          }
          return;
        }
        if (e.target.closest('[data-action="copy-file"]')) {
          navigator.clipboard.writeText(f.content).then(() => showToast('Copied', 'ok'));
        }
      };
    }

    async function previewFile(path, highlightLine) {
      if (!state.dirHandle) { showToast('Open a workspace first', 'warn'); return; }
      if (rpState.activeTab !== 'files') switchRpTab('files');
      const emptyEl = document.getElementById('rp-files-empty');
      const previewEl = document.getElementById('rp-file-preview');

      /* ── PDF: resolve path to get File object for thumbnail rendering ── */
      if (path.toLowerCase().endsWith('.pdf')) {
        try {
          const h = await resolvePath(path);
          if (h.kind !== 'file') {
            previewEl.style.display = 'block';
            emptyEl.style.display = 'none';
            previewEl.innerHTML = `<div class="rp-empty-state"><i class="fas fa-exclamation-triangle" style="color:var(--red)"></i><span>"${esc(path)}" is not a file</span></div>`;
            return;
          }
          const file = await h.getFile();
          rpState.activeFile = { content: await extractPdfText(file), isPdf: true };
          renderPdfPreview(file);
          emptyEl.style.display = 'none';
          previewEl.style.display = 'block';
          return;
        } catch (e) {
          previewEl.style.display = 'block';
          emptyEl.style.display = 'none';
          previewEl.innerHTML = `<div class="rp-empty-state"><i class="fas fa-exclamation-triangle" style="color:var(--red)"></i><span>${esc(e.message)}</span></div>`;
          return;
        }
      }

      /* ── Text / image / SVG files ── */
      try {
        const result = await readFileSafe(path);
        const rawOutput = result.output || '';
        const header = rawOutput.split('\n---\n')[0] || '';
        const content = rawOutput.includes('\n---\n')
          ? rawOutput.split('\n---\n').slice(1).join('\n---\n')
          : rawOutput;

        /* ── Raster image: show preview instead of code ── */
        if (result._imageDataUrl) {
          rpState.activeFile = {
            path, content: result.output,
            lines: ['[Image file — see preview]'],
            isImage: true, imageDataUrl: result._imageDataUrl,
            truncated: result.output.includes('TRUNCATED'), meta: header
          };
          previewEl.innerHTML =
            `<div class="rp-file-header">` +
              `<span class="rp-file-name"><i class="fas fa-image" style="color:var(--accent);margin-right:4px"></i>${esc(path)}</span>` +
              `<span class="rp-file-meta">${result.output.split('\n')[0]}</span>` +
            `</div>` +
            `<div class="rp-file-image">` +
              `<img src="${result._imageDataUrl}" onclick="openImgViewer(this.src)" alt="${esc(path)}">` +
            `</div>`;
          emptyEl.style.display = 'none';
          previewEl.style.display = 'block';
          return;
        }

        /* ── SVG: show rendered preview instead of raw XML ── */
        if (result._svgPreviewUrl) {
          rpState.activeFile = {
            path, content: result.output,
            lines: ['[SVG file — see preview]'],
            isImage: true, imageDataUrl: result._svgPreviewUrl,
            truncated: false, meta: header
          };
          previewEl.innerHTML =
            `<div class="rp-file-header">` +
              `<span class="rp-file-name"><i class="fas fa-bezier-curve" style="color:var(--accent);margin-right:4px"></i>${esc(path)}</span>` +
              `<span class="rp-file-meta">${result.output.split('\n')[0]}</span>` +
            `</div>` +
            `<div class="rp-file-image">` +
              `<img src="${result._svgPreviewUrl}" onclick="openImgViewer(this.src)" alt="${esc(path)}">` +
            `</div>`;
          emptyEl.style.display = 'none';
          previewEl.style.display = 'block';
          return;
        }
        /* ── HTML files: code + rendered preview ── */
        const isHtml = /\.(html?|xhtml?)$/i.test(path);
        if (isHtml) {
          // For HTML preview we always need the actual file text, not a skeleton/summary.
          // readFileSafe may return a skeleton or truncated output for large files.
          // Priority: fileCache (set by readFileSafe on every real read) → direct file read → content from output
          let realContent = state.fileCache.get(path);
          if (typeof realContent !== 'string') {
            // Cache miss — try reading the file directly (bypasses skeleton logic)
            try {
              const h = await resolvePath(path);
              if (h && h.kind === 'file') {
                const fh = await h.getFile();
                realContent = await fh.text();
                state.fileCache.set(path, realContent);
              }
            } catch { /* fall through */ }
          }
          // Last resort: use whatever content we extracted from readFileSafe output
          if (typeof realContent !== 'string') realContent = content || '';
          rpState.activeFile = {
            path, content: realContent,
            lines: realContent.split('\n'),
            isHtml: true,
            truncated: rawOutput.includes('TRUNCATED'),
            meta: header
          };
          renderFilePreview();
          emptyEl.style.display = 'none';
          previewEl.style.display = 'block';
          return;
        }
        /* ── Text file: render with syntax highlighting ── */
        const lines = content.split('\n');
        rpState.activeFile = {
          path, content, lines,
          isImage: false, imageDataUrl: null,
          highlightLine: highlightLine || null,
          truncated: rawOutput.includes('TRUNCATED'),
          meta: header
        };
        renderFilePreview();
        emptyEl.style.display = 'none';
        previewEl.style.display = 'block';
      } catch (e) {
        previewEl.style.display = 'block';
        emptyEl.style.display = 'none';
        previewEl.innerHTML =
          `<div class="rp-empty-state">` +
            `<i class="fas fa-exclamation-triangle" style="color:var(--red)"></i>` +
            `<span>${esc(e.message)}</span>` +
          `</div>`;
      }
    }

    function rpCopyLine(numEl, lineNum) {
      const f = rpState.activeFile; if (!f) return;
      navigator.clipboard.writeText(f.lines[lineNum - 1]).then(() => { numEl.style.color = 'var(--green)'; setTimeout(() => numEl.style.color = '', 800); });
    }
    function rpCopyFile() {
      const f = rpState.activeFile; if (!f) return;
      navigator.clipboard.writeText(f.content).then(() => showToast('Copied', 'ok'));
    }

    /* ── Terminal panel ── */
    let _rpTermId = 0;
    function rpTermStart(command) {
      const id = ++_rpTermId; rpState._termCurrentId = id;
      const entry = { id, command: command.slice(0, 200), output: '', exitCode: null, startTime: Date.now(), endTime: null, streaming: true, collapsed: false };
      rpState.terminalEntries.push(entry);
      if (rpState.terminalEntries.length > 50) rpState.terminalEntries = rpState.terminalEntries.slice(-30);
      document.getElementById('rp-term-empty').style.display = 'none';
      rpRenderTermEntry(entry, true);
      if (rpState.activeTab === 'term') { const c = document.getElementById('rp-term-entries'); c.scrollTop = c.scrollHeight; }
    }
    function rpTermAppend(text) {
      const entry = rpState.terminalEntries.find(e => e.id === rpState._termCurrentId && e.streaming);
      if (!entry) return; entry.output += text;
      if (rpState.activeTab === 'term') {
        const outEl = document.getElementById('rp-term-out-' + entry.id);
        if (outEl && !outEl.classList.contains('collapsed')) { outEl.textContent = entry.output; outEl.scrollTop = outEl.scrollHeight; }
      }
    }
    function rpTermEnd(fullOutput) {
      const entry = rpState.terminalEntries.find(e => e.id === rpState._termCurrentId && e.streaming);
      if (!entry) return; entry.streaming = false; entry.endTime = Date.now();
      entry.output = fullOutput || entry.output;
      const m = entry.output.match(/\[exit code:\s*(\d+)\]/); entry.exitCode = m ? parseInt(m[1]) : 0;
      rpRenderTermEntry(entry, false);
    }
    function rpRenderTermEntry(entry, isNew) {
      const el = document.getElementById('rp-term-' + entry.id);
      const dur = entry.endTime ? ((entry.endTime - entry.startTime) / 1000).toFixed(1) + 's' : '...';
      const exitCls = entry.streaming ? 'running' : entry.exitCode === 0 ? 'ok' : 'err';
      const exitText = entry.streaming ? 'running' : entry.exitCode === 0 ? '0' : ' ' + entry.exitCode;
      const html = `<div class="rp-term-header" onclick="rpToggleTermEntry(${entry.id})"><i class="fas fa-chevron-down rp-term-chevron${entry.collapsed ? ' collapsed' : ''}"></i><i class="fas fa-terminal rp-term-cmd-icon"></i><span class="rp-term-cmd">${esc(entry.command)}</span><div class="rp-term-meta"><span>${dur}</span><span class="rp-term-exit ${exitCls}">${exitText}</span></div></div><div class="rp-term-output${entry.collapsed ? ' collapsed' : ''}" id="rp-term-out-${entry.id}">${esc(entry.output)}</div>`;
      if (el) { el.innerHTML = html; return; }
      const newEl = document.createElement('div');
      newEl.className = 'rp-term-entry';
      newEl.id = 'rp-term-' + entry.id;
      newEl.innerHTML = html;
      document.getElementById('rp-term-entries').appendChild(newEl);
    }
    function rpToggleTermEntry(id) {
      const el = document.getElementById('rp-term-' + id); if (!el) return;
      const chev = el.querySelector('.rp-term-chevron'), out = el.querySelector('.rp-term-output');
      const entry = rpState.terminalEntries.find(e => e.id === id); if (entry) entry.collapsed = !entry.collapsed;
      chev?.classList.toggle('collapsed'); out?.classList.toggle('collapsed');
    }
    function rpClearTerminal() {
      rpState.terminalEntries = []; _rpTermId = 0; rpState._termCurrentId = null;
      document.getElementById('rp-term-entries').innerHTML = ''; document.getElementById('rp-term-empty').style.display = '';
    }

    /* ── Git panel ── */
    async function updateGitPanel() {
      const el = document.getElementById('rp-git-content');
      if (!state.compConnected) { el.innerHTML = '<div class="rp-empty-state"><i class="fas fa-code-branch"></i><span>Git requires the companion server</span></div>'; return; }
      el.innerHTML = '<div class="rp-empty-state"><i class="fas fa-spinner fa-spin"></i><span>Loading...</span></div>';
      try {
        const [branchRes, statusRes] = await Promise.all([execViaCompanion('git rev-parse --abbrev-ref HEAD 2>/dev/null', 10), execViaCompanion('git status --short 2>/dev/null', 10)]);
        const branch = branchRes.replace(/\n/g, '').trim() || 'unknown';
        const statusLines = statusRes.trim().split('\n').filter(l => l.trim());
        if (statusRes.includes('NOT A GIT REPOSITORY')) { el.innerHTML = '<div class="rp-empty-state"><i class="fas fa-code-branch"></i><span>Not a git repository</span></div>'; return; }
        let html = `<div class="rp-git-branch"><i class="fas fa-code-branch rp-git-branch-icon"></i><span class="rp-git-branch-name">${esc(branch)}</span></div><div class="rp-git-actions"><button class="rp-git-btn" onclick="rpGitQuick('stage')"><i class="fas fa-plus"></i> Stage All</button><button class="rp-git-btn" onclick="rpGitQuick('log')"><i class="fas fa-clock-rotate-left"></i> Log</button><button class="rp-git-btn" onclick="updateGitPanel()"><i class="fas fa-rotate"></i></button></div>`;
        if (statusLines.length) {
          html += '<div class="rp-git-status">';
          for (const line of statusLines) {
            const code = line.substring(0, 2).trim();
            let path = line.substring(3).trim();
            const sc = code.charAt(0) || '?';
            if (path.includes(' -> ')) {
              path = path.split(' -> ').pop().trim();
            }
            if (path.startsWith('"') && path.endsWith('"')) {
              path = path.substring(1, path.length - 1).replace(/\\"/g, '"');
            }
            html += `<div class="rp-git-status-file" onclick="previewFile(&quot;${esc(path)}&quot;)"><span class="rp-git-status-code ${sc}">${sc}</span><span class="rp-git-status-path">${esc(path)}</span></div>`;
          }
          html += '</div>';
        } else { html += '<div class="rp-empty-state" style="padding:20px"><i class="fas fa-check-circle" style="color:var(--green)"></i><span>Working tree clean</span></div>'; }
        el.innerHTML = html;
      } catch (e) { el.innerHTML = `<div class="rp-empty-state"><i class="fas fa-exclamation-triangle" style="color:var(--red)"></i><span>${esc(e.message)}</span></div>`; }
    }

    async function rpGitQuick(action) {
      if (!state.compConnected) return;
      if (action === 'log') {
        const el = document.getElementById('rp-git-content');
        const existingLog = el.querySelector('.rp-git-log');
        if (existingLog) existingLog.remove();
        const logEl = document.createElement('div');
        logEl.className = 'rp-git-log';
        logEl.style.cssText = 'border-top:1px solid var(--border)';
        logEl.innerHTML = '<div style="padding:6px 12px;font-size:9px;color:var(--tx-4);font-family:JetBrains Mono,monospace;text-transform:uppercase;letter-spacing:.5px">Recent Commits</div>';
        el.appendChild(logEl);
        try {
          const out = await execViaCompanion('git log --oneline --decorate -15', 15);
          const clean = (out || '').replace(/\[exit code.*$/, '').trim();
          if (!clean) { logEl.innerHTML += '<div style="padding:12px;font-size:11px;color:var(--tx-4);text-align:center">No commits yet</div>'; return; }
          const lines = clean.split('\n').filter(l => l.trim());
          const items = lines.map((line, i) => {
            const m = line.match(/^([0-9a-f]{7,})\s*(.*)/);
            if (!m) return '';
            const hash = m[1], msg = m[2].trim();
            const isFirst = i === 0;
            return `<div style="display:flex;align-items:flex-start;gap:8px;padding:${isFirst ? '8' : '5'}px 12px;${isFirst ? 'background:var(--bg-2);' : ''}cursor:default;transition:background .1s" onmouseover="this.style.background='var(--bg-3)'" onmouseout="this.style.background='${isFirst ? 'var(--bg-2)' : ''}'">
          <code style="font-family:JetBrains Mono,monospace;font-size:10px;color:var(--accent);flex-shrink:0;margin-top:1px;user-select:all;cursor:text">${esc(hash)}</code>
          <span style="font-size:11px;color:var(--tx-1);line-height:1.4">${esc(msg)}</span>
        </div>`;
          }).join('');
          logEl.innerHTML += '<div>' + items + '</div>';
        } catch (e) { logEl.innerHTML += '<div style="padding:12px;font-size:11px;color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
        return;
      }
      if (action === 'stage') {
        rpTermStart('git add -A');
        try { const out = await execViaCompanion('git add -A', 15); rpTermEnd(out); showToast('Staged', 'ok'); }
        catch (e) { rpTermEnd('[Error: ' + e.message + ']'); showToast('Failed', 'err'); }
        setTimeout(updateGitPanel, 500);
      }
    }

    function initRightPanelResize() {
      const handle = document.getElementById('rp-resize-handle');
      const panel = document.getElementById('right-panel');
      if (!handle || !panel) return;

      const MIN_W = 260;
      const MAX_W = 800;
      let startX = 0;
      let startW = 0;

      function onDown(e) {
        if (panel.classList.contains('collapsed')) return;
        e.preventDefault();
        startX = e.clientX;
        startW = panel.offsetWidth;
        handle.classList.add('active');
        panel.classList.add('resizing');
        document.body.classList.add('rp-resizing');
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }

      function onMove(e) {
        const dx = startX - e.clientX;
        const newW = Math.max(MIN_W, Math.min(MAX_W, startW + dx));
        panel.style.width = newW + 'px';
      }

      function onUp() {
        handle.classList.remove('active');
        panel.classList.remove('resizing');
        document.body.classList.remove('rp-resizing');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        localStorage.setItem('SlopLobster_rpWidth', panel.style.width);
      }

      handle.addEventListener('mousedown', onDown);

      // Restore saved width
      try {
        const saved = localStorage.getItem('SlopLobster_rpWidth');
        if (saved) {
          const w = parseInt(saved);
          if (w && w >= MIN_W && w <= MAX_W) {
            panel.style.width = w + 'px';
          }
        }
      } catch {}
    }

    function initRightPanel() {
      rpState.renderChanges(); rpState.updateBadge();
      /* Add clear button to terminal tab header */
      const termTab = document.querySelector('.rp-tab[data-tab="term"]');
      if (termTab && !termTab.querySelector('.rp-term-clear')) {
        const btn = document.createElement('button'); btn.className = 'rp-term-clear'; btn.textContent = 'Clear'; btn.onclick = e => { e.stopPropagation(); rpClearTerminal(); };
        termTab.appendChild(btn);
      }
    }

    /* ═══════════════ WORKSPACE CONVERSATION STORAGE ═══════════════ */
    const CONV_DIR = '.sloplobster/conversations';

    let _convSaveTimer = null;
    let _convIndexTimer = null;
    let _localStorageImported = false;

    /** Create .sloplobster/conversations/ directory if it doesn't exist */
    async function ensureConvDir(root = conversationWorkspaceHandle()) {
      if (!root) return false;
      try {
        const slopDir = await root.getDirectoryHandle('.sloplobster', { create: true });
        await slopDir.getDirectoryHandle('conversations', { create: true });
        return true;
      } catch (e) {
        console.error('[conv] ensureConvDir error:', e.message);
        return false;
      }
    }

    /** Save a single conversation JSON to workspace */
    function saveConvToWorkspace(conv) {
      const root = conversationWorkspaceHandle();
      convWorkspaceSaveChain = convWorkspaceSaveChain.catch(() => {}).then(() => writeConvToWorkspace(conv, root));
      return convWorkspaceSaveChain;
    }
    async function writeConvToWorkspace(conv, root) {
      if (!root || deletedConvIds.has(conv.id)) return false;
      try {
        if (!(await ensureConvDir(root))) return false;
        const slopDir = await root.getDirectoryHandle('.sloplobster');
        const convDir = await slopDir.getDirectoryHandle('conversations');
        const file = await convDir.getFileHandle(conv.id + '.json', { create: true });
        const writable = await file.createWritable();
        const clean = {
          id: conv.id, title: conv.title || 'Untitled',
          created: conv.created, updated: conv.updated,
          _originalTask: conv._originalTask || null,
          _taskState: conv._taskState || null,
          _harness: conv._harness || null,
          messages: conv.messages.map(m => {
            const c = { role: m.role, content: m.content || null };
            if (m.tool_calls) c.tool_calls = m.tool_calls;
            if (m.tool_call_id) c.tool_call_id = m.tool_call_id;
            if (m._hadImages) c._hadImages = m._hadImages;
            if (m._subAgentData) c._subAgentData = m._subAgentData;
            if (m._swarmData)    c._swarmData    = m._swarmData;
            if (c.role === 'tool' && typeof c.content === 'string' && c.content.length > 8000) {
              c.content = c.content.slice(0, 8000) + '\n... [truncated in file storage]';
            }
            return c;
          })
        };
        await writable.write(JSON.stringify(clean, null, 2));
        await writable.close();
        conv.updated = Date.now();
        return true;
      } catch (e) {
        console.error('[conv] save file error:', e.message);
        return false;
      }
    }

    /** Save index.json (debounced) */
    function scheduleConvIndexSave() {
      clearTimeout(_convIndexTimer);
      _convIndexTimer = setTimeout(async () => {
        const root = conversationWorkspaceHandle();
        if (!root) return;
        try {
          if (!(await ensureConvDir(root))) return;
          const slopDir = await root.getDirectoryHandle('.sloplobster');
          const convDir = await slopDir.getDirectoryHandle('conversations');
          const file = await convDir.getFileHandle('index.json', { create: true });
          const writable = await file.createWritable();
          const index = {
            version: 1,
            activeId: state.activeConvId,
            deletedIds: [...deletedConvIds],
            conversations: state.conversations.filter(c => !deletedConvIds.has(c.id)).map(c => ({
              id: c.id, title: c.title || 'Untitled',
              created: c.created, updated: c.updated
            }))
          };
          await writable.write(JSON.stringify(index, null, 2));
          await writable.close();
        } catch (e) { console.error('[conv] index save error:', e.message); }
      }, 1000);
    }

    /** Load all conversations from workspace folder */
    async function loadConversationsFromWorkspace() {
      const root = conversationWorkspaceHandle();
      if (!root) return false;
      try {
        if (!(await ensureConvDir(root))) return false;
        const slopDir = await root.getDirectoryHandle('.sloplobster');
        const convDir = await slopDir.getDirectoryHandle('conversations');

        // Read index
        let indexData = null;
        try {
          const indexFile = await convDir.getFileHandle('index.json');
          indexData = JSON.parse(await (await indexFile.getFile()).text());
        } catch { /* No index yet — first time */ }

        for (const id of indexData?.deletedIds || []) deletedConvIds.add(id);
        if (!indexData || !Array.isArray(indexData.conversations)) {
          // Scan for any conv_*.json files and build index from scratch
          const files = [];
          for await (const [name, handle] of convDir.entries()) {
            if (name === 'index.json' || !name.startsWith('conv_') || !name.endsWith('.json')) continue;
            try {
              const data = JSON.parse(await (await handle.getFile()).text());
              if (data.id && !deletedConvIds.has(data.id)) files.push({ id: data.id, title: data.title || 'Untitled', created: data.created || Date.now(), updated: data.updated || Date.now() });
            } catch { /* skip corrupted */ }
          }
          if (!files.length) return false;
          indexData = { conversations: files };
          scheduleConvIndexSave();
        }

        // Load each conversation from its file
        const loaded = [];
        for (const meta of indexData.conversations) {
          if (deletedConvIds.has(meta.id)) continue;
          try {
            const convFile = await convDir.getFileHandle(meta.id + '.json');
            const raw = await (await convFile.getFile()).text();
            const data = JSON.parse(raw);
            loaded.push({
              id: data.id || meta.id,
              title: data.title || meta.title || 'Untitled',
              messages: data.messages || [],
              created: data.created || meta.created || Date.now(),
              updated: data.updated || meta.updated || Date.now(),
              _originalTask: data._originalTask || null,
              _taskState: data._taskState || null,
              _harness: data._harness || null
            });
          } catch (e) {
            if (e.name === 'NotFoundError') continue;
            console.warn('[conv] failed to load', meta.id, e.message);
            loaded.push({
              id: meta.id, title: meta.title || '(load error)',
              messages: [], created: meta.created || Date.now(),
              updated: meta.updated || Date.now(), _loadError: true
            });
          }
        }

        state.conversations = loaded;
        state.activeConvId = indexData.activeId && loaded.find(c => c.id === indexData.activeId)
          ? indexData.activeId
          : (loaded.length ? loaded[0].id : null);
        return true;

      } catch (e) {
        console.warn('[conv] workspace load error:', e.message);
        return false;
      }
    }

    /** One-time import from localStorage into workspace */
    async function importFromLocalStorage() {
      if (_localStorageImported || !state.dirHandle) return;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (!Array.isArray(data) || !data.length) return;
        let imported = 0;
        for (const conv of data) {
          if (!conv.id || deletedConvIds.has(conv.id) || !conv.messages || !conv.messages.length) continue;
          if (state.conversations.find(c => c.id === conv.id)) continue;
          state.conversations.push(conv);
          if (!(await ensureConvDir())) break;
          await saveConvToWorkspace(conv);
          imported++;
          _localStorageImported = true
        }

        if (imported > 0) {
          scheduleConvIndexSave();
          // Clean up localStorage
          localStorage.removeItem(STORAGE_KEY);
          showToast(`Imported ${imported} conversation${imported > 1 ? 's' : ''} from browser cache to workspace`, 'ok');
        }
      } catch (e) {
        console.warn('[conv] import error:', e.message);
      }
    }

    /** Get storage status for UI display */
    function getConvStorageStatus() {
      if (!state.dirHandle) return { source: 'memory', label: 'In memory', icon: 'fa-memory' };
      if (state.conversations.length === 0) return { source: 'workspace', label: 'Workspace', icon: 'fa-folder-open', count: 0 };
      return { source: 'workspace', label: 'Workspace', icon: 'fa-folder-open', count: state.conversations.length };
    }

    function updateEmbeddingUI(status, progress, indexTotal, current, totalFiles) {
      const wrap = document.getElementById('embed-status-wrap');
      if (wrap) wrap.classList.remove('has-error');
      const dot = wrap?.querySelector('.embed-status-dot');
      const text = document.getElementById('embed-status-text');
      if (!dot || !text) return;

      // Reset classes
      dot.className = 'embed-status-dot';

      switch (status) {
        case 'loading':
          dot.classList.add('loading');
          text.textContent = 'Loading embedding model...';
          break;
        case 'downloading':
          dot.classList.add('loading');
          text.textContent = 'Downloading model weights...' + (progress != null ? ' ' + Math.round(progress) + '%' : '');
          break;
        case 'ready':
          dot.classList.add('ready');
          const count = typeof totalFiles === 'number' && typeof current === 'number'
            ? current + '/' + totalFiles + ' files indexed'
            : semanticIndex.size + ' embeddings loaded';
          text.textContent = count;
          break;
        case 'indexing':
          dot.classList.add('loading');
          text.textContent = 'Indexing files...' + (typeof current === 'number' && typeof totalFiles === 'number'
            ? ' ' + current + '/' + totalFiles
            : '');
          break;
        case 'reading':
          dot.classList.add('loading');
          text.textContent = 'Reading files...' + (typeof current === 'number' && typeof totalFiles === 'number'
            ? ' ' + current + '/' + totalFiles
            : '');
          break;
        case 'error':
          document.getElementById('embed-status-wrap').classList.add('has-error');
          dot.classList.add('error');
          text.textContent = (progress || 'Failed to load embedding model');
          const retryBtn = document.querySelector('.embed-retry');
          if (retryBtn) retryBtn.style.display = '';
          break;

        case 'empty':
          dot.classList.add('unavailable');
          text.textContent = 'Not loaded';
          break;
        default:
          dot.classList.add('unavailable');
          text.textContent = 'Not loaded';
      }
    }
    async function handleEmbedLoad() {
      const btn = document.querySelector('.embed-retry');
      if (btn) {
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
        btn.disabled = true;
      }
      updateEmbeddingUI('loading');
      try {
        await embeddingService.load();
        if (state.dirHandle) startIndexing();
        showToast('Embedding model loaded — ' + semanticIndex.size + ' files indexed', 'ok');
      } catch (e) {
        console.warn('[embed] load error:', e.message);
        updateEmbeddingUI('error', e.message);
        showToast('Failed to load: ' + e.message.slice(0, 80), 'err');
      } finally {
        if (btn) {
          btn.innerHTML = '<i class="fas fa-download"></i> Load';
          btn.disabled = false;
        }
      }
    }

    function handleEmbedRetry() {
      embeddingService._loadPromise = null;
      embeddingService.error = null;
      updateEmbeddingUI(semanticIndex.size > 0 ? 'ready' : 'empty');
      handleEmbedLoad();
    }

    /* ═══════════════ INIT ═══════════════ */
    function init() {
      loadSettings();
      initCompanionPairing();
      initHarnessFeatures();
      loadConversations();
      renderWelcomeGrid();

      // Check for mid-task interrupted session from IndexedDB
      if (typeof dbGet === 'function') {
        dbGet('agent_states', 'active_session').then(sess => {
          if (sess && (sess.running || sess.run?.phase === 'paused') && sess.convId && (Date.now() - sess.timestamp < 1000 * 60 * 120)) {
            const resumeBanner = document.createElement('div');
            resumeBanner.className = 'health-warning';
            resumeBanner.style.background = 'rgba(234, 179, 8, .12)';
            resumeBanner.style.border = '1px solid rgba(234, 179, 8, .4)';
            resumeBanner.style.margin = '8px 12px';
            resumeBanner.style.display = 'flex';
            resumeBanner.style.alignItems = 'center';
            resumeBanner.style.gap = '8px';
            resumeBanner.innerHTML = `
              <i class="fas fa-rotate-left" style="color:var(--yellow)"></i>
              <span style="font-size:11px;color:var(--tx-1)">Previous agent task was interrupted by page reload: <strong>${esc((sess.originalTask || 'Task').slice(0, 60))}</strong></span>
              <button style="margin-left:auto;background:var(--accent);color:#000;border:none;border-radius:4px;padding:3px 8px;font-size:10px;font-weight:700;cursor:pointer" onclick="this.closest('.health-warning').remove();resumeInterruptedRun('${sess.convId}');">Resume Task</button>
              <button style="background:transparent;color:var(--tx-4);border:none;cursor:pointer;font-size:12px" onclick="this.closest('.health-warning').remove();clearActiveAgentState();"><i class="fas fa-xmark"></i></button>
            `;
            const header = document.querySelector('header');
            if (header && header.nextSibling) {
              header.parentNode.insertBefore(resumeBanner, header.nextSibling);
            }
          }
        });
      }

      if (!state.conversations.length) {
        document.getElementById('welcome').style.display = 'flex';
        $msg().style.display = 'none';
      }

      renderConvList();
      renderToolList();
      renderReferenceSites();
      setupFileDrop();
      setupScrollDetection();

      /* ── Paste: auto-attach images from clipboard ── */
      document.addEventListener('paste', async e => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
        const items = [...(e.clipboardData?.items || [])];
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            e.preventDefault();
            try {
              const file = item.getAsFile();
              const dataUrl = await fileToBase64(file);
              const sizeKB = Math.round((dataUrl.length * 3 / 4) / 1024);
              state.pendingImages.push({ dataUrl, name: 'pasted-image.jpg', size: sizeKB + ' KB' });
              addImageAttachmentsToInputArea();
              updateSendBtn();
              showToast('Image pasted — press Enter to send', 'ok');
              document.getElementById('msg-input').focus();
            } catch (err) { showToast('Could not read pasted image', 'err'); }
            return;
          }
        }
      });

      /* ── Input: auto-resize, history, send on Enter, @ file mentions ── */
      const inp = document.getElementById('msg-input');
      inp.addEventListener('input', () => {
        inputHistoryIdx = -1;
        inp.style.height = 'auto';
        inp.style.height = Math.min(inp.scrollHeight, 150) + 'px';
        updateSendBtn();
        updateInputCounter();
        handleMentionInput(inp);
      });
      inp.addEventListener('keydown', e => {
        const mentionPopup = document.getElementById('file-mention-popup');
        const isMentionOpen = mentionPopup && mentionPopup.classList.contains('open');

        if (isMentionOpen) {
          if (e.key === 'ArrowDown') {
            _mentionSelectedIndex = Math.min(_mentionSelectedIndex + 1, _mentionFilteredFiles.length - 1);
            renderMentionPopup();
            e.preventDefault();
            return;
          }
          if (e.key === 'ArrowUp') {
            _mentionSelectedIndex = Math.max(_mentionSelectedIndex - 1, 0);
            renderMentionPopup();
            e.preventDefault();
            return;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            insertMentionIndex(_mentionSelectedIndex);
            return;
          }
          if (e.key === 'Escape') {
            mentionPopup.classList.remove('open');
            e.preventDefault();
            return;
          }
        }

        if (e.key === 'ArrowUp') {
          if (inputHistory.length && (inputHistoryIdx < inputHistory.length - 1 || inp.value !== inputHistory[inputHistoryIdx])) {
            if (inputHistoryIdx === -1) inputDraft = inp.value;
            inputHistoryIdx = Math.min(inputHistoryIdx + 1, inputHistory.length - 1);
            inp.value = inputHistory[inputHistoryIdx];
            inp.style.height = 'auto';
            inp.style.height = Math.min(inp.scrollHeight, 150) + 'px';
            updateSendBtn();
            e.preventDefault();
          }
          return;
        }
        if (e.key === 'ArrowDown') {
          if (inputHistoryIdx > -1) {
            inputHistoryIdx--;
            inp.value = inputHistoryIdx === -1 ? inputDraft : inputHistory[inputHistoryIdx];
            inp.style.height = 'auto';
            inp.style.height = Math.min(inp.scrollHeight, 150) + 'px';
            updateSendBtn();
            e.preventDefault();
          }
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (state.running) queueSteerMessage();
          else handleSend();
        }
      });

      /* ── Command Palette input listeners ── */
      const cmdInp = document.getElementById('cmd-palette-input');
      if (cmdInp) {
        cmdInp.addEventListener('input', e => {
          _cmdPaletteSelectedIndex = 0;
          renderCommandPalette(e.target.value);
        });
        cmdInp.addEventListener('keydown', e => {
          if (e.key === 'ArrowDown') {
            _cmdPaletteSelectedIndex = Math.min(_cmdPaletteSelectedIndex + 1, _cmdPaletteFiltered.length - 1);
            renderCommandPalette(cmdInp.value);
            e.preventDefault();
            return;
          }
          if (e.key === 'ArrowUp') {
            _cmdPaletteSelectedIndex = Math.max(_cmdPaletteSelectedIndex - 1, 0);
            renderCommandPalette(cmdInp.value);
            e.preventDefault();
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            executePaletteItem(_cmdPaletteSelectedIndex);
            return;
          }
          if (e.key === 'Escape') {
            closeCommandPalette();
            e.preventDefault();
            return;
          }
        });
      }

      /* ── Model selector: load vs switch ── */
      document.getElementById('model-sel').addEventListener('change', async e => {
        const newModel = e.target.value;
        if (!newModel) return;
        if (activeInstance?.identifier === newModel) {
          state.model = newModel;
          updateVisionUI();
          updateModelMeta();
          updateModelLoadBtn();
          updateSendBtn();
          updateWelcomeStatus();
          return;
        }
        if (state.running) {
          showToast('Wait for current response to finish', 'warn');
          e.target.value = state.model;
          return;
        }
        state.model = newModel;
        updateVisionUI();
        updateModelMeta();
        updateSendBtn();
        updateWelcomeStatus();
        await requestModelLoad(newModel);
      });

      /* ── Model metadata hint ── */
      const meta = document.getElementById('model-meta');
      const info = state.modelInfoMap.get(state.model);
      if (info) {
        const parts = [];
        if (info.paramsString) parts.push(info.paramsString);
        if (info.contextLength) parts.push((info.contextLength / 1000).toFixed(0) + 'k ctx');
        if (info.trainedForToolUse) parts.push('tools');
        if (info.vision) parts.push('👁');
        meta.textContent = parts.length ? '(' + parts.join(' · ') + ')' : '';
      } else {
        meta.textContent = '';
      }
      updateVisionUI();
      updateSendBtn();
      updateWelcomeStatus();

      /* ── Settings sliders ── */
      document.getElementById('s-temp').addEventListener('input', e => {
        document.getElementById('s-temp-val').textContent = e.target.value;
      });
      document.getElementById('s-top-p')?.addEventListener('input', e => {
        document.getElementById('s-top-p-val').textContent = parseFloat(e.target.value).toFixed(2);
      });
      document.getElementById('s-top-k')?.addEventListener('input', e => {
        document.getElementById('s-top-k-val').textContent = e.target.value;
      });
      document.getElementById('s-min-p')?.addEventListener('input', e => {
        document.getElementById('s-min-p-val').textContent = parseFloat(e.target.value).toFixed(2);
      });
      document.getElementById('s-repeat-penalty')?.addEventListener('input', e => {
        document.getElementById('s-repeat-penalty-val').textContent = parseFloat(e.target.value).toFixed(2);
      });
      document.getElementById('s-use-server-sampling')?.addEventListener('change', e => {
        const group = document.getElementById('sampling-sliders-group');
        const advGroup = document.getElementById('advanced-samplers-group');
        const qwenGroup = document.getElementById('qwen-thinking-group');
        if (group) { group.style.opacity = e.target.checked ? '.35' : ''; group.style.pointerEvents = e.target.checked ? 'none' : ''; }
        if (advGroup) { advGroup.style.opacity = e.target.checked ? '.35' : ''; advGroup.style.pointerEvents = e.target.checked ? 'none' : ''; }
        if (qwenGroup) { qwenGroup.style.opacity = e.target.checked ? '.35' : ''; qwenGroup.style.pointerEvents = e.target.checked ? 'none' : ''; }
      });
      document.getElementById('s-use-model-load-defaults')?.addEventListener('change', e => {
        const group = document.getElementById('model-load-overrides-group');
        if (group) { group.style.opacity = e.target.checked ? '.35' : ''; group.style.pointerEvents = e.target.checked ? 'none' : ''; }
      });
      document.getElementById('s-freq-penalty')?.addEventListener('input', e => {
        document.getElementById('s-freq-penalty-val').textContent = parseFloat(e.target.value).toFixed(2);
      });
      document.getElementById('s-dry-multiplier')?.addEventListener('input', e => {
        document.getElementById('s-dry-multiplier-val').textContent = parseFloat(e.target.value).toFixed(1);
      });
      document.getElementById('s-xtc-prob')?.addEventListener('input', e => {
        document.getElementById('s-xtc-prob-val').textContent = parseFloat(e.target.value).toFixed(2);
      });

      // Sync quick temp slider
      const tqs = document.getElementById('temp-quick-slider');
      const tqv = document.getElementById('temp-quick-val');
      if (tqs) {
        tqs.value = state.temp;
        const v = parseFloat(state.temp);
        tqv.textContent = v.toFixed(2);
        tqv.style.color = v <= 0.3 ? 'var(--cyan)' : v <= 0.8 ? 'var(--tx-4)' : v <= 1.3 ? 'var(--yellow)' : 'var(--red)';
      }

      /* ── Modal close on backdrop click ── */
      document.getElementById('settings-modal').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeSettings();
      });
      document.getElementById('shortcuts-modal').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeShortcuts();
      });

      /* ── Keyboard shortcuts ── */
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          if (document.getElementById('cmd-palette-modal')?.classList.contains('open')) {
            closeCommandPalette();
            return;
          }
          if (document.getElementById('file-mention-popup')?.classList.contains('open')) {
            document.getElementById('file-mention-popup').classList.remove('open');
            return;
          }
          if (document.getElementById('conv-search-bar')?.classList.contains('open')) {
            closeConvSearch();
            return;
          }
          if (document.getElementById('img-viewer').classList.contains('open')) {
            closeImgViewer();
            return;
          }
          if (document.getElementById('settings-modal').classList.contains('open')) {
            closeSettings();
            return;
          }
          if (document.getElementById('shortcuts-modal').classList.contains('open')) {
            closeShortcuts();
            return;
          }
          if (state.running) {
            state.abortCtrl?.abort();
            state.running = false;
            updateSendBtn();
            return;
          }
          // When idle and no modals open, focus the input
          const msgInp = document.getElementById('msg-input');
          if (msgInp && document.activeElement !== msgInp) { msgInp.focus(); return; }
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          openCommandPalette();
          return;
        }
        if (e.ctrlKey && e.shiftKey && e.key === 'N') {
          e.preventDefault();
          doNewConversation();
        }
        if (e.ctrlKey && !e.shiftKey && e.key === 'b') {
          e.preventDefault();
          toggleSidebar();
        }
        if (e.ctrlKey && e.key === ',') {
          e.preventDefault();
          openSettings();
        }
        if (e.ctrlKey && e.shiftKey && e.key === 'E') {
          e.preventDefault();
          exportConversation();
        }
        if (e.ctrlKey && e.shiftKey && e.key === 'M') {
          e.preventDefault();
          smartCompact();
        }
        if (e.ctrlKey && e.shiftKey && e.key === 'P') {
          e.preventDefault();
          togglePlanMode();
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !e.shiftKey) {
          // Only intercept if messages are visible (not welcome screen)
          if (document.getElementById('messages').style.display !== 'none') {
            e.preventDefault();
            openConvSearch();
          }
        }
        if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
          e.preventDefault();
          inp.focus();
        }
        if ((e.ctrlKey || e.metaKey) && e.key === '/') {
          e.preventDefault();
          inp.focus();
        }
      });

      /* ── Workspace warning banner ── */
      updateWorkspaceBanner();

      /* ── Default system prompt ── */
      if (!document.getElementById('s-sys-prompt').value) {
        document.getElementById('s-sys-prompt').value = DEFAULT_SYS;
      }

      if (document.getElementById('s-qwen-enable-thinking')?.checked === undefined) document.getElementById('s-qwen-enable-thinking').checked = true;
      if (document.getElementById('s-qwen-preserve-thinking')?.checked === undefined) document.getElementById('s-qwen-preserve-thinking').checked = true;

      /* ── Auto-scroll indicator ── */
      updateScrollLockBtn();

      /* ── Right panel ── */
      initRightPanel();
      initRightPanelResize();

      document.getElementById('rp-preview-reload').onclick = () => reloadDevPreview();
      document.getElementById('rp-preview-open').onclick = () => {
        if (state.devServer) window.open(`http://localhost:${state.devServer.port}`, '_blank');
      };
      document.getElementById('rp-preview-stop').onclick = () => {
        stopDevServer();
        showToast('Dev server stopped', 'info');
      };

      /* ── Initial connection checks ── */
      setTimeout(() => testConnection(3), 800);

      /* ── Poll companion health every 20s ── */
      const _intervals = [];
      _intervals.push(setInterval(checkCompanion, 20000));

      /* ── Poll LM Studio for model changes every 300s ── */
      setInterval(async () => {
        if (state.connected && !state.running) {
          try {
            await refreshModels(false);
          } catch { /* silent */ }
        }
      }, 300000);

      /* ── Load persisted embeddings from IndexedDB on startup ── */
      loadEmbeddingsFromIDB().then(() => {
        if (semanticIndex.size > 0) {
          embeddingService.load().catch(() => {});
        }
        updateEmbeddingUI(semanticIndex.size > 0 ? 'ready' : 'empty');
      });

      window.addEventListener('beforeunload', () => {
        _intervals.forEach(clearInterval);
        clearTimeout(_convSaveTimer);
        clearTimeout(_convIndexTimer);

        // Save to workspace if available
        if (state.activeConvId && state.dirHandle) {
          const c = state.conversations.find(c => c.id === state.activeConvId);
          if (c) saveConvToWorkspace(c);
        }

        // Fallback: save lightweight version to localStorage
        if (state.messages.length > 0 && state.activeConvId) {
          const c = state.conversations.find(c => c.id === state.activeConvId);
          if (c) {
            c.messages = state.messages.map(m => {
              const clean = { ...m };
              delete clean._diff; delete clean._searchData; delete clean._images;
              if (m._images?.length) clean._hadImages = m._images.length;
              if (clean.role === 'tool' && typeof clean.content === 'string' && clean.content.length > 2000)
                clean.content = clean.content.slice(0, 2000) + '\n... [truncated]';
              return clean;
            });
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.conversations)); } catch {}
          }
        }
      });

      /* ── MCP config editor: keep syntax-highlight overlay in sync ── */
      const _mcpTa = document.getElementById('s-mcp-config');
      if (_mcpTa) {
        _mcpTa.addEventListener('input', syncMcpHighlight);
        _mcpTa.addEventListener('scroll', syncMcpHighlight);
        syncMcpHighlight();
      }

      /* ── Clean up old conversation data from localStorage ── */
      setTimeout(async () => {
        try {
          const old = localStorage.getItem(STORAGE_KEY);
          if (!old) return;
          const parsed = JSON.parse(old);
          if (!Array.isArray(parsed) || !parsed.length) {
            localStorage.removeItem(STORAGE_KEY);
            return;
          }
          if (state.dirHandle) {
            const workspaceLoaded = state.conversations.some(c => c.messages.length > 0);
            if (workspaceLoaded) {
              localStorage.removeItem(STORAGE_KEY);
              console.info('[init] removed old localStorage conversations — workspace storage active');
            }
          }
        } catch { /* ignore parse errors */ }
      }, 5000);
    }

    /* ═══════════════ IN-CONVERSATION SEARCH ═══════════════ */
    const _convSearch = {
      query: '',
      matches: [],   // [{el, textNode, start, end, mark}]
      current: -1,
    };

    function openConvSearch() {
      const bar = document.getElementById('conv-search-bar');
      if (!bar) return;
      bar.classList.add('open');
      const inp = document.getElementById('conv-search-input-msg');
      inp.focus();
      inp.select();
    }

    function closeConvSearch() {
      const bar = document.getElementById('conv-search-bar');
      if (!bar) return;
      bar.classList.remove('open');
      _clearConvSearchHighlights();
      _convSearch.matches = [];
      _convSearch.current = -1;
      _updateConvSearchMeta();
      document.getElementById('conv-search-input-msg').value = '';
    }

    function convSearchKeydown(e) {
      if (e.key === 'Escape') { closeConvSearch(); return; }
      if (e.key === 'Enter') { e.shiftKey ? convSearchPrev() : convSearchNext(); }
    }

    function _clearConvSearchHighlights() {
      document.querySelectorAll('.msg-search-highlight').forEach(el => {
        const parent = el.parentNode;
        if (parent) {
          parent.replaceChild(document.createTextNode(el.textContent), el);
          parent.normalize();
        }
      });
      _convSearch.matches = [];
      _convSearch.current = -1;
    }

    function convSearchInput(q) {
      _clearConvSearchHighlights();
      _convSearch.query = q.trim();
      if (!_convSearch.query) { _updateConvSearchMeta(); return; }

      const msgs = document.querySelectorAll('#messages .msg-content, #messages .think-content, #messages .tool-result');
      const matches = [];

      // Walk text nodes and highlight
      function walkAndHighlight(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const idx = node.nodeValue.toLowerCase().indexOf(_convSearch.query.toLowerCase());
          if (idx !== -1) {
            const before = document.createTextNode(node.nodeValue.slice(0, idx));
            const mark = document.createElement('mark');
            mark.className = 'msg-search-highlight';
            mark.textContent = node.nodeValue.slice(idx, idx + _convSearch.query.length);
            const after = document.createTextNode(node.nodeValue.slice(idx + _convSearch.query.length));
            const parent = node.parentNode;
            parent.insertBefore(before, node);
            parent.insertBefore(mark, node);
            parent.insertBefore(after, node);
            parent.removeChild(node);
            matches.push(mark);
            // Continue searching in the 'after' text node
            walkAndHighlight(after);
          }
        } else if (node.nodeType === Node.ELEMENT_NODE && !['SCRIPT','STYLE'].includes(node.tagName)) {
          Array.from(node.childNodes).forEach(walkAndHighlight);
        }
      }

      msgs.forEach(el => walkAndHighlight(el));
      _convSearch.matches = matches;
      _convSearch.current = matches.length > 0 ? 0 : -1;
      if (_convSearch.current === 0) _scrollToConvMatch(0);
      _updateConvSearchMeta();
    }

    function _scrollToConvMatch(idx) {
      _convSearch.matches.forEach((m, i) => m.classList.toggle('current', i === idx));
      const m = _convSearch.matches[idx];
      if (m) m.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function convSearchNext() {
      if (!_convSearch.matches.length) return;
      _convSearch.current = (_convSearch.current + 1) % _convSearch.matches.length;
      _scrollToConvMatch(_convSearch.current);
      _updateConvSearchMeta();
    }

    function convSearchPrev() {
      if (!_convSearch.matches.length) return;
      _convSearch.current = (_convSearch.current - 1 + _convSearch.matches.length) % _convSearch.matches.length;
      _scrollToConvMatch(_convSearch.current);
      _updateConvSearchMeta();
    }

    function _updateConvSearchMeta() {
      const meta = document.getElementById('conv-search-meta');
      const prev = document.getElementById('conv-search-prev');
      const next = document.getElementById('conv-search-next');
      if (!meta) return;
      const n = _convSearch.matches.length;
      if (!_convSearch.query) { meta.textContent = ''; }
      else if (n === 0) { meta.textContent = 'No results'; meta.style.color = 'var(--red)'; }
      else { meta.textContent = `${_convSearch.current + 1} / ${n}`; meta.style.color = ''; }
      if (prev) prev.disabled = n < 2;
      if (next) next.disabled = n < 2;
    }

    /* ═══════════════ INPUT CHARACTER COUNTER ═══════════════ */
    function updateInputCounter() {
      const inp = document.getElementById('msg-input');
      const counter = document.getElementById('input-counter');
      if (!inp || !counter) return;
      const len = inp.value.length;
      if (len === 0) { counter.textContent = ''; return; }
      const estTokens = Math.round(len / 4);
      counter.textContent = `${len} chars · ~${estTokens} tok`;
      counter.className = 'input-counter' + (len > 8000 ? ' danger' : len > 4000 ? ' warn' : '');
    }

    function quickTemp(val) {
      const v = parseFloat(val);
      state.temp = v;
      const el = document.getElementById('temp-quick-val');
      el.textContent = v.toFixed(2);
      el.style.color = v <= 0.3 ? 'var(--cyan)' : v <= 0.8 ? 'var(--tx-4)' : v <= 1.3 ? 'var(--yellow)' : 'var(--red)';
      document.getElementById('s-temp').value = v;
      document.getElementById('s-temp-val').textContent = v.toFixed(1);
      persistSettings();
    }

    function showContextBreakdown() {
      const sysTok = state._sysPromptLength || estimateTokens(DEFAULT_SYS);
      const convTok = estimateConvTokens();
      const exactTok = getFreshTokenEstimate();
      const totalTok = exactTok || (sysTok + convTok);
      const ctxWindow = state.ctxWindow;
      const pct = Math.min(100, (totalTok / ctxWindow) * 100);
      const remaining = ctxWindow - totalTok;
      const msgs = state.messages.length;
      const userMsgs = state.messages.filter(m => m.role === 'user').length;
      const asstMsgs = state.messages.filter(m => m.role === 'assistant').length;
      const toolMsgs = state.messages.filter(m => m.role === 'tool').length;
      const comprStats = getCompressionStats();

      const rows = [
        ['System prompt', formatTok(sysTok), 'var(--cyan)'],
        ['Conversation', formatTok(convTok), 'var(--teal)'],
        ['Tool schemas (est)', formatTok(state._lastPromptBreakdown?.schemas || 0), 'var(--yellow)'],
        ['Retrieved context (est, in conversation)', formatTok(state._lastPromptBreakdown?.retrieved || 0), 'var(--tx-3)'],
        exactTok ? ['Total (last exact + delta)', formatTok(exactTok), 'var(--green)'] : ['Total (estimated)', formatTok(totalTok), 'var(--tx-2)'],
        ['Context window', formatTok(ctxWindow), 'var(--tx-4)'],
        ['Remaining', formatTok(remaining), remaining < ctxWindow * 0.2 ? 'var(--red)' : 'var(--green)'],
      ];
      const msgRows = [
        ['User messages', userMsgs],
        ['Assistant messages', asstMsgs],
        ['Tool results', toolMsgs],
        ['Total messages', msgs],
      ];

      const existing = document.getElementById('ctx-breakdown-popup');
      if (existing) { existing.remove(); return; }

      const popup = document.createElement('div');
      popup.id = 'ctx-breakdown-popup';
      popup.style.cssText = `position:fixed;z-index:1000;background:var(--bg-1);border:1px solid var(--border-l);border-radius:8px;padding:14px 16px;min-width:260px;box-shadow:0 8px 32px rgba(0,0,0,.5);font-size:11px;font-family:'JetBrains Mono',monospace`;
      // Position below context meter
      const meter = document.querySelector('.ctx-meter');
      const rect = meter.getBoundingClientRect();
      popup.style.top = (rect.bottom + 6) + 'px';
      popup.style.left = Math.max(8, rect.left - 80) + 'px';

      popup.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <span style="color:var(--tx-0);font-weight:600;font-size:12px">Context Breakdown</span>
          <button onclick="document.getElementById('ctx-breakdown-popup').remove()" style="background:none;border:none;color:var(--tx-4);cursor:pointer;font-size:14px;line-height:1">×</button>
        </div>
        <div style="margin-bottom:10px">
          <div style="height:5px;background:var(--bg-3);border-radius:3px;overflow:hidden;margin-bottom:4px">
            <div style="height:100%;width:${pct.toFixed(1)}%;background:${pct>80?'var(--red)':pct>50?'var(--yellow)':'var(--cyan)'};border-radius:3px;transition:width .3s"></div>
          </div>
          <span style="color:var(--tx-3)">${pct.toFixed(1)}% used</span>
        </div>
        <table style="width:100%;border-collapse:collapse">
          ${rows.map(([label, val, color]) => `<tr><td style="color:var(--tx-3);padding:2px 0">${label}</td><td style="text-align:right;color:${color};font-weight:600;padding:2px 0">${val}</td></tr>`).join('')}
        </table>
        <div style="border-top:1px solid var(--border);margin:8px 0"></div>
        <table style="width:100%;border-collapse:collapse">
          ${msgRows.map(([label, val]) => `<tr><td style="color:var(--tx-4);padding:2px 0">${label}</td><td style="text-align:right;color:var(--tx-2);padding:2px 0">${val}</td></tr>`).join('')}
        </table>
        ${comprStats && comprStats.saved > 100 ? `<div style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px;color:var(--green);font-size:10px"><i class="fas fa-compress" style="margin-right:4px"></i>Compression saved ~${formatTok(Math.round(comprStats.saved/3.8))} tok (${comprStats.pct}%)</div>` : ''}
      `;
      document.body.appendChild(popup);
      // Close on outside click
      setTimeout(() => { document.addEventListener('click', function _close(e) { if (!popup.contains(e.target) && !e.target.closest('.ctx-meter')) { popup.remove(); document.removeEventListener('click', _close); } }); }, 10);
    }

    /* ═══════════════ SWARM INPUT MODE TOGGLE ═══════════════ */
    let _swarmInputMode = false;
    function toggleSwarmInputMode() {
      _swarmInputMode = !_swarmInputMode;
      const btn = document.getElementById('swarm-toggle-btn');
      const inp = document.getElementById('msg-input');
      if (btn) btn.classList.toggle('active', _swarmInputMode);
      if (inp) {
        inp.placeholder = _swarmInputMode
          ? 'Describe a goal for the swarm (multiple agents will tackle it in parallel)...'
          : (state.planMode ? 'Describe a task to plan (steps will be generated before execution)...' : 'Ask SlopLobster to do something... (drop files or paste images)');
      }
      showToast(_swarmInputMode ? 'Swarm mode ON — agents will run in parallel' : 'Swarm mode OFF', 'info');
    }

    /* ═══════════════ DEEP RESEARCH ═══════════════ */
    let _deepResearchInputMode = false;

    function toggleDeepResearchInputMode() {
      _deepResearchInputMode = !_deepResearchInputMode;
      const btn = document.getElementById('research-toggle-btn');
      const inp = document.getElementById('msg-input');
      if (btn) btn.classList.toggle('active', _deepResearchInputMode);
      if (inp) {
        inp.placeholder = _deepResearchInputMode
          ? 'Enter a topic for deep research (live iterative search & synthesis)...'
          : (state.planMode ? 'Describe a task to plan...' : _swarmInputMode ? 'Describe a goal for the swarm...' : 'Ask SlopLobster to do something...');
      }
      showToast(_deepResearchInputMode ? 'Deep Research ON — agent will plan, search, and synthesize live' : 'Deep Research OFF', 'info');
    }

    /**
     * Helper: Non-streaming LLM call for tool internal logic.
     */
    async function callLLMForTool(messages, temperature = 0.2, maxTokens = 2000) {
      if (!state.connected || !state.model) throw new Error('LLM not connected');
      const data = await requestModelJSON({ model: state.model, messages, temperature,
        max_tokens: Math.min(maxTokens, 4000) }, state.abortCtrl?.signal);
      return data.choices?.[0]?.message?.content || '';
    }

    /**
     * Creates the initial DOM structure for the live research panel.
     * DOES NOT append to DOM. The caller (executeTool) will append it inside the tool panel.
     */
    function createLiveResearchPanel(query) {
      const el = document.createElement('div');
      el.className = 'deep-research-panel';
      el.innerHTML = `
        <div class="dr-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <i class="fas fa-microscope"></i>
          <div class="dr-title">Deep Research: ${esc(query)}</div>
          <div class="dr-status">Initializing...</div>
          <button class="dr-abort-btn" onclick="event.stopPropagation(); this.closest('.deep-research-panel')._drAbortFn && this.closest('.deep-research-panel')._drAbortFn()" style="margin-left:8px">
            <i class="fas fa-stop"></i> Abort
          </button>
        </div>
        <div class="dr-body">
          <!-- Phase 1: Plan -->
          <div class="dr-phase dr-phase-plan">
            <div class="dr-phase-indicator"><div class="dr-dot"></div><div class="dr-line"></div></div>
            <div class="dr-phase-content">
              <div class="dr-phase-title" onclick="this.closest('.dr-phase').classList.toggle('dr-phase-collapsed')">
                <i class="fas fa-brain"></i> Planning Research
                <span class="dr-phase-stat dr-stat-plan">—</span>
              </div>
              <div class="dr-phase-details"><ul class="dr-query-list dr-queries"></ul></div>
            </div>
          </div>
          <!-- Phase 2: Search -->
          <div class="dr-phase dr-phase-search">
            <div class="dr-phase-indicator"><div class="dr-dot"></div><div class="dr-line"></div></div>
            <div class="dr-phase-content">
              <div class="dr-phase-title" onclick="this.closest('.dr-phase').classList.toggle('dr-phase-collapsed')">
                <i class="fas fa-globe"></i> Searching Web
                <span class="dr-phase-stat dr-stat-search">—</span>
              </div>
              <div class="dr-phase-details"><ul class="dr-source-list dr-search-results"></ul></div>
            </div>
          </div>
          <!-- Phase 3: Read -->
          <div class="dr-phase dr-phase-read">
            <div class="dr-phase-indicator"><div class="dr-dot"></div><div class="dr-line"></div></div>
            <div class="dr-phase-content">
              <div class="dr-phase-title" onclick="this.closest('.dr-phase').classList.toggle('dr-phase-collapsed')">
                <i class="fas fa-book-open"></i> Reading Sources
                <span class="dr-phase-stat dr-stat-read">—</span>
              </div>
              <div class="dr-phase-details"><ul class="dr-source-list dr-read-results"></ul></div>
            </div>
          </div>
          <!-- Phase 4: Synthesize -->
          <div class="dr-phase dr-phase-synth">
            <div class="dr-phase-indicator"><div class="dr-dot"></div></div>
            <div class="dr-phase-content">
              <div class="dr-phase-title">
                <i class="fas fa-wand-magic-sparkles"></i> Synthesizing Report
                <span class="dr-phase-stat dr-stat-synth">—</span>
              </div>
              <div class="dr-phase-details">
                <div class="dr-report" style="display:none"></div>
                <div class="dr-report-actions" style="display:none">
                  <button class="dr-act-btn" onclick="drCopyReport(this)"><i class="fas fa-copy"></i> Copy</button>
                  <button class="dr-act-btn" onclick="drExportReport(this)"><i class="fas fa-download"></i> Export .md</button>
                  <span class="dr-source-count" style="font-size:9px;color:var(--tx-4);font-family:'JetBrains Mono',monospace;margin-left:auto"></span>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
      return el;
    }

    /**
     * Runs the deep research loop, updating the provided panel element live.
     * Uses executeTool to invoke web_search and fetch_url.
     */
    async function runDeepResearch(query, depth = 2, signal, panelEl) {
      const startTime = performance.now();
      const sources = [];
      let report = 'Research failed to complete.';
      let _reportText = '';

      const setStatus = (text) => {
        const statusEl = panelEl?.querySelector('.dr-status');
        if (statusEl) statusEl.textContent = text;
      };

      const setStat = (cls, text) => {
        // cls is like '.dr-stat-plan' — query within the panel
        const el = panelEl?.querySelector(cls);
        if (el) el.textContent = text;
      };

      // Wire abort button to the panel instance (not window, to support multiple panels)
      if (panelEl) {
        panelEl._drAbortFn = () => {
          panelEl._drAborted = true;
          const abortBtn = panelEl.querySelector('.dr-abort-btn');
          if (abortBtn) { abortBtn.disabled = true; abortBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Aborting…'; }
        };
        panelEl._drAborted = false;
      }

      const isAborted = () => signal?.aborted || panelEl?._drAborted;

      // Phase class names match .dr-phase-plan, .dr-phase-search etc.
      const activatePhase = (phaseClass) => {
        const phaseOrder = ['dr-phase-plan', 'dr-phase-search', 'dr-phase-read', 'dr-phase-synth'];
        const currentIdx = phaseOrder.indexOf(phaseClass);
        const phases = panelEl?.querySelectorAll('.dr-phase');
        phases?.forEach(p => {
          const pClass = phaseOrder.find(c => p.classList.contains(c));
          if (!pClass) return;
          const pIdx = phaseOrder.indexOf(pClass);

          if (pClass === phaseClass) {
            p.classList.add('active');
            p.classList.remove('dr-phase-collapsed');
          } else if (pIdx < currentIdx) {
            p.classList.remove('active');
            p.classList.add('done');
            if (pClass !== 'dr-phase-synth') p.classList.add('dr-phase-collapsed');

            const icon = p.querySelector('.dr-phase-title i');
            if (icon) icon.className = 'fas fa-check-circle';

            if (pClass === 'dr-phase-plan') {
              const count = p.querySelectorAll('.dr-query-item').length;
              setStat('.dr-stat-plan', `${count} queries`);
            } else if (pClass === 'dr-phase-search') {
              const count = p.querySelectorAll('.dr-source-item').length;
              setStat('.dr-stat-search', `${count} URLs`);
            } else if (pClass === 'dr-phase-read') {
              const ok = p.querySelectorAll('.dr-source-item i.fa-check').length;
              const total = p.querySelectorAll('.dr-source-item').length;
              setStat('.dr-stat-read', `${ok}/${total} ok`);
            }
          }
        });
        scrollBottom();
      };

      // ── Current date string injected into every prompt ──────────────
      const now = new Date();
      const todayStr = now.toLocaleDateString('en-GB', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
      const todayISO = now.toISOString().slice(0, 10); // YYYY-MM-DD

      // ── Helper: check if fetched content is usable ───────────────────
      const isUsableContent = (text) => {
        if (!text || text.length < 150) return false;
        if (text.includes('[Fetch error]')) return false;
        if (text.includes('[Browser Error]')) return false;
        if (text.includes('JavaScript-rendered')) return false;
        if (text.includes('[Truncated at 0')) return false;
        const words = text.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(w => w.length > 2);
        return words.length > 30;
      };

      // ── Helper: extract actual content from browser_get_content output ─
      const extractBrowserContent = (raw) => {
        // Strip the "Page content (text, N chars):\n---\n" header added by browserApi
        const marker = '---\n';
        const idx = raw.indexOf(marker);
        return idx !== -1 ? raw.slice(idx + marker.length) : raw;
      };

      // ── Track whether browser is already open for this research session ─
      let _browserOpenForResearch = false;

      const ensureBrowserOpen = async () => {
        if (_browserOpenForResearch) return true;
        try {
          const out = await browserApi('/browser_launch', { headless: true });
          if (out.includes('[Browser Error]')) return false;
          _browserOpenForResearch = true;
          return true;
        } catch (e) { return false; }
      };

      const closeBrowserIfOpened = async () => {
        if (!_browserOpenForResearch) return;
        try { await browserApi('/browser_close', {}); } catch (e) {}
        _browserOpenForResearch = false;
      };

      // ── Helper: fetch one URL with Playwright ────────────────────────
      const playwrightFetch = async (url) => {
        const launched = await ensureBrowserOpen();
        if (!launched) return null;
        try {
          // Navigate and wait for network to settle
          const navOut = await browserApi('/browser_navigate', { url, wait_until: 'networkidle' });
          if (navOut.includes('[Browser Error]')) {
            // Try with looser wait condition
            const navOut2 = await browserApi('/browser_navigate', { url, wait_until: 'domcontentloaded' });
            if (navOut2.includes('[Browser Error]')) return null;
          }
          // Try to grab main article body first, fall back to full page
          for (const selector of ['article', 'main', '[role="main"]', '.article-body', '.story-body', '.post-content', 'body']) {
            const contentOut = await browserApi('/browser_get_content', { selector, mode: 'text' });
            if (!contentOut.includes('[Browser Error]')) {
              const content = extractBrowserContent(contentOut);
              if (isUsableContent(content)) {
                return content.length > 6000 ? content.slice(0, 6000) + '\n… [truncated]' : content;
              }
            }
          }
          return null;
        } catch (e) { return null; }
      };

      // ── Helper: try fetching with multiple strategies ─────────────────
      // Order: fetchViaCompanion → Playwright → AMP cache → snippet
      const smartFetch = async (url, snippet, title) => {
        // Strategy 1: plain HTTP fetch via companion (fast, works for static/API sites)
        try {
          const text = await fetchViaCompanion(url, 40000);
          if (isUsableContent(text)) {
            return { content: text.length > 5000 ? text.slice(0, 5000) + '\n… [truncated]' : text, via: 'fetch' };
          }
        } catch (e) { /* try next */ }

        // Strategy 2: Playwright headless browser (handles JS-rendered pages)
        if (state.browserAvailable) {
          try {
            const pwContent = await playwrightFetch(url);
            if (pwContent) return { content: pwContent, via: 'browser' };
          } catch (e) { /* try next */ }
        }

        // Strategy 3: Google AMP cache (static HTML mirror of many news articles)
        try {
          const noScheme = url.replace(/^https?:\/\//, '');
          const domain = noScheme.split('/')[0];
          const ampDomain = domain.replace(/\./g, '-').replace(/-([^-]+)$/, '.$1') + '.cdn.ampproject.org';
          const isHttps = url.startsWith('https');
          const ampUrl = `https://${ampDomain}/c/${isHttps ? 's/' : ''}${noScheme}`;
          const text3 = await fetchViaCompanion(ampUrl, 40000);
          if (isUsableContent(text3)) {
            return { content: text3.length > 5000 ? text3.slice(0, 5000) + '\n… [truncated]' : text3, via: 'amp' };
          }
        } catch (e) { /* try next */ }

        // Strategy 4: Search snippet as last resort
        if (snippet && snippet.length > 60) {
          return {
            content: `Title: ${title || url}\nURL: ${url}\nSnippet: ${snippet}\n\n[Full page could not be fetched — content derived from search snippet only]`,
            via: 'snippet'
          };
        }

        return null;
      };

      // ── Diagnostic log visible in the panel status bar ──────────────
      const drLog = (msg, level = 'info') => {
        const colors = { info: 'var(--tx-3)', warn: 'var(--yellow)', error: 'var(--red)', ok: 'var(--green)' };
        console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log']('[DR]', msg);
        setStatus(msg);
        // Also append to a debug log inside the panel
        if (panelEl) {
          let log = panelEl.querySelector('.dr-debug-log');
          if (!log) {
            log = document.createElement('div');
            log.className = 'dr-debug-log';
            log.style.cssText = 'font-size:9px;font-family:JetBrains Mono,monospace;color:var(--tx-4);padding:4px 8px;max-height:80px;overflow-y:auto;border-top:1px solid var(--border);margin-top:4px;';
            panelEl.querySelector('.dr-body')?.appendChild(log);
          }
          const line = document.createElement('div');
          line.style.color = colors[level] || 'var(--tx-4)';
          line.textContent = `${new Date().toISOString().slice(11,19)} ${msg}`;
          log.appendChild(line);
          log.scrollTop = log.scrollHeight;
        }
      };

      try {
        // ── Step 0: Rewrite user intent (best-effort, skip if model returns empty) ──
        activatePhase('dr-phase-plan');
        drLog('Analyzing query intent…');
        setStat('.dr-stat-plan', 'analyzing…');

        let researchTopic = query;
        try {
          drLog(`LLM connected: ${state.connected}, model: ${state.model}, apiUrl: ${state.apiUrl}`);
          const intentMessages = [
            { role: 'user', content: `What is the core research topic in this request? Reply with only the topic, no explanation.\n\nRequest: "${query}"` }
          ];
          const topicResult = await callLLMForTool(intentMessages, 0.2, 80);
          drLog(`Intent result: "${topicResult?.slice(0,60)}"`, 'ok');
          // Only use it if it's a short focused phrase (not a long essay or empty)
          const cleaned = topicResult?.trim().replace(/^["'`]|["'`]$/g, '') || '';
          if (cleaned.length > 5 && cleaned.length < 200 && !cleaned.includes('\n')) {
            researchTopic = cleaned;
          }
        } catch (e) {
          drLog(`Intent rewrite skipped: ${e.message}`, 'warn');
        }

        // Show interpreted topic in panel title if different
        if (researchTopic !== query) {
          const titleEl = panelEl?.querySelector('.dr-title');
          if (titleEl) {
            titleEl.innerHTML = `Deep Research: <span style="color:var(--tx-1)">${esc(researchTopic)}</span><span style="font-size:10px;color:var(--tx-4);margin-left:6px">from: "${esc(query.length > 45 ? query.slice(0,42)+'…' : query)}"</span>`;
          }
        }

        // Phase 1: Plan search queries — simple prompt that small models can follow
        drLog('Planning search queries…');
        setStat('.dr-stat-plan', 'thinking…');
        const numQueries = depth * 2 + 2; // 4 / 6 / 8

        // Use a minimal, model-agnostic prompt
        const planPrompt = `List ${numQueries} search engine queries to research: ${researchTopic}\n\nWrite one query per line. Include the year ${now.getFullYear()} in queries about current info. No bullets, no numbers, no explanations.`;
        let queriesText;
        try {
          queriesText = await callLLMForTool([{ role: 'user', content: planPrompt }], 0.5, 600);
          drLog(`Got ${queriesText?.split('\n').filter(l=>l.trim().length>3).length} raw lines from LLM`, 'ok');
        } catch(e) {
          drLog(`Query planning failed: ${e.message}`, 'error');
          throw e;
        }

        // Very permissive parsing — strip any prefix junk, accept anything >3 chars
        const queries = queriesText
          .split('\n')
          .map(q => q
            .replace(/^[\d]+[\.\)]\s*/, '')   // "1. " or "1) "
            .replace(/^[-*•·]\s*/, '')          // "- " or "* "
            .replace(/^(Query|Search|Topic)[\s\d]*[:：]\s*/i, '') // "Query 1: "
            .trim()
          )
          .filter(q => q.length > 3 && !q.toLowerCase().startsWith('here') && !q.toLowerCase().startsWith('sure'))
          .slice(0, numQueries);

        // Last-resort fallback: if model returned nothing useful, generate queries from the topic directly
        if (queries.length === 0) {
          drLog('LLM returned no usable queries — using fallback queries', 'warn');
          const words = researchTopic.split(' ').slice(0, 6).join(' ');
          queries.push(
            `${words} ${now.getFullYear()}`,
            `${words} comparison`,
            `${words} price features`,
            `best ${words}`,
            `${words} review`,
            `${words} specifications`
          );
          queries.splice(numQueries);
        }

        drLog(`Using ${queries.length} queries`, 'ok');

        const queriesList = panelEl?.querySelector('.dr-queries');
        if (queriesList) {
          queriesList.innerHTML = queries.map((q, i) =>
            `<li class="dr-query-item"><span style="font-size:9px;color:var(--tx-4);font-family:'JetBrains Mono',monospace;min-width:16px">${i+1}.</span> <i class="fas fa-search"></i> ${esc(q)}</li>`
          ).join('');
        }
        setStat('.dr-stat-plan', `${queries.length} queries`);

        if (isAborted()) throw new Error('Aborted');

        // Phase 2: Search — call searchViaCompanion directly for structured results
        activatePhase('dr-phase-search');
        drLog(`Searching with ${queries.length} queries, compConnected=${state.compConnected}, compUrl=${state.compUrl}`);
        setStat('.dr-stat-search', '0 URLs');
        const allSearchResults = [];
        const seen = new Set();
        const searchResultsList = panelEl?.querySelector('.dr-search-results');

        for (const q of queries) {
          if (isAborted()) break;
          drLog(`Searching: "${q.slice(0,40)}…"`);
          try {
            const data = await searchViaCompanion(q, 5, 0);
            drLog(`Search "${q.slice(0,30)}" → count=${data?.count}, results=${data?.results?.length}, error=${data?.error||'none'}`, data?.error ? 'warn' : 'ok');
            if (!data?.results?.length) continue;
            for (const r of data.results) {
              if (!r.url || r.error || seen.has(r.url)) continue;
              if (!r.url.startsWith('http')) continue;
              seen.add(r.url);
              allSearchResults.push({ url: r.url, title: r.title || r.url, snippet: r.snippet || '' });

              if (searchResultsList) {
                const li = document.createElement('li');
                li.className = 'dr-source-item';
                const display = (r.title || r.url);
                li.innerHTML = `<i class="fas fa-globe" style="color:var(--tx-4)"></i> <a href="${esc(r.url)}" target="_blank" title="${esc(r.snippet || r.url)}">${esc(display.length > 65 ? display.slice(0, 62) + '…' : display)}</a>`;
                searchResultsList.appendChild(li);
                searchResultsList.scrollTop = searchResultsList.scrollHeight;
              }
              setStat('.dr-stat-search', `${allSearchResults.length} URLs`);
            }
          } catch (e) { drLog(`Search failed for "${q.slice(0,30)}": ${e.message}`, 'error'); }
        }
        drLog(`Search phase done: ${allSearchResults.length} unique URLs`, allSearchResults.length > 0 ? 'ok' : 'warn');

        if (isAborted()) throw new Error('Aborted');

        // Phase 3: Smart fetch with fallback strategies
        const maxFetch = depth * 3;
        activatePhase('dr-phase-read');
        setStatus(`Reading ${Math.min(allSearchResults.length, maxFetch)} sources...`);
        setStat('.dr-stat-read', `0/${Math.min(allSearchResults.length, maxFetch)}`);
        const fetchedContents = [];
        const urlsToFetch = allSearchResults.slice(0, maxFetch);
        const readResultsList = panelEl?.querySelector('.dr-read-results');
        let readOk = 0;

        for (let i = 0; i < urlsToFetch.length; i++) {
          if (isAborted()) break;
          const { url, title, snippet } = urlsToFetch[i];
          setStatus(`Reading ${i+1}/${urlsToFetch.length}: ${url.slice(0, 40)}…`);

          let readLi = null;
          if (readResultsList) {
            readLi = document.createElement('li');
            readLi.className = 'dr-source-item';
            const displayTitle = title && title !== url ? title : url;
            readLi.innerHTML = `<i class="fas fa-spinner fa-spin" style="color:var(--tx-4)"></i> <a href="${esc(url)}" target="_blank" title="${esc(url)}">${esc(displayTitle.length > 55 ? displayTitle.slice(0, 52) + '…' : displayTitle)}</a>`;
            readResultsList.appendChild(readLi);
            readResultsList.scrollTop = readResultsList.scrollHeight;
          }

          const displayLabel = readLi?.querySelector('a')?.textContent || url;

          try {
            const result = await smartFetch(url, snippet, title);
            if (result) {
              fetchedContents.push({ url, title, content: result.content, via: result.via });
              sources.push(url);
              readOk++;
              const viaIcon = result.via === 'snippet' ? 'exclamation-triangle' : result.via === 'browser' ? 'robot' : 'check';
              const viaColor = result.via === 'snippet' ? 'var(--yellow)' : result.via === 'browser' ? 'var(--cyan)' : 'var(--green)';
              const viaTitle = result.via === 'snippet' ? 'snippet only' : result.via === 'browser' ? 'Playwright browser' : result.via === 'amp' ? 'AMP cache' : 'fetched';
              if (readLi) {
                readLi.innerHTML = `<i class="fas fa-${viaIcon}" style="color:${viaColor}" title="${viaTitle}"></i> <a href="${esc(url)}" target="_blank" title="${esc(url)}">${esc(displayLabel)}</a><span style="font-size:8px;color:var(--tx-4);margin-left:4px;font-family:'JetBrains Mono',monospace">${result.via}</span>`;
              }
            } else {
              if (readLi) {
                readLi.innerHTML = `<i class="fas fa-times" style="color:var(--red)" title="could not fetch"></i> <a href="${esc(url)}" target="_blank" title="${esc(url)}">${esc(displayLabel)}</a>`;
              }
            }
          } catch (e) {
            console.warn('[research] smartFetch failed for', url, e);
            if (readLi) {
              readLi.innerHTML = `<i class="fas fa-times" style="color:var(--red)"></i> <a href="${esc(url)}" target="_blank" title="${esc(url)}">${esc(displayLabel)}</a>`;
            }
          }
          setStat('.dr-stat-read', `${readOk}/${urlsToFetch.length} ok`);
        }

        if (isAborted()) throw new Error('Aborted');

        // Phase 4: Synthesize report
        activatePhase('dr-phase-synth');
        setStatus('Synthesizing report…');
        setStat('.dr-stat-synth', 'writing…');

        // Label snippet-only sources so the synthesizer knows to treat them with lower confidence
        const sourcesText = fetchedContents.map((s, i) => {
          const label = s.via === 'snippet'
            ? `[Source ${i+1} — snippet only, lower confidence](${s.url})`
            : s.via === 'browser'
              ? `[Source ${i+1} — fetched via headless browser](${s.url})`
              : `[Source ${i+1}](${s.url})`;
          return `${label}:\n${s.content}`;
        }).join('\n\n---\n\n');

        const reportEl = panelEl?.querySelector('.dr-report');

        if (fetchedContents.length === 0) {
            report = "Could not gather any content from the web for this topic. Please check your companion server connection and try again.";
            if (reportEl) { reportEl.innerHTML = renderMd(report); reportEl.style.display = 'block'; }
        } else {
            // Stream synthesis word-by-word into the report element
            if (reportEl) {
              reportEl.style.display = 'block';
              reportEl.classList.add('streaming');
              reportEl.textContent = '';
            }

            const snippetOnlyCount = fetchedContents.filter(s => s.via === 'snippet').length;
            const browserCount = fetchedContents.filter(s => s.via === 'browser').length;
            const fetchedCount = fetchedContents.length - snippetOnlyCount;
            const sourceCaveat = snippetOnlyCount > 0
              ? `\nNote: ${snippetOnlyCount} source(s) could only be accessed via search snippets. Treat those citations with slightly lower confidence.`
              : '';
            const browserNote = browserCount > 0
              ? `\n${browserCount} source(s) were fetched using a headless browser (Playwright) — these are fully rendered pages and can be cited with full confidence.`
              : '';

            const synthMessages = [
              {
                role: 'user',
                content: `Write a research report about: ${researchTopic}\n\nToday's date: ${todayISO}\n\nUse these sources. Cite them as [Source 1], [Source 2], etc. Use markdown headings. End with a ## References section.\n\n${sourcesText}`
              }
            ];

            // Use streaming if available, otherwise fallback to batch
            try {
              const result = await requestModel({ model: state.model, messages: synthMessages,
                temperature: 0.3, max_tokens: 4000, stream: true }, state.abortCtrl?.signal, {
                onReasoning: full => setStat('.dr-stat-synth', 'reasoning (' + full.length + ' chars)'),
                onContent: full => {
                  _reportText = full;
                  if (reportEl) { reportEl.innerHTML = renderMd(full); reportEl.classList.add('streaming'); }
                  scrollBottom();
                }
              });
              report = result.content || 'No content generated.';
              _reportText = report;

            } catch (streamErr) {
              throw streamErr;
            }

            if (reportEl) {
              reportEl.classList.remove('streaming');
              reportEl.innerHTML = renderMd(report);
              reportEl.querySelectorAll('pre code').forEach(b => {
                if (!b.dataset.hljs) { hljs.highlightElement(b); b.dataset.hljs = '1'; }
              });
              addCopyBtns(reportEl);
            }
        }

        // Show report action bar
        const actionsEl = panelEl?.querySelector('.dr-report-actions');
        if (actionsEl) {
          actionsEl.style.display = 'flex';
          const countEl = panelEl?.querySelector('.dr-source-count');
          if (countEl) countEl.textContent = `${fetchedContents.length} sources · ${Math.round((performance.now() - startTime) / 1000)}s`;
        }
        setStat('.dr-stat-synth', `${fetchedContents.length} srcs`);

        // Store report text on panel for export
        if (panelEl) panelEl._drReportText = _reportText;
        if (panelEl) panelEl._drQuery = query;

      } catch (e) {
        const phase = panelEl?.querySelector('.dr-phase.active');
        if (phase) {
          const dot = phase.querySelector('.dr-dot');
          if (dot) dot.classList.add('dr-dot-error');
        }

        if (e.message === 'Aborted' || e.name === 'AbortError' || panelEl?._drAborted) {
          report = 'Research was cancelled by the user.';
          setStatus('Cancelled');
        } else {
          report = `Research failed: ${e.message}`;
          setStatus('Failed');
          console.error('[research] error:', e);
        }
      } finally {
        // Always close the Playwright browser if we opened one
        await closeBrowserIfOpened();
      }

      // Hide abort button when done
      const abortBtn = panelEl?.querySelector('.dr-abort-btn');
      if (abortBtn) abortBtn.style.display = 'none';
      if (panelEl) panelEl._drAbortFn = null;

      // Final updates
      const duration = ((performance.now() - startTime) / 1000).toFixed(1);
      const finalPhase = panelEl?.querySelector('.dr-phase.active');
      if (finalPhase) {
        finalPhase.classList.remove('active');
        finalPhase.classList.add('done');
        finalPhase.classList.remove('dr-phase-collapsed');
        const icon = finalPhase.querySelector('.dr-phase-title i');
        if(icon) icon.className = 'fas fa-check-circle';
      }
      setStatus(`Done · ${duration}s · ${sources.length} sources`);

      return {
        output: report,
        _sources: sources,
        _researchData: { query, depth, duration, sourceCount: sources.length, report }
      };
    }

    /* ═══════════════ DEEP RESEARCH HELPERS ═══════════════ */
    let _drDepth = 2;

    function setDrDepth(d) {
      _drDepth = d;
      // Update selection styles
      [1,2,3].forEach(n => {
        const el = document.getElementById(`dr-depth-${n}`);
        if (el) el.classList.toggle('selected', n === d);
      });
      const lbl = document.getElementById('research-depth-label');
      if (lbl) lbl.textContent = `·${d}`;
      const popup = document.getElementById('dr-depth-popup');
      if (popup) popup.style.display = 'none';
    }

    function toggleDrDepthPopup(e) {
      e.stopPropagation();
      const popup = document.getElementById('dr-depth-popup');
      if (!popup) return;
      const visible = popup.style.display !== 'none';
      popup.style.display = visible ? 'none' : 'block';
      if (!visible) {
        // Close on outside click
        setTimeout(() => {
          document.addEventListener('click', function _close() {
            popup.style.display = 'none';
            document.removeEventListener('click', _close);
          }, { once: true });
        }, 0);
      }
    }

    function drCopyReport(btn) {
      // Find the nearest deep-research-panel ancestor
      const panel = btn.closest('.deep-research-panel');
      const text = panel?._drReportText || panel?.querySelector('.dr-report')?.innerText || '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add('copied');
        btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '<i class="fas fa-copy"></i> Copy';
        }, 2000);
      });
    }

    function drExportReport(btn) {
      const panel = btn.closest('.deep-research-panel');
      const text = panel?._drReportText || panel?.querySelector('.dr-report')?.innerText || '';
      const query = panel?._drQuery || 'research';
      if (!text) { showToast('No report to export', 'warn'); return; }
      const slug = query.slice(0, 40).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
      const filename = `research_${slug}.md`;
      const blob = new Blob([`# Research Report: ${query}\n\n${text}`], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      btn.innerHTML = '<i class="fas fa-check"></i> Saved!';
      setTimeout(() => { btn.innerHTML = '<i class="fas fa-download"></i> Export .md'; }, 2000);
    }

    // Override depth when deep research is triggered
    const _origToggleDR = toggleDeepResearchInputMode;
    // Patch send to use _drDepth
    const _origHandleSend = handleSend;

    init();


