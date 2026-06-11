// ============================================================================
//  ROSTER — assignments taken from "MGH ED VOTING SHEET.xlsx" (2026-06-11).
//
//    GROUP1   = 1 point per vote   (Active staff, 8+ shifts/month) — 34 voters
//    GROUP2   = ½ point per vote   (Active <8 shifts / Provisional / secondary) — 14 voters
//    COURTESY = no vote            (on the team roster but NOT on the voting sheet) — 26
//
//  Eligible to vote (Group 1 + Group 2) = 48  →  50% = 24  →  quorum = 24.
//  (Courtesy list pending confirmation by leadership; some may move to Group 1/2.)
//
//  ⚠️ NAME NOTES (voting sheet vs Teams list) — confirm these are the same people
//  and that the displayed name is what each person will look for:
//    • "Meg Reynolds"         — sheet "Reynolds, Megan"
//    • "Kyle Vojdani"         — sheet "Vojdani, Omid Kyle"
//    • "Indy Sahota"          — sheet "Sahota, Inderjeet"
//    • "Rob Soegtrop"         — sheet "Soegtrop, Robert"
//    • "Rey Kishmiri"         — sheet "Keshmiri, Rey"
//    • "David Smith"          — sheet "Smith, David J"
//    • "Karen Ho"             — sheet "Ho, Karen Cin Ting"
//    • "Salvatore Sirna"      — on the voting sheet but was NOT in the Teams list
// ============================================================================

export const GROUP1 = [
  "Adam Kaufman",
  "Alvin Yang",
  "Andrew Shum",
  "Angela Marrocco",
  "Brendan McCullough",
  "Brittany Cameron",
  "Cristina Pastia",
  "David Phillips",
  "David Rosenstein",
  "David Sheps",
  "David Smith",
  "George Porfiris",
  "Jason Lam",
  "Jefferson Hayre",
  "Karen Ho",
  "Kasia Stefanski",
  "Kate Lazier",
  "Kristin Malcolm",
  "Kyle Vojdani",
  "Lingli Ma",
  "Lisa Ballinger",
  "Manpreet Lamba",
  "Marlee Klaiman",
  "Meg Reynolds",
  "Michael Charnish",
  "Muneesh Jha",
  "Nadia Incardona",
  "Rajani Vairavanathan",
  "Ruchi Mohindra",
  "Salvatore Sirna",
  "Tania Philip",
  "Tom Klosek",
  "Walter Himmel",
  "Zachary Hickey",
];

export const GROUP2 = [
  "Aran Balachandran",
  "David Ng",
  "Eileen Cheung",
  "Francis Sem",
  "Indy Sahota",
  "James Fairbairn",
  "Mazen Jazi",
  "Nadia Primiani",
  "Natalie Mamen",
  "Rakesh Kumar",
  "Rey Kishmiri",
  "Rob Soegtrop",
  "Russell Bahar",
  "Santosh Kanjeekal",
];

export const COURTESY = [
  "Adil Shamji",
  "Alex Chan",
  "Alx Florea",
  "Andrea Lo",
  "Andrew Maeng",
  "Brandon Lam",
  "Dan Tsoy",
  "Diana",
  "Fatemeh Bakhtiari",
  "Fraser Kegel",
  "Henry Becker",
  "Jane Wang",
  "Justin Losier",
  "Lucas Mastropaolo",
  "Luke Kyne",
  "Maria Leis",
  "Matthew Skelly",
  "Nicole Falzone",
  "Nima Farkhani",
  "Rana Kamhawy",
  "Rebecca Chang",
  "Ryan Gotesman",
  "Sara Brade",
  "Sebastian Przech",
  "Vivian Tam",
  "Yusuf Malik",
];

// ---- derived helpers (no need to edit below) -------------------------------

export const WEIGHTS = { 1: 1, 2: 0.5, courtesy: 0 };

export function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Build a flat, sorted roster with group + weight on each entry.
export const ROSTER = [
  ...GROUP1.map((n) => ({ name: n, group: "1", weight: 1 })),
  ...GROUP2.map((n) => ({ name: n, group: "2", weight: 0.5 })),
  ...COURTESY.map((n) => ({ name: n, group: "courtesy", weight: 0 })),
]
  .map((p) => ({ ...p, slug: slugify(p.name) }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const ROSTER_BY_SLUG = Object.fromEntries(ROSTER.map((p) => [p.slug, p]));

// Number of eligible voters (weight > 0) — used to show "50% of eligible".
export const ELIGIBLE_COUNT = ROSTER.filter((p) => p.weight > 0).length;
