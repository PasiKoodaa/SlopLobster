/* IndexedDB journal adapter and review UI. Every append resolves only after commit. */
var runJournalWriter;
async function appendJournalEvent(event) {
  const db = await getDB(); if (!db) return false;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['run_journals', 'run_events'], 'readwrite');
    const runs = tx.objectStore('run_journals'), events = tx.objectStore('run_events');
    let saved;
    const request = runs.get(event.runId);
    request.onsuccess = () => {
      const previous = request.result || { id: event.runId, convId: event.convId, objective: event.objective, created: event.created, lastSeq: 0 };
      saved = { ...event, eventId: event.id, id: event.runId + ':' + (previous.lastSeq + 1), seq: previous.lastSeq + 1 };
      events.add(saved);
      runs.put({ ...previous, lastSeq: saved.seq, updated: event.created,
        phase: /^run\.(finished|paused)$/.test(event.type) ? event.type.slice(4) : /^run\.(started|resumed)$/.test(event.type) ? 'running' : previous.phase || 'running' });
    };
    tx.oncomplete = () => resolve(saved);
    tx.onabort = tx.onerror = () => reject(new Error('Journal storage failed: ' + (tx.error?.message || 'transaction aborted')));
  });
}
function recordRunEvent(type, detail = {}) {
  if (state.journalEnabled === false || !state.runController) return Promise.resolve(null);
  runJournalWriter ||= HarnessJournal.create({ append: appendJournalEvent, redact: redactSecrets });
  return runJournalWriter.record({ runId: state.runController.snapshot().id, convId: state.activeConvId, objective: state.originalTask }, type, detail)
    .catch(error => { error.name = 'JournalStorageError'; state.journalError = error.message; state.running = false; state.abortCtrl?.abort(error); throw error; });
}
async function loadRunJournal(runId) {
  const db = await getDB(); if (!db) throw new Error('Browser journal storage is unavailable');
  return new Promise((resolve, reject) => {
    const tx = db.transaction('run_events', 'readonly');
    const request = tx.objectStore('run_events').index('runId').getAll(IDBKeyRange.only(runId));
    tx.oncomplete = () => resolve(request.result || []);
    tx.onabort = tx.onerror = () => reject(new Error('Could not load run journal'));
  });
}
async function deleteRunJournalsForConversation(convId) {
  const db = await getDB(); if (!db) throw new Error('Browser journal storage is unavailable');
  await runJournalWriter?.flush();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['run_journals', 'run_events'], 'readwrite');
    const runs = tx.objectStore('run_journals'), events = tx.objectStore('run_events');
    const request = runs.index('convId').getAllKeys(IDBKeyRange.only(convId));
    request.onsuccess = () => {
      for (const id of request.result) {
        runs.delete(id);
        const cursor = events.index('runId').openKeyCursor(IDBKeyRange.only(id));
        cursor.onsuccess = () => { if (cursor.result) { events.delete(cursor.result.primaryKey); cursor.result.continue(); } };
      }
    };
    tx.oncomplete = () => resolve(true);
    tx.onabort = tx.onerror = () => reject(new Error('Could not delete conversation journals'));
  });
}
async function refreshRunJournals(runId) {
  const f = harnessFeatureState;
  f.journals = (await dbGetAll('run_journals')).sort((a, b) => b.updated - a.updated);
  f.journalId = runId || (f.journals.some(r => r.id === f.journalId) && f.journalId) || f.journals.find(r => r.convId === state.activeConvId)?.id || f.journals[0]?.id;
  f.journalEvents = f.journalId ? await loadRunJournal(f.journalId) : [];
  renderHarnessFeatures();
}
function renderRunJournal() {
  const f = harnessFeatureState, events = f.journalEvents || [], replay = HarnessJournal.replay(events);
  return '<p>Durable run timeline. Entries contain redacted, bounded excerpts. Offline replay never executes tools.</p>' +
    featureButton('refresh-journal', 'Refresh') +
    (f.journals || []).map(r => featureButton('select-journal', (r.objective || r.convId || r.id).slice(0, 65) + ' · ' + (r.phase || 'running'), r.id)).join('') +
    '<article><p>' + hfEsc(replay.eventCount) + ' events · ' + hfEsc(replay.phase) + ' · ' + hfEsc(replay.incomplete.length) + ' unfinished operations</p>' +
    replay.integrityIssues.map(issue => '<p>' + hfEsc(issue) + '</p>').join('') +
    (replay.incomplete.length ? '<p>Unfinished operations require inspection. The journal does not authorize repeating them.</p><pre>' + hfEsc(JSON.stringify(replay.incomplete, null, 2)) + '</pre>' : '') +
    (f.journalId ? featureButton('export-journal', 'Export journal JSON', f.journalId) : '') +
    events.slice(-300).map(e => '<details><summary>' + hfEsc(e.seq) + ' · ' + hfEsc(e.type) + ' · ' + hfEsc(new Date(e.created).toLocaleTimeString()) + '</summary><pre>' + hfEsc(JSON.stringify(e.detail, null, 2)) + '</pre></details>').join('') +
    (events.length > 300 ? '<p>Showing the latest 300 events. Export includes the full journal.</p>' : '') + '</article>';
}
