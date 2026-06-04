# EcoFlow PowerStream Monitor PWA

A single-file Progressive Web App for monitoring EcoFlow PowerStream MicroInverter devices (STREAM series) in real time. No server required — runs entirely in your browser.

https://danielw3b.github.io/ecoflow-powerstream-pwa/

![EcoFlow Monitor Screenshot](screenshot-mobile.png)


![EcoFlow Monitor Screenshot](screenshot.png)

## Features

- **Real-time monitoring** — live solar power, grid feed-in, battery state via MQTT over WebSocket
- **More than Two inverter support** — side-by-side device cards with individual charts
- **Energy History** — Hour / Day / Month / Year bar charts with kWh accumulation
- **Weather widget** — current conditions via Open-Meteo (no API key needed)
- **CSV export** — per-device or combined, unit auto-scales by period
- **Offline detection** — instant via MQTT `/status` topic + API polling fallback
- **PWA installable** — add to home screen on Android/iOS, works as standalone app
- **Screen wake lock** — keeps display on while monitoring
- **Editable device names** — stored in localStorage
- **No server** — pure browser app, all data stays on your device
- **Dark theme** — high contrast, readable in direct sunlight

## Requirements

- EcoFlow Developer API access key + secret key
  → Register at [developer-eu.ecoflow.com](https://developer-eu.ecoflow.com) (EU) or [developer.ecoflow.com](https://developer.ecoflow.com)
- EcoFlow PowerStream MicroInverter (STREAM series, 600W or 800W)
- Modern browser (Chrome 84+, Edge, Brave)

## Quick Start

### Option A — Open directly (simplest)
1. Download `index.html`
2. Open it in Chrome on Android using a local HTTP server app (e.g. *HTTP Server* by paw.app)
3. Tap **⚙** → enter your Access Key and Secret Key → **Connect**
4. Install as PWA: browser menu → **Add to Home Screen**

### Option B — GitHub Pages (share with others)
1. Fork this repository
2. Settings → Pages → Source: main branch
3. Share `https://yourusername.github.io/ecoflow-pwa`
4. Each user enters their own API keys — nothing is stored server-side

### Option C — Local network access
Set `SERVER_URL` at the top of `index.html` to your server's IP if hosting via Node.js.

## Configuration

All settings are stored in `localStorage` — nothing leaves your device.

| Setting | Description |
|---|---|
| Access Key | EcoFlow developer API access key |
| Secret Key | EcoFlow developer API secret key |
| Region | EU (`api-e.ecoflow.com`) or Global (`api.ecoflow.com`) |

## Technical Details

### Architecture
```
EcoFlow STREAM Inverters
    ↓ MQTT (protobuf)
EcoFlow Cloud Broker  (mqtt-e.ecoflow.com)
    ↓ MQTT over WebSocket (wss port 8084)
index.html (browser)
    ├── HMAC-SHA256 signing (Web Crypto API)
    ├── REST API calls (device list, MQTT credentials)
    ├── Canvas charts (power + energy history)
    └── localStorage (Wh history, device names, config)
```

![EcoFlow Monitor Screenshot](ecoflow_pwa_architecture.svg)

### API Used
- `GET /iot-open/sign/device/list` — fetch devices + online status
- `GET /iot-open/sign/certification` — get MQTT broker credentials
- MQTT topic `subscribe`: `/open/${certificateAccount}/${sn}/quota` — live telemetry (JSON)
- MQTT topic `subscribe`: `/open/${certificateAccount}/${sn}/status` — online/offline events
- [Open-Meteo](https://open-meteo.com) — weather (no key required)

### Real Device Field Names
The STREAM inverter sends different field names than the official documentation:

| Field | Description | Unit |
|---|---|---|
| `powGetPv` | PV1 power | W (float) |
| `powGetPv2` | PV2 power | W (float) |
| `gridConnectionPower` | Grid feed-in power | W (float) |
| `gridConnectionVol` | Grid voltage | V |
| `gridConnectionFreq` | Grid frequency | Hz |
| `gridConnectionSta` | Grid connection status | string |
| `plugInInfoPvVol` | PV1 voltage | V (float) |
| `plugInInfoPv2Vol` | PV2 voltage | V (float) |
| `plugInInfoPvAmp` | PV1 current | A (float) |
| `plugInInfoPv2Amp` | PV2 current | A (float) |

### MQTT Notes
- Port **8084** (WebSocket/TLS) — not 8883 (raw TCP)
- Credentials from `/iot-open/sign/certification` — valid long-term
- Devices send **incremental updates** — fields arrive in small batches, state is merged
- Multiple browser tabs/devices can connect simultaneously

## Energy History

Wh values are accumulated locally using the trapezoid method:
- Readings ≤ 3 min apart → `Wh += avg_watts × hours`
- Gaps > 3 min → skipped (reconnects, night, etc.)
- Hour view: rolling 24 hours
- Day view: last 30 days
- Month/Year: aggregated from daily data
- Persisted in `localStorage` — survives page reloads and app restarts

## AI Assistant Reference

This project was built collaboratively with **Claude** (Anthropic) over an extended conversation including:
- Reverse engineering the EcoFlow STREAM MQTT protocol and real device field names
- Debugging MQTT broker authentication (open API vs consumer API)
- Designing the single-file PWA architecture with no server dependency
- Iterative UI development based on real-world mobile testing

Claude's assistance was instrumental in navigating undocumented API behaviour and building a production-quality app from scratch. Model used: Claude Sonnet (claude.ai).

At the end also Gemini, Google’s primary conversational and agentic AI assistant was involved 
to recover the strange disappearance of code fragments in the last build. :)

## License

MIT License — see `LICENSE` file.

## Contributing

Issues and pull requests welcome. Tested with:
- EcoFlow STREAM MicroInverter 600W / 800W (BK01Z series)
- Chrome on Android, Brave Browser
- EU region (api-e.ecoflow.com)

---
*Not affiliated with EcoFlow Technology Inc.*
