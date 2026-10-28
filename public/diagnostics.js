/* Privacy-conscious, bounded, local-only diagnostic history for intermittent mobile bugs. */
(function (root) {
  'use strict';
  const STORAGE_KEY = 'crossmeldDiagnostics.v1';
  const LIMIT = 180;
  const MAX_AGE_MS = 48 * 60 * 60 * 1000;
  // Deliberately allowlist metadata. Never accept raw state, packets, tiles,
  // messages, player names, room codes, or reconnect credentials.
  const NUMBERS = new Set(['round','revision','previousRevision','seat','turnSeat','pending','pendingAgeMs','stockCount','discardCount','latencyMs','timeoutMs','codeNumber','line','column']);
  const BOOLEANS = new Set(['connected','reconnecting','busy','paused','waitingForFinish','canAct','canDraw','canTake','canMeld','ownTurn','hasSocket','handshakePending','resyncing','socketOpen','visible']);
  const WORDS = new Set(['action','source','phase','reason','socketState','messageType','screen','event','errorName','errorMessage','stack','state']);
  const MAX_STRING = 240;
  function scrub(value) {
    return String(value)
      .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted]')
      .replace(/(?:file|wss?|https?):\/\/[^\s)]+/gi, '[URL]')
      .replace(/[?#][^\s)]+/g, '[redacted]')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .slice(0, MAX_STRING);
  }
  function safeFields(details) {
    const safe = {};
    if (!details || typeof details !== 'object') return safe;
    for (const [key, value] of Object.entries(details)) {
      if (NUMBERS.has(key) && typeof value === 'number' && Number.isFinite(value)) safe[key] = Math.round(value);
      else if (BOOLEANS.has(key) && typeof value === 'boolean') safe[key] = value;
      else if (WORDS.has(key) && typeof value === 'string') safe[key] = scrub(value);
    }
    return safe;
  }
  function createDiagnostics(storage, now = () => Date.now()) {
    let rows = [];
    try {
      const fromDisk = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(fromDisk)) rows = fromDisk.filter(row => row && typeof row.t === 'number' &&
        row.t <= now() && now() - row.t <= MAX_AGE_MS && typeof row.event === 'string')
        .slice(-LIMIT).map(row => ({t:row.t, event:scrub(row.event), details:safeFields(row.details)}));
    } catch { /* Safari private mode, disabled storage, malformed cache */ }
    const persist = () => {
      try { storage?.setItem(STORAGE_KEY, JSON.stringify(rows)); } catch { /* still keep in memory */ }
    };
    const prune = () => { rows = rows.filter(row => now() - row.t <= MAX_AGE_MS).slice(-LIMIT); };
    function record(event, details = {}) {
      rows.push({t:now(), event:scrub(event).slice(0,48), details:safeFields(details)});
      prune();persist();
    }
    function report() {
      prune();
      const header = ['Crossmeld diagnostic log (local, user-initiated copy)',
        'Generated: ' + new Date(now()).toISOString(),
        'Privacy: contains no tile identities, private hands, usernames, chat, room codes or reconnect tokens.',
        'Note: only the most recent 180 events (up to 48 hours) are retained.', ''];
      return header.concat(rows.map(row => new Date(row.t).toISOString() + ' ' + row.event + ' ' + JSON.stringify(row.details))).join('\n');
    }
    function clear() { rows = [];try {storage?.removeItem(STORAGE_KEY);} catch {} }
    return {record, report, clear, entries:() => rows.slice(), safeFields};
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {createDiagnostics};
  if (root && root.document) {
    let storage = null;
    try {storage = root.localStorage;} catch {}
    root.CrossmeldDiagnostics = createDiagnostics(storage);
  }
})(typeof window !== 'undefined' ? window : null);
