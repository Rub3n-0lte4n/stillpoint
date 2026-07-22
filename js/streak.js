/* Reading streak — a daily ledger of active reading seconds.
   fp_streak_v1 = { goalMin, best, days: { "YYYY-MM-DD": seconds } }
   Day keys are LOCAL dates; the day boundary is local midnight. Streak, today's
   progress, and goal-met are always computed from the ledger — only `best` is
   stored, as a high-water mark, because pruning would eventually erase an
   all-time best. Spec: docs/superpowers/specs/2026-07-10-reading-streak-design.md */

const KEY = "fp_streak_v1";
const DEFAULT_GOAL = 5;                       // minutes per day
export const GOAL_MIN = 5, GOAL_MAX = 60, GOAL_STEP = 5;
const KEEP_DAYS = 400;                        // ledger prune horizon

export function todayKey(d = new Date()){
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function prevKey(key){
  const [y, m, dd] = key.split("-").map(Number);
  const d = new Date(y, m - 1, dd);
  d.setDate(d.getDate() - 1);
  return todayKey(d);
}

/* ---- pure core (tested in test/streak.test.mjs) ---- */

// Current streak = consecutive goal-met days ending today (if met) or yesterday —
// a streak stays alive all day and is only lost once a midnight passes unmet.
export function computeStreak(days, goalMin, todayStr){
  const met = (k) => (days[k] || 0) >= goalMin * 60;
  const todaySec = days[todayStr] || 0;
  const metToday = met(todayStr);
  let current = 0;
  let k = metToday ? todayStr : prevKey(todayStr);
  while(met(k)){ current++; k = prevKey(k); }
  return { current, metToday, todaySec };
}

// Backup import: a device can only under-report a day, so per-day max is honest.
export function mergeDays(local, imported){
  const out = { ...local };
  for(const k in (imported || {})) out[k] = Math.max(out[k] || 0, imported[k] || 0);
  return out;
}

// Last 7 local days ending on `todayStr`, oldest first — the landing week row.
export function weekOf(days, goalMin, todayStr){
  const out = [];
  let k = todayStr;
  for(let i = 0; i < 7; i++){
    const sec = days[k] || 0;
    out.unshift({ key: k, sec, met: sec >= goalMin * 60 });
    k = prevKey(k);
  }
  return out;
}

export function pruneDays(days, keep = KEEP_DAYS){
  const keys = Object.keys(days).sort();
  if(keys.length <= keep) return days;
  const out = {};
  for(const k of keys.slice(-keep)) out[k] = days[k];
  return out;
}

/* ---- storage-backed API ---- */

function fresh(){ return { goalMin: DEFAULT_GOAL, best: 0, days: {} }; }
function load(){
  try{
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    if(v && typeof v === "object" && v.days && typeof v.days === "object")
      return { goalMin: v.goalMin || DEFAULT_GOAL, best: v.best || 0, days: v.days };
  }catch(e){}
  return null;
}
function save(st, now = new Date()){
  st.days = pruneDays(st.days);
  const { current } = computeStreak(st.days, st.goalMin, todayKey(now));
  if(current > (st.best || 0)) st.best = current;
  try{ localStorage.setItem(KEY, JSON.stringify(st)); }catch(e){}
  return st;
}

export const Streak = {
  hasData(){
    const st = load();
    return !!(st && Object.keys(st.days).length);
  },
  getState(d = new Date()){
    const st = load() || fresh();
    const { current, metToday, todaySec } = computeStreak(st.days, st.goalMin, todayKey(d));
    return { goalMin: st.goalMin, best: Math.max(st.best || 0, current), current, metToday, todaySec };
  },
  // Credits seconds to the local date of `d`. `crossed` is true only when this
  // call moves the day's total from below goal to at-or-above goal.
  addSeconds(sec, d = new Date()){
    const st = load() || fresh();
    const k = todayKey(d);
    if(!(sec > 0)) return { crossed: false, current: computeStreak(st.days, st.goalMin, k).current };
    const before = st.days[k] || 0;
    st.days[k] = before + sec;
    save(st, d);
    const goalSec = st.goalMin * 60;
    return {
      crossed: before < goalSec && st.days[k] >= goalSec,
      current: computeStreak(st.days, st.goalMin, k).current,
    };
  },
  setGoal(min){
    const st = load() || fresh();
    st.goalMin = Math.min(GOAL_MAX, Math.max(GOAL_MIN, Math.round(min / GOAL_STEP) * GOAL_STEP));
    save(st);
    return st.goalMin;
  },
  week(d = new Date()){
    const st = load() || fresh();
    return weekOf(st.days, st.goalMin, todayKey(d));
  },
  raw(){ return load(); },   // for backup export
  // Backup import: per-day max, best max; the local goal wins unless local state is absent.
  importMerge(v){
    if(!v || typeof v !== "object" || !v.days || typeof v.days !== "object") return;
    const local = load();
    const st = local || { goalMin: v.goalMin || DEFAULT_GOAL, best: 0, days: {} };
    st.days = mergeDays(st.days, v.days);
    st.best = Math.max(st.best || 0, v.best || 0);
    save(st);
  },
};
