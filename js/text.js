// Text utilities: tokenizing, ORP focus point, HTML escaping, and the demo passage.

// Split text into word tokens, flagging sentence ends + clause pauses for natural pacing.
export function tokenize(text){
  const raw = text.replace(/\s+/g," ").trim();
  if(!raw) return [];
  return raw.split(" ").map(w => ({
    w,
    end: /[.!?…]["')\]]?$/.test(w),
    pause: /[,;:—–)\]]["']?$/.test(w),
  }));
}

// ORP (optimal recognition point) index for a word, ignoring leading punctuation.
export function orpIndex(word){
  const letters = word.replace(/[^A-Za-z0-9]/g,"");
  const L = letters.length || word.length;
  let i;
  if(L<=1) i=0; else if(L<=5) i=1; else if(L<=9) i=2; else if(L<=13) i=3; else i=4;
  let seen=0;
  for(let k=0;k<word.length;k++){
    if(/[A-Za-z0-9]/.test(word[k])){ if(seen===i) return k; seen++; }
  }
  return Math.min(i, word.length-1);
}

export function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

// Short looping passage for the auto-playing hero preview — phrased so the demo also carries the message.
export const HERO = `Every word arrives at one still point. No scanning. No hunting across the line. Your eyes rest while the reading moves. This is what focus feels like.`;

export const DEMO = `Reading is a curious act of magic. We take small marks arranged on a surface and, almost instantly, they bloom into meaning inside the mind. The eye does not glide smoothly across a line; it leaps, pauses, and leaps again, landing on a single point within each word before the brain assembles the rest. Stillpoint borrows that natural anchor. Instead of asking your eyes to chase the text, it brings each word to you and holds it at the very spot your attention already wants to rest. The result feels less like reading and more like remembering — as though the words were already there, waiting to be recognised. Try sliding the speed upward. You will be surprised how much faster you can read when your eyes are allowed to stay perfectly still.`;
