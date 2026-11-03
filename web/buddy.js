// ClawdBuddy (web) - a 1:1 port of ClawdBuddy.ino.
// Same 128x64 1-bit frame buffer, same Adafruit GFX drawing algorithms and
// font, same mascot logic. The mouse is the button: click = tap,
// double click = double tap, hold = long press.
"use strict";

const W = 128, H = 64, WHITE = 1, BLACK = 0;

// =====================================================================
//                     Adafruit GFX / SSD1306 port
// =====================================================================
class OLED {
  constructor() {
    this.buf = new Uint8Array(W * H);
    this.ink = new Uint8Array(W * H);         // color index per lit pixel (color mode)
    this.color_ = 0;                          // current ink
    this.cx = 0; this.cy = 0; this.size = 1; this.color = WHITE;
    this.inverted = false; this.dimmed = false;
  }
  clear() { this.buf.fill(0); this.ink.fill(0); }
  px(x, y, c) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    this.buf[i] = c;
    if (c) this.ink[i] = this.color_;
  }
  hline(x, y, w, c) { for (let i = 0; i < w; i++) this.px(x + i, y, c); }
  vline(x, y, h, c) { for (let i = 0; i < h; i++) this.px(x, y + i, c); }
  fillRect(x, y, w, h, c) { for (let i = x; i < x + w; i++) this.vline(i, y, h, c); }
  drawRect(x, y, w, h, c) {
    this.hline(x, y, w, c); this.hline(x, y + h - 1, w, c);
    this.vline(x, y, h, c); this.vline(x + w - 1, y, h, c);
  }
  drawLine(x0, y0, x1, y1, c) {
    const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    if (steep) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
    if (x0 > x1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
    const dx = x1 - x0, dy = Math.abs(y1 - y0);
    let err = Math.trunc(dx / 2);
    const ystep = y0 < y1 ? 1 : -1;
    for (; x0 <= x1; x0++) {
      if (steep) this.px(y0, x0, c); else this.px(x0, y0, c);
      err -= dy;
      if (err < 0) { y0 += ystep; err += dx; }
    }
  }
  drawCircle(x0, y0, r, c) {
    let f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r;
    this.px(x0, y0 + r, c); this.px(x0, y0 - r, c); this.px(x0 + r, y0, c); this.px(x0 - r, y0, c);
    while (x < y) {
      if (f >= 0) { y--; ddy += 2; f += ddy; }
      x++; ddx += 2; f += ddx;
      this.px(x0 + x, y0 + y, c); this.px(x0 - x, y0 + y, c);
      this.px(x0 + x, y0 - y, c); this.px(x0 - x, y0 - y, c);
      this.px(x0 + y, y0 + x, c); this.px(x0 - y, y0 + x, c);
      this.px(x0 + y, y0 - x, c); this.px(x0 - y, y0 - x, c);
    }
  }
  circleHelper(x0, y0, r, corner, c) {
    let f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r;
    while (x < y) {
      if (f >= 0) { y--; ddy += 2; f += ddy; }
      x++; ddx += 2; f += ddx;
      if (corner & 4) { this.px(x0 + x, y0 + y, c); this.px(x0 + y, y0 + x, c); }
      if (corner & 2) { this.px(x0 + x, y0 - y, c); this.px(x0 + y, y0 - x, c); }
      if (corner & 8) { this.px(x0 - y, y0 + x, c); this.px(x0 - x, y0 + y, c); }
      if (corner & 1) { this.px(x0 - y, y0 - x, c); this.px(x0 - x, y0 - y, c); }
    }
  }
  fillCircle(x0, y0, r, c) { this.vline(x0, y0 - r, 2 * r + 1, c); this.fillCircleHelper(x0, y0, r, 3, 0, c); }
  fillCircleHelper(x0, y0, r, corners, delta, c) {
    let f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r, px = x, py = y;
    delta++;
    while (x < y) {
      if (f >= 0) { y--; ddy += 2; f += ddy; }
      x++; ddx += 2; f += ddx;
      if (x < y + 1) {
        if (corners & 1) this.vline(x0 + x, y0 - y, 2 * y + delta, c);
        if (corners & 2) this.vline(x0 - x, y0 - y, 2 * y + delta, c);
      }
      if (y !== py) {
        if (corners & 1) this.vline(x0 + py, y0 - px, 2 * px + delta, c);
        if (corners & 2) this.vline(x0 - py, y0 - px, 2 * px + delta, c);
        py = y;
      }
      px = x;
    }
  }
  drawRoundRect(x, y, w, h, r, c) {
    const m = Math.trunc(Math.min(w, h) / 2); if (r > m) r = m;
    this.hline(x + r, y, w - 2 * r, c); this.hline(x + r, y + h - 1, w - 2 * r, c);
    this.vline(x, y + r, h - 2 * r, c); this.vline(x + w - 1, y + r, h - 2 * r, c);
    this.circleHelper(x + r, y + r, r, 1, c);
    this.circleHelper(x + w - r - 1, y + r, r, 2, c);
    this.circleHelper(x + w - r - 1, y + h - r - 1, r, 4, c);
    this.circleHelper(x + r, y + h - r - 1, r, 8, c);
  }
  fillRoundRect(x, y, w, h, r, c) {
    const m = Math.trunc(Math.min(w, h) / 2); if (r > m) r = m;
    this.fillRect(x + r, y, w - 2 * r, h, c);
    this.fillCircleHelper(x + w - r - 1, y + r, r, 1, h - 2 * r - 1, c);
    this.fillCircleHelper(x + r, y + r, r, 2, h - 2 * r - 1, c);
  }
  fillTriangle(x0, y0, x1, y1, x2, y2, c) {
    if (y0 > y1) { [y0, y1] = [y1, y0]; [x0, x1] = [x1, x0]; }
    if (y1 > y2) { [y2, y1] = [y1, y2]; [x2, x1] = [x1, x2]; }
    if (y0 > y1) { [y0, y1] = [y1, y0]; [x0, x1] = [x1, x0]; }
    let a, b, y, last;
    if (y0 === y2) {
      a = b = x0;
      if (x1 < a) a = x1; else if (x1 > b) b = x1;
      if (x2 < a) a = x2; else if (x2 > b) b = x2;
      this.hline(a, y0, b - a + 1, c); return;
    }
    const dx01 = x1 - x0, dy01 = y1 - y0, dx02 = x2 - x0, dy02 = y2 - y0, dx12 = x2 - x1, dy12 = y2 - y1;
    let sa = 0, sb = 0;
    last = y1 === y2 ? y1 : y1 - 1;
    for (y = y0; y <= last; y++) {
      a = x0 + Math.trunc(sa / dy01); b = x0 + Math.trunc(sb / dy02);
      sa += dx01; sb += dx02;
      if (a > b) [a, b] = [b, a];
      this.hline(a, y, b - a + 1, c);
    }
    sa = dx12 * (y - y1); sb = dx02 * (y - y0);
    for (; y <= y2; y++) {
      a = x1 + Math.trunc(sa / dy12); b = x0 + Math.trunc(sb / dy02);
      sa += dx12; sb += dx02;
      if (a > b) [a, b] = [b, a];
      this.hline(a, y, b - a + 1, c);
    }
  }
  drawChar(x, y, ch, c, s) {
    if (x >= W || y >= H || x + 6 * s - 1 < 0 || y + 8 * s - 1 < 0) return;
    if (ch >= 176) ch++;                       // classic (non-cp437) charset
    for (let i = 0; i < 5; i++) {
      let line = FONT[ch * 5 + i];
      for (let j = 0; j < 8; j++, line >>= 1) {
        if (line & 1) {
          if (s === 1) this.px(x + i, y + j, c);
          else this.fillRect(x + i * s, y + j * s, s, s, c);
        }
      }
    }
  }
  setTextSize(s) { this.size = s; }
  setCursor(x, y) { this.cx = x; this.cy = y; }
  print(str) {
    str = String(str);
    for (let k = 0; k < str.length; k++) {
      let code = str.charCodeAt(k);
      if (code > 255) code = 63;               // '?'
      this.drawChar(this.cx, this.cy, code, this.color, this.size);
      this.cx += 6 * this.size;
    }
  }
}

const display = new OLED();

// Color mode (screen version only; the real OLED is one color). Toggle with
// "color": true/false in web/config.json.
const INK_WHITE = 0, INK_ORANGE = 1, INK_GREEN = 2, INK_YELLOW = 3, INK_RED = 4,
      INK_BLUE = 5, INK_PINK = 6, INK_GRAY = 7, INK_CYAN = 8, INK_AMBER = 9;
const PALETTE = [
  [228, 240, 255], [232, 128, 92], [110, 220, 120], [240, 205, 80], [240, 90, 80],
  [100, 170, 255], [255, 120, 175], [125, 135, 148], [110, 220, 230], [245, 165, 60],
];
const ink = c => { display.color_ = c; };
const usageInk = p => (p < 70 ? INK_GREEN : p < 90 ? INK_YELLOW : INK_RED);
const AIR_INK = [INK_GREEN, INK_GREEN, INK_YELLOW, INK_AMBER, INK_RED, INK_RED];
const tempInk = t => (t < 5 ? INK_BLUE : t < 25 ? INK_WHITE : t < 32 ? INK_YELLOW : INK_RED);
const TASK_INK = [INK_CYAN, INK_BLUE, INK_BLUE, INK_ORANGE, INK_YELLOW, INK_CYAN, INK_PINK, INK_WHITE];

// =====================================================================
//                               CONFIG
// =====================================================================
let CFG = { place: "Almaty", latitude: 43.2295, longitude: 76.8374, night_start: 23, night_end: 7, color: false };

// =====================================================================
//                               STATE
// =====================================================================
let outdoorTemp = NaN, usAqi = -1, pm25 = NaN;
const fiveHour = { pct: -1, resetsAt: 0 }, sevenDay = { pct: -1, resetsAt: 0 };
let nowTm = new Date();

const ACT_IDLE = 0, ACT_WORKING = 1, ACT_WAITING = 2, ACT_DONE = 3;
const T_THINK = 0, T_READ = 1, T_SEARCH = 2, T_EDIT = 3, T_RUN = 4, T_WEB = 5, T_AGENT = 6, T_TOOL = 7;
const TASK_KEY = ["think", "read", "search", "edit", "run", "web", "agent", "tool"];
const TASK_LABEL = ["Thinking", "Reading", "Searching", "Editing", "Running", "Browsing", "Delegating", "Working"];

let activity = ACT_IDLE, activitySince = 0, lastWorkEvent = 0;
let task = T_THINK, taskSince = 0, pendingThinkAt = 0, lastEventTs = 0;
let actDetail = "";

const C_TIME = 0, C_AIR = 1, C_5H = 2, C_WEEK = 3, C_ACT = 4;
const IDLE_ROT = [[C_TIME, 8000], [C_AIR, 6000], [C_5H, 5000], [C_WEEK, 5000]];
const WORK_ROT = [[C_ACT, 8000], [C_5H, 3500], [C_ACT, 8000], [C_WEEK, 3500]];
const ROT_LEN = 4, BAND_H = 30, SLIDE_MS = 260;
let rotIdx = 0, curCard = C_TIME, prevCard = C_TIME, cardSince = 0, holdUntil = 0, detailSince = 0;
let flashUntil = 0;

const DOUBLE_TAP_MS = 350, LONG_PRESS_MS = 600;
let buttonDown = false, isTouching = false, isLongPressing = false;
let touchStart = 0, lastTapTime = 0, lastInteraction = 0, tapCount = 0;

const S = 3, MW = 14 * S, MH = 7 * S, WALK_MAX = W - MW, GROUND_Y = 61, HOP_V = 2.8;
const EYE_OPEN = 0, EYE_BLINK = 1, EYE_HAPPY = 2, EYE_CLOSED = 3, EYE_TIRED = 4, EYE_WIDE = 5;
const MOOD_HAPPY = 0, MOOD_TIRED = 1, MOOD_SWEATY = 2, MOOD_EMPTY = 3, MOOD_SLEEPY = 4;

let mx = 40, targetX = 40, miniX = 20, jumpY = 0, jumpV = 0;
let lookX = 0, legPhase = 0, facing = 1;
let lookUntil = 0, nextAction = 0, lastStep = 0, nextBlink = 0, blinkUntil = 0, happyUntil = 0;
let stretchUntil = 0, sitUntil = 0, petting = false;
const puffs = Array.from({ length: 5 }, () => ({ x: 0, born: 0 }));
let puffIdx = 0, lastPuff = 0;

// =====================================================================
//                               HELPERS
// =====================================================================
const millis = () => Math.floor(performance.now());
const epochNow = () => Math.floor(Date.now() / 1000);
const random = (a, b) => (b === undefined ? Math.floor(Math.random() * a) : a + Math.floor(Math.random() * (b - a)));
const constrain = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const lround = v => Math.sign(v) * Math.round(Math.abs(v));
const pad2 = n => String(n).padStart(2, "0");
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function effectivePct(l) {
  if (l.pct < 0) return -1;
  if (l.resetsAt > 0 && epochNow() >= l.resetsAt) return 0;
  return l.pct;
}
const maxUsage = () => Math.max(effectivePct(fiveHour), effectivePct(sevenDay));
const isNight = () => nowTm.getHours() >= CFG.night_start || nowTm.getHours() < CFG.night_end;

function airLevel(aqi) {
  if (aqi < 0) return -1;
  if (aqi <= 50) return 0; if (aqi <= 100) return 1; if (aqi <= 150) return 2;
  if (aqi <= 200) return 3; if (aqi <= 300) return 4; return 5;
}
const AIR_WORD = ["Clean", "Fine", "Hazy", "Smog", "Bad!", "Toxic"];
const AIR_ADVICE = ["Open the windows", "OK to air out", "Air out briefly", "Windows shut!", "Mask up outside", "Stay indoors!"];

function textAt(x, y, size, s) { display.setTextSize(size); display.setCursor(x, y); display.print(s); }
function textRight(rx, y, size, s) { textAt(rx - s.length * 6 * size, y, size, s); }

function marquee(s, y, t0, now) {
  const w = s.length * 6;
  if (w <= W) { textAt(0, y, 1, s); return; }
  const el = now - t0, span = w + 36;
  const off = el > 1500 ? Math.trunc((el - 1500) / 28) % span : 0;
  textAt(-off, y, 1, s);
  textAt(-off + span, y, 1, s);
}

function hop(v) { if (jumpY <= 0.01 && jumpV === 0) jumpV = v; }

// =====================================================================
//                         ACTIVITY / EVENTS
// =====================================================================
function setDetail(s) { actDetail = String(s || "").slice(0, 99); detailSince = millis(); }
function setTask(t, d) { if (t !== task) { task = t; taskSince = millis(); } setDetail(d); pendingThinkAt = 0; }
function setActivity(a) {
  const now = millis();
  if (a !== activity) rotIdx = 0;
  activity = a; activitySince = now;
  if (a === ACT_WAITING) flashUntil = now + 1200;
  if (a !== ACT_IDLE) lastInteraction = now;
  if (a === ACT_DONE) hop(HOP_V);
}
const parseTask = s => { const i = TASK_KEY.indexOf(s); return i < 0 ? T_TOOL : i; };

function applyEvent(ev) {
  const type = ev.type || "", det = ev.detail || "", ts = ev.ts || 0;
  if (ts && ts < lastEventTs) return;
  if (ts) lastEventTs = ts;
  const now = millis();
  if (type === "working") {
    const t = parseTask(ev.task || "think");
    if (activity !== ACT_WORKING) { setActivity(ACT_WORKING); setTask(t, det); }
    else if (t === T_THINK && task !== T_THINK && now - taskSince < 1500) pendingThinkAt = taskSince + 1500;
    else setTask(t, det);
    lastWorkEvent = now;
  } else if (type === "waiting") { setActivity(ACT_WAITING); setDetail(det || "Tap me to dismiss"); }
  else if (type === "done") { setActivity(ACT_DONE); setDetail(det); }
  else if (type === "idle") setActivity(ACT_IDLE);
}

function applyUsage(u) {
  const rl = u.rate_limits || u;
  const read = (v, l) => {
    if (!v) return;
    if (v.used_percentage != null) l.pct = Number(v.used_percentage);
    if (v.resets_at != null) l.resetsAt = Number(v.resets_at);
  };
  read(rl.five_hour, fiveHour);
  read(rl.seven_day, sevenDay);
}

// =====================================================================
//                                INPUT
// =====================================================================
function onSingleTap(now) {
  if (activity === ACT_WAITING || activity === ACT_DONE) setActivity(ACT_IDLE);
  happyUntil = now + 1500; sitUntil = 0; hop(HOP_V);
}
function onDoubleTap(now) {
  if (activity === ACT_WAITING || activity === ACT_DONE) setActivity(ACT_IDLE);
  rotIdx = (rotIdx + 1) % ROT_LEN;
  const rot = activity === ACT_WORKING ? WORK_ROT : IDLE_ROT;
  if (rot[rotIdx][0] === curCard) rotIdx = (rotIdx + 1) % ROT_LEN;
  switchCard(rot[rotIdx][0], now);
  holdUntil = now + 12000;
}
function onLongPress() { if (activity === ACT_WAITING) setActivity(ACT_IDLE); petting = true; sitUntil = 0; }
function onLongRelease(now) { petting = false; happyUntil = now + 800; }

function handleInput(now) {
  const touch = buttonDown;
  if (touch && !isTouching) { isTouching = true; touchStart = now; lastInteraction = now; }
  if (touch && isTouching && !isLongPressing && now - touchStart > LONG_PRESS_MS) {
    isLongPressing = true; tapCount = 0; onLongPress(now);
  }
  if (!touch && isTouching) {
    isTouching = false;
    if (isLongPressing) { isLongPressing = false; onLongRelease(now); }
    else { tapCount++; lastTapTime = now; }
  }
  if (!touch && tapCount > 0 && now - lastTapTime > DOUBLE_TAP_MS) {
    if (tapCount === 1) onSingleTap(now); else onDoubleTap(now);
    tapCount = 0;
  }
}

// =====================================================================
//                              INFO CARDS
// =====================================================================
function switchCard(c, now) { if (c === curCard) return; prevCard = curCard; curCard = c; cardSince = now; }

function updateCards(now) {
  if (activity === ACT_WAITING || activity === ACT_DONE) { switchCard(C_ACT, now); return; }
  const rot = activity === ACT_WORKING ? WORK_ROT : IDLE_ROT;
  if (curCard !== rot[rotIdx][0]) { switchCard(rot[rotIdx][0], now); return; }
  if (now > holdUntil && now - cardSince > rot[rotIdx][1]) {
    rotIdx = (rotIdx + 1) % ROT_LEN;
    switchCard(rot[rotIdx][0], now);
    detailSince = now;
  }
}

const drawDegree = (x, y, r) => display.drawCircle(x + r, y + r, r, WHITE);

function drawTimeCard(yo) {
  textAt(0, 1 + yo, 2, pad2(nowTm.getHours()) + ":" + pad2(nowTm.getMinutes()));
  if (!isNaN(outdoorTemp)) {
    ink(tempInk(outdoorTemp));
    const t = String(lround(outdoorTemp));
    const w = t.length * 12 + 7 + 12, x = W - w;
    textAt(x, 1 + yo, 2, t);
    drawDegree(x + t.length * 12 + 1, 1 + yo, 2);
    textAt(x + t.length * 12 + 7, 1 + yo, 2, "C");
  }
  ink(INK_GRAY);
  textAt(0, 21 + yo, 1, `${DAYS[nowTm.getDay()]}, ${pad2(nowTm.getDate())} ${MONTHS[nowTm.getMonth()]}`);
}

function drawAirCard(yo) {
  const lvl = airLevel(usAqi);
  textAt(0, 1 + yo, 2, "Air: ");
  if (lvl >= 0) ink(AIR_INK[lvl]);
  textAt(60, 1 + yo, 2, lvl < 0 ? "..." : AIR_WORD[lvl]);
  ink(INK_WHITE);
  textAt(0, 21 + yo, 1, lvl < 0 ? "checking the sky" : AIR_ADVICE[lvl]);
  for (let i = 0; i < 6; i++) {
    const h = 2 + i, x = 105 + i * 4, y = 28 + yo - h;
    ink(lvl >= 0 && i <= lvl ? AIR_INK[i] : INK_GRAY);
    if (lvl >= 0 && i <= lvl) display.fillRect(x, y, 3, h, WHITE);
    else display.hline(x, 28 + yo, 3, WHITE);
  }
}

function drawLimitCard(yo, weekly) {
  const l = weekly ? sevenDay : fiveHour;
  const p = effectivePct(l);
  const val = p < 0 ? "--" : Math.trunc(p + 0.5) + "%";
  textAt(0, 1 + yo, 2, weekly ? "Week " : "5h   ");
  if (p >= 0) ink(usageInk(p));
  textAt(60, 1 + yo, 2, val);
  ink(INK_GRAY);
  if (p < 0) { textAt(0, 21 + yo, 1, "open Claude Code"); return; }

  const bw = 66, bh = 7, by = 21 + yo;
  display.drawRect(0, by, bw, bh, WHITE);
  const fill = Math.trunc((bw - 4) * Math.min(p, 100) / 100 + 0.5);
  ink(usageInk(p));
  if (fill > 0) display.fillRect(2, by + 2, fill, bh - 4, WHITE);
  ink(INK_GRAY);

  if (l.resetsAt > 0) {
    if (epochNow() >= l.resetsAt) { textRight(W, by, 1, "reset!"); return; }
    const r = new Date(l.resetsAt * 1000);
    const hm = pad2(r.getHours()) + ":" + pad2(r.getMinutes());
    const soon = l.resetsAt - epochNow() < 20 * 3600;
    textRight(W, by, 1, soon ? "til " + hm : DAYS[r.getDay()].slice(0, 3) + " " + hm);
  }
}

function drawActivityCard(yo, now) {
  let title = "Working";
  if (activity === ACT_WAITING) title = "Needs you!";
  else if (activity === ACT_DONE) title = "All done!";
  else if (activity === ACT_WORKING) title = TASK_LABEL[task];
  ink(activity === ACT_WAITING ? INK_RED : activity === ACT_DONE ? INK_GREEN : TASK_INK[task]);
  textAt(0, 1 + yo, 2, title);
  ink(INK_WHITE);
  if (activity === ACT_WORKING && task === T_THINK && !actDetail) textAt(0, 21 + yo, 1, "...");
  else marquee(actDetail, 21 + yo, detailSince, now);
}

function drawCard(c, yo, now) {
  ink(INK_WHITE);
  if (c === C_TIME) drawTimeCard(yo);
  else if (c === C_AIR) drawAirCard(yo);
  else if (c === C_5H) drawLimitCard(yo, false);
  else if (c === C_WEEK) drawLimitCard(yo, true);
  else drawActivityCard(yo, now);
}

function drawInfoBand(now) {
  const t = now - cardSince;
  if (t < SLIDE_MS) {
    let p = t / SLIDE_MS;
    p = 1 - (1 - p) * (1 - p);
    const off = Math.trunc(p * (BAND_H + 2));
    drawCard(prevCard, -off, now);
    drawCard(curCard, BAND_H + 2 - off, now);
  } else drawCard(curCard, 0, now);
  display.fillRect(0, BAND_H, W, H - BAND_H, BLACK);
}

// =====================================================================
//                            MASCOT DRAWING
// =====================================================================
function drawClawd(ox, oy, s, eyes, look, lookY, legs, armL, armR, sitting, bob, mask) {
  const by = oy + bob;
  ink(INK_ORANGE);
  display.fillRect(ox + 2 * s, by, 10 * s, 5 * s, WHITE);
  display.fillRect(ox, by + (2 + armL) * s, 2 * s, s, WHITE);
  display.fillRect(ox + 12 * s, by + (2 + armR) * s, 2 * s, s, WHITE);
  if (!sitting) {
    const legX = [3, 5, 8, 10];
    for (let i = 0; i < 4; i++) {
      const lifted = (legs === 1 && (i === 0 || i === 2)) || (legs === 2 && (i === 1 || i === 3));
      const top = by + 5 * s, bottom = oy + 7 * s - (lifted ? s : 0);
      display.fillRect(ox + legX[i] * s, top, s, bottom - top, WHITE);
    }
  }
  if (s < 3) {
    display.fillRect(ox + 4 * s, by + s, s, 2 * s, BLACK);
    display.fillRect(ox + 9 * s, by + s, s, 2 * s, BLACK);
    return;
  }
  for (let e = 0; e < 2; e++) {
    const ex = ox + (e ? 9 : 4) * s + look, ey = by + s + lookY;
    switch (eyes) {
      case EYE_OPEN: display.fillRect(ex, ey, 3, 6, BLACK); break;
      case EYE_WIDE: display.fillRect(ex - 1, ey - 1, 5, 8, BLACK); display.px(ex, ey, WHITE); break;
      case EYE_BLINK: display.fillRect(ex, ey + 4, 3, 1, BLACK); break;
      case EYE_CLOSED: display.fillRect(ex - 1, ey + 4, 5, 1, BLACK); break;
      case EYE_TIRED: display.fillRect(ex, ey + 3, 3, 3, BLACK); break;
      case EYE_HAPPY:
        for (let t = 0; t < 2; t++) {
          display.drawLine(ex - 1, ey + 4 + t, ex + 1, ey + 2 + t, BLACK);
          display.drawLine(ex + 1, ey + 2 + t, ex + 3, ey + 4 + t, BLACK);
        }
        break;
    }
  }
  if (mask) {
    const mx0 = ox + 3 * s, my0 = by + 3 * s + 1;
    display.fillRect(mx0, my0, 8 * s, 2 * s - 1, BLACK);
    ink(INK_WHITE);
    display.hline(mx0 + 2, my0 + 2, 8 * s - 4, WHITE);
    ink(INK_ORANGE);
    display.drawLine(ox + 2 * s, by + 2 * s + 2, mx0, my0, BLACK);
    display.drawLine(ox + 12 * s - 1, by + 2 * s + 2, mx0 + 8 * s - 1, my0, BLACK);
  }
}

function drawSideBubble(ox, oy, txt) {
  ink(INK_WHITE);
  const w = txt.length * 6 + 7, h = 11;
  const y = Math.max(BAND_H + 2, oy - 4);
  let x = ox + MW + 2;
  if (x + w > W) x = ox - w - 2;
  x = Math.max(0, x);
  display.fillRoundRect(x, y, w, h, 3, BLACK);
  display.drawRoundRect(x, y, w, h, 3, WHITE);
  textAt(x + 4, y + 2, 1, txt);
}

function drawHeart(x, y) {
  ink(INK_PINK);
  display.fillCircle(x - 2, y, 2, WHITE);
  display.fillCircle(x + 2, y, 2, WHITE);
  display.fillTriangle(x - 4, y + 1, x + 4, y + 1, x, y + 5, WHITE);
}

function drawZz(ox, oy, now) {
  ink(INK_CYAN);
  const p = Math.trunc(now / 140) % 16;
  textAt(Math.min(ox + MW + 1 + Math.trunc(p / 4), W - 6), oy + 2 - Math.trunc(p / 3), 1, "z");
  const q = (p + 8) % 16;
  textAt(Math.min(ox + MW + 5 + Math.trunc(q / 4), W - 6), oy - 1 - Math.trunc(q / 3), 1, "Z");
}

function drawSweat(ox, oy, now) {
  ink(INK_BLUE);
  const x = ox + 12 * S + 2, y = oy + 1 + Math.trunc(now / 90) % 8;
  display.fillCircle(x, y, 1, WHITE);
  display.px(x, y - 2, WHITE);
}

function drawMagnifier(ox, oy, dir) {
  ink(INK_CYAN);
  const hx = dir > 0 ? ox + 14 * S : ox - 1, hy = oy + S;
  display.drawLine(hx, hy, hx + dir * 3, hy - 3, WHITE);
  display.drawCircle(hx + dir * 6, hy - 6, 3, WHITE);
}

function drawSparks(ox, oy, dir) {
  ink(INK_YELLOW);
  const x = dir > 0 ? ox + 14 * S + 2 : ox - 3, y = oy + 3 * S;
  for (let i = 0; i < 3; i++) display.px(x + dir * random(0, 6), y - random(0, 7), WHITE);
}

function currentMood(now) {
  const u = maxUsage();
  if (u >= 100) return MOOD_EMPTY;
  if (u >= 90) return MOOD_SWEATY;
  if (u >= 70) return MOOD_TIRED;
  if (isNight() && now - lastInteraction > 5 * 60000) return MOOD_SLEEPY;
  return MOOD_HAPPY;
}

function pingPong() { if (Math.abs(mx - targetX) < 0.5) targetX = mx < WALK_MAX / 2 ? WALK_MAX : 0; }

function updateAndDrawMascot(now) {
  if (activity === ACT_DONE && now - activitySince > 8000) setActivity(ACT_IDLE);
  if (activity === ACT_WORKING && now - lastWorkEvent > 10 * 60000) setActivity(ACT_IDLE);
  if (pendingThinkAt && now >= pendingThinkAt) setTask(T_THINK, "");

  const mood = currentMood(now);
  let eyes = EYE_OPEN, armL = 0, armR = 0, lookY = 0;
  let sitting = false, sweat = false, zz = false, heart = false;
  let magnifier = false, sparks = false, dust = false, mini = false, speedLines = false;
  let bubble = null;
  let speed = (mood === MOOD_TIRED || mood === MOOD_SWEATY) ? 0.35 : 0.7;

  if (activity === ACT_WORKING) {
    switch (task) {
      case T_THINK: {
        speed = 0.3; lookY = -1;
        if (now > nextAction) { targetX = random(0, WALK_MAX + 1); nextAction = now + random(2500, 5000); }
        const n = Math.trunc(now / 350) % 4;
        bubble = ".".repeat(n) + " ".repeat(3 - n);
        break;
      }
      case T_READ:
      case T_SEARCH:
        speed = task === T_SEARCH ? 1.3 : 0.45;
        pingPong(); magnifier = true;
        if (facing > 0) armR = -1; else armL = -1;
        break;
      case T_EDIT: {
        targetX = mx;
        const down = Math.trunc(now / 150) % 2 === 1;
        if (facing > 0) armR = down ? 1 : -1; else armL = down ? 1 : -1;
        sparks = down; lookX = facing * 2;
        break;
      }
      case T_RUN: {
        speed = 2.6; pingPong(); dust = speedLines = true;
        const f = Math.trunc(now / 80) % 2 === 1;
        armL = f ? -1 : 1; armR = f ? 1 : -1;
        bubble = "zoom";
        break;
      }
      case T_WEB:
        targetX = mx;
        if (Math.trunc(now / 900) % 2 === 0) hop(2.0);
        lookX = Math.trunc(now / 600) % 2 ? 2 : -2;
        bubble = "www";
        break;
      case T_AGENT:
        speed = 0.8; pingPong(); mini = true;
        break;
      default: {
        targetX = mx;
        const f = Math.trunc(now / 130) % 2 === 1;
        armL = f ? -1 : 0; armR = f ? 0 : -1;
      }
    }
  } else if (activity === ACT_WAITING) {
    const t = now - activitySince;
    eyes = EYE_WIDE; armL = armR = -1; targetX = mx;
    if (t < 20000) hop(HOP_V);
    if (t < 20000 || Math.trunc(now / 500) % 2) bubble = "!";
  } else if (activity === ACT_DONE) {
    eyes = EYE_HAPPY; targetX = mx;
    const f = Math.trunc(now / 250) % 2 === 1;
    armL = f ? -1 : 0; armR = f ? 0 : -1;
    if (now - activitySince < 2500) hop(HOP_V);
    lookX = f ? 1 : -1;
  } else {
    if ((mood === MOOD_EMPTY || mood === MOOD_SLEEPY) && !petting && now > happyUntil) {
      sitting = true; zz = true; eyes = EYE_CLOSED; targetX = mx;
    } else {
      if (now > nextAction) {
        const r = random(100);
        if (r < 35) targetX = random(0, WALK_MAX + 1);
        else if (r < 50) { lookX = random(2) ? -2 : 2; lookUntil = now + 900; }
        else if (r < 62 && mood === MOOD_HAPPY) hop(HOP_V);
        else if (r < 72) stretchUntil = now + 1200;
        else if (r < 80 && mood === MOOD_HAPPY) { sitUntil = now + 4000; targetX = mx; }
        nextAction = now + random(2000, 5500);
      }
      if (now < stretchUntil) { armL = armR = -1; lookY = -1; }
      if (now < sitUntil) sitting = true;
      if (mood === MOOD_TIRED) eyes = EYE_TIRED;
      if (mood === MOOD_SWEATY) { eyes = EYE_TIRED; sweat = true; }
    }
  }

  if (petting) { eyes = EYE_HAPPY; heart = true; bubble = null; zz = false; targetX = mx; }
  else if (now < happyUntil && activity === ACT_IDLE) eyes = EYE_HAPPY;

  let walking = false;
  if (!sitting && Math.abs(targetX - mx) > 0.5) {
    facing = targetX > mx ? 1 : -1;
    mx += facing * Math.min(speed, Math.abs(targetX - mx));
    walking = true;
    if (task !== T_EDIT || activity !== ACT_WORKING) lookX = facing * 2;
    const stepMs = speed >= 2 ? 60 : speed >= 1 ? 100 : 160;
    if (now - lastStep > stepMs) { legPhase = legPhase === 1 ? 2 : 1; lastStep = now; }
  } else {
    legPhase = 0;
    if (now > lookUntil && activity !== ACT_DONE && !(activity === ACT_WORKING && (task === T_EDIT || task === T_WEB)))
      lookX = 0;
  }
  mx = constrain(mx, 0, WALK_MAX);

  if (jumpV !== 0 || jumpY > 0) {
    jumpY += jumpV; jumpV -= 0.5;
    if (jumpY <= 0) { jumpY = 0; jumpV = 0; }
  }

  if (now > nextBlink) { blinkUntil = now + 120; nextBlink = now + random(1500, 5000); }
  if (now < blinkUntil && (eyes === EYE_OPEN || eyes === EYE_TIRED || eyes === EYE_WIDE)) eyes = EYE_BLINK;

  const bob = (!walking && jumpY === 0 && !sitting && Math.trunc(now / 700) % 2) ? 1 : 0;
  const ox = Math.trunc(mx + 0.5);
  const oy = sitting ? GROUND_Y - 5 * S : GROUND_Y - MH - Math.trunc(jumpY);

  ink(INK_GRAY);
  for (let x = 0; x < W; x += 4) display.px(x, GROUND_Y + 1, WHITE);
  const shadow = Math.max(10, 30 - Math.trunc(jumpY) * 3);
  display.hline(ox + MW / 2 - Math.trunc(shadow / 2), GROUND_Y + 2, shadow, WHITE);

  if (dust && walking && now - lastPuff > 110) {
    puffs[puffIdx] = { x: facing > 0 ? ox + 2 : ox + MW - 2, born: now };
    puffIdx = (puffIdx + 1) % 5;
    lastPuff = now;
  }
  for (const p of puffs) {
    const age = now - p.born;
    if (p.born && age < 350) display.drawCircle(p.x, GROUND_Y - 1 - Math.trunc(age / 120), 1 + Math.trunc(age / 150), WHITE);
  }

  if (mini) {
    const target = mx + (facing > 0 ? -18 : MW + 4);
    miniX += (target - miniX) * 0.08;
    const mxi = constrain(Math.trunc(miniX), 0, W - 14);
    const step = Math.trunc(now / 120) % 2;
    drawClawd(mxi, GROUND_Y - 7, 1, EYE_OPEN, 0, 0, step ? 1 : 2, 0, 0, false, 0, false);
  } else miniX = mx;

  const mask = airLevel(usAqi) >= 3 && !sitting;
  drawClawd(ox, oy, S, eyes, lookX, lookY, legPhase, armL, armR, sitting, bob, mask);

  ink(INK_GRAY);
  if (speedLines && walking) {
    for (let i = 0; i < 3; i++) {
      const len = 6 + (Math.trunc(now / 60) + i * 3) % 7;
      const y = oy + 3 + i * 5;
      const x = facing > 0 ? ox - 3 - len : ox + MW + 3;
      display.hline(x, y, len, WHITE);
    }
  }
  if (magnifier) drawMagnifier(ox, oy, facing);
  if (sparks) drawSparks(ox, oy, facing);
  if (sweat) drawSweat(ox, oy, now);
  if (zz) drawZz(ox, oy, now);
  if (heart) drawHeart(ox + MW / 2, Math.max(BAND_H + 4, oy - 6 - Math.trunc(now / 150) % 3));
  if (bubble) drawSideBubble(ox, oy, bubble);
}

// =====================================================================
//                         RENDER TO <canvas>
// =====================================================================
const canvas = document.getElementById("oled");
const ctx = canvas.getContext("2d");
const img = ctx.createImageData(W, H);
const ON = [228, 240, 255], ON_DIM = [110, 118, 128];

function present() {
  const on = display.dimmed ? ON_DIM : ON;
  const k = display.dimmed ? 0.5 : 1;
  for (let i = 0; i < W * H; i++) {
    const lit = display.buf[i] ^ (display.inverted ? 1 : 0);
    // color mode: lit pixels use their ink (pixels lit only by the "!" flash stay white)
    const c = !lit ? null : (CFG.color && display.buf[i]) ? PALETTE[display.ink[i]].map(v => v * k) : on;
    const o = i * 4;
    img.data[o] = c ? c[0] : 0;
    img.data[o + 1] = c ? c[1] : 0;
    img.data[o + 2] = c ? c[2] : 0;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function frame() {
  const now = millis();
  handleInput(now);
  nowTm = new Date();
  display.dimmed = isNight();
  display.clear();
  ink(INK_WHITE);
  updateCards(now);
  drawInfoBand(now);
  updateAndDrawMascot(now);
  display.inverted = now < flashUntil && Math.trunc(now / 200) % 2 === 0;
  present();
}

// =====================================================================
//                      DATA: server events + weather
// =====================================================================
function connectEvents() {
  const es = new EventSource("/events");
  es.onopen = () => reportViewport();   // also after a server restart
  es.onmessage = m => {
    try {
      const msg = JSON.parse(m.data);
      if (msg.kind === "usage") applyUsage(msg.data);
      else if (msg.kind === "event") applyEvent(msg.data);
    } catch (e) { /* ignore malformed */ }
  };
  // EventSource reconnects by itself if the server restarts
}

async function fetchEnv() {
  const loc = `latitude=${CFG.latitude}&longitude=${CFG.longitude}`;
  try {
    const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?${loc}&current=temperature_2m`)).json();
    if (w.current && w.current.temperature_2m != null) outdoorTemp = w.current.temperature_2m;
    const a = await (await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${loc}&current=us_aqi,pm2_5`)).json();
    if (a.current && a.current.us_aqi != null) usAqi = a.current.us_aqi;
    if (a.current && a.current.pm2_5 != null) pm25 = a.current.pm2_5;
    return true;
  } catch (e) { return false; }
}

async function envLoop() {
  const ok = await fetchEnv();
  setTimeout(envLoop, ok ? 10 * 60 * 1000 : 30 * 1000);
}

// mouse = the button
canvas.addEventListener("pointerdown", e => { buttonDown = true; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointerup", () => { buttonDown = false; });
canvas.addEventListener("pointercancel", () => { buttonDown = false; });
canvas.addEventListener("contextmenu", e => e.preventDefault());

// tell the launcher the real page size so it can size the window exactly
function reportViewport() {
  fetch("/viewport", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }),
  }).catch(() => {});
}
addEventListener("resize", reportViewport);

(async function start() {
  reportViewport();
  try { CFG = Object.assign(CFG, await (await fetch("/config")).json()); } catch (e) { /* defaults */ }
  lastInteraction = millis();
  connectEvents();
  envLoop();
  setInterval(frame, 33);  // ~30 fps, same as the ESP32
})();
