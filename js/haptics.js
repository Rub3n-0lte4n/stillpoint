// Dependency-free reimplementation of the web-haptics API (github.com/lochie/web-haptics, MIT),
// vendored to keep the app buildless, CSP-locked and offline-capable.
// Android and friends: the Vibration API. iOS 17.4+: toggling a native
// <input type="checkbox" switch> emits the system haptic tick. WebKit only
// plays that tick for a control it considers rendered, so the switch is parked
// offscreen at natural size — never opacity:0 / display:none / pointer-events:none —
// and only while the page holds user activation (a real tap or shortly after).
// The presets the app actually uses (a subset of web-haptics' vocabulary).
const patterns = { light:[12], success:[35,55,35] };
const canVibrate = typeof navigator!=="undefined" && typeof navigator.vibrate==="function";
let iosInput = null;

function ensureIOS(){
  if(iosInput || !document.body) return iosInput;
  const label = document.createElement("label");
  label.setAttribute("aria-hidden","true");
  label.style.cssText = "position:fixed;top:-100px;left:-100px;margin:0;";
  const input = document.createElement("input");
  input.type = "checkbox"; input.setAttribute("switch",""); input.tabIndex = -1;
  label.appendChild(input); document.body.appendChild(label);
  iosInput = input; return input;
}

// One system tick per toggle; a Vibration-API pattern of n buzz segments
// becomes n spaced ticks (the follow-ups ride the same activation window).
function tickIOS(times){
  const input = ensureIOS(); if(!input) return;
  input.click();
  for(let i=1;i<times;i++) setTimeout(()=>{ try{ input.click(); }catch(e){} }, i*90);
}

export function trigger(input="light"){
  try{
    const pat = Array.isArray(input) ? input : (patterns[input] || patterns.light);
    if(canVibrate){ navigator.vibrate(pat); return; }
    tickIOS(Math.ceil(pat.length/2));
  }catch(e){ /* silently no-op on unsupported platforms */ }
}

export const Haptics = { trigger };
