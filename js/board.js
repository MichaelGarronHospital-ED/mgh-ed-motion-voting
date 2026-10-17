// ============================================================================
//  VOTERS' BOARD. Pure functions, no Firebase.
//
//  Phones listen to two small documents only: config/live (the board: what is
//  open, and this meeting's results) and config/roster. Earlier results are in
//  config/history, read once when a voter taps "Show earlier results".
//  Both are built from the motions alone (never from a laptop's selections or
//  roster names), so two consoles always build the same board.
// ============================================================================
import { sortMotions, tsMillis, localDate } from "./count.js";

const SIZE_CAP = 600000;   // characters of JSON; Firestore's limit is 1 MiB per document

// Canonical form for comparing two boards: keys sorted, undefined dropped, and
// every time field left out (any key ending in "At"), because times change
// nothing voters act on and the server fills them in later.
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    Object.keys(v).sort().forEach((k) => {
      if (/At$/.test(k) || v[k] === undefined) return;
      out[k] = canonical(v[k]);
    });
    return out;
  }
  return v;
}
export function sameBoard(a, b) { return JSON.stringify(canonical(a || null)) === JSON.stringify(canonical(b || null)); }

const visible = (p) => !p.archived && !p.deleted;
const n = (v) => (v === undefined ? null : v);
// The earlier count of a re-opened motion, in a few fields.
function priorOutcome(p) {
  const pr = p.priorResults || [];
  if (!pr.length) return null;
  const r = pr[pr.length - 1];
  return { outcome: r.outcome, weight: { favour: r.weight.favour, against: r.weight.against },
    rule: { threshold: (r.rule && r.rule.threshold) || "majority", tieRule: (r.rule && r.rule.tieRule) || "tie" } };
}
export function openEntry(p) {
  return {
    id: p.id, number: n(p.number), text: p.text, kind: p.kind || "motion", threshold: p.threshold || "majority",
    rule: n(p.rule), revoteOf: n(p.revoteOf), revoteReason: n(p.revoteReason), round: p.round || 1,
  };
}
export function resultEntry(p, pos, closedAt) {
  return {
    pos, number: n(p.number), text: p.text, kind: p.kind || "motion", threshold: p.threshold || "majority",
    result: p.status === "closed" && p.result ? p.result : null,
    closedAt: closedAt !== undefined ? closedAt : n(p.closedAt),
    revoteOf: n(p.revoteOf), revoteReason: n(p.revoteReason), supersededBy: n(p.supersededBy),
    reopenCount: p.reopenCount || 0, priorOutcome: priorOutcome(p),
  };
}

// When a motion closed, in milliseconds. opts.justClosed is a motion this
// laptop is closing right now (its time is not known yet): it counts as opts.now.
function closedMs(p, opts) {
  if (opts && p.id === opts.justClosed) return opts.now;
  return tsMillis(p.closedAt);
}

// The board. Without meetings: results = the closed, visible motions that
// closed on the same day as the latest one (older ones are in history).
export function buildBoard(polls, meetings, opts = {}) {
  const open = polls.find((p) => p.status === "open" && visible(p)) || null;
  const closed = polls.filter((p) => p.status === "closed" && visible(p) && closedMs(p, opts) !== null);
  let latest = null;
  closed.forEach((p) => { if (latest === null || closedMs(p, opts) > closedMs(latest, opts)) latest = p; });
  const day = latest ? localDate(closedMs(latest, opts)) : null;
  const onBoard = sortMotions(closed.filter((p) => localDate(closedMs(p, opts)) === day));
  const results = {};
  onBoard.forEach((p, i) => { results[p.id] = resultEntry(p, i); });
  const board = { v: 2, meeting: null, open: open ? openEntry(open) : null, results, lastClosedId: latest ? latest.id : null };
  // Size guard: drop the earliest entries past the cap (they are in history).
  let ids = Object.keys(results).sort((a, b) => results[a].pos - results[b].pos);
  while (ids.length && JSON.stringify(board).length > SIZE_CAP) { delete results[ids.shift()]; }
  return board;
}

// History: closed, visible motions with a saved result that are not on the
// board, newest first, capped by size. Built only from data the server has
// confirmed (no pending times), so the array never carries a placeholder.
export function buildHistory(polls, meetings, board) {
  const onBoard = new Set(Object.keys((board && board.results) || {}));
  const list = polls.filter((p) => p.status === "closed" && visible(p) && p.result && !onBoard.has(p.id));
  const t = (p) => tsMillis(p.closedAt) ?? tsMillis(p.createdAt) ?? 0;
  list.sort((a, b) => t(b) - t(a) || String(a.id).localeCompare(String(b.id)));
  const entries = [];
  let size = 60, truncated = false;
  for (const p of list) {
    const e = {
      id: p.id, meetingId: null, meetingTitle: null, meetingDate: localDate(t(p)) || null,
      number: n(p.number), text: String(p.text || "").slice(0, 500), kind: p.kind || "motion",
      result: p.result, revoteOf: n(p.revoteOf), revoteReason: n(p.revoteReason), supersededBy: n(p.supersededBy),
      reopenCount: p.reopenCount || 0, priorOutcome: priorOutcome(p),
    };
    const s = JSON.stringify(e).length + 1;
    if (size + s > SIZE_CAP) { truncated = true; break; }
    size += s;
    entries.push(e);
  }
  return { v: 1, truncated, entries };
}

// Field-path changes that turn board `cur` into board `next`, touching only
// what differs. Each is [path array, value]; value undefined means delete.
// A results entry that already exists is patched key by key and its time
// fields are never touched (a time another action wrote a second ago, still
// pending on this laptop, is never overwritten). timeFor(id) gives a value for
// a NEW entry's closedAt (the server time for the motion being closed).
export function boardPatch(cur, next, timeFor) {
  const c = cur || {};
  const out = [];
  for (const k of ["v", "meeting", "open", "lastClosedId"]) {
    if (!sameBoard(c[k] === undefined ? null : c[k], next[k])) out.push([[k], next[k]]);
  }
  const cr = c.results || {}, nr = next.results || {};
  Object.keys(cr).forEach((id) => { if (!(id in nr)) out.push([["results", id], undefined]); });
  Object.keys(nr).forEach((id) => {
    if (!(id in cr)) {
      const e = { ...nr[id] };
      const t = timeFor ? timeFor(id) : undefined;
      if (t !== undefined) e.closedAt = t;
      out.push([["results", id], e]);
      return;
    }
    const a = cr[id] || {}, b = nr[id];
    new Set([...Object.keys(a), ...Object.keys(b)]).forEach((key) => {
      if (/At$/.test(key)) return;
      if (!sameBoard(a[key] === undefined ? null : a[key], b[key] === undefined ? null : b[key])) {
        out.push([["results", id, key], b[key] === undefined ? undefined : b[key]]);
      }
    });
  });
  return out;
}
