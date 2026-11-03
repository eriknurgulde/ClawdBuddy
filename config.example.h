// ClawdBuddy configuration
// Copy this file to config.h (same folder) and edit the values.
#pragma once

// WiFi (ESP32 supports 2.4 GHz networks only)
const char* WIFI_SSID = "your-wifi-name";
const char* WIFI_PASS = "your-wifi-password";

// The board will be reachable as http://<HOSTNAME>.local
const char* HOSTNAME = "deskbuddy";

// Location for weather + air quality (find yours at https://www.latlong.net)
const char* PLACE_NAME = "Almaty";
#define LATITUDE  43.2295
#define LONGITUDE 76.8374

// POSIX timezone string. Note the inverted sign: UTC+5 is "<+05>-5".
// Examples: "UTC0", "CET-1CEST,M3.5.0,M10.5.0/3" (Berlin),
//           "EST5EDT,M3.2.0,M11.1.0" (New York), "<+05>-5" (Almaty)
// Full list: https://github.com/nayarsystems/posix_tz_db/blob/master/zones.csv
const char* TZ_INFO = "<+05>-5";

// Night mode: screen dims and the mascot falls asleep when left alone
const int NIGHT_START = 23;
const int NIGHT_END   = 7;

// Button on GPIO 23. Default: button between GPIO 23 and 3V3 (internal pull-down).
// Set to true if your button connects GPIO 23 to GND instead (internal pull-up).
// A TTP223 touch module works with the default.
#define BUTTON_ACTIVE_LOW false
