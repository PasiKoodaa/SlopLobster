/* Baseline comparison uses execution status and test identities, never agent claims. */
(function(root) {
  'use strict';
  const writes = new Set(['edit_file', 'write_file', 'write_file_chunked', 'delete_file', 'move_file']);
  function snapshot(command, result = {}) {
    const raw = String(result.output || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');
    const ids = new Set();
    for (const line of raw.split('\n')) {
      let match;
      if ((match = /^\s*FAILED\s+([^\s(]+)/.exec(line))) ids.add('pytest:' + match[1]);
      else if ((match = /^\s*(?:FAIL|ERROR):\s+(.+)/.exec(line))) ids.add('unittest:' + match[1].trim());
      else if ((match = /^\s*not ok\s+\d+\s*-\s*(.+)/.exec(line))) ids.add('node:' + match[1].trim());
      else if ((match = /^\s*[✖×]\s+(.+?)(?:\s+\([\d.]+\s*m?s\))?\s*$/.exec(line)) && !/failing tests:?$/i.test(match[1])) ids.add('node:' + match[1].trim());
      else if ((match = /^\s*●\s+(.+)/.exec(line))) ids.add('jest:' + match[1].trim());
      else if ((match = /^\s*--- FAIL:\s+(\S+)/.exec(line))) ids.add('go:' + match[1]);
      else if ((match = /^----\s+(.+?)\s+stdout\s+----$/.exec(line))) ids.add('cargo:' + match[1]);
    }
    // Summary counts prevent a partial excerpt from being mistaken for the full failing set.
    const counts = raw.split('\n').filter(line => /\d+\s+(?:failed|failing|errors?)(?=[,;\s)]|$)/i.test(line))
      .map(line => [...line.matchAll(/(\d+)\s+(?:failed|failing|errors?)(?=[,;\s)]|$)/gi)].reduce((n, m) => n + +m[1], 0));
    const nodeCount = /(?:^|\n)(?:#\s*|ℹ\s*)fail\s+(\d+)/m.exec(raw);
    if (nodeCount) counts.push(+nodeCount[1]);
    const unitCount = /FAILED\s*\(([^)]+)\)/.exec(raw);
    if (unitCount) counts.push([...unitCount[1].matchAll(/(?:failures|errors)=(\d+)/g)].reduce((n, m) => n + +m[1], 0));
    const failureCount = Math.max(ids.size, 0, ...counts);
    const unavailable = [127, 9009].includes(result.exitCode) || /command not found|not recognized as.*command/i.test(raw);
    const incomplete = result.truncated || ['unknown', 'cancelled', 'timeout', 'blocked', 'pending'].includes(result.status) || !Number.isInteger(result.exitCode);
    const status = unavailable ? 'unavailable' : incomplete ? 'inconclusive'
      : result.exitCode === 0 && failureCount === 0 && result.status === 'ok' ? 'passed' : 'failed';
    return { command, status, exitCode: result.exitCode ?? null, failureIds: [...ids].sort(), failureCount,
      identitiesComplete: counts.length > 0 && failureCount > 0 && ids.size === failureCount && !result.truncated,
      output: raw.slice(-12000), truncated: !!result.truncated || raw.length > 12000, created: Date.now() };
  }
  function compare(baseline, current) {
    const base = { baselineStatus: baseline?.status || 'unavailable', status: current.status, newFailures: [], existingFailures: [], resolvedFailures: [] };
    if (current.status === 'passed') return { ...base, outcome: baseline?.status === 'failed' ? 'resolved' : 'passed' };
    if (current.status !== 'failed') return { ...base, outcome: 'inconclusive' };
    if (!baseline || baseline.command !== current.command || !['passed', 'failed'].includes(baseline.status)) return { ...base, outcome: 'unclassified_failure' };
    if (baseline.status === 'passed') return { ...base, outcome: 'regression', newFailures: current.failureIds };
    if (!baseline.identitiesComplete || !current.identitiesComplete) return { ...base, outcome: 'unclassified_failure' };
    const before = new Set(baseline.failureIds), after = new Set(current.failureIds);
    base.newFailures = current.failureIds.filter(id => !before.has(id));
    base.existingFailures = current.failureIds.filter(id => before.has(id));
    base.resolvedFailures = baseline.failureIds.filter(id => !after.has(id));
    return { ...base, outcome: base.newFailures.length ? 'regression' : 'pre_existing' };
  }
  function requiresRecheck(name, result = {}) {
    if (result._pendingApproval || result.status === 'blocked') return false;
    return writes.has(name) || name === 'execute_command' || /^(?:git_(?:add|commit|push|checkout_branch|stash)|spawn_swarm|spawn_sub_agent)$/.test(name);
  }
  const api = { snapshot, compare, requiresRecheck };
  root.HarnessVerification = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
