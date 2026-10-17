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
  const t = tallyMotion(votes, groupOf, rule);
  const eligible = frozen
    ? Object.values(frozen).filter((g) => weightIn(rule, g) > 0).length
    : ctx.liveEligible(rule);
  const quorumNeeded = quorumNeededFor(eligible, rule.quorumPercent);
  return {
    v: 1, kind: "motion",
    outcome: decide(t, rule, quorumNeeded),
    weight: t.weight, count: t.count,
    totalVotes: t.totalVotes, quorumCount: t.quorumCount, quorumNeeded, eligible,
    writeIns: t.writeIns, flags: t.flags,
    rule: copyRule(rule),
  };
}

// The words for an outcome, always from the result's own rule (never today's
// settings). audience: "console" (present tense) or "voter" / "record" (past).
export function outcomeWords(result, audience = "voter") {
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
  return o === "pass" || o === "decided" ? "pass" : o === "fail" || o === "noMajority" || o === "none" ? "fail" : o === "tie" ? "tie" : "noq";
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
