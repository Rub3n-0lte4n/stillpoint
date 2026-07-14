// Pure patron logic — no DOM, unit-testable.
// Patronage is an honor system: a one-time Stripe payment whose receipt carries an
// unlock code. The code is verified against a SHA-256 hash so the public repo never
// contains the plaintext. Themes are cosmetic; the core reader stays free for everyone.

export const PATRON_LINK = "https://buy.stripe.com/eVq8wPaCMgcD1WVeSu7N604";

// Reading themes. "midnight" is the free default; the rest are patron-only.
// Each id maps to an html[data-theme] token-override block in styles.css.
export const THEMES = [
  { id:"midnight", name:"Midnight" },
  { id:"ember",    name:"Ember Atelier" },
  { id:"garden",   name:"Night Garden" },
  { id:"abyss",    name:"Abyss" },
  { id:"tokyo",    name:"Tokyo Night" },
];

export function themeById(id){ return THEMES.find(t=>t.id===id) || THEMES[0]; }
export function isPatronTheme(id){ return themeById(id).id !== "midnight"; }

// Case/punctuation-insensitive: "there-the-dance-is" === "THERE THE DANCE IS".
export function normalizeCode(s){ return String(s||"").toUpperCase().replace(/[^A-Z]/g,""); }

const CODE_HASH = "66e6dca31f8e1326a3243aa1437df57f55bdb66586ab8f0415335959ca5d5591";

export async function verifyPatronCode(input, subtle){
  const s = subtle || (globalThis.crypto && globalThis.crypto.subtle);
  if(!s) return false;                     // non-secure context — cannot verify
  const bytes = new TextEncoder().encode(normalizeCode(input));
  const digest = await s.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
  return hex === CODE_HASH;
}
