---
name: ecoflow-powerstream
description: >
  Use when building apps, scripts or integrations for EcoFlow PowerStream
  MicroInverter devices (STREAM series, model BK01Z). Covers API signing,
  MQTT connection over WebSocket, real device field names (which differ from
  the official docs), offline detection, and single-file PWA architecture.
  Trigger on any mention of EcoFlow, PowerStream, STREAM inverter, mqtt-e.ecoflow.com,
  or EcoFlow developer API.
version: "1.0"
author: "Built with Claude (Anthropic) — claude.ai"
---

# EcoFlow PowerStream MQTT & PWA Skill

## When to use this skill
Use when building apps, scripts or automations for EcoFlow PowerStream MicroInverter devices
(STREAM series, model BK01Z). Covers API signing, MQTT connection, real device field names,
and single-file PWA architecture.

---

## 1. API Signing (HMAC-SHA256)

**Endpoint base (EU):** `https://api-e.ecoflow.com`
**Endpoint base (Global):** `https://api.ecoflow.com`

Signature algorithm (from official Java demo `MyMapUtil.java`):
1. Flatten request body recursively: nested objects → dot notation (`a.b=v`), arrays → bracket notation (`a[0]=v`)
2. Sort flattened keys alphabetically
3. Build string: `sorted_k=v&...&accessKey=X&nonce=X&timestamp=X`
   — accessKey/nonce/timestamp are **appended after** sorted params, NOT sorted into them
4. HMAC-SHA256 hex of that string using secretKey

```javascript
function flattenObject(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const ak = `${key}[${i}]`;
        if (item !== null && typeof item === "object") Object.assign(out, flattenObject(item, ak));
        else out[ak] = item;
      });
    } else if (v !== null && typeof v === "object") {
      Object.assign(out, flattenObject(v, key));
    } else { out[key] = v; }
  }
  return out;
}

function buildSign(params, accessKey, secretKey, nonce, ts) {
  const flat   = params ? flattenObject(params) : {};
  const kvStr  = Object.keys(flat).sort().map(k => `${k}=${flat[k]}`).join("&");
  const payload = kvStr
    ? `${kvStr}&accessKey=${accessKey}&nonce=${nonce}&timestamp=${ts}`
    : `accessKey=${accessKey}&nonce=${nonce}&timestamp=${ts}`;
  return crypto.createHmac("sha256", secretKey).update(payload).digest("hex");
}
```

---

## 2. Key REST Endpoints

```
GET /iot-open/sign/device/list
  → returns devices[] with .sn, .deviceName, .online (1=online, 0=offline)

GET /iot-open/sign/certification
  → returns {url, port, certificateAccount, certificatePassword}
  → use certificateAccount as MQTT clientId AND username
```

**Note:** `GET /iot-open/sign/device/quota/all?sn=X` returns empty for STREAM devices — not supported via REST. Use MQTT instead.

---

## 3. MQTT Connection

**Broker:** `mqtt-e.ecoflow.com`
**Port for raw TCP/TLS:** 8883 — works with developer credentials
**Port for WebSocket/TLS:** 8084 — required for browser PWA

```javascript
// Node.js (raw TLS)
const sock = tls.connect({ host: "mqtt-e.ecoflow.com", port: 8883, rejectUnauthorized: false });

// Browser (WebSocket)
const ws = new WebSocket("wss://mqtt-e.ecoflow.com:8084/mqtt", ["mqtt"]);
```

**MQTT CONNECT packet:**
- clientId = `certificateAccount`
- username = `certificateAccount`
- password = `certificatePassword`
- keepAlive = 30s

**Subscribe topics:**
```
/open/${certificateAccount}/${sn}/quota   ← live telemetry (JSON, incremental)
/open/${certificateAccount}/${sn}/status  ← online/offline events
```

**Publish topics (set commands):**
```
/open/${certificateAccount}/${sn}/set
```

---

## 4. Real Device Field Names (STREAM MicroInverter)

The device sends **different field names** than the official documentation. Fields arrive in small incremental batches — merge into accumulated state:

| Real Field | Doc Field | Description | Unit |
|---|---|---|---|
| `powGetPv` | `pv1InputWatts` | PV1 power | W (float, no ÷10) |
| `powGetPv2` | `pv2InputWatts` | PV2 power | W (float, no ÷10) |
| `gridConnectionPower` | `invOutputWatts` | Grid feed-in | W (float) |
| `gridConnectionVol` | `invOutputVolt` | Grid voltage | V (float) |
| `gridConnectionFreq` | `invFreq` | Grid frequency | Hz (float) |
| `gridConnectionAmp` | `invOutputCur` | Grid current | A (float) |
| `gridConnectionSta` | — | Status string | e.g. "PANEL_FEED_GRID" |
| `plugInInfoPvVol` | `pv1InputVolt` | PV1 voltage | V (float, no ÷10) |
| `plugInInfoPv2Vol` | `pv2InputVolt` | PV2 voltage | V (float) |
| `plugInInfoPvAmp` | `pv1InputCur` | PV1 current | A (float) |
| `plugInInfoPv2Amp` | `pv2InputCur` | PV2 current | A (float) |
| `moduleWifiRssi` | `wifiRssi` | WiFi signal | dBm (float) |
| `feedGridModePowMax` | `ratedPower` | Max feed power | W |
| `batSoc` | `batSoc` | Battery % | int |

**Doc fields that use ÷10 scaling** (integer × 0.1 = real value):
`pv1InputVolt`, `pv1InputCur`, `pv1InputWatts`, `pv2InputVolt`, `pv2InputCur`,
`pv2InputWatts`, `batInputVolt`, `batInputCur`, `batInputWatts`, `batTemp`,
`invOutputVolt`, `invOutputCur`, `invOutputWatts`, `invFreq`

---

## 5. MQTT Message Format

**Quota push** (device → app):
```json
{
  "powGetPv": 349.6,
  "gridConnectionPower": 205.3,
  "gridConnectionVol": 234.1,
  "gridConnectionFreq": 49.99,
  "plugInInfoPvVol": 32.31,
  "plugInInfoPvAmp": 0.783
}
```
Fields arrive in small partial batches (2–6 fields at a time). Merge into accumulated state. Full upload every ~2 min (`displayPropertyFullUploadPeriod: 120000`).

**Status push:**
```json
{ "params": { "status": 1 } }   // 1 = online, 0 = offline
```

---

## 6. Offline Detection Strategy

**Primary:** Subscribe to `/open/${clientId}/${sn}/status` — instant online/offline
**Secondary:** Poll `GET /iot-open/sign/device/list` every 2 min — check `.online` field
**Fallback timer:** If no data for 5 min → mark offline (do NOT use short timers, causes loops)

**Critical:** On MQTT reconnect, do NOT reset device status to "waiting" — keep existing live/offline state. Only set "waiting" on very first subscription ever.

---

## 7. Known Limitations & Gotchas

- **No historical data API** for PowerStream — accumulate from live MQTT only
- **Consumer API** (`api.ecoflow.com/auth/login`) does not work for SSO (Google) accounts
- **MQTT credentials** from `/iot-open/sign/certification` are long-lived but scene-specific
- **Multiple tabs/devices** can connect simultaneously with same `certificateAccount` clientId — broker handles it fine
- **Incremental updates** — never assume a full state in one message, always merge
- **Binary protobuf** format exists on consumer MQTT (port 8883 consumer broker) but open API delivers JSON
- **`POST /iot-open/sign/device/quota`** always returns `[8521] signature is wrong` — use GET instead
- **`GET /iot-open/sign/device/quota/all`** returns `code:0` but empty `data` for STREAM — not supported

---

## 8. Single-File PWA Pattern

The app works as a standalone `index.html` opened from `file://` or served locally:
- WebSocket to `wss://mqtt-e.ecoflow.com:8084/mqtt` works from `file://` origin
- CORS: EcoFlow API allows browser requests with valid signatures
- Service Workers do NOT work on `file://` — omit or handle gracefully
- `localStorage` for config, Wh history, device names
- Screen Wake Lock API (`navigator.wakeLock.request("screen")`) keeps display on

---

## 9. AI Assistant Reference

This skill was derived from a real production app built with **Claude** (Anthropic, claude.ai).
The complete development conversation is available as a transcript covering:
- Protocol reverse engineering
- MQTT authentication debugging
- PWA architecture decisions
- Mobile UI iteration

Model: Claude Sonnet 4.6
