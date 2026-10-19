// ============================================================================
//  VOTERS' BOARD. Pure functions, no Firebase.
//
//  Phones listen to two small documents only: config/live (the board: what is
//  open, and this meeting's results) and config/roster. Earlier results are in
//  config/history, read once when a voter taps "Show earlier results".
//  Both are built from the motions alone (never from a laptop's selections or
//  roster names), so two consoles always build the same board.
// ============================================================================
import { sortMotions, tsMillis, localDate, agendaOrder } from "./count.js?v=voting-13";

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
export function openEntry(p, number, main) {
  const e = {
    id: p.id, number: n(number !== undefined ? number : p.number), text: p.text, kind: p.kind || "motion", threshold: p.threshold || "majority",
    rule: n(p.rule), revoteOf: n(p.revoteOf), revoteReason: n(p.revoteReason), round: p.round || 1,
  };
  if (p.kind === "choice") { e.options = p.options || []; e.optionIds = p.optionIds || []; e.seats = p.seats || 1; e.style = p.style || "question"; }
  if (main) { e.amendsNumber = n(main.number); e.amendsText = String(main.text || "").slice(0, 2000); }
  return e;
}
export function resultEntry(p, pos, number) {
  const e = {
    pos, number: n(number !== undefined ? number : p.number), text: p.text, kind: p.kind || "motion", threshold: p.threshold || "majority",
    result: p.status === "closed" && p.result ? p.result : null,
    closedAt: n(p.closedAt),
    revoteOf: n(p.revoteOf), revoteReason: n(p.revoteReason), supersededBy: n(p.supersededBy),
    reopenCount: p.reopenCount || 0, priorOutcome: priorOutcome(p),
  };
  if (p.kind === "choice") {
    e.seats = p.seats || 1; e.style = p.style || "question";
    if (!e.result) e.options = p.options || [];     // labels only until the result (which has them) is saved
  }
  return e;
}

// When a motion closed, in milliseconds. opts.justClosed is a motion this
// laptop is closing right now (its time is not known yet): it counts as opts.now.
function closedMs(p, opts) {
  if (opts && p.id === opts.justClosed) return opts.now;
  return tsMillis(p.closedAt);
}

const visibleMeeting = (m) => m && !m.archived && !m.deleted;
// The meeting voters see: the open one; else the one that ended last.
// Archived and trashed meetings never qualify.
export function boardMeeting(meetings) {
  const ms = (meetings || []).filter(visibleMeeting);
  const open = ms.find((m) => m.status === "open");
  if (open) return open;
  let best = null;
  ms.filter((m) => m.status === "closed" && tsMillis(m.endedAt) !== null).forEach((m) => {
    if (!best || tsMillis(m.endedAt) > tsMillis(best.endedAt)) best = m;
  });
  return best;
}
// Agenda numbers of every motion, per meeting.
function numbersFor(polls) {
  const byMeeting = {};
  polls.forEach((p) => { if (p.meetingId) (byMeeting[p.meetingId] = byMeeting[p.meetingId] || []).push(p); });
  const nums = {}, rows = {};
  Object.values(byMeeting).forEach((list) => agendaOrder(list).forEach((r, i) => { nums[r.poll.id] = r.number; rows[r.poll.id] = i; }));
  return { nums, rows };
}

// The board. With meetings: that meeting's closed motions, by agenda position.
// Without any meeting (motions made before meetings existed): the closed
// motions that closed on the same day as the latest one (older ones are in
// history). opts.justClosed: a motion being closed right now (time: opts.now).
export function buildBoard(polls, meetings, opts = {}) {
  const ms = meetings || [];
  const { nums, rows } = numbersFor(polls);
  const byId = Object.fromEntries(polls.map((p) => [p.id, p]));
  const open = polls.find((p) => p.status === "open" && visible(p)) || null;
  const m = boardMeeting(ms);
  const closed = polls.filter((p) => p.status === "closed" && visible(p) && closedMs(p, opts) !== null);
  let latest = null;
  closed.forEach((p) => { if (latest === null || closedMs(p, opts) > closedMs(latest, opts)) latest = p; });
  let onBoard;
  if (m) {
    onBoard = polls.filter((p) => p.status === "closed" && visible(p) && p.meetingId === m.id)
      .sort((a, b) => (rows[a.id] ?? 0) - (rows[b.id] ?? 0));
  } else {
    const pool = closed.filter((p) => !ms.length || !p.meetingId);
    let last = null;
    pool.forEach((p) => { if (last === null || closedMs(p, opts) > closedMs(last, opts)) last = p; });
    const day = last ? localDate(closedMs(last, opts)) : null;
    onBoard = sortMotions(pool.filter((p) => localDate(closedMs(p, opts)) === day));
  }
  const results = {};
  onBoard.forEach((p, i) => { results[p.id] = resultEntry(p, i, nums[p.id]); });
  const main = open && open.amends && byId[open.amends] ? { number: nums[open.amends] ?? byId[open.amends].number, text: byId[open.amends].text } : null;
  const board = {
    v: 2,
    meeting: m ? { id: m.id, title: m.title || "", date: m.date || "", status: m.status || "planned", checkIn: m.checkIn === true } : null,
    open: open ? openEntry(open, nums[open.id], main) : null,
    results, lastClosedId: latest ? latest.id : null,
  };
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
  const mById = Object.fromEntries((meetings || []).map((m) => [m.id, m]));
  const { nums } = numbersFor(polls);
  const list = polls.filter((p) => p.status === "closed" && visible(p) && p.result && !onBoard.has(p.id));
  const t = (p) => tsMillis(p.closedAt) ?? tsMillis(p.createdAt) ?? 0;
  list.sort((a, b) => t(b) - t(a) || String(a.id).localeCompare(String(b.id)));
  const entries = [];
  let size = 60, truncated = false;
  for (const p of list) {
    const e = {
      id: p.id, meetingId: n(p.meetingId && mById[p.meetingId] ? p.meetingId : null),
      meetingTitle: p.meetingId && mById[p.meetingId] ? mById[p.meetingId].title || "" : null,
      meetingDate: (p.meetingId && mById[p.meetingId] && mById[p.meetingId].date) || localDate(t(p)) || null,
      number: n(nums[p.id] !== undefined ? nums[p.id] : p.number), text: String(p.text || "").slice(0, 500), kind: p.kind || "motion",
      seats: p.kind === "choice" ? p.seats || 1 : null, style: p.kind === "choice" ? p.style || "question" : null,
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
