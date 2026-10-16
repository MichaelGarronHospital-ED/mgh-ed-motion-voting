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
