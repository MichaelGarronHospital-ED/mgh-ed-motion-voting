// Module hooks for the rules tests: the page code in ../../js imports Firebase
// from gstatic.com; here those imports go to the shims (real SDK, emulator
// only). The page's own files are loaded as ES modules.
const SHIMS = {
  "firebase-app.js": "./shims/firebase-app.mjs",
  "firebase-firestore.js": "./shims/firebase-firestore.mjs",
  "firebase-auth.js": "./shims/firebase-auth.mjs",
};
export async function resolve(spec, ctx, next) {
  const m = /^https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/(firebase-[a-z]+\.js)$/.exec(spec);
  if (m && SHIMS[m[1]]) return { url: new URL(SHIMS[m[1]], import.meta.url).href, shortCircuit: true };
  if (spec.startsWith("https:")) throw new Error("rules test: no network imports: " + spec);
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (/\/js\/[a-z0-9-]+\.js$/.test(url) && !url.includes("node_modules")) return next(url, { ...ctx, format: "module" });
  return next(url, ctx);
}
