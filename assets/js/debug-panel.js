/* eslint-disable */
/**
 * Debug panel — hidden unless ?debug=1 is in the URL.
 *
 * It surfaces a small overlay in the bottom-right showing the
 * current phase, role, game code, uid, counts, and the last error
 * / last action. It also has an "Export state JSON" button that
 * works without admin login (so a player on a different device can
 * snapshot their view when filing a bug).
 */
(function (global) {
  'use strict';

  const HG = global.HatGame;
  const U = HG.Utils;
  const q = U.getQuery();
  if (q.debug !== '1') return;

  const root = document.getElementById('debug-panel');
  if (!root) return;
  root.classList.remove('hidden');

  let lastError = null;
  let lastAction = null;

  // Hook the console to capture our prefixed logs.
  const origError = console.error;
  console.error = function () {
    const first = arguments[0];
    if (typeof first === 'string' && first.indexOf('[AliasGame]') === 0) {
      lastError = Array.from(arguments).map(String).join(' ');
      paint();
    }
    return origError.apply(console, arguments);
  };

  // Track every visible toast as the most recent action.
  const toast = document.getElementById('toast');
  if (toast) {
    new MutationObserver(() => {
      if (!toast.classList.contains('hidden')) {
        lastAction = toast.textContent;
        paint();
      }
    }).observe(toast, { childList: true, characterData: true, subtree: true, attributes: true });
  }

  let current = {};
  function update(info) {
    current = info || {};
    paint();
  }

  function paint() {
    // Round snapshot is now generic (`round`) — `round1` is the
    // legacy alias kept for old debug dumps.
    const round = current.round || current.round1;
    // Pull session details on demand so the panel always reflects
    // current storage state (the wider `update` payload doesn't
    // carry them).
    const playerSess = U.loadPlayerSession();
    const adminSess = U.loadAdminSession();
    const lastRestoreErr = U.getLastRestoreError();
    const lastRestored = U.getLastRestored();
    const lines = [
      ['role', current.role || U.getCurrentRole()],
      ['provider', current.provider],
      ['phase', current.phase],
      ['registration', current.registrationLocked == null ? null :
        (current.registrationLocked ? 'locked' : 'open')],
      ['game code', current.gameCode],
      ['game id', current.gameId],
      ['uid', current.uid],
      ['player id', current.playerId],
      ['#players', current.players],
      ['#teams', current.teams],
      ['#my words', current.myWords],
      ['#hat words', current.hatWords],
      ['currentRound', current.currentRound],
      ['round.status', round && round.status],
      ['round.turn', round && round.turnNumber],
      ['round.remaining', round && round.remainingCount],
      ['round.pendingVal', round && round.pendingValidationCount],
      ['session.role', U.getCurrentRole()],
      ['session.playerId', playerSess && playerSess.playerId],
      ['session.gameId', (playerSess && playerSess.gameId) ||
                        (adminSess && adminSess.gameId)],
      ['session.gameCode', (playerSess && playerSess.gameCode) ||
                          (adminSess && adminSess.gameCode)],
      ['session.uid', playerSess && playerSess.uid],
      ['session.restored', lastRestored ? String(!!lastRestored.result) : '—'],
      ['session.lastErr', lastRestoreErr],
      ['last action', lastAction],
      ['last error', lastError],
    ];
    while (root.firstChild) root.removeChild(root.firstChild);
    const title = document.createElement('div');
    title.className = 'debug-title';
    title.textContent = 'debug';
    root.appendChild(title);

    const dl = document.createElement('dl');
    dl.className = 'debug-dl';
    lines.forEach(([k, v]) => {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v == null ? '—' : String(v).slice(0, 80);
      dl.appendChild(dt); dl.appendChild(dd);
    });
    root.appendChild(dl);

    // Validation arrays — surfacing these makes the "2 pending /
    // 0 cards" class of drift bugs obvious at a glance.
    const v = current.validation;
    if (v) {
      const vh = document.createElement('div');
      vh.className = 'debug-title';
      vh.textContent = 'validation';
      root.appendChild(vh);
      const vdl = document.createElement('dl');
      vdl.className = 'debug-dl';
      const vrows = [
        ['phase', v.phase],
        ['remaining', v.remainingCount],
        ['pending ids', (v.pendingValidationWordIds || []).length],
        ['pending count', v.pendingValidationCount],
        ['turn.guessed', (v.currentTurnGuessed || []).length],
        ['turn.confirmed', (v.currentTurnConfirmed || []).length],
        ['turn.rejected', (v.currentTurnRejected || []).length],
        ['all confirmed', (v.confirmedAllTurns || []).length],
        ['all rejected', (v.rejectedAllTurns || []).length],
      ];
      vrows.forEach(([k, val]) => {
        const dt = document.createElement('dt'); dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = val == null ? '—' : String(val);
        vdl.appendChild(dt); vdl.appendChild(dd);
      });
      root.appendChild(vdl);
    }

    // Recent events tail — newest at the bottom. Helps a tester see
    // exactly what the provider just recorded as the previous click's
    // side-effects.
    const events = current.events;
    if (Array.isArray(events) && events.length) {
      const eh = document.createElement('div');
      eh.className = 'debug-title';
      eh.textContent = 'recent events';
      root.appendChild(eh);
      const ul = document.createElement('ul');
      ul.className = 'debug-events';
      events.forEach(e => {
        const li = document.createElement('li');
        const t = (e.timestamp || '').replace('T', ' ').slice(11, 19);
        li.textContent = t + ' · ' + e.type;
        ul.appendChild(li);
      });
      root.appendChild(ul);
    }

    const btn = document.createElement('button');
    btn.className = 'btn btn-tiny btn-ghost';
    btn.textContent = 'Copy debug JSON';
    btn.onclick = () => {
      const data = Object.assign({ lastError, lastAction }, current);
      navigator.clipboard.writeText(JSON.stringify(data, null, 2))
        .then(() => U.showToast('Debug JSON copied.', 'info'))
        .catch(() => U.showToast(JSON.stringify(data), 'info'));
    };
    root.appendChild(btn);
  }

  HG.Debug = { update: update };
  paint();
})(window);
