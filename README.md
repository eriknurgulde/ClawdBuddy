# ClawdBuddy

A tiny pixel critter that lives on a 128×64 OLED on your desk and acts out what **Claude Code** is doing: it reads with a magnifying glass, hammers while editing, sprints while commands run, and jumps up and down when Claude needs your permission. It also shows your **Claude usage limits**, the **time**, the **temperature** and **how polluted the air is**, in plain words.

Built from an ESP32, an SSD1306 OLED and a push button: about $10 of parts.
**No hardware?** Run the [screen version](#screen-version-no-hardware): the exact same buddy in a small always-on-top window in the corner of your screen.

> Fan project. Not affiliated with or endorsed by Anthropic.

## What it shows

The screen is split into an **info card** on top (big text, slides to the next card every few seconds) and the **mascot's world** below.

| Card | Example |
|---|---|
| Time + weather | `14:32      13°C` / `Tuesday, 03 Nov` |
| Air quality | `Air: Fine` / `OK to air out` + pollution meter |
| 5-hour limit | `5h   10%` / progress bar, `til 12:50` |
| Weekly limit | `Week 52%` / progress bar, `Tue 16:00` |
| Claude activity | `Editing` / `ClawdBuddy.ino` (long text scrolls) |

Air quality is shown as **Clean → Fine → Hazy → Smog → Bad! → Toxic** with a hint like *"Open the windows"* or *"Windows shut!"* (based on US AQI from Open-Meteo).

## What the mascot does

| Claude Code is… | Mascot |
|---|---|
| thinking | wanders slowly, looks up, `...` bubble |
| reading files | strolls with a magnifying glass |
| searching (Grep/Glob) | hurries back and forth with the magnifier |
| editing / writing | hammers away, sparks fly |
| running commands | sprints with speed lines and dust, `zoom` |
| browsing the web | hops and looks around, `www` |
| running a subagent | walks with a mini-me following |
| waiting for permission | screen flashes, jumps with `!` |
| done | happy dance, scrolls Claude's last message |

Also: wanders, hops, stretches and sits when idle · tired eyes at ≥70% usage, sweating at ≥90%, asleep at 100% · wears a mask when air is smoggy · dims and sleeps at night.

**Button:** tap = hop / dismiss alert · double tap = next card · long press = pet it ♥

## Hardware

| Part | Notes |
|---|---|
| ESP32 dev board | any classic ESP32 (WROOM-32) |
| SSD1306 0.96" OLED, 128×64, I²C | address `0x3C` |
| Push button | or a TTP223 touch module |

| Module pin | ESP32 pin |
|---|---|
| OLED VCC / GND | 3V3 / GND |
| OLED SDA | GPIO 21 |
| OLED SCL | GPIO 22 |
| Button | between GPIO 23 and 3V3 (no resistor needed) |
| *or* TTP223 VCC / GND / SIG | 3V3 / GND / GPIO 23 |

## Setup

### 1. Flash the ESP32

1. Install the **esp32** board package (v3.x) in Arduino IDE.
2. Install libraries: **Adafruit SSD1306**, **Adafruit GFX**, **ArduinoJson** (v7).
3. Copy `config.example.h` to `config.h` and set your WiFi, location and timezone.
   (`config.h` is git-ignored, so your password stays local.)
4. Open `ClawdBuddy.ino`, select **ESP32 Dev Module**, upload.

On boot the screen shows `deskbuddy.local` and the board's IP address.

### 2. Connect Claude Code

You need Python 3 on the computer where you run Claude Code.

```bash
python pc/install.py
```

This adds a status line and a few hooks to `~/.claude/settings.json` (a backup is saved first). Restart Claude Code and the mascot comes alive.

If `deskbuddy.local` doesn't resolve on your network, point the scripts at the IP instead by setting an environment variable, e.g. in `~/.claude/settings.json`:

```json
"env": { "DESKBUDDY_HOST": "192.168.1.132" }
```

To remove everything: `python pc/install.py --uninstall`

## Screen version (no hardware)

`web/` is a 1:1 port of the firmware: the same 128×64 frame buffer, Adafruit GFX drawing code and font, rendered crisp in a small always-on-top window in the corner of your screen. Run it instead of, or alongside, the ESP32. Both get the same updates.

```bash
python web/webbuddy.py                    # opens the window (bottom-right corner)
python web/webbuddy.py --install-startup  # start it automatically at login (Windows)
python web/webbuddy.py --uninstall-startup
```

It needs Python 3 and Edge or Chrome. It opens the page as a small app window and keeps it on top. Close the window to stop it. The mouse is the button: **click** = tap, **double click** = next card, **hold** = pet.

The server only listens on `127.0.0.1:8787`. To change the location, corner or size, create `web/config.json`:

```json
{ "place": "Berlin", "latitude": 52.52, "longitude": 13.40,
  "corner": "bottom-right", "scale": 3, "night_start": 23, "night_end": 7 }
```

On macOS/Linux, `python web/webbuddy.py --no-window` runs the server; open `http://127.0.0.1:8787` yourself.

`pc/deskbuddy.py` sends every update to both the board (`DESKBUDDY_HOST`) and the screen buddy (`DESKBUDDY_WEB`). Set either one to `off` if you don't use it.

## How it works

```
Claude Code ──status line (rate_limits JSON)──► pc/deskbuddy.py ──HTTP──► ESP32 /usage  + screen buddy
            ──hooks (prompt, tools, stop…)────► pc/deskbuddy.py ──HTTP──► ESP32 /event  + screen buddy
ESP32 ──HTTPS──► Open-Meteo (temperature, US AQI, PM2.5), NTP (time)
```

- **Usage limits** come from the official `rate_limits` field Claude Code passes to status line scripts (Pro/Max plans). The numbers are shared with the Claude apps, so the bars show your real total. They refresh whenever Claude Code is active; in between, the board counts down to the reset on its own.
- **Activity** comes from Claude Code hooks registered with `"async": true`, so they never slow Claude down. Every network call has a 1 s timeout and failures are ignored. If the board is unplugged, nothing happens.
- Weather and air quality are fetched on the ESP32's second core every 10 minutes, so animations never stutter.

### HTTP API

Handy for scripting or testing without Claude Code:

```bash
curl http://deskbuddy.local/                                   # status JSON
curl -X POST http://deskbuddy.local/event -d '{"type":"working","task":"run","detail":"npm test"}'
curl -X POST http://deskbuddy.local/event -d '{"type":"waiting","detail":"Needs permission"}'
curl -X POST http://deskbuddy.local/usage -d '{"five_hour":{"used_percentage":42,"resets_at":1893456000}}'
```

`type`: `working` · `waiting` · `done` · `idle`
`task`: `think` · `read` · `search` · `edit` · `run` · `web` · `agent` · `tool`

## Troubleshooting

- **Bars show `--`**: usage appears after Claude Code's first response in a session, and only on Pro/Max plans.
- **Nothing reacts**: open `http://deskbuddy.local/` in a browser. If it doesn't load, set `DESKBUDDY_HOST` to the IP shown on boot.
- **Clock is off**: check `TZ_INFO` in `config.h` (POSIX format, the sign is inverted: UTC+5 is `<+05>-5`).
- **Status line**: a custom status line hides some footer hints in Claude Code (like `esc to interrupt`; Esc still works).

## Credits

Hardware and touch-input approach inspired by the [ESP32 OLED Desk Bot](https://github.com/Abaymelethil) by Abay Melethil (MIT).
The screen version embeds the classic 5x7 font from [Adafruit GFX](https://github.com/adafruit/Adafruit-GFX-Library) (BSD license).

## License

MIT
