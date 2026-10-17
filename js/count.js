// ============================================================================
//  COUNTING. Pure functions, no Firebase: how ballots become a result.
//  db.js re-exports these and supplies who is in which category.
// ============================================================================

export const CHOICES = ["favour", "against", "abstain"];

// Each name (slug) counts at most once, in the weights and in quorum. The app
// stores a ballot under its own slug and the rules insist on that, but a
// second ballot carrying the same slug under another id (written before the
// rules did, or by hand) must never count twice. The ballot stored under its
// own slug wins; otherwise the first one seen.
// weightOf(vote) gives that ballot's points.
export function tallyVotes(votes, weightOf) {
  const w = { favour: 0, against: 0, abstain: 0 };
  const c = { favour: 0, against: 0, abstain: 0 };
  const eligibleVoters = new Set();
  const seen = new Set();
  let flags = 0, writeIns = 0, counted = 0;
  const ordered = [...votes].sort((a, b) => (b.id === b.slug) - (a.id === a.slug));
  for (const v of ordered) {
    const key = v.slug !== undefined ? v.slug : v.id;
    if (seen.has(key)) continue;
    seen.add(key);
    counted += 1;
    const ew = weightOf(v);
    if (CHOICES.includes(v.choice)) { w[v.choice] += ew; c[v.choice] += 1; }
    if (ew > 0) eligibleVoters.add(key);
    if (v.flagged) flags += 1;
    if (v.isWriteIn) writeIns += 1;
  }
  return {
    weight: w, count: c,
    totalVotes: counted,
    quorumCount: eligibleVoters.size,   // distinct eligible voters who voted
    flags, writeIns,
  };
}

// ---- rules for counting (voting upgrade, step 1) ---------------------------
// LEGACY_RULE is how every motion was counted before rules were saved with each
// motion: 1 / 0.5 / 0 points, quorum 50% rounded up, more points in favour than
// against passes, a tie is "Tie". Any motion without its own `rule` snapshot
// (old motions, the phones' fallback count) is counted with it, never with
// today's settings. DEFAULT_RULE is what applies when no settings are saved.
export const LEGACY_RULE = Object.freeze({
  v: 1, weights: Object.freeze({ "1": 1, "2": 0.5, courtesy: 0 }), quorumPercent: 50,
  threshold: "majority", tieRule: "tie",
});
export const DEFAULT_RULE = LEGACY_RULE;
export function copyRule(r) { return JSON.parse(JSON.stringify(r)); }

// The rule a new motion would open with under these settings (null = none saved).
export function ruleFromSettings(settings, threshold) {
  const s = settings || {};
  const base = copyRule(DEFAULT_RULE);
  if (s.weights) base.weights = { "1": s.weights["1"], "2": s.weights["2"], courtesy: s.weights.courtesy };
  if (Number.isInteger(s.quorumPercent)) base.quorumPercent = s.quorumPercent;
  if (s.tieRule) base.tieRule = s.tieRule;
  base.threshold = threshold || s.threshold || base.threshold;
  return base;
}
// Defaults for fields older motions do not have.
export function motionShape(poll) {
  const p = poll || {};
  return { kind: p.kind || "motion", threshold: p.threshold || "majority", meetingId: p.meetingId || null };
}
// Which rule counts this motion: closed with a saved result = the result's own;
// opened = the snapshot taken when it first opened; opened before snapshots
// existed = LEGACY_RULE; a draft = today's settings with its own pass rule.
export function ruleFor(poll, settings) {
  if (poll && poll.status === "closed" && poll.result && poll.result.rule) return poll.result.rule;
  if (poll && poll.rule) return poll.rule;
  if (poll && poll.status && poll.status !== "draft") return LEGACY_RULE;
  return ruleFromSettings(settings, poll && poll.threshold);
}

// Points are added in hundredths, as whole numbers, so 0.5 + 0.5 + ... never drifts.
export function units(x) { return Math.round(Number(x || 0) * 100); }
// Points for one vote in a category; a category missing from the rule counts 0.
export function weightIn(rule, group) {
  const w = rule && rule.weights && Object.prototype.hasOwnProperty.call(rule.weights, group) ? rule.weights[group] : 0;
  return typeof w === "number" && w > 0 ? w : 0;
}
// Quorum needed: quorumPercent of eligible voters, rounded up (50% of 48 = 24).
export function quorumNeededFor(eligible, quorumPercent) {
  return Math.floor((eligible * quorumPercent + 99) / 100);
}

// A motion's tally under a rule. groupOf(vote) gives that ballot's category.
export function tallyMotion(votes, groupOf, rule) {
  const wu = { favour: 0, against: 0, abstain: 0 };
  const t = tallyVotes(votes, (v) => {
    const u = units(weightIn(rule, groupOf(v)));
    if (CHOICES.includes(v.choice)) wu[v.choice] += u;
    return u / 100;
  });
  t.weight = { favour: wu.favour / 100, against: wu.against / 100, abstain: wu.abstain / 100 };
  t.units = wu;
  return t;
}

// pass | fail | tie | noq. No quorum always wins. Majority: more points in
// favour than against; equal is a tie (0 and 0 too). Two-thirds: at least two
// thirds of the points for or against (abstentions not counted); exactly two
// thirds passes; equal points, or none at all, fail (never a tie).
export function decide(t, rule, quorumNeeded) {
  if (t.quorumCount < quorumNeeded) return "noq";
  const f = t.units ? t.units.favour : units(t.weight.favour);
  const a = t.units ? t.units.against : units(t.weight.against);
  if ((rule && rule.threshold) === "twoThirds") return f + a > 0 && 3 * f >= 2 * (f + a) ? "pass" : "fail";
  return f > a ? "pass" : f < a ? "fail" : "tie";
}

// The full result of a motion from its ballots. ctx supplies who is in which
// category today: { groupOf(slug), liveEligible(rule), settings }.
// A closed motion with frozen categories (lockedGroups) uses those.
export function computeResult(poll, votes, ctx) {
  const rule = ruleFor(poll, ctx.settings);
  const frozen = poll.status === "closed" && poll.lockedGroups ? poll.lockedGroups : null;
  const groupOf = (v) => (frozen && Object.prototype.hasOwnProperty.call(frozen, v.slug) ? frozen[v.slug] : ctx.groupOf(v.slug));
  const eligible = frozen
    ? Object.values(frozen).filter((g) => weightIn(rule, g) > 0).length
    : ctx.liveEligible(rule);
  const quorumNeeded = quorumNeededFor(eligible, rule.quorumPercent);
  if ((poll.kind || "motion") === "choice") return computeChoice(poll, votes, groupOf, rule, eligible, quorumNeeded);
  const t = tallyMotion(votes, groupOf, rule);
  return {
    v: 1, kind: "motion",
    outcome: decide(t, rule, quorumNeeded),
    weight: t.weight, count: t.count,
    totalVotes: t.totalVotes, quorumCount: t.quorumCount, quorumNeeded, eligible,
    writeIns: t.writeIns, flags: t.flags,
    rule: copyRule(rule),
  };
}

// ---- questions and elections (voting upgrade, step 6) -------------------------------
// A ballot picks up to `seats` options (or abstains). Each pick adds the voter's
// full points to that option. Options are ranked by points. Winners are the
// top `seats` options with more than 0 points; an option with 0 points never
// wins. "tie" only when an option outside the top `seats` has the same points
// as the last winner (options level with each other but all inside the
// winners are simply winners). Fewer options with points than seats: decided,
// with fewer winners and a note. No option with points: "none". "More than half"
// (one pick): the leader needs over half of the points cast for options
// (abstentions not counted), else "noMajority". No quorum always wins.
export function tallyChoice(votes, groupOf, rule, poll) {
  const opts = (poll.options || []).map((o) => ({ id: o.id, label: o.label, u: 0, count: 0 }));
  const byId = Object.fromEntries(opts.map((o) => [o.id, o]));
  const abst = { u: 0, count: 0 };
  const t = tallyVotes(votes, (v) => {
    const u = units(weightIn(rule, groupOf(v)));
    if (v.choice === "abstain") { abst.u += u; abst.count += 1; }
    else if (v.choice === "pick" && Array.isArray(v.picks)) {
      [...new Set(v.picks)].forEach((id) => { if (byId[id]) { byId[id].u += u; byId[id].count += 1; } });
    }
    return u / 100;
  });
  return { t, opts, abst };
}
function computeChoice(poll, votes, groupOf, rule, eligible, quorumNeeded) {
  const { t, opts, abst } = tallyChoice(votes, groupOf, rule, poll);
  const seats = Math.max(1, poll.seats || 1);
  const ranked = opts.map((o, i) => ({ ...o, i })).sort((a, b) => b.u - a.u || a.i - b.i);
  const scoring = ranked.filter((o) => o.u > 0);
  let outcome, winners = [], tied = [], note = "";
  if (t.quorumCount < quorumNeeded) outcome = "noq";
  else if (!scoring.length) outcome = "none";
  else if (scoring.length <= seats) {
    outcome = "decided"; winners = scoring.map((o) => o.id);
    if (scoring.length < seats) note = `Only ${scoring.length} option${scoring.length === 1 ? "" : "s"} received points.`;
  } else {
    const last = scoring[seats - 1].u;
    if (scoring[seats].u === last) {
      outcome = "tie";
      winners = scoring.filter((o) => o.u > last).map((o) => o.id);
      tied = scoring.filter((o) => o.u === last).map((o) => o.id);
    } else {
      outcome = "decided"; winners = scoring.slice(0, seats).map((o) => o.id);
    }
  }
  const cast = opts.reduce((n, o) => n + o.u, 0);
  if (outcome === "decided" && seats === 1 && rule.threshold === "majority" && !(scoring[0].u * 2 > cast)) {
    outcome = "noMajority"; winners = [];
  }
  return {
    v: 1, kind: "choice", seats, style: poll.style || "question", outcome,
    options: ranked.map((o) => ({ id: o.id, label: o.label, weight: o.u / 100, count: o.count })),
    abstain: { weight: abst.u / 100, count: abst.count }, winners, tied, note,
    weight: { favour: 0, against: 0, abstain: abst.u / 100 }, count: { favour: 0, against: 0, abstain: abst.count },
    totalVotes: t.totalVotes, quorumCount: t.quorumCount, quorumNeeded, eligible,
    writeIns: t.writeIns, flags: t.flags, rule: copyRule(rule),
  };
}
// "Dr A and Dr B", "Dr A, Dr B and Dr C".
function andList(xs) { return xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`; }
function choiceWords(r) {
  const label = (id) => ((r.options || []).find((o) => o.id === id) || {}).label || id;
  const election = r.style === "election";
  switch (r.outcome) {
    case "decided": return `${election ? "Elected" : "Chosen"}: ${(r.winners || []).map(label).join(", ")}`;
    case "tie": return (r.winners || []).length || (r.seats || 1) > 1
      ? `Tie for the last seat: ${andList((r.tied || []).map(label))}` : `Tie for first place: ${andList((r.tied || []).map(label))}`;
    case "noMajority": return `No option has more than half. ${label((r.options || [])[0] && r.options[0].id)} leads.`;
    case "none": return "No choice made";
    case "noq": return "No quorum";
    default: return "";
  }
}

// The words for an outcome, always from the result's own rule (never today's
// settings). audience: "console" (present tense) or "voter" / "record" (past).
export function outcomeWords(result, audience = "voter") {
  if (result && result.kind === "choice") return choiceWords(result);
  const now = audience === "console";
  const r = (result && result.rule) || LEGACY_RULE;
  const two = r.threshold === "twoThirds";
  switch (result && result.outcome) {
    case "pass": return now ? "Passes" : "Passed";
    case "fail":
      if (two && result.weight && units(result.weight.favour) + units(result.weight.against) === 0)
        return now ? "Does not pass: no points for or against" : "Did not pass: no points for or against";
      if (two) return now ? "Does not pass (needs two-thirds)" : "Did not pass (needed two-thirds)";
      return now ? "Does not pass" : "Did not pass";
    case "tie": return r.tieRule === "fails" ? "Tie: does not pass" : "Tie";
    case "noq": return now ? "No quorum: cannot pass" : "No quorum";
    default: return "";
  }
}
// The verdict style (pass | fail | tie | noq) for an outcome.
export function outcomeKind(result) {
  const o = result && result.outcome;
  return o === "pass" || o === "decided" ? "pass" : o === "fail" || o === "none" ? "fail" : o === "tie" || o === "noMajority" ? "tie" : "noq";
}

// ---- times -------------------------------------------------------------------
// A stored time as milliseconds (Firestore Timestamp, the test stub's plain
// copy, or a number), or null when missing or still pending.
export function tsMillis(t) {
  if (t === null || t === undefined) return null;
  if (typeof t === "number") return t;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.seconds === "number") return t.seconds * 1000 + Math.floor((t.nanoseconds || 0) / 1e6);
  return null;
}
export function sameTime(a, b) { return tsMillis(a) === tsMillis(b); }
// "12:14" in the device's local time.
export function clockTime(t) {
  const ms = tsMillis(t);
  if (ms === null) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
// Local calendar date YYYY-MM-DD of a stored time.
export function localDate(t) {
  const ms = tsMillis(t);
  if (ms === null) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- order ---------------------------------------------------------------------
// Everywhere motions are listed or numbered: by meeting date (a motion with no
// meeting uses the date it was added), then agenda order, then closing time,
// then when it was added. meetings: { id: { date } } (optional).
export function sortMotions(polls, meetings) {
  const m = meetings || {};
  const dateOf = (p) => (p.meetingId && m[p.meetingId] && m[p.meetingId].date) || localDate(p.createdAt) || "";
  const num = (x) => (x === null || x === undefined ? Infinity : x);
  return [...polls].sort((a, b) =>
    dateOf(a).localeCompare(dateOf(b))
    || (a.order || 0) - (b.order || 0)
    || num(tsMillis(a.closedAt)) - num(tsMillis(b.closedAt))
    || num(tsMillis(a.createdAt)) - num(tsMillis(b.createdAt)));
}

// ---- pasting the physician list (voting upgrade, step 3) -----------------------
// Category words people use: Full / Full vote / 1 / Group 1; Half / Half vote /
// 2 / Group 2; No vote / Courtesy / 0.
const CAT_WORDS = {
  "full": "1", "full vote": "1", "1": "1", "group 1": "1", "group1": "1",
  "half": "2", "half vote": "2", "2": "2", "group 2": "2", "group2": "2", "0.5": "2",
  "no vote": "courtesy", "courtesy": "courtesy", "0": "courtesy", "none": "courtesy",
};
export function categoryWord(w) {
  const k = String(w || "").trim().toLowerCase().replace(/\s+/g, " ");
  return Object.prototype.hasOwnProperty.call(CAT_WORDS, k) ? CAT_WORDS[k] : null;
}
const slugOf = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// "Reynolds, Megan" becomes "Megan Reynolds".
function tidyName(n) {
  let s = String(n || "").replace(/\s+/g, " ").trim();
  const m = /^([^,]+),\s*(.+)$/.exec(s);
  if (m) s = `${m[2].trim()} ${m[1].trim()}`;
  return s;
}
// Same surname, and one first name starts the other (Meg / Megan): likely one person.
function looksAlike(a, b) {
  const pa = a.toLowerCase().split(" "), pb = b.toLowerCase().split(" ");
  if (pa.length < 2 || pb.length < 2 || pa[pa.length - 1] !== pb[pb.length - 1]) return false;
  const fa = pa[0], fb = pb[0];
  return fa !== fb && fa.length >= 3 && fb.length >= 3 && (fa.startsWith(fb.slice(0, 3)) || fb.startsWith(fa.slice(0, 3)));
}

// Read a pasted list (from Excel: two columns; or lines "Name, category") and
// compare it with the list in use. roster: [{ name, slug, group }] (today's
// list, removed people left out). same: { pastedSlug: existingSlug | "new" }
// answers to "same person?". Returns the preview:
//   added [{name, slug, group}], changed [{name, slug, from, to}], unchanged [names],
//   missing [{name, slug}] (in the list but not pasted), problems [{line, text, kind, ...}].
export function parseRoster(text, roster, same = {}) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = { added: [], changed: [], unchanged: [], missing: [], problems: [], tooMany: lines.length > 300 };
  const bySlug = {};
  roster.forEach((p) => { bySlug[p.slug] = p; });
  const seen = {};
  lines.slice(0, 300).forEach((line, i) => {
    let name, cat = null, catText = "";
    if (line.includes("\t")) {
      const cols = line.split("\t").map((c) => c.trim()).filter(Boolean);
      name = cols[0] || ""; catText = cols[1] || "";
    } else {
      const parts = line.split(",").map((c) => c.trim());
      if (parts.length > 1 && categoryWord(parts[parts.length - 1])) { catText = parts.pop(); }
      name = parts.join(", ");
    }
    if (catText) {
      cat = categoryWord(catText);
      if (!cat) { out.problems.push({ line: i + 1, text: line, kind: "unclear", msg: "Line not understood" }); return; }
    }
    name = tidyName(name);
    const slug = slugOf(name);
    if (!slug || !/[a-z]/i.test(name) || name.length < 3) { out.problems.push({ line: i + 1, text: line, kind: "unclear", msg: "Line not understood" }); return; }
    if (seen[slug]) { out.problems.push({ line: i + 1, text: line, kind: "twice", msg: `Listed twice: ${name}` }); return; }
    seen[slug] = true;
    let target = bySlug[slug];
    if (!target && same[slug] && same[slug] !== "new" && bySlug[same[slug]]) { target = bySlug[same[slug]]; seen[target.slug] = true; }
    if (target) {
      seen[target.slug] = true;
      if (cat && cat !== target.group) out.changed.push({ name: target.name, slug: target.slug, from: target.group, to: cat });
      else out.unchanged.push(target.name);
      return;
    }
    const alike = same[slug] === "new" ? null : roster.find((p) => looksAlike(p.name, name));
    if (alike) { out.problems.push({ line: i + 1, text: line, kind: "alike", msg: `Looks like ${alike.name}: same person?`, slug, other: alike.slug, name }); return; }
    if (!cat) { out.problems.push({ line: i + 1, text: line, kind: "nocat", msg: `No category for a new name: ${name}` }); return; }
    out.added.push({ name, slug, group: cat });
  });
  roster.forEach((p) => { if (!seen[p.slug]) out.missing.push({ name: p.name, slug: p.slug }); });
  return out;
}

// ---- agendas (voting upgrade, step 4) ---------------------------------------------
// A meeting's motions in agenda order, numbered 1, 2, 2a, 2a.1, 3: main motions
// by `order`, each followed by its amendments (`amends` = the motion they
// change), each followed by amendments to that amendment (two levels at most).
// Returns [{ poll, number, depth, parent }] (deleted motions left out).
const letters = (i) => (i < 26 ? String.fromCharCode(97 + i) : letters(Math.floor(i / 26) - 1) + String.fromCharCode(97 + (i % 26)));
export function agendaOrder(polls) {
  const list = polls.filter((p) => !p.deleted);
  const ids = new Set(list.map((p) => p.id));
  const byOrder = (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)
    || (tsMillis(a.createdAt) ?? 0) - (tsMillis(b.createdAt) ?? 0) || String(a.id).localeCompare(String(b.id));
  const kids = (id) => list.filter((p) => p.amends === id).sort(byOrder);
  const out = [];
  list.filter((p) => !p.amends || !ids.has(p.amends)).sort(byOrder).forEach((m, i) => {
    const n = String(i + 1);
    out.push({ poll: m, number: n, depth: 0, parent: null });
    kids(m.id).forEach((a, j) => {
      const an = n + letters(j);
      out.push({ poll: a, number: an, depth: 1, parent: m.id });
      kids(a.id).forEach((b, k) => out.push({ poll: b, number: `${an}.${k + 1}`, depth: 2, parent: a.id }));
    });
  });
  return out;
}
export function agendaNumbers(polls) {
  const out = {};
  agendaOrder(polls).forEach((r) => { out[r.poll.id] = r.number; });
  return out;
}

// Read a pasted agenda: one motion per line. Leading numbering and bullets
// ("1.", "2)", "a.", "-", "*") are removed; a line starting with "Amendment"
// amends the motion above it, "Amendment to the amendment" the amendment above
// that. Blank lines are ignored; up to 50 lines.
// Returns { rows: [{ text, depth, parent (row index), number, problem }], tooMany }.
export function parseAgenda(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  let lastMain = -1, lastAmend = -1, mains = 0, amendCount = 0, subCount = 0;
  lines.slice(0, 50).forEach((raw) => {
    let t = raw.replace(/^(?:\(?(?:\d+|[a-zA-Z])[.)]|[-*•])\s+/, "").trim();
    let depth = 0;
    if (/^amendment to the amendment\b/i.test(t)) depth = 2;
    else if (/^amendment\b/i.test(t)) depth = 1;
    const row = { text: t, depth, parent: null, number: "", problem: null };
    if (t.replace(/^amendment( to the amendment)?\b[:\s-]*/i, "").length < 3) row.problem = "Too short";
    if (depth === 0) {
      mains += 1; amendCount = 0; lastMain = rows.length; lastAmend = -1;
      row.number = String(mains);
    } else if (depth === 1) {
      if (lastMain < 0) row.problem = row.problem || "Amendment with no motion above it";
      else { row.parent = lastMain; row.number = rows[lastMain].number + letters(amendCount); amendCount += 1; subCount = 0; lastAmend = rows.length; }
    } else {
      if (lastAmend < 0) row.problem = row.problem || "Amendment to an amendment with no amendment above it";
      else { row.parent = lastAmend; subCount += 1; row.number = `${rows[lastAmend].number}.${subCount}`; }
    }
    rows.push(row);
  });
  return { rows, tooMany: lines.length > 50 };
}
// Today's local date as YYYY-MM-DD (meeting dates are local text, so time
// zones never shift them).
export function todayLocal() { return localDate(Date.now()); }
