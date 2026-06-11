// ============================================================================
//  ROSTER — assign every physician to a group.
//  Just move names between the three lists below. That's the only edit needed.
//
//    GROUP1   = 1 point per vote   (Active staff, 8+ shifts/month)
//    GROUP2   = ½ point per vote   (Active <8 shifts, Provisional active,
//                                   Active secondary site)
//    COURTESY = no vote            (recorded for transparency, weight 0)
//
//  NOTE: Everyone is currently in GROUP1. Cut/paste names into GROUP2 or
//  COURTESY as needed. Anyone not listed who votes is treated as a write-in
//  (weight 0 until leadership assigns one in the admin "Voters" table).
// ============================================================================

export const GROUP1 = [
  "Adam Kaufman",
  "Adil Shamji",
  "Alex Chan",
  "Alvin Yang",
  "Alx Florea",
  "Amanda Fitzgibbon",
  "Andrea Lo",
  "Andrew Maeng",
  "Andrew Shum",
  "Angela Marrocco",
  "Aran Balachandran",
  "Brandon Lam",
  "Brendan McCullough",
  "Brittany Cameron",
  "Cristina Pastia",
  "Dan Tsoy",
  "David Ng",
  "David Phillips",
  "David Rosenstein",
  "David Sheps",
  "David Smith",
  "Diana",
  "Eileen Cheung",
  "Fatemeh Bakhtiari",
  "Francis Sem",
  "Fraser Kegel",
  "George Porfiris",
  "Henry Becker",
  "Indy Sahota",
  "Jack Hickey",
  "James Fairbairn",
  "Jane Wang",
  "Jason Lam",
  "Jefferson Hayre",
  "Justin Losier",
  "Karen Ho",
  "Kasia Stefanski",
  "Kate Lazier",
  "Kristin Malcolm",
  "Kyle Vojdani",
  "Lingli Ma",
  "Lisa Ballinger",
  "Lucas Mastropaolo",
  "Luke Kyne",
  "Manpreet Lamba",
  "Maria Leis",
  "Marlee Klaiman",
  "Matthew Skelly",
  "Mazen Jazi",
  "Meg Reynolds",
  "Michael Charnish",
  "Muneesh Jha",
  "Nadia Incardona",
  "Nadia Primiani",
  "Natalie Mamen",
  "Nicole Falzone",
  "Nima Farkhani",
  "Rajani Vairavanathan",
  "Rakesh Kumar",
  "Rana Kamhawy",
  "Rebecca Chang",
  "Rey Kishmiri",
  "Rob Soegtrop",
  "Ruchi Mohindra",
  "Russell Bahar",
  "Ryan Gotesman",
  "Santosh Kanjeekal",
  "Sara Brade",
  "Sebastian Przech",
  "Tania Philip",
  "Tom Klosek",
  "Vivian Tam",
  "Walter Himmel",
  "Yusuf Malik",
];

export const GROUP2 = [
  // ½ point per vote — e.g. "Jane Doe",
];

export const COURTESY = [
  // no vote — e.g. "John Doe",
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
