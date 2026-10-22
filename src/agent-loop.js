/* Agent orchestration; rendering and tool adapters are supplied by the app. */
    async function agentLoop() {
      if (state.running) return;
      if (!(await beforeHarnessRun())) return;
      if (!state.runController) {
        const active = typeof dbGet === 'function' ? await dbGet('agent_states', 'active_session') : null;
        const saved = active?.convId === state.activeConvId && active.run ? active.run : state.taskState?.run;
        state.runController = HarnessRunState.create(saved);
        const restored = active?.convId === state.activeConvId ? active : state.taskState || {};
        state.workspaceRevision = restored.workspaceRevision || 0;
        state.progressRevision = restored.progressRevision || 0;
        state.modelRecoveries = restored.modelRecoveries || {};
        state.mutationPaths = restored.mutationPaths || [];
        state.artifactRefs = restored.artifactRefs || restored.artifacts || [];
        state.completion = null;
        if (active?.convId === state.activeConvId && active.verification?.runId === state.runController.snapshot().id) state.verificationState = active.verification;
        if (active?.convId === state.activeConvId && saved?.reservedTokens > 0) {
          const recovered = (active.sessionOutput || 0) + saved.reservedTokens;
          if (recovered > _sessionTotalOut) _updateSessionTok(recovered - _sessionTotalOut);
        }
      }
      // Explicit retries and the next approved plan step may follow a completed run.
      // Paused/exhausted runs retain their counters; completed work starts a new allowance.
      if (state.runController.snapshot().phase === 'finished') {
        state.runController = HarnessRunState.create();
        state.modelRecoveries = {}; state.verificationState = null; state.workspaceRevision = 0; state.progressRevision = 0; state.mutationPaths = []; state.completion = null;
      }
      state.runController.transition('recovering');
      state.running = true; updateSendBtn();
      state.abortCtrl = new AbortController();
      const sessionChanges = { modified: new Set(), created: new Set(), deleted: new Set(), moved: [] };
      let runTimer;
      const limitMs = (state.maxRunMinutes || 0) * 60000;
      if (limitMs) runTimer = setTimeout(() => state.abortCtrl?.abort(new DOMException('Run time limit reached', 'AbortError')), Math.max(1, limitMs - state.runController.snapshot().elapsedMs));
      try {
      try {
        if (typeof recordRunEvent === 'function') await recordRunEvent(state.runController.snapshot().iterations ? 'run.resumed' : 'run.started', { run: state.runController.snapshot() });
        await reconcileCommandJobs();
        if (typeof reconcileWorkspaceMutations === 'function') await reconcileWorkspaceMutations();
        state.runController.transition('running');
        if (typeof ensureVerificationBaseline === 'function') await ensureVerificationBaseline();
        if (!state.running) return;
      }
      catch (e) {
        state.running = false; updateSendBtn();
        appendMsg('system', 'Task startup paused: ' + e.message);
        return;
      }
      let iters = 0;
      const compStats = createCompressionStats();
      const SOFT_WARN = Math.floor(state.maxIters * 0.4);
      const COMPACT_AT = Math.max(1, Math.floor(state.maxIters * 0.6));

      toolCallHistory.length = 0;
      state._envNudgedPairs = new Set();
      textLoopBuffer.length = 0;
      tokenTracker.reset();
      tokenTracker._probeDone = false;
      agentStopwatch = performance.now();
      await saveActiveAgentState();

      while (state.running) {
        await saveActiveAgentState();
        // Drain any messages the user typed while the agent was running (see
        // queueSteerMessage). Injected as normal user turns so the agent picks
        // them up in its very next LLM call — no stop/restart needed. Done
        // before the pause/hard-stop checks below so guidance is never lost
        // even if this iteration happens to also be the last one.
        if (state.pendingSteerMessages.length) {
          const toInject = state.pendingSteerMessages.splice(0);
          for (const sm of toInject) {
            const el = createMsgEl('user', sm.text);
            $msg().appendChild(el); scrollBottom();
            state.messages.push({ role: 'user', content: sm.text });
          }
          renderSteerQueue();
        }
        const runLimit = state.runController.stopReason({ maxIterations: state.maxIters, tokenLimit: state.runTokenLimit || 0, maxElapsedMs: limitMs });
        if (runLimit) {
          await saveProgressToWorkspace(runLimit);
          appendMsg('system', 'Run paused at its ' + runLimit.replace(/_/g, ' ') + '. Limits survive compaction and reload. Raise the limit in Settings to resume, or send a new task.');
          break;
        }
        if (state.tokenBudget > 0 && _sessionTotalOut >= state.tokenBudget) {
          await saveProgressToWorkspace('session token budget reached (' + _sessionTotalOut + ' tokens)');
          appendMsg('system', 'Stopped: session output-token budget of ' + state.tokenBudget.toLocaleString() + ' reached (' + _sessionTotalOut.toLocaleString() + ' generated so far). Raise or disable the budget in Settings → Tools to continue. Progress saved to `' + getProgressFile() + '`.');
          notifyUser('Agent stopped', 'Hit the session token budget. Progress was saved.', 'agent-stopped');
          break;
        }
        if (state.pauseRequested) {
          state.pauseRequested = false;
          appendPauseMsg();
          updatePauseBtn();
          break;
        }
        const ctxPct = getContextPct();
        // Only compact based on context % after at least one real LLM call has happened.
        // On iteration 0: tokenTracker.lastPromptTokens is -1, so getContextPct() falls back
        // to estimateConvTokens() which can wildly overestimate when previous compact artifacts
        // ([ORIGINAL TASK], [summary], [CONTINUE WORKING]) are already in state.messages.
        // Waiting until iters > 0 guarantees we have a real token count from the model.
        const hasContextReading = iters > 0;
        if (state.memoryAgentEnabled && hasContextReading) {
          const overPct = ctxPct >= state.autoCompactPct;
          const measuredTokens = Math.max(tokenTracker.lastPromptTokens, Math.round(ctxPct * state.ctxWindow / 100));
          const overTokenThreshold = state.compactTokenThreshold > 0 && measuredTokens >= state.compactTokenThreshold;
          if (overPct || overTokenThreshold) {
            const reason = overTokenThreshold && !overPct
              ? ('token threshold (' + measuredTokens.toLocaleString() + ' ≥ ' + state.compactTokenThreshold.toLocaleString() + ')')
              : ('context limit (' + Math.round(ctxPct) + '%)');
            const saved = await saveProgressToWorkspace(reason);
            if (!saved) appendMsg('system', '⚠ Could not save progress file — workspace may be disconnected');
            await progressCompact(saved); iters = 0; tokenTracker.reset(); if (!state.running) break; continue;
          }
        }
        if (state.memoryAgentEnabled && iters >= COMPACT_AT) {
          const saved = await saveProgressToWorkspace('iteration limit (' + iters + ')');
          await progressCompact(saved); iters = 0; tokenTracker.reset(); if (!state.running) break; continue;
        }
        if (state.memoryAgentEnabled && iters === SOFT_WARN) {
          state.messages.push({
            role: 'user',
            content: '[SYSTEM NOTE: Context at ' + Math.round(getContextPct()) + '%. Will auto-compact at ' + COMPACT_AT + ' iterations. A progress file will be saved. Continue working normally — do not acknowledge this message, just keep going.]'
          });
        }
        state.runController.step({ maxIterations: state.maxIters, tokenLimit: state.runTokenLimit || 0, maxElapsedMs: limitMs });
        iters++;
        await saveActiveAgentState();
        saveCurrentConv();

        const th = showThinking(); let cur = '', tcs = [];
        const liveThinkEls = new Map();
        let reasoningEl = null; // live block for native reasoning_content/reasoning stream
        let _chatRes = null;
        let usage = null;
        try {
            _chatRes = await streamChat(state.messages, t => { cur = t; if (th) th.remove(); updateStreamingMsg(t); }, c => { tcs = c; }, (thinkText) => {
            let idx = -1; for (let i = 0; i < tcs.length; i++) { if (tcs[i].function.name === 'think') idx = i; }
            if (idx === -1) return; if (th) th.remove();
            if (!liveThinkEls.has(idx)) {
              const el = createLiveThinkBlock();
              if (streamEl && streamEl.parentNode) streamEl.parentNode.insertBefore(el, streamEl);
              else $msg().appendChild(el);
              liveThinkEls.set(idx, el);
            }
            updateLiveThinkBlock(liveThinkEls.get(idx), thinkText); // scroll now happens inside the rAF-batched update
          }, (reasoningText) => {
            // Native model reasoning (Qwen3/DeepSeek-style "reasoning_content"). This streams
            // BEFORE any delta.content arrives, so surface it immediately instead of leaving
            // the user staring at a static "Thinking..." indicator — critical for spotting a
            // model stuck in an endless reasoning loop.
            if (th) th.remove();
            if (!reasoningEl) {
              reasoningEl = createLiveThinkBlock();
              if (streamEl && streamEl.parentNode) streamEl.parentNode.insertBefore(reasoningEl, streamEl);
              else $msg().appendChild(reasoningEl);
            }
            updateLiveThinkBlock(reasoningEl, reasoningText); // scroll now happens inside the rAF-batched update
          });
          if (reasoningEl) finalizeLiveThinkBlock(reasoningEl);
          cur = _chatRes.content || '';
          tcs = _chatRes?.toolCalls?.filter(Boolean) || [];
          usage = _chatRes.usage || { in: 0, out: 0 };
          tokenTracker.commit();

          // Strip thinking blocks (Gemma 4 <|channel>thought...<channel|>, Qwen <think>...</think>)
          // from the visible text content. These are internal reasoning that shouldn't show in the bubble.
          cur = stripThinkingBlocks(cur);

          /* ── Truncation recovery ──────────────────────────────────────
           * If the model hit max_tokens while generating a tool call's
           * arguments, finish_reason will be "length" and the arguments
           * string will be invalid JSON. Instead of passing broken args
           * to executeTool (which gives a confusing error), we inject a
           * synthetic tool result that explains exactly how to recover.
           * ────────────────────────────────────────────────────────────*/
          if (_chatRes.finishReason === 'length' && tcs.length) {
            const truncatedTcs = tcs.filter(tc => {
              if (!tc.function.arguments) return true;
              try { JSON.parse(tc.function.arguments); return false; }
              catch { return true; }
            });
            if (truncatedTcs.length) {
              // Push the (broken) assistant message first so the conversation is valid
              const brokenAm = { role: 'assistant', content: cur || null };
              brokenAm.tool_calls = tcs;
              // Don't double-push — we already pushed am below, so patch it
              // Actually we haven't pushed yet here; handle below by continuing
              // before the normal push. Mark them so agentLoop skips execution.
              tcs._hasTruncation = true;
              tcs._truncatedTcs = truncatedTcs;
            }
          }
        } catch (e) {
          // ── Cleanup: safely finalize all mid-stream UI elements ──
          if (th && th.parentNode) th.remove();

          for (const el of [...liveThinkEls.values(), ...(reasoningEl ? [reasoningEl] : [])]) {
            if (el._rAF) { cancelAnimationFrame(el._rAF); el._rAF = null; }
            const content = el.querySelector('.think-content');
            const badge = el.querySelector('.think-badge');
            if (content) {
              content.classList.remove('streaming-cursor');
              if (el._text) content.textContent = el._text; // flush any text queued in an un-fired rAF frame
              if (!content.textContent.trim()) content.textContent = '(interrupted)';
            }
            if (badge) {
              badge.className = 'think-badge done'; badge.textContent = 'interrupted';
            }
            el._collapsed = true;
            el.querySelector('.think-content').classList.add('collapsed');
            el.querySelector('.think-chevron').classList.add('collapsed');
            el.querySelector('.think-stop-btn')?.remove();
          }
          liveThinkEls.clear();
          reasoningEl = null;

          if (streamEl) {
            if (streamEl._rAF) cancelAnimationFrame(streamEl._rAF);
            const c = streamEl.querySelector('.msg-content');
            if (c) c.classList.remove('streaming-cursor');

            if (cur) {
              c.innerHTML = renderMd(cur);
              c.querySelectorAll('pre code').forEach(b => {
                if (!b.dataset.hljs) { hljs.highlightElement(b); b.dataset.hljs = '1'; }
              });
              addCopyBtns(c);
              const outTok = usage ? usage.out : estimateTokens(cur);
              const hdr = streamEl.querySelector('.msg-header');
              const tokEl = document.createElement('span');
              tokEl.className = 'msg-tok';
              tokEl.title = usage ? 'Output tokens (exact from LM Studio)' : 'Output tokens (estimated)';
              tokEl.textContent = (usage ? '' : '~') + formatTok(outTok) + ' out';
              hdr.insertBefore(tokEl, hdr.querySelector('.msg-actions'));

              // Don't push am yet — check for truncation first
              const am = { role: 'assistant', content: cur || null };
              if (tcs.length) am.tool_calls = tcs;
            } else {
              streamEl.remove();
            }
            streamEl._streaming = false;
            streamEl = null;
          }

          if (e.name === 'AbortError') {
            if (iters > 2) saveProgressToWorkspace('user stopped (' + iters + ' iterations)');
            appendMsg('system', 'Stopped.');
            break;
          }
          state.modelRecoveries ||= {};
          if (e.code === 'context_overflow' && state.memoryAgentEnabled && !state.modelRecoveries.context) {
            state.modelRecoveries.context = 1;
            appendMsg('system','The model context is full. Saving progress and compacting before one retry.');
            const saved = await saveProgressToWorkspace('server context overflow');
            await progressCompact(saved); iters = 0; tokenTracker.reset();
            if (state.running) continue;
          }
          if (e.code === 'truncated_tool_call' && (state.modelRecoveries.truncation || 0) < 2) {
            state.modelRecoveries.truncation = (state.modelRecoveries.truncation || 0) + 1;
            state.messages.push({role:'user',content:'[Tool-call recovery] The previous generation hit its output limit. No tool from it was executed. Use smaller targeted edits or shorter tool arguments. Do not assume any file was written.',_harnessContext:true});
            continue;
          }
          appendMsg('system', 'Error: ' + e.message);
          break;
        }
        if (th && th.parentNode) th.remove();

        // ── Create assistant message (do NOT push yet — truncation check decides when) ──
        const am = { role: 'assistant', content: cur || null };
        if (tcs.length) am.tool_calls = tcs;

        for (const [, el] of liveThinkEls) finalizeLiveThinkBlock(el);
        liveThinkEls.clear();

        // If Gemma/Qwen produced only a thinking block (no text, no tool calls), continue the loop
        if (!cur && !tcs.length) {
          if (streamEl) { streamEl.remove(); streamEl = null; }
          // Inject a nudge so the model responds with actual content next turn
          state.messages.push({ role: 'user', content: '[SYSTEM: Please respond with your answer or use a tool. Do not output only a thinking block.]' });
          continue;
        }

        if (!tcs.length) {
          // ── No tool calls: text-only response ──
          state.messages.push(am);
          updateContextMeter();

          if (checkTextLoop(cur)) {
            if (streamEl) { finalizeStreamingMsg(cur); streamEl = null; }
            const wEl = document.createElement('div'); wEl.className = 'health-warning';
            wEl.innerHTML = '<i class="fas fa-triangle-exclamation"></i><span>Agent stuck in a text loop — repeating similar responses. Intervening...</span>';
            $msg().appendChild(wEl); scrollBottom();
            state.messages.push({ role: 'user', content: '[SYSTEM: Your last ' + TEXT_LOOP_WINDOW + ' responses were highly repetitive — you are looping. Stop. Either take a DIFFERENT action (use a tool, try a new approach) or clearly tell the user what you are stuck on and ask for guidance. Do NOT repeat what you just said.]' });
            textLoopBuffer.length = 0;
            continue;
          }

          // Warn if the model was cut off mid-response by the context/token limit
          if (_chatRes.finishReason === 'length' && !tcs._hasTruncation) {
            const promptTok = tokenTracker.lastPromptTokens > 0 ? tokenTracker.lastPromptTokens : estimateConvTokens();
            const remaining = state.ctxWindow - promptTok;
            const wEl = document.createElement('div'); wEl.className = 'health-warning';
            wEl.innerHTML = `<i class="fas fa-scissors"></i><span>Response cut off — model hit the output token limit mid-answer (~${formatTok(promptTok)} of ${formatTok(state.ctxWindow)} ctx used, ~${formatTok(remaining)} remaining). Run <code>/compact</code> to free context, or ask the model to continue.</span>`;
            $msg().appendChild(wEl); scrollBottom();
          }

          finalizeStreamingMsg(cur);
          if (_chatRes.finishReason !== 'length') {
            const completion = typeof assessHarnessCompletion === 'function' ? await assessHarnessCompletion() : { outcome:'completed', reasons:[] };
            if (completion.outcome === 'blocked') state.runController.transition('paused',completion.reasons.join(' '));
            else { harnessModelFinished(); state.runController.transition('finished',completion.outcome); }
            const title = {verified:'Completed and verified',completed:'Completed',completed_unverified:'Completed with verification outstanding',blocked:'Task blocked'}[completion.outcome];
            appendMsg('system',title + (completion.reasons.length ? ': '+completion.reasons.join(' ') : '.'));
            notifyUser(title, completion.reasons.join(' ') || cur || title, 'agent-done');
          }
          break;
        }

        /* ════════════════════════════════════════════════════════════════════════
           TRUNCATION RECOVERY
           When the model hit max_tokens mid-tool-call, its arguments are
           invalid JSON. We must:
             1. Push the assistant message ONCE (with all tool_calls)
             2. Inject synthetic error results for EVERY tool call in the batch
                (truncated ones get recovery guidance; non-truncated ones in the
                same batch are also unsalvageable because the model's attention
                was cut off and it can't meaningfully process their results)
             3. Continue the loop so the model reads the errors and retries
           ════════════════════════════════════════════════════════════════════════ */
        if (tcs._hasTruncation) {
          state.messages.push(am);   // ← push ONCE
          updateContextMeter();
          finalizeStreamingMsg(cur);
          streamEl = null;

          for (const tc of tcs) {
            const isTruncated = tcs._truncatedTcs.some(t => t.id === tc.id);

            if (isTruncated) {
              // ── This tool call's arguments were cut off (invalid JSON) ──
              const name = tc.function.name;
              const argsStr = tc.function.arguments || '';

              // Try to rescue the path from whatever was generated before truncation
              const pathMatch = argsStr.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
              const rescuedPath = pathMatch ? pathMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null;
              const pathHint = rescuedPath ? ` for "${rescuedPath}"` : '';

              let recoveryMsg;

              if (name === 'write_file') {
                recoveryMsg =
                  `TRUNCATED — write_file${pathHint} was cut off mid-argument (hit max_tokens).\n\n` +
                  `The file content is too large to fit in a single tool call's JSON.\n\n` +
                  `Fix — use write_file_chunked instead:\n` +
                  `write_file_chunked({\n` +
                  `  "path": "${rescuedPath || 'YOUR_FILE_PATH'}",\n` +
                  `  "chunks": [\n` +
                  `    "first ~200 lines of the file",\n` +
                  `    "next ~200 lines",\n` +
                  `    "... continue until complete"\n` +
                  `  ]\n` +
                  `})\n\n` +
                  `Each chunk should be under 300 lines. The tool concatenates them in order.`;
              } else if (name === 'edit_file') {
                recoveryMsg =
                  `TRUNCATED — edit_file${pathHint} was cut off mid-argument (hit max_tokens).\n\n` +
                  `The old_text or new_text block is too large.\n\n` +
                  `Fix:\n` +
                  `1. Break the edit into multiple smaller edit_file calls (each old_text ≤ 20 lines)\n` +
                  `2. Target only the specific lines that need to change — don't include large unchanged blocks in old_text\n` +
                  `3. Always put "path" as the FIRST key in the JSON`;
              } else if (name === 'write_file_chunked') {
                // Salvage what we can from partial chunks
                const rescuedChunks = [];
                const chunksStart = argsStr.indexOf('"chunks"');
                if (chunksStart !== -1) {
                  const arrStart = argsStr.indexOf('[', chunksStart);
                  if (arrStart !== -1) {
                    const partial = argsStr.slice(arrStart);
                    let i = 1;
                    while (i < partial.length) {
                      while (i < partial.length && /[\s,]/.test(partial[i])) i++;
                      if (partial[i] !== '"') break;
                      let j = i + 1, str = '', complete = false;
                      while (j < partial.length) {
                        if (partial[j] === '\\' && j + 1 < partial.length) {
                          const esc = partial[j + 1];
                          str += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
                          j += 2;
                        } else if (partial[j] === '"') { complete = true; j++; break; }
                        else { str += partial[j]; j++; }
                      }
                      if (complete) { rescuedChunks.push(str); i = j; }
                      else break;
                    }
                  }
                }

                if (rescuedChunks.length && rescuedPath) {
                  const joinedLen = rescuedChunks.join('').split('\n').length;
                  recoveryMsg =
                    `⚠ PARTIAL WRITE — write_file_chunked${pathHint} was truncated mid-stream.\n` +
                    `Received ${rescuedChunks.length} chunk(s) / ~${joinedLen} lines before truncation.\n\n` +
                    `The file may be INCOMPLETE. Continue with:\n` +
                    `write_file_chunked({"path": "${rescuedPath}", "append": true, "chunks": ["...remaining content..."]})\n\n` +
                    `Keep each chunk ≤ 60 lines.`;
                } else {
                  recoveryMsg =
                    `TRUNCATED — write_file_chunked${pathHint} was cut off before any complete chunks could be parsed.\n\n` +
                    `Fix: Keep each chunk small (≤60 lines) so all chunks fit in one tool call.\n\n` +
                    `write_file_chunked({"path": "${rescuedPath || 'YOUR_FILE_PATH'}", "chunks": ["chunk1", "chunk2", ...]})`;
                }
              } else {
                recoveryMsg =
                  `TRUNCATED — ${name}${pathHint} arguments were cut off mid-stream (hit max_tokens).\n\n` +
                  `Reduce the size of the arguments and retry.`;
              }

              state.messages.push({ role: 'tool', tool_call_id: tc.id, content: recoveryMsg });

            } else {
              // ── This tool call had valid JSON, but the batch was interrupted ──
              // The model's generation was cut off, so it can't meaningfully
              // process real results. Tell it to retry the whole batch.
              state.messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content:
                  `[BATCH INTERRUPTED — another tool call in this batch was truncated when the model hit max_tokens. ` +
                  `The model's generation was cut off and cannot process results reliably.\n\n` +
                  `Please retry this tool call in your next response.]`
              });
            }
          }

          // Show a warning UI element
          const warnEl = document.createElement('div');
          warnEl.className = 'health-warning';
          const truncatedNames = tcs._truncatedTcs.map(tc => `<code>${esc(tc.function.name)}</code>`).join(', ');
          const otherCount = tcs.length - tcs._truncatedTcs.length;
          const otherNote = otherCount > 0
            ? ` and ${otherCount} other tool${otherCount > 1 ? 's' : ''} interrupted`
            : '';
          warnEl.innerHTML = `<i class="fas fa-scissors"></i><span>Tool call truncated (hit max_tokens) — injecting recovery guidance for ${truncatedNames}${otherNote}</span>`;
          $msg().appendChild(warnEl);
          scrollBottom();

          continue;   // Let the model read the recovery messages and retry
        }

        // ── Normal flow: push assistant message and proceed to tool execution ──
        state.messages.push(am);
        updateContextMeter();

        if (cur) finalizeStreamingMsg(cur);

        const thinkTcs = tcs.filter(tc => tc.function.name === 'think');
        const nonThinkTcs = tcs.filter(tc => tc.function.name !== 'think');
        const validToolNames = new Set(getToolDefs().map(t => t.function.name));
        const rejectedTcs = nonThinkTcs.filter(tc => !validToolNames.has(tc.function.name));
        const validNonThinkTcs = nonThinkTcs.filter(tc => validToolNames.has(tc.function.name));

        if (rejectedTcs.length) {
          appendMsg('system', 'Tool(s) no longer available: ' + rejectedTcs.map(tc => tc.function.name).join(', ') + ' — companion disconnected mid-conversation.');
        }

        if (validNonThinkTcs.length) {
          const isParallel = validNonThinkTcs.length > 1 && validNonThinkTcs.every(tc => HarnessRuntime.isReadOnly(tc.function.name));
          if (isParallel) showParallelBadge(validNonThinkTcs.length);
          const toolAbortCtrls = validNonThinkTcs.map(() => new AbortController());
          const batchSignal = state.abortCtrl?.signal;
          const abortBatch = () => toolAbortCtrls.forEach(ctrl => ctrl.abort());
          if (batchSignal?.aborted) abortBatch();
          else batchSignal?.addEventListener('abort', abortBatch, { once: true });
          const batchId = 'batch_' + Date.now();
          const toolPanels = validNonThinkTcs.map((tc, i) => {
            const p = showToolPanel(tc.function.name, tc.function.arguments, 'run',
              () => toolAbortCtrls[i].abort(), tc.id);
            p.el._batchId = batchId;
            return p;
          });

          const panelMap = new Map();
          for (let i = 0; i < validNonThinkTcs.length; i++) panelMap.set(validNonThinkTcs[i].id, toolPanels[i]);

        const results = await HarnessRuntime.runToolBatch(validNonThinkTcs, async (tc, i) => {
          if (toolAbortCtrls[i].signal.aborted || !state.running || state.abortCtrl?.signal.aborted) {
            updateToolStatus(toolPanels[i], 'err'); updateToolResult(toolPanels[i], 'Cancelled by user.');
            return { tc, outText: 'Cancelled by user.', cancelled: true };
          }
          let result;
          try {
            result = HarnessRuntime.normalizeResult(await executeTool(tc.function.name, tc.function.arguments, toolAbortCtrls[i].signal, toolPanels[i], tc._operationId));
            const toolFailed = result.status !== 'ok';
            updateToolStatus(toolPanels[i], toolFailed ? 'err' : 'ok');
          } catch (e) {
            if (toolAbortCtrls[i].signal.aborted) {
              updateToolStatus(toolPanels[i], 'err'); updateToolResult(toolPanels[i], 'Cancelled by user.');
              return { tc, outText: 'Cancelled by user.', cancelled: true };
            }
            result = { output: 'Error: ' + e.message }; updateToolStatus(toolPanels[i], 'err');
          }

          if (result === undefined || result === null || typeof result !== 'object') {
            const badResult = !result
              ? 'Tool returned nothing (internal error — this is a bug in executeTool for "' + tc.function.name + '")'
              : 'Tool returned non-object: ' + typeof result + ' — ' + JSON.stringify(result).slice(0, 120);
            console.error('[executeTool] INVALID RESULT', {
              tool: tc.function.name, args: tc.function.arguments?.slice(0, 300), result, typeof: typeof result, stack: new Error().stack
            });
            updateToolStatus(toolPanels[i], 'err');
            updateToolResult(toolPanels[i], badResult);
            return { tc, outText: badResult, diff: null, searchData: null };
          }

          let outText = (typeof result === 'string') ? result : (result.output) || '';
          outText = redactSecrets(outText);
          const diff = result.diff || null;
          const searchData = result._searchData || null;

          if (result._screenshotDataUrl) { toolPanels[i].el._screenshotDataUrl = result._screenshotDataUrl; toolPanels[i].el._imagePath = 'screenshot'; toolPanels[i].el._imageReason = result._screenshotReason || 'agent requested'; toolPanels[i].el._imageType = 'screenshot'; }
          else if (result._imageDataUrl) { toolPanels[i].el._imageDataUrl = result._imageDataUrl; toolPanels[i].el._imagePath = result._imagePath || 'unknown'; toolPanels[i].el._imageReason = result._imageReason || 'file read'; toolPanels[i].el._imageType = result._imageType || 'file'; }
          toolPanels[i].el._svgPreviewUrl = result._svgPreviewUrl || null; toolPanels[i].el._svgText = result._svgText || null; toolPanels[i].el._svgPath = result._svgPath || null;
          toolPanels[i].el._previewDataUrl = result._previewDataUrl || null; toolPanels[i].el._previewPath = result._previewPath || null;
          if (result._subAgentData) toolPanels[i].el._subAgentData = result._subAgentData;
          if (result._swarmData)    toolPanels[i].el._swarmData    = result._swarmData;

          updateToolResult(toolPanels[i], outText);
          if (searchData) showSearchPanel(searchData);

          /* ── Inline approval: show diff + buttons as a standalone panel ── */
          if (result._pendingApproval === true) {
            const isNewFile = result._pendingIsNewFile === true;
            const endApproval = beginRunApproval({ tool: tc.function.name, path: result._pendingPath });
            const approved = await new Promise((resolve) => {
              let decided = false;
              const onDecide = (val) => { if (decided) return; decided = true; resolve(val); };

              const wrapper = document.createElement('div');
              wrapper.className = 'diff-panel pending';
              wrapper.style.border = '2px solid rgba(234, 179, 8, .45)';

              const pendingPath = result._pendingPath || '(unknown)';

              const hdr = document.createElement('div');
              hdr.className = 'diff-hdr';
              hdr.style.background = 'rgba(234, 179, 8, .06)';
              const waitingId = 'approval-wait-' + Date.now();
              hdr.innerHTML = `<i class="fas fa-hourglass-half" id="${waitingId}" style="color:var(--yellow);animation:pulse 1s infinite;font-size:10px"></i><span style="color:var(--yellow);font-weight:700;font-size:11px">${isNewFile ? 'New file awaiting approval' : 'Edit awaiting approval'}</span><span style="flex:1"></span><span style="font-size:10px;color:var(--tx-4);font-family:'JetBrains Mono',monospace">${esc(pendingPath)}</span>`;
              wrapper.appendChild(hdr);

              if (diff) {
                const { compact: displayLines } = compactDiffLines(diff.lines, 2, 2);
                const content = document.createElement('div');
                content.className = 'diff-content';
                content.style.maxHeight = '260px';
                content.innerHTML = displayLines.map(l => {
                  if (l.type === 'ellipsis') return `<div class="diff-line ellipsis">···</div>`;
                  return `<div class="diff-line ${l.type}">${esc(l.text)}</div>`;
                }).join('');
                wrapper.appendChild(content);
              } else if (isNewFile && result._pendingNewContent != null) {
                const preview = document.createElement('div');
                preview.className = 'new-file-pending';
                preview.style.border = 'none';
                preview.style.borderRadius = '0';
                const newContent = result._pendingNewContent;
                const chars = newContent.length;
                const linesCount = newContent.split('\n').length;
                preview.innerHTML = `<div class="nfp-hdr"><i class="fas fa-file-circle-plus"></i> ${esc(pendingPath)} <span style="margin-left:auto;color:var(--green)">${chars} chars · ${linesCount} lines</span></div><div class="nfp-preview">${esc(newContent.slice(0, 4000))}${chars > 4000 ? '\n\n... (truncated for display)' : ''}</div>`;
                wrapper.appendChild(preview);
              } else {
                const fallback = document.createElement('div');
                fallback.style.cssText = 'padding:12px;font-size:11px;color:var(--yellow);background:rgba(234,179,8,.04)';
                fallback.innerHTML = '<i class="fas fa-exclamation-triangle" style="margin-right:4px"></i> Approval requested but no diff or content available. This is an internal error — the tool returned _pendingApproval but no _pendingNewContent or diff.';
                wrapper.appendChild(fallback);
              }

              const bar = document.createElement('div');
              bar.className = 'diff-approval-bar';
              bar.style.background = 'rgba(234, 179, 8, .06)';
              bar.style.borderTop = '1px solid rgba(234, 179, 8, .25)';
              bar.style.padding = '10px 12px';
              bar.innerHTML = `<span class="da-label" style="font-size:12px">${isNewFile ? 'Create this file?' : 'Apply this edit?'}</span><button class="da-btn accept" style="padding:6px 16px;font-size:11px"><i class="fas fa-check"></i> Accept</button><button class="da-btn reject" style="padding:6px 16px;font-size:11px"><i class="fas fa-xmark"></i> Reject</button>`;

              const acceptBtn = bar.querySelector('.da-btn.accept');
              const rejectBtn = bar.querySelector('.da-btn.reject');

              acceptBtn.onclick = () => {
                onDecide(true);
                wrapper.style.border = '2px solid rgba(34, 197, 94, .35)';
                wrapper.classList.remove('pending');
                const waitIcon = document.getElementById(waitingId);
                if (waitIcon) { waitIcon.className = 'fas fa-check-circle'; waitIcon.style.color = 'var(--green)'; waitIcon.style.animation = 'none'; }
                const label = hdr.querySelector('span[style*="yellow"]');
                if (label) { label.style.color = 'var(--green)'; label.textContent = isNewFile ? 'File created' : 'Edit applied'; }
                bar.innerHTML = '<span class="da-label" style="color:var(--green);font-size:12px"><i class="fas fa-check"></i> Accepted</span>';
                acceptBtn.replaceWith(acceptBtn.cloneNode(true));
                rejectBtn.replaceWith(rejectBtn.cloneNode(true));
              };

              rejectBtn.onclick = () => {
                onDecide(false);
                wrapper.style.border = '2px solid rgba(239, 68, 68, .35)';
                wrapper.style.opacity = '.5';
                wrapper.style.pointerEvents = 'none';
                const waitIcon = document.getElementById(waitingId);
                if (waitIcon) { waitIcon.className = 'fas fa-xmark-circle'; waitIcon.style.color = 'var(--red)'; waitIcon.style.animation = 'none'; }
                const label = hdr.querySelector('span[style*="yellow"]');
                if (label) { label.style.color = 'var(--red)'; label.textContent = isNewFile ? 'File rejected' : 'Edit rejected'; }
                bar.innerHTML = '<span class="da-label" style="color:var(--red);font-size:12px"><i class="fas fa-xmark"></i> Rejected</span>';
                acceptBtn.replaceWith(acceptBtn.cloneNode(true));
                rejectBtn.replaceWith(rejectBtn.cloneNode(true));
              };

              wrapper.appendChild(bar);
              $msg().appendChild(wrapper);
              state.autoScroll = true;
              updateScrollLockBtn();
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  wrapper.scrollIntoView({ behavior: 'smooth', block: 'end' });
                });
              });

              if (toolAbortCtrls[i].signal) {
                const h = () => {
                  if (!decided) {
                    decided = true;
                    resolve(false);
                    wrapper.style.border = '2px solid rgba(239, 68, 68, .35)';
                    wrapper.style.opacity = '.5';
                    wrapper.style.pointerEvents = 'none';
                    const waitIcon = document.getElementById(waitingId);
                    if (waitIcon) { waitIcon.className = 'fas fa-ban'; waitIcon.style.color = 'var(--red)'; waitIcon.style.animation = 'none'; }
                    bar.innerHTML = '<span class="da-label" style="color:var(--red);font-size:12px"><i class="fas fa-stop"></i> Cancelled</span>';
                  }
                  toolAbortCtrls[i].signal.removeEventListener('abort', h);
                };
                toolAbortCtrls[i].signal.addEventListener('abort', h);
              }
            });

            await endApproval(approved);
            if (approved) {
              let actual;
              try {
                actual = await HarnessRuntime.withToolLock('write_file', async () => {
                  if (toolAbortCtrls[i].signal.aborted || !state.running) throw new DOMException('Aborted', 'AbortError');
                  if (typeof recordRunEvent === 'function') await recordRunEvent('edit.started', { operationId: tc._operationId || result._operationId || tc.id, path: pendingPath });
                  const applied = isNewFile ? await applyPendingWrite(result) : await applyPendingEdit(result);
                  if (typeof noteVerificationMutation === 'function') noteVerificationMutation(tc.function.name, applied);
                  if (typeof recordRunEvent === 'function') await recordRunEvent(applied.status === 'error' ? 'edit.failed' : 'edit.applied', { operationId: tc._operationId || result._operationId || tc.id, path: pendingPath, result: applied });
                  return applied;
                });
              } catch (approvalErr) {
                console.error('[agent] applyPending error:', approvalErr);
                updateToolStatus(toolPanels[i], 'err');
                updateToolResult(toolPanels[i], 'Error applying approved change: ' + approvalErr.message);
                return { tc, outText: 'Error applying approved change: ' + approvalErr.message, diff: null, searchData: null };
              }
              actual = HarnessRuntime.normalizeResult(actual);
              actual = await archiveToolOutput(tc.function.name,actual,(tc._operationId || result._operationId || tc.id)+':approved');
              recordHarnessTool(tc.function.name, safeParseArgs(tc.function.arguments), actual, tc.id, tc._operationId || result._operationId);
              if (actual.status !== 'ok') {
                updateToolStatus(toolPanels[i], 'err'); updateToolResult(toolPanels[i], actual.output);
                return { tc, outText: actual.output, diff: null, searchData: null, rejected: true };
              }
              const tArgs = safeParseArgs(tc.function.arguments);
              if (tArgs && tArgs.path) {
                if (isNewFile) sessionChanges.created.add(tArgs.path); else sessionChanges.modified.add(tArgs.path);
                rpState.addChange(tArgs.path, isNewFile ? 'created' : 'modified', actual.diff);
                previewFile(tArgs.path);
                debouncedFileTreeRefresh();
                if (state.compConnected && (tArgs.path.endsWith('.py'))) {
                  const ck = await checkPythonFile(tArgs.path,toolAbortCtrls[i].signal);
                  if (typeof ck === 'string' && ck.trim()) actual.output += '\n\n⚠️ SYNTAX CHECK:\n' + ck.trim();
                }
              }
              updateToolResult(toolPanels[i], actual.output || 'Applied');
              toolCallHistory.push(HarnessCore.progressRecord(tc.function.name,tc.function.arguments,actual,state.progressRevision || 0));
              return { tc, outText: actual.output || 'Applied', diff: actual.diff || null, searchData: null, status: actual.status, artifactId:actual._artifactId };
            } else {
              updateToolStatus(toolPanels[i], 'err');
              updateToolResult(toolPanels[i], 'Rejected — try a different approach.');
              return { tc, outText: 'Edit to "' + pendingPath + '" rejected by user. Do NOT retry this exact edit.', diff: null, searchData: null, rejected: true };
            }
          } else {
            if (diff) showDiffPanel(diff);
          }

          /* ── Error auto-routing ── */
          if (/not found|does not exist|no such file/i.test(outText)) {
            const routed = await autoRouteFileError(tc.function.name, outText, toolPanels[i]);
            if (routed !== outText) {
              updateToolResult(toolPanels[i], routed);
              return { tc, outText: routed, diff, searchData };
            }
          }

          if (result.status === 'ok') {
            const args = safeParseArgs(tc.function.arguments);
            if (tc.function.name === 'write_file') sessionChanges.created.add(args.path);
            if (tc.function.name === 'write_file_chunked') sessionChanges.created.add(args.path);
            if (tc.function.name === 'edit_file') sessionChanges.modified.add(args.path);
            if (tc.function.name === 'delete_file') sessionChanges.deleted.add(args.path);
            if (tc.function.name === 'move_file') sessionChanges.moved.push({ from: args.source, to: args.destination });
          }
          const progress = HarnessCore.progressRecord(tc.function.name,tc.function.arguments,{...result,output:outText},state.progressRevision || 0);
          const success = result.status === 'ok';
          // NOTE: outText is stored separately from sig (sig is name+args only) so the
          // malformed-argument detector below can actually match on the error message.
          toolCallHistory.push(progress); if (toolCallHistory.length > 20) toolCallHistory.shift();
          return { tc, outText, diff, searchData, status: result.status, artifactId:result._artifactId };
        }).finally(() => batchSignal?.removeEventListener('abort', abortBatch));

          const hadEdits = results.some(r => !r.rejected && !r.cancelled &&
            HarnessVerification.requiresRecheck(r.tc.function.name, { status: r.status }));

          const postToolMessages=[];
          /* Detect repeated missing-argument errors — LLM keeps forgetting params */
          if (toolCallHistory.length >= 2) {
            const recent = toolCallHistory.slice(-4);
            const malformedErrors = recent.filter(r =>
              !r.success && (
                r.outText.includes('"path" is required') ||
                r.outText.includes('"content" is required') ||
                r.outText.includes('"edits" must be') ||
                r.outText.includes('"command" is required') ||
                r.outText.includes('"query" is required') ||
                r.outText.includes('"task" is required') ||
                r.outText.includes('invalid arguments') ||
                r.outText.includes('truncated JSON') ||
                r.outText.includes('empty arguments')
              )
            );
            if (malformedErrors.length >= 2) {
              const isTruncation = recent.some(r => r.outText.includes('truncated') || r.outText.includes('empty'));
              const wEl = document.createElement('div');
              wEl.className = 'health-warning';
              wEl.innerHTML = `<i class="fas fa-triangle-exclamation"></i><span>Agent repeatedly sending ${isTruncation ? 'TRUNCATED' : 'malformed'} tool calls — injecting fix</span>`;
              $msg().appendChild(wEl); scrollBottom();
              const hint = isTruncation
                ? '[SYSTEM: Your tool call JSON is being TRUNCATED mid-stream. This happens when old_text or content is too long.\n\nIMMEDIATE FIX:\n• For files >30KB: NEVER use write_file — use edit_file with 5-15 line blocks\n• For edit_file: keep each old_text under 500 characters\n• Split large edits into MULTIPLE edit_file calls (each targeting a different section)\n• Do NOT put entire file contents in a single tool call\n\nDo NOT retry the same call. Split it into smaller pieces.]'
                : '[SYSTEM: You have sent ' + malformedErrors.length + ' tool calls with missing or malformed arguments.\n\nRULES:\n1. Every tool call MUST have ALL required parameters as valid JSON\n2. If a file is very large (>30KB), do NOT use write_file with the full content — use edit_file instead with small search/replace blocks\n3. Double-check your JSON: every { has a matching }, every " has a matching "\n4. Do NOT retry the same broken call. Fix the argument format first.]';
              postToolMessages.push({ role: 'user', content: hint });
              toolCallHistory.length = 0;
            }
          }

          /* Detect a stalled loop — same tool + same arguments fired 3+ times in a
             row regardless of success/failure (e.g. retrying a failing shell command
             unchanged, or re-reading a file it already has). Forces a stop-and-explain
             instead of quietly burning iterations/tokens. */
          if (toolCallHistory.length >= 3) {
            const lastN = toolCallHistory.slice(-3);
            if (HarnessCore.stalled(toolCallHistory)) {
              const toolName = lastN[0].sig.split(':')[0];
              const wEl = document.createElement('div');
              wEl.className = 'health-warning';
              wEl.innerHTML = `<i class="fas fa-rotate" style="color:var(--red)"></i><span>Agent repeated the same "${esc(toolName)}" call 3 times in a row — stopping the loop</span>`;
              $msg().appendChild(wEl); scrollBottom();
              postToolMessages.push({
                role: 'user',
                content: `[SYSTEM: You've called ${toolName} with the exact same arguments 3 times in a row with no progress. Do NOT repeat this call again unchanged.\n\nStop and do one of the following:\n1. Explain to the user what's blocking you and why the same approach keeps failing/repeating.\n2. Try a materially different approach (different arguments, different tool, or ask_user if you're missing information you can't infer).\n3. If the previous result actually looked correct, move on to the next step instead of re-verifying the same thing.]`
              });
              toolCallHistory.length = 0;
            }
          }

          /* Detect "fixed it by changing the command" — e.g. failed with python3,
             succeeded moments later with python. This is exactly the class of
             environment correction that's easy to lose after compaction, since a
             summarizer sees it once and it looks like a minor detail next to
             "core task" / "files modified". Nudge toward save_memory, once per
             distinct pair per run, rather than saving it automatically — only the
             agent knows if it's a real environment fact vs. a one-off typo. */
          if (toolCallHistory.length >= 2) {
            const recent = toolCallHistory.slice(-6);
            const cmdEntries = recent.map(r => {
              const sep = r.sig.indexOf(':');
              const name = r.sig.slice(0, sep);
              if (name !== 'execute_command') return null;
              const argsPrefix = r.sig.slice(sep + 1);
              let cmd = argsPrefix;
              try { cmd = JSON.parse(argsPrefix).command || argsPrefix; }
              catch { const m = argsPrefix.match(/"command"\s*:\s*"([^"]*)/); if (m) cmd = m[1]; }
              return { cmd, success: r.success };
            }).filter(Boolean);
            outer: for (let i = 0; i < cmdEntries.length; i++) {
              if (cmdEntries[i].success) continue;
              for (let j = i + 1; j < cmdEntries.length; j++) {
                if (!cmdEntries[j].success) continue;
                const a = (cmdEntries[i].cmd || '').trim().split(/\s+/)[0];
                const b = (cmdEntries[j].cmd || '').trim().split(/\s+/)[0];
                if (a && b && a !== b) {
                  const pairKey = a + '→' + b;
                  state._envNudgedPairs = state._envNudgedPairs || new Set();
                  if (!state._envNudgedPairs.has(pairKey)) {
                    state._envNudgedPairs.add(pairKey);
                    postToolMessages.push({
                      role: 'user',
                      content: `[SYSTEM: You just fixed a failing command by switching from "${a}" to "${b}". If this is an environment-specific fact (the right command/tool/version to use in THIS workspace) rather than a one-off typo, call save_memory now so you don't rediscover it the hard way again after this conversation compacts or in a future session here. Skip this if it was just a typo.]`
                    });
                  }
                }
                break outer;
              }
            }
          }


          const resultMap = new Map();
          for (const r of results) resultMap.set(r.tc.id, r);

          for (const tc of tcs) {
            if (tc.function.name === 'think') {
              let thought = '';
              try { const a = JSON.parse(tc.function.arguments); thought = a.thought || ''; } catch { thought = tc.function.arguments || ''; }
              state.messages.push({ role: 'tool', tool_call_id: tc.id, content: thought });
            } else {
              const r = resultMap.get(tc.id);
              const panel = panelMap.get(tc.id);
              if (!r || r.rejected) {
                state.messages.push({
                  role: 'tool', tool_call_id: tc.id,
                  content: r && r.rejected
                    ? '[Error: ' + tc.function.name + ' edit was rejected by the user. Do NOT retry this exact edit.]'
                    : '[Error: ' + tc.function.name + ' is no longer available — the companion server disconnected. The tool list has been updated. Use only the tools that are currently available.]'
                });
                continue;
              }
              const toolMsg = { role: 'tool', tool_call_id: tc.id, content: compressToolOutput(tc.function.name, r.outText, compStats)+(r.artifactId?'\n[Full output: '+r.artifactId+'; use read_artifact to retrieve it.]':''), _operationId:tc._operationId, _status:r.status, _artifactId:r.artifactId, _diff: r.diff || null, _searchData: r.searchData || null };
              if (panel) {
                if (panel.el._svgPreviewUrl) { toolMsg._svgPreviewUrl = panel.el._svgPreviewUrl; toolMsg._svgText = panel.el._svgText; toolMsg._svgPath = panel.el._svgPath; }
                if (panel.el._previewDataUrl) { toolMsg._previewDataUrl = panel.el._previewDataUrl; toolMsg._previewPath = panel.el._previewPath; }
                if (panel.el._imageDataUrl) { toolMsg._imageDataUrl = panel.el._imageDataUrl; toolMsg._imagePath = panel.el._imagePath; toolMsg._imageReason = panel.el._imageReason; toolMsg._imageType = panel.el._imageType; }
                if (panel.el._screenshotDataUrl) { toolMsg._screenshotDataUrl = panel.el._screenshotDataUrl; toolMsg._imagePath = panel.el._imagePath; toolMsg._imageReason = panel.el._screenshotReason; toolMsg._imageType = panel.el._imageType; }
                if (panel.el._subAgentData) toolMsg._subAgentData = panel.el._subAgentData;
                if (panel.el._swarmData)    toolMsg._swarmData    = panel.el._swarmData;
              }
              state.messages.push(toolMsg);
              const tName = tc.function.name; const tArgs = safeParseArgs(tc.function.arguments);
              if ((tName === 'edit_file' || tName === 'write_file') && r.diff) {
                rpState.addChange(r.diff.path, tName === 'write_file' ? 'created' : 'modified', r.diff);
                if (tArgs.path) previewFile(tArgs.path);
              }
              if (tName === 'delete_file' && tArgs.path) rpState.addChange(tArgs.path, 'deleted', null);
              if (tName === 'move_file' && tArgs.destination) rpState.addChange(tArgs.destination, 'moved', null);
            }
          }

          state.messages.push(...postToolMessages);
          if (state.running && hadEdits && state.autoVerifyCommand && state.compConnected) await verifyAfterChanges();
          if (rpState.activeTab === 'git' && state.compConnected) setTimeout(updateGitPanel, 300);

          /* ── Render previews ── */
          for (let ri = 0; ri < results.length; ri++) {
            const panel = toolPanels[ri];
            if (results[ri].rejected) continue;
            if (panel.el._svgPreviewUrl && !panel.el.querySelector('.svg-preview')) {
              panel.el.classList.add('screenshot-tool');
              const prev = document.createElement('div'); prev.className = 'svg-preview';
              const path = esc(panel.el._svgPath || 'file.svg');
              prev.innerHTML =
                '<div class="svg-toggle-row"><span><i class="fas fa-bezier-curve" style="color:var(--accent);margin-right:4px"></i>' + path + '</span><button class="svg-toggle-btn" onclick="toggleSvgView(this)">View Code</button></div>' +
                '<img class="svg-preview-img" src="' + panel.el._svgPreviewUrl + '" onclick="openImgViewer(this.src)" alt="' + path + '">' +
                '<div class="svg-code-view"><pre><code class="language-xml">' + esc(panel.el._svgText || '') + '</code></pre></div>';
              panel.el.appendChild(prev);
            }
            if (panel.el._previewDataUrl && !panel.el._imageDataUrl && !panel.el.querySelector('.image-preview-only')) {
              panel.el.classList.add('screenshot-tool');
              const prev = document.createElement('div'); prev.className = 'image-preview-only';
              const path = esc(panel.el._previewPath || 'image');
              prev.innerHTML =
                '<div class="img-label"><i class="fas fa-image" style="color:var(--accent)"></i>' + path + '</div>' +
                '<img src="' + panel.el._previewDataUrl + '" onclick="openImgViewer(this.src)" alt="' + path + '">';
              panel.el.appendChild(prev);
            }

            /* ── Sub-agent panels ── */
            if (panel.el._subAgentData && !panel.el.querySelector('.sub-agent-panel')) {
              showSubAgentPanel(panel.el._subAgentData);
              const res = panel.el.querySelector('.tool-result');
              if (res) res.style.display = 'none';
              continue;
            }

            /* ── Swarm panels ── */
            if (panel.el._swarmData && !panel.el.querySelector('.swarm-panel')) {
              // Remove the live swarm panel that was appended directly to $msg() during execution
              if (panel.el._swarmLiveEl && panel.el._swarmLiveEl.parentNode) {
                panel.el._swarmLiveEl.remove();
              }
              showSwarmPanel(panel.el._swarmData, panel.el);
              const res = panel.el.querySelector('.tool-result');
              if (res) res.style.display = 'none';
              continue;
            }


            /* ── PDF thumbnail preview ── */
            if (panel.el._pdfThumbnail && !panel.el.querySelector('.screenshot-preview')) {
              panel.el.classList.add('screenshot-tool');
              const prev = document.createElement('div');
              prev.className = 'screenshot-preview';
              prev.innerHTML = '<div style="font-size:10px;color:var(--tx-3);margin-bottom:4px;font-family:\'JetBrains Mono\',monospace"><i class="fas fa-file-pdf" style="color:var(--red)"></i> ' + esc(panel.el._pdfPath || 'document.pdf') + '</div><img src="' + panel.el._pdfThumbnail + '" onclick="openImgViewer(this.src)" alt="PDF preview" style="max-height:200px;border-radius:4px;border:1px solid var(--border);cursor:pointer">';
              panel.el.appendChild(prev);
            }

            const imgUrl = panel.el._screenshotDataUrl || panel.el._imageDataUrl;
            const hasImageData = imgUrl && !panel.el._svgPreviewUrl && !panel.el._pdfThumbnail;
            if (!hasImageData) continue;

            if (!panel.el.querySelector('.screenshot-preview')) {
              panel.el.classList.add('screenshot-tool');
              const preview = document.createElement('div'); preview.className = 'screenshot-preview';
              const imgPath = panel.el._imagePath || 'image';
              const label = panel.el._imageType === 'file' ? '<div style="font-size:10px;color:var(--tx-3);margin-bottom:4px;font-family:\'JetBrains Mono\',monospace"><i class="fas fa-image" style="color:var(--accent)"></i> ' + esc(imgPath) + '</div>' : '';
              preview.innerHTML = label + '<img src="' + imgUrl + '" onclick="openImgViewer(this.src)" alt="' + esc(imgPath) + '">';
              panel.el.appendChild(preview);
            }
            state.messages.push({ role: 'user', content: '[' + (panel.el._imageType || 'screenshot') + ': ' + (panel.el._imageReason || 'captured') + ' — ' + (panel.el._imagePath || 'image') + ']', _images: [{ type: 'image_url', image_url: { url: imgUrl } }], _isAgentImage: true, _imageType: panel.el._imageType });
          }
        }

        /* ── Think-only turn (no non-think tools) ── */
        else {
          for (const tc of tcs) {
            let thought='';
            if(tc.function.name==='think') {try {thought=JSON.parse(tc.function.arguments).thought || '';} catch {thought=tc.function.arguments || '';}}
            else thought='Error: tool '+tc.function.name+' is unavailable. Choose an available tool.';
            state.messages.push({role:'tool',tool_call_id:tc.id,content:thought,_status:tc.function.name==='think'?'ok':'error'});
          }
        }

        // Save a checkpoint after each iteration where files were modified
        modifiedFiles.forEach(p => allModified.add(p));
        saveCheckpoint(iters, allModified); // pass cumulative set
        modifiedFiles.clear(); newFiles.clear();

        if(typeof collectCompletedCommandJobs==='function') await collectCompletedCommandJobs();
        updateContextMeter();
      }

      } catch (error) {
        appendMsg('system', state.abortCtrl?.signal.aborted || error.name === 'AbortError' ? 'Task stopped: ' + error.message : 'Task paused: ' + error.message);
      } finally {
      clearTimeout(runTimer);
      if (state.runController.snapshot().phase !== 'finished') state.runController.transition('paused');
      state.running = false; state.abortCtrl = null; updateSendBtn(); saveCurrentConv();
      try {
        if (state.runController.snapshot().phase === 'finished') await clearActiveAgentState();
        else await saveActiveAgentState();
      } catch (error) { appendMsg('system', 'Run checkpoint could not be saved: ' + error.message); }
      if (typeof recordRunEvent === 'function') {
        try { await recordRunEvent(state.runController.snapshot().phase === 'finished' ? 'run.finished' : 'run.paused', { run: state.runController.snapshot() }); }
        catch (error) { appendMsg('system', 'Journal could not record the final run state: ' + error.message); }
      }
      console.log('[tokens]', {
        context: tokenTracker.lastPromptTokens >= 0 ? tokenTracker.lastPromptTokens : '(no usage data)',
        output: tokenTracker.totalOutputTokens,
        total: (tokenTracker.lastPromptTokens >= 0 ? tokenTracker.lastPromptTokens : 0) + tokenTracker.totalOutputTokens,
        elapsed: agentStopwatch ? (performance.now() - agentStopwatch) / 1000 + 's' : '-',
        contextPct: Math.round(getContextPct()) + '%',
        _callOut: tokenTracker._callOut,
        _lastPrompt: tokenTracker.lastPromptTokens,
        _totalOut: tokenTracker.totalOutputTokens,
      });

      showCompletionSummary(); agentStopwatch = null;
      await afterHarnessRun();
      }

      if (sessionChanges.modified.size || sessionChanges.created.size || sessionChanges.deleted.size || sessionChanges.moved.length) {
        showChangeSummary(sessionChanges); refreshFileTree();
      }
    }

