/*
  ClawdBuddy - a tiny Claude Code companion living on the DeskBuddy hardware
  ---------------------------------------------------------------------------
  Hardware (same as DeskBuddy):
    ESP32, SSD1306 128x64 OLED on I2C (SDA 21, SCL 22, addr 0x3C),
    TTP223 touch sensor on GPIO 23.

  Layout:
    y 0..29   info card (big text), rotates with a slide animation
              idle    : time+temp -> air -> 5h limit -> weekly limit
              working : what Claude is doing -> 5h -> what Claude is doing -> weekly
    y 31..63  the mascot's little world (full width)

  Mascot behaviour follows Claude Code (via hooks):
    thinking  : wanders slowly, "..." bubble
    reading   : strolls with a magnifying glass
    searching : hurries back and forth with the magnifier
    editing   : hammers away, sparks fly
    running   : sprints across the screen kicking up dust
    browsing  : hops and looks around, "www" bubble
    delegating: walks with a mini-me following
    needs you : jumps with "!" (tap to dismiss)
    done      : happy dance
  Idle: wanders, hops, stretches, sits. Usage >=70% tired, >=90% sweating,
  100% asleep. Bad air -> wears a mask. Night -> dims and sleeps.

  Touch: tap = hop / dismiss alert, double tap = next card, long press = pet.

  HTTP API (port 80, http://deskbuddy.local):
    POST /usage   Claude Code "rate_limits" JSON
    POST /event   {"type":"working|waiting|done|idle","task":"think|read|search|edit|run|web|agent|tool",
                   "detail":"...","ts":<ms epoch>}
    GET  /        status JSON
*/
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <time.h>
#include <math.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ================= USER CONFIG =================
// Copy config.example.h to config.h and fill in your WiFi + location.
// config.h is git-ignored so your password never ends up on GitHub.
#if __has_include("config.h")
#include "config.h"
#else
#error "Missing config.h - copy config.example.h to config.h and edit it."
#endif

// ================= HARDWARE =================
#define TOUCH_PIN 23
#define SCREEN_W 128
#define SCREEN_H 64
#define OLED_ADDR 0x3C
#define WHITE SSD1306_WHITE
#define BLACK SSD1306_BLACK
Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1);
WebServer server(80);

// ================= DATA =================
volatile float outdoorTemp = NAN;
volatile int   usAqi = -1;
volatile float pm25 = NAN;

struct Limit { float pct = -1; long long resetsAt = 0; };
Limit fiveHour, sevenDay;

struct tm nowTm;
bool timeOk = false;

// ================= CLAUDE ACTIVITY =================
enum Activity { ACT_IDLE, ACT_WORKING, ACT_WAITING, ACT_DONE };
enum Task { T_THINK, T_READ, T_SEARCH, T_EDIT, T_RUN, T_WEB, T_AGENT, T_TOOL, T_COUNT };
const char* TASK_KEY[T_COUNT]   = {"think", "read", "search", "edit", "run", "web", "agent", "tool"};
const char* TASK_LABEL[T_COUNT] = {"Thinking", "Reading", "Searching", "Editing", "Running",
                                   "Browsing", "Delegating", "Working"};

Activity activity = ACT_IDLE;
unsigned long activitySince = 0, lastWorkEvent = 0;
Task task = T_THINK;
unsigned long taskSince = 0, pendingThinkAt = 0;
long long lastEventTs = 0;
char actDetail[100] = "";

// ================= INFO CARDS =================
enum Card { C_TIME, C_AIR, C_5H, C_WEEK, C_ACT };
struct Slot { Card card; uint16_t ms; };
const Slot IDLE_ROT[] = {{C_TIME, 8000}, {C_AIR, 6000}, {C_5H, 5000}, {C_WEEK, 5000}};
const Slot WORK_ROT[] = {{C_ACT, 8000}, {C_5H, 3500}, {C_ACT, 8000}, {C_WEEK, 3500}};
const int ROT_LEN = 4;
const int BAND_H = 30;                    // info band height
const unsigned long SLIDE_MS = 260;

int rotIdx = 0;
Card curCard = C_TIME, prevCard = C_TIME;
unsigned long cardSince = 0, holdUntil = 0;
unsigned long detailSince = 0;            // marquee restart

bool inverted = false, dimmed = false;
unsigned long flashUntil = 0;

// ================= INPUT =================
const unsigned long DOUBLE_TAP_MS = 350;
const unsigned long LONG_PRESS_MS = 600;
bool isTouching = false, isLongPressing = false;
unsigned long touchStart = 0, lastTapTime = 0, lastInteraction = 0;
int tapCount = 0;

// ================= MASCOT =================
// Drawn on a 14 x 7 cell grid; each cell = S x S pixels.
const int S = 3;
const int MW = 14 * S;                 // 42 px wide
const int MH = 7 * S;                  // 21 px tall
const int WALK_MAX = SCREEN_W - MW;    // 86 px of walking room
const int GROUND_Y = 61;
const float HOP_V = 2.8f;              // ~8 px hop, stays inside the scene

enum Eyes { EYE_OPEN, EYE_BLINK, EYE_HAPPY, EYE_CLOSED, EYE_TIRED, EYE_WIDE };
enum Mood { MOOD_HAPPY, MOOD_TIRED, MOOD_SWEATY, MOOD_EMPTY, MOOD_SLEEPY };

float mx = 40, targetX = 40, miniX = 20;
float jumpY = 0, jumpV = 0;
int lookX = 0, legPhase = 0, facing = 1;
unsigned long lookUntil = 0, nextAction = 0, lastStep = 0;
unsigned long nextBlink = 0, blinkUntil = 0, happyUntil = 0;
unsigned long stretchUntil = 0, sitUntil = 0;
bool petting = false;

struct Puff { int x; unsigned long born; };
Puff puffs[5];
int puffIdx = 0;
unsigned long lastPuff = 0;

// ================= PROTOTYPES =================
void envTask(void*);
void handleInput(unsigned long now);
void setActivity(Activity a);
void switchCard(Card c, unsigned long now);

// =====================================================================
//                               HELPERS
// =====================================================================
long long epochNow() { return (long long)time(nullptr); }
bool clockValid() { return epochNow() > 1700000000LL; }

float effectivePct(const Limit& l) {
  if (l.pct < 0) return -1;
  if (l.resetsAt > 0 && clockValid() && epochNow() >= l.resetsAt) return 0;  // window already reset
  return l.pct;
}

float maxUsage() { return max(effectivePct(fiveHour), effectivePct(sevenDay)); }

bool isNight() {
  if (!timeOk) return false;
  return nowTm.tm_hour >= NIGHT_START || nowTm.tm_hour < NIGHT_END;
}

// Air quality in human words. level 0..5
int airLevel(int aqi) {
  if (aqi < 0) return -1;
  if (aqi <= 50) return 0;
  if (aqi <= 100) return 1;
  if (aqi <= 150) return 2;
  if (aqi <= 200) return 3;
  if (aqi <= 300) return 4;
  return 5;
}
const char* AIR_WORD[6]   = {"Clean", "Fine", "Hazy", "Smog", "Bad!", "Toxic"};
const char* AIR_ADVICE[6] = {"Open the windows", "OK to air out", "Air out briefly",
                             "Windows shut!", "Mask up outside", "Stay indoors!"};

void textAt(int x, int y, int size, const char* s) {
  display.setTextSize(size);
  display.setCursor(x, y);
  display.print(s);
}
void textRight(int rightX, int y, int size, const char* s) {
  textAt(rightX - (int)strlen(s) * 6 * size, y, size, s);
}
void textCenter(int y, int size, const char* s) {
  textAt((SCREEN_W - (int)strlen(s) * 6 * size) / 2, y, size, s);
}

// Scrolls text that doesn't fit; short text is just printed.
void marquee(const char* s, int y, unsigned long t0, unsigned long now) {
  int w = strlen(s) * 6;
  if (w <= SCREEN_W) { textAt(0, y, 1, s); return; }
  unsigned long el = now - t0;
  int span = w + 36;
  int off = el > 1500 ? (int)(((el - 1500) / 28) % span) : 0;
  textAt(-off, y, 1, s);
  textAt(-off + span, y, 1, s);
}

void hop(float v) { if (jumpY <= 0.01f && jumpV == 0) jumpV = v; }

// =====================================================================
//                         ACTIVITY / EVENTS
// =====================================================================
void setDetail(const char* s) {
  strlcpy(actDetail, s ? s : "", sizeof(actDetail));
  detailSince = millis();
}

void setTask(Task t, const char* d) {
  if (t != task) { task = t; taskSince = millis(); }
  setDetail(d);
  pendingThinkAt = 0;
}

void setActivity(Activity a) {
  unsigned long now = millis();
  if (a != activity) rotIdx = 0;
  activity = a;
  activitySince = now;
  if (a == ACT_WAITING) flashUntil = now + 1200;
  if (a != ACT_IDLE) lastInteraction = now;
  if (a == ACT_DONE) hop(HOP_V);
}

Task parseTask(const String& s) {
  for (int i = 0; i < T_COUNT; i++) if (s == TASK_KEY[i]) return (Task)i;
  return T_TOOL;
}

void handleEvent() {
  String type, taskS, det;
  long long ts = 0;
  JsonDocument doc;
  String body = server.arg("plain");
  if (body.length() && !deserializeJson(doc, body)) {
    type  = (const char*)(doc["type"] | "");
    taskS = (const char*)(doc["task"] | "");
    det   = (const char*)(doc["detail"] | "");
    ts    = doc["ts"] | 0LL;
  } else {
    type = server.arg("type"); taskS = server.arg("task"); det = server.arg("detail");
  }

  // Hooks run async on the PC, so events can arrive out of order.
  if (ts && ts < lastEventTs) { server.send(200, "application/json", "{\"ok\":true,\"stale\":true}"); return; }
  if (ts) lastEventTs = ts;

  unsigned long now = millis();
  if (type == "working") {
    Task t = parseTask(taskS.length() ? taskS : String("think"));
    if (activity != ACT_WORKING) { setActivity(ACT_WORKING); setTask(t, det.c_str()); }
    else if (t == T_THINK && task != T_THINK && now - taskSince < 1500) {
      pendingThinkAt = taskSince + 1500;   // let short tool animations finish
    } else setTask(t, det.c_str());
    lastWorkEvent = now;
  }
  else if (type == "waiting") { setActivity(ACT_WAITING); setDetail(det.length() ? det.c_str() : "Tap me to dismiss"); }
  else if (type == "done")    { setActivity(ACT_DONE);    setDetail(det.c_str()); }
  else if (type == "idle")    { setActivity(ACT_IDLE); }
  else { server.send(400, "text/plain", "type must be working|waiting|done|idle"); return; }
  server.send(200, "application/json", "{\"ok\":true}");
}

void handleUsage() {
  JsonDocument doc;
  if (deserializeJson(doc, server.arg("plain"))) { server.send(400, "text/plain", "bad json"); return; }
  JsonVariantConst rl = doc["rate_limits"];
  if (rl.isNull()) rl = doc.as<JsonVariantConst>();
  auto readLimit = [](JsonVariantConst v, Limit& l) {
    if (v.isNull()) return;
    if (!v["used_percentage"].isNull()) l.pct = v["used_percentage"].as<float>();
    if (!v["resets_at"].isNull()) l.resetsAt = v["resets_at"].as<long long>();
  };
  readLimit(rl["five_hour"], fiveHour);
  readLimit(rl["seven_day"], sevenDay);
  server.send(200, "application/json", "{\"ok\":true}");
}

void handleStatus() {
  JsonDocument d;
  d["ip"] = WiFi.localIP().toString();
  d["activity"] = (int)activity;
  d["task"] = TASK_KEY[task];
  d["detail"] = actDetail;
  d["five_hour"]["used_percentage"] = fiveHour.pct;
  d["five_hour"]["resets_at"] = fiveHour.resetsAt;
  d["seven_day"]["used_percentage"] = sevenDay.pct;
  d["seven_day"]["resets_at"] = sevenDay.resetsAt;
  d["temp"] = (float)outdoorTemp;
  d["us_aqi"] = (int)usAqi;
  d["pm2_5"] = (float)pm25;
  String out; serializeJson(d, out);
  server.send(200, "application/json", out);
}

// =====================================================================
//                               SETUP
// =====================================================================
void bootMessage(const char* l1, const char* l2 = nullptr) {
  display.clearDisplay();
  textCenter(l2 ? 22 : 28, 1, l1);
  if (l2) textCenter(36, 1, l2);
  display.display();
}

void setup() {
  Serial.begin(115200);
  pinMode(TOUCH_PIN, INPUT);
  randomSeed(esp_random());

  Wire.begin(21, 22);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println(F("SSD1306 failed"));
    for (;;) delay(1000);
  }
  display.setTextColor(WHITE);
  display.setTextWrap(false);
  bootMessage("Clawd is waking up...");

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) delay(250);

  configTzTime(TZ_INFO, "pool.ntp.org", "time.google.com");

  if (WiFi.status() == WL_CONNECTED) {
    if (MDNS.begin(HOSTNAME)) MDNS.addService("http", "tcp", 80);
    String ip = WiFi.localIP().toString();
    Serial.println("IP: " + ip);
    bootMessage("deskbuddy.local", ip.c_str());
    delay(2000);
  } else {
    bootMessage("No WiFi yet,", "retrying...");
    delay(1500);
  }

  server.on("/", HTTP_GET, handleStatus);
  server.on("/usage", HTTP_POST, handleUsage);
  server.on("/event", HTTP_ANY, handleEvent);
  server.begin();

  // Weather + air are fetched on core 0 so HTTPS never freezes animations.
  xTaskCreatePinnedToCore(envTask, "env", 16384, nullptr, 1, nullptr, 0);

  lastInteraction = millis();
}

// =====================================================================
//                         WEATHER + AIR (core 0)
// =====================================================================
bool fetchJson(const String& url, JsonDocument& doc) {
  WiFiClientSecure client;
  client.setInsecure();               // public, read-only data
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(client, url)) return false;
  bool ok = false;
  if (http.GET() == 200) ok = !deserializeJson(doc, http.getString());
  http.end();
  return ok;
}

bool fetchEnv() {
  String loc = "latitude=" + String(LATITUDE, 4) + "&longitude=" + String(LONGITUDE, 4);
  bool ok = true;
  JsonDocument w;
  if (fetchJson("https://api.open-meteo.com/v1/forecast?" + loc + "&current=temperature_2m", w)) {
    JsonVariantConst t = w["current"]["temperature_2m"];
    if (!t.isNull()) outdoorTemp = t.as<float>();
  } else ok = false;
  JsonDocument a;
  if (fetchJson("https://air-quality-api.open-meteo.com/v1/air-quality?" + loc + "&current=us_aqi,pm2_5", a)) {
    JsonVariantConst q = a["current"]["us_aqi"];
    JsonVariantConst p = a["current"]["pm2_5"];
    if (!q.isNull()) usAqi = q.as<int>();
    if (!p.isNull()) pm25 = p.as<float>();
  } else ok = false;
  return ok;
}

void envTask(void*) {
  for (;;) {
    if (WiFi.status() == WL_CONNECTED) {
      bool ok = fetchEnv();
      vTaskDelay(pdMS_TO_TICKS(ok ? 10UL * 60 * 1000 : 30UL * 1000));
    } else vTaskDelay(pdMS_TO_TICKS(5000));
  }
}

// =====================================================================
//                                INPUT
// =====================================================================
void onSingleTap(unsigned long now) {
  if (activity == ACT_WAITING || activity == ACT_DONE) setActivity(ACT_IDLE);
  happyUntil = now + 1500;
  sitUntil = 0;
  hop(HOP_V);
}

void onDoubleTap(unsigned long now) {
  if (activity == ACT_WAITING || activity == ACT_DONE) setActivity(ACT_IDLE);
  rotIdx = (rotIdx + 1) % ROT_LEN;
  const Slot* rot = activity == ACT_WORKING ? WORK_ROT : IDLE_ROT;
  // skip a repeat of the card that's already showing
  if (rot[rotIdx].card == curCard) rotIdx = (rotIdx + 1) % ROT_LEN;
  switchCard(rot[rotIdx].card, now);
  holdUntil = now + 12000;
}

void onLongPress(unsigned long now) {
  if (activity == ACT_WAITING) setActivity(ACT_IDLE);
  petting = true;
  sitUntil = 0;
}

void onLongRelease(unsigned long now) {
  petting = false;
  happyUntil = now + 800;
}

void handleInput(unsigned long now) {
  bool touch = digitalRead(TOUCH_PIN);
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
    if (tapCount == 1) onSingleTap(now); else onDoubleTap(now);
    tapCount = 0;
  }
}

// =====================================================================
//                              INFO CARDS
// =====================================================================
void switchCard(Card c, unsigned long now) {
  if (c == curCard) return;
  prevCard = curCard;
  curCard = c;
  cardSince = now;
}

void updateCards(unsigned long now) {
  if (activity == ACT_WAITING || activity == ACT_DONE) { switchCard(C_ACT, now); return; }
  const Slot* rot = activity == ACT_WORKING ? WORK_ROT : IDLE_ROT;
  if (curCard != rot[rotIdx].card) { switchCard(rot[rotIdx].card, now); return; }
  if (now > holdUntil && now - cardSince > rot[rotIdx].ms) {
    rotIdx = (rotIdx + 1) % ROT_LEN;
    switchCard(rot[rotIdx].card, now);
    detailSince = now;
  }
}

void drawDegree(int x, int y, int r) { display.drawCircle(x + r, y + r, r, WHITE); }

void drawTimeCard(int yo) {
  char buf[24];
  if (timeOk) snprintf(buf, sizeof(buf), "%02d:%02d", nowTm.tm_hour, nowTm.tm_min);
  else strcpy(buf, "--:--");
  textAt(0, 1 + yo, 2, buf);

  if (!isnan(outdoorTemp)) {                       // "13°C", right aligned
    snprintf(buf, sizeof(buf), "%ld", lroundf(outdoorTemp));
    int w = strlen(buf) * 12 + 7 + 12;
    int x = SCREEN_W - w;
    textAt(x, 1 + yo, 2, buf);
    drawDegree(x + strlen(buf) * 12 + 1, 1 + yo, 2);
    textAt(x + strlen(buf) * 12 + 7, 1 + yo, 2, "C");
  }

  if (timeOk) strftime(buf, sizeof(buf), "%A, %d %b", &nowTm);
  else strcpy(buf, "syncing clock...");
  textAt(0, 21 + yo, 1, buf);
}

void drawAirCard(int yo) {
  int lvl = airLevel(usAqi);
  char buf[24];
  snprintf(buf, sizeof(buf), "Air: %s", lvl < 0 ? "..." : AIR_WORD[lvl]);
  textAt(0, 1 + yo, 2, buf);
  textAt(0, 21 + yo, 1, lvl < 0 ? "checking the sky" : AIR_ADVICE[lvl]);

  // pollution meter: 6 rising bars, filled up to the current level
  for (int i = 0; i < 6; i++) {
    int h = 2 + i;
    int x = 105 + i * 4, y = 28 + yo - h;
    if (lvl >= 0 && i <= lvl) display.fillRect(x, y, 3, h, WHITE);
    else display.drawFastHLine(x, 28 + yo, 3, WHITE);
  }
}

void drawLimitCard(int yo, bool weekly) {
  const Limit& l = weekly ? sevenDay : fiveHour;
  float p = effectivePct(l);
  char buf[24];
  if (p < 0) snprintf(buf, sizeof(buf), weekly ? "Week --" : "5h   --");
  else snprintf(buf, sizeof(buf), weekly ? "Week %d%%" : "5h   %d%%", (int)(p + 0.5f));
  textAt(0, 1 + yo, 2, buf);

  if (p < 0) { textAt(0, 21 + yo, 1, "open Claude Code"); return; }

  const int bw = 66, bh = 7, by = 21 + yo;
  display.drawRect(0, by, bw, bh, WHITE);
  int fill = (int)((bw - 4) * min(p, 100.0f) / 100.0f + 0.5f);
  if (fill > 0) display.fillRect(2, by + 2, fill, bh - 4, WHITE);

  if (l.resetsAt > 0 && clockValid()) {
    if (epochNow() >= l.resetsAt) { textRight(SCREEN_W, by, 1, "reset!"); return; }
    time_t r = (time_t)l.resetsAt;
    struct tm rt;
    localtime_r(&r, &rt);
    bool soon = l.resetsAt - epochNow() < 20 * 3600;
    strftime(buf, sizeof(buf), soon ? "til %H:%M" : "%a %H:%M", &rt);
    textRight(SCREEN_W, by, 1, buf);
  }
}

void drawActivityCard(int yo, unsigned long now) {
  const char* title = "Working";
  if (activity == ACT_WAITING) title = "Needs you!";
  else if (activity == ACT_DONE) title = "All done!";
  else if (activity == ACT_WORKING) title = TASK_LABEL[task];
  textAt(0, 1 + yo, 2, title);
  if (activity == ACT_WORKING && task == T_THINK && !actDetail[0]) {
    textAt(0, 21 + yo, 1, "...");
  } else marquee(actDetail, 21 + yo, detailSince, now);
}

void drawCard(Card c, int yo, unsigned long now) {
  switch (c) {
    case C_TIME: drawTimeCard(yo); break;
    case C_AIR:  drawAirCard(yo); break;
    case C_5H:   drawLimitCard(yo, false); break;
    case C_WEEK: drawLimitCard(yo, true); break;
    case C_ACT:  drawActivityCard(yo, now); break;
  }
}

void drawInfoBand(unsigned long now) {
  unsigned long t = now - cardSince;
  if (t < SLIDE_MS) {                       // slide old card up, new card in from below
    float p = (float)t / SLIDE_MS;
    p = 1 - (1 - p) * (1 - p);              // ease-out
    int off = (int)(p * (BAND_H + 2));
    drawCard(prevCard, -off, now);
    drawCard(curCard, BAND_H + 2 - off, now);
  } else drawCard(curCard, 0, now);
  display.fillRect(0, BAND_H, SCREEN_W, SCREEN_H - BAND_H, BLACK);  // clip
}

// =====================================================================
//                            MASCOT DRAWING
// =====================================================================
// ox, oy = top-left of the 14x7-cell grid at scale s.
void drawClawd(int ox, int oy, int s, Eyes eyes, int look, int lookY, int legs,
               int armL, int armR, bool sitting, int bob, bool mask) {
  int by = oy + bob;
  display.fillRect(ox + 2 * s, by, 10 * s, 5 * s, WHITE);                 // body
  display.fillRect(ox, by + (2 + armL) * s, 2 * s, s, WHITE);             // left arm
  display.fillRect(ox + 12 * s, by + (2 + armR) * s, 2 * s, s, WHITE);    // right arm
  if (!sitting) {
    const int legX[4] = {3, 5, 8, 10};
    for (int i = 0; i < 4; i++) {
      bool lifted = (legs == 1 && (i == 0 || i == 2)) || (legs == 2 && (i == 1 || i == 3));
      int top = by + 5 * s;
      int bottom = oy + 7 * s - (lifted ? s : 0);   // feet stay planted while breathing
      display.fillRect(ox + legX[i] * s, top, s, bottom - top, WHITE);
    }
  }

  if (s < 3) {                                       // mini-me: simple eyes
    display.fillRect(ox + 4 * s, by + s, s, 2 * s, BLACK);
    display.fillRect(ox + 9 * s, by + s, s, 2 * s, BLACK);
    return;
  }

  for (int e = 0; e < 2; e++) {
    int ex = ox + (e ? 9 : 4) * s + look;
    int ey = by + s + lookY;
    switch (eyes) {
      case EYE_OPEN:   display.fillRect(ex, ey, 3, 6, BLACK); break;
      case EYE_WIDE:   display.fillRect(ex - 1, ey - 1, 5, 8, BLACK); display.drawPixel(ex, ey, WHITE); break;
      case EYE_BLINK:  display.fillRect(ex, ey + 4, 3, 1, BLACK); break;
      case EYE_CLOSED: display.fillRect(ex - 1, ey + 4, 5, 1, BLACK); break;
      case EYE_TIRED:  display.fillRect(ex, ey + 3, 3, 3, BLACK); break;
      case EYE_HAPPY:
        for (int t = 0; t < 2; t++) {
          display.drawLine(ex - 1, ey + 4 + t, ex + 1, ey + 2 + t, BLACK);
          display.drawLine(ex + 1, ey + 2 + t, ex + 3, ey + 4 + t, BLACK);
        }
        break;
    }
  }

  if (mask) {                                        // smog mask over the lower face
    int mx0 = ox + 3 * s, my0 = by + 3 * s + 1;
    display.fillRect(mx0, my0, 8 * s, 2 * s - 1, BLACK);
    display.drawFastHLine(mx0 + 2, my0 + 2, 8 * s - 4, WHITE);
    display.drawLine(ox + 2 * s, by + 2 * s + 2, mx0, my0, BLACK);
    display.drawLine(ox + 12 * s - 1, by + 2 * s + 2, mx0 + 8 * s - 1, my0, BLACK);
  }
}

void drawSideBubble(int ox, int oy, const char* txt) {
  int w = strlen(txt) * 6 + 7, h = 11;
  int y = max(BAND_H + 2, oy - 4);
  int x = ox + MW + 2;
  if (x + w > SCREEN_W) x = ox - w - 2;
  x = max(0, x);
  display.fillRoundRect(x, y, w, h, 3, BLACK);
  display.drawRoundRect(x, y, w, h, 3, WHITE);
  textAt(x + 4, y + 2, 1, txt);
}

void drawHeart(int x, int y) {
  display.fillCircle(x - 2, y, 2, WHITE);
  display.fillCircle(x + 2, y, 2, WHITE);
  display.fillTriangle(x - 4, y + 1, x + 4, y + 1, x, y + 5, WHITE);
}

void drawZz(int ox, int oy, unsigned long now) {
  int p = (now / 140) % 16;
  textAt(min(ox + MW + 1 + p / 4, SCREEN_W - 6), oy + 2 - p / 3, 1, "z");
  int q = (p + 8) % 16;
  textAt(min(ox + MW + 5 + q / 4, SCREEN_W - 6), oy - 1 - q / 3, 1, "Z");
}

void drawSweat(int ox, int oy, unsigned long now) {
  int x = ox + 12 * S + 2;
  int y = oy + 1 + (now / 90) % 8;
  display.fillCircle(x, y, 1, WHITE);
  display.drawPixel(x, y - 2, WHITE);
}

void drawMagnifier(int ox, int oy, int dir) {
  int hx = dir > 0 ? ox + 14 * S : ox - 1;          // in front of the raised arm
  int hy = oy + S;
  display.drawLine(hx, hy, hx + dir * 3, hy - 3, WHITE);
  display.drawCircle(hx + dir * 6, hy - 6, 3, WHITE);
}

void drawSparks(int ox, int oy, int dir, unsigned long now) {
  int x = dir > 0 ? ox + 14 * S + 2 : ox - 3;
  int y = oy + 3 * S;
  for (int i = 0; i < 3; i++) display.drawPixel(x + dir * random(0, 6), y - random(0, 7), WHITE);
}

Mood currentMood(unsigned long now) {
  float u = maxUsage();
  if (u >= 100) return MOOD_EMPTY;
  if (u >= 90)  return MOOD_SWEATY;
  if (u >= 70)  return MOOD_TIRED;
  if (isNight() && now - lastInteraction > 5UL * 60000) return MOOD_SLEEPY;
  return MOOD_HAPPY;
}

void pingPong() {                                   // walk to the far side
  if (fabs(mx - targetX) < 0.5f) targetX = (mx < WALK_MAX / 2) ? WALK_MAX : 0;
}

void updateAndDrawMascot(unsigned long now) {
  // activity housekeeping
  if (activity == ACT_DONE && now - activitySince > 8000) setActivity(ACT_IDLE);
  if (activity == ACT_WORKING && now - lastWorkEvent > 10UL * 60000) setActivity(ACT_IDLE);
  if (pendingThinkAt && now >= pendingThinkAt) setTask(T_THINK, "");

  Mood mood = currentMood(now);
  Eyes eyes = EYE_OPEN;
  int armL = 0, armR = 0, lookY = 0;
  bool sitting = false, sweat = false, zz = false, heart = false;
  bool magnifier = false, sparks = false, dust = false, mini = false, speedLines = false;
  const char* bubble = nullptr;
  static char dots[4];
  float speed = (mood == MOOD_TIRED || mood == MOOD_SWEATY) ? 0.35f : 0.7f;

  if (activity == ACT_WORKING) {
    switch (task) {
      case T_THINK: {
        speed = 0.3f; lookY = -1;
        if (now > nextAction) { targetX = random(0, WALK_MAX + 1); nextAction = now + random(2500, 5000); }
        int n = (now / 350) % 4;
        for (int i = 0; i < 3; i++) dots[i] = i < n ? '.' : ' ';
        dots[3] = 0;
        bubble = dots;
        break;
      }
      case T_READ:
      case T_SEARCH:
        speed = task == T_SEARCH ? 1.3f : 0.45f;
        pingPong();
        magnifier = true;
        if (facing > 0) armR = -1; else armL = -1;
        break;
      case T_EDIT: {
        targetX = mx;                                // stay put and hammer
        bool down = (now / 150) % 2;
        if (facing > 0) armR = down ? 1 : -1; else armL = down ? 1 : -1;
        sparks = down;
        lookX = facing * 2;
        break;
      }
      case T_RUN: {
        speed = 2.6f;
        pingPong();
        dust = speedLines = true;
        bool f = (now / 80) % 2;                     // arms pumping
        armL = f ? -1 : 1; armR = f ? 1 : -1;
        bubble = "zoom";
        break;
      }
      case T_WEB:
        targetX = mx;
        if ((now / 900) % 2 == 0) hop(2.0f);
        lookX = ((now / 600) % 2) ? 2 : -2;
        bubble = "www";
        break;
      case T_AGENT:
        speed = 0.8f;
        pingPong();
        mini = true;
        break;
      default: {                                    // generic tool: typing
        targetX = mx;
        bool f = (now / 130) % 2;
        armL = f ? -1 : 0; armR = f ? 0 : -1;
      }
    }
  } else if (activity == ACT_WAITING) {
    unsigned long t = now - activitySince;
    eyes = EYE_WIDE; armL = armR = -1;
    targetX = mx;
    if (t < 20000) hop(HOP_V);
    if (t < 20000 || (now / 500) % 2) bubble = "!";
  } else if (activity == ACT_DONE) {
    eyes = EYE_HAPPY;
    targetX = mx;
    bool f = (now / 250) % 2;                        // little dance
    armL = f ? -1 : 0; armR = f ? 0 : -1;
    if (now - activitySince < 2500) hop(HOP_V);
    lookX = f ? 1 : -1;
  } else {                                           // idle life
    if ((mood == MOOD_EMPTY || mood == MOOD_SLEEPY) && !petting && now > happyUntil) {
      sitting = true; zz = true; eyes = EYE_CLOSED; targetX = mx;
    } else {
      if (now > nextAction) {
        int r = random(100);
        if (r < 35)      targetX = random(0, WALK_MAX + 1);
        else if (r < 50) { lookX = random(2) ? -2 : 2; lookUntil = now + 900; }
        else if (r < 62 && mood == MOOD_HAPPY) hop(HOP_V);
        else if (r < 72) stretchUntil = now + 1200;
        else if (r < 80 && mood == MOOD_HAPPY) { sitUntil = now + 4000; targetX = mx; }
        nextAction = now + random(2000, 5500);
      }
      if (now < stretchUntil) { armL = armR = -1; lookY = -1; }
      if (now < sitUntil) sitting = true;
      if (mood == MOOD_TIRED)  eyes = EYE_TIRED;
      if (mood == MOOD_SWEATY) { eyes = EYE_TIRED; sweat = true; }
    }
  }

  if (petting) { eyes = EYE_HAPPY; heart = true; bubble = nullptr; zz = false; targetX = mx; }
  else if (now < happyUntil && activity == ACT_IDLE) eyes = EYE_HAPPY;

  // walking
  bool walking = false;
  if (!sitting && fabs(targetX - mx) > 0.5f) {
    facing = targetX > mx ? 1 : -1;
    mx += facing * min(speed, fabsf(targetX - mx));
    walking = true;
    if (task != T_EDIT || activity != ACT_WORKING) lookX = facing * 2;
    unsigned long stepMs = speed >= 2 ? 60 : speed >= 1 ? 100 : 160;
    if (now - lastStep > stepMs) { legPhase = (legPhase == 1) ? 2 : 1; lastStep = now; }
  } else {
    legPhase = 0;
    if (now > lookUntil && activity != ACT_DONE && !(activity == ACT_WORKING && (task == T_EDIT || task == T_WEB)))
      lookX = 0;
  }
  mx = constrain(mx, 0.0f, (float)WALK_MAX);

  // jump physics
  if (jumpV != 0 || jumpY > 0) {
    jumpY += jumpV; jumpV -= 0.5f;
    if (jumpY <= 0) { jumpY = 0; jumpV = 0; }
  }

  // blinking
  if (now > nextBlink) { blinkUntil = now + 120; nextBlink = now + random(1500, 5000); }
  if (now < blinkUntil && (eyes == EYE_OPEN || eyes == EYE_TIRED || eyes == EYE_WIDE)) eyes = EYE_BLINK;

  int bob = (!walking && jumpY == 0 && !sitting && (now / 700) % 2) ? 1 : 0;
  int ox = (int)(mx + 0.5f);
  int oy = sitting ? GROUND_Y - 5 * S : GROUND_Y - MH - (int)jumpY;

  // ground + shadow
  for (int x = 0; x < SCREEN_W; x += 4) display.drawPixel(x, GROUND_Y + 1, WHITE);
  int shadow = max(10, 30 - (int)jumpY * 3);
  display.drawFastHLine(ox + MW / 2 - shadow / 2, GROUND_Y + 2, shadow, WHITE);

  // dust puffs behind a sprinting mascot
  if (dust && walking && now - lastPuff > 110) {
    puffs[puffIdx] = {facing > 0 ? ox + 2 : ox + MW - 2, now};
    puffIdx = (puffIdx + 1) % 5;
    lastPuff = now;
  }
  for (auto& p : puffs) {
    unsigned long age = now - p.born;
    if (p.born && age < 350) display.drawCircle(p.x, GROUND_Y - 1 - age / 120, 1 + age / 150, WHITE);
  }

  // mini-me for delegating
  if (mini) {
    float target = mx + (facing > 0 ? -18 : MW + 4);
    miniX += (target - miniX) * 0.08f;
    int mxi = constrain((int)miniX, 0, SCREEN_W - 14);
    bool step = (now / 120) % 2;
    drawClawd(mxi, GROUND_Y - 7, 1, EYE_OPEN, 0, 0, step ? 1 : 2, 0, 0, false, 0, false);
  } else miniX = mx;

  bool mask = airLevel(usAqi) >= 3 && !sitting;
  drawClawd(ox, oy, S, eyes, lookX, lookY, legPhase, armL, armR, sitting, bob, mask);

  if (speedLines && walking) {                       // motion streaks behind it
    for (int i = 0; i < 3; i++) {
      int len = 6 + (int)((now / 60 + i * 3) % 7);
      int y = oy + 3 + i * 5;
      int x = facing > 0 ? ox - 3 - len : ox + MW + 3;
      display.drawFastHLine(x, y, len, WHITE);
    }
  }
  if (magnifier) drawMagnifier(ox, oy, facing);
  if (sparks) drawSparks(ox, oy, facing, now);
  if (sweat) drawSweat(ox, oy, now);
  if (zz) drawZz(ox, oy, now);
  if (heart) drawHeart(ox + MW / 2, max(BAND_H + 4, oy - 6 - (int)((now / 150) % 3)));
  if (bubble) drawSideBubble(ox, oy, bubble);
}

// =====================================================================
//                                LOOP
// =====================================================================
void loop() {
  server.handleClient();
  unsigned long now = millis();
  handleInput(now);

  static unsigned long lastFrame = 0;
  if (now - lastFrame < 33) return;   // ~30 fps
  lastFrame = now;

  timeOk = getLocalTime(&nowTm, 0);
  bool wantDim = isNight();
  if (wantDim != dimmed) { display.dim(wantDim); dimmed = wantDim; }

  display.clearDisplay();
  updateCards(now);
  drawInfoBand(now);
  updateAndDrawMascot(now);

  bool wantInvert = now < flashUntil && ((now / 200) % 2 == 0);
  if (wantInvert != inverted) { display.invertDisplay(wantInvert); inverted = wantInvert; }
  display.display();
}
