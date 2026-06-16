// Dependency-free reimplementation of the web-haptics API (github.com/lochie/web-haptics, MIT),
// vendored to keep the app buildless, CSP-locked and offline-capable.
// Uses the Vibration API where available, and the iOS Safari <input switch> toggle trick elsewhere.
const patterns = { light:[12], success:[35,55,35], nudge:[55,35,18], error:[28,40,28,40,28], buzz:[200] };
const canVibrate = typeof navigator!=="undefined" && typeof navigator.vibrate==="function";
let iosToggle = null;

function ensureIOS(){
  if(iosToggle || !document.body) return iosToggle;
  const label = document.createElement("label");
  label.setAttribute("aria-hidden","true");
  label.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;";
  const input = document.createElement("input");
  input.type = "checkbox"; input.setAttribute("switch",""); input.tabIndex = -1;
  label.appendChild(input); document.body.appendChild(label);
  iosToggle = label; return label;
}

export function trigger(input="light"){
  try{
    if(canVibrate){ navigator.vibrate(Array.isArray(input) ? input : (patterns[input] || patterns.light)); return; }
    const t = ensureIOS(); if(t) t.click();   // iOS: toggling a system switch emits a haptic tick
  }catch(e){ /* silently no-op on unsupported platforms */ }
}

export const Haptics = { trigger };
