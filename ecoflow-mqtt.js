/**
 * EcoFlow STREAM / PowerStream — MQTT Client
 * Fixed per official documentation + Java demo:
 *  - Topic:    /open/${certificateAccount}/${sn}/quota
 *  - Certs:    /iot-open/sign/certification
 *  - Sign:     sorted_params&accessKey=x&nonce=x&timestamp=x
 *  - Payload:  plain JSON (not binary)
 *
 * Zero dependencies — Node.js built-ins only.
 * Run: node ecoflow-mqtt.js
 */
"use strict";

const tls    = require("tls");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

// ─── Your credentials ────────────────────────────────────────────────────────
const ACCESS_KEY = "your_access_key_here";
const SECRET_KEY = "your_secret_key_here";
const BASE_URL   = "https://api-e.ecoflow.com";

// ─── Logging config ───────────────────────────────────────────────────────────
const LOG_DIR  = __dirname;
const LOG_FILE = path.join(LOG_DIR, "ecoflow.log");
const csvInit  = {};

// ─── Signature (exactly as Java demo MyMapUtil.java) ─────────────────────────
function makeNonce() { return String(Math.floor(10000 + Math.random() * 990000)); }

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
    } else {
      out[key] = v;
    }
  }
  return out;
}

function buildSign(params, accessKey, secretKey, nonce, timestamp) {
  const flat   = params ? flattenObject(params) : {};
  const kvStr  = Object.keys(flat).sort().map(k => `${k}=${flat[k]}`).join("&");
  const payload = kvStr
    ? `${kvStr}&accessKey=${accessKey}&nonce=${nonce}&timestamp=${timestamp}`
    : `accessKey=${accessKey}&nonce=${nonce}&timestamp=${timestamp}`;
  return crypto.createHmac("sha256", secretKey).update(payload).digest("hex");
}

// ─── REST helper ──────────────────────────────────────────────────────────────
async function apiGet(path, params = null) {
  const ts    = String(Date.now());
  const nonce = makeNonce();
  const sign  = buildSign(params, ACCESS_KEY, SECRET_KEY, nonce, ts);
  const headers = { accessKey: ACCESS_KEY, timestamp: ts, nonce, sign, "Content-Type": "application/json;charset=UTF-8" };

  let url = `${BASE_URL}${path}`;
  if (params) {
    const flat = flattenObject(params);
    const qs   = Object.keys(flat).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(flat[k])}`).join("&");
    if (qs) url += `?${qs}`;
  }

  const res  = await fetch(url, { method: "GET", headers });
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) throw new Error(`[${json.code}] ${json.message}`);
  return json.data;
}

// ─── CSV + rolling log ────────────────────────────────────────────────────────
function logCsv(sn, name, data) {
  const file = path.join(LOG_DIR, `ecoflow-${sn}.csv`);
  const keys = Object.keys(data);
  const ts   = new Date().toISOString();
  if (!csvInit[sn] && !fs.existsSync(file))
    fs.writeFileSync(file, ["timestamp", "device", ...keys].join(",") + "\n", "utf8");
  csvInit[sn] = true;
  fs.appendFileSync(file, [ts, `"${name}"`, ...keys.map(k => data[k])].join(",") + "\n", "utf8");
}

function logText(lines) {
  fs.appendFileSync(LOG_FILE, lines.join("\n") + "\n", "utf8");
}

// ─── MQTT 3.1.1 builders ──────────────────────────────────────────────────────
function encLen(n){const o=[];do{let b=n%128;n=Math.floor(n/128);if(n)b|=0x80;o.push(b);}while(n);return Buffer.from(o);}
function mStr(s){const b=Buffer.from(s,"utf8"),h=Buffer.alloc(2);h.writeUInt16BE(b.length,0);return Buffer.concat([h,b]);}
function mqttConnect(id,u,p){const vh=Buffer.concat([mStr("MQTT"),Buffer.from([4,0xC2,0,30])]);const pl=Buffer.concat([mStr(id),mStr(u),mStr(p)]);const body=Buffer.concat([vh,pl]);return Buffer.concat([Buffer.from([0x10]),encLen(body.length),body]);}
function mqttSub(pid,t,q=1){const p=Buffer.alloc(2);p.writeUInt16BE(pid,0);const b=Buffer.concat([p,mStr(t),Buffer.from([q])]);return Buffer.concat([Buffer.from([0x82]),encLen(b.length),b]);}
const PINGREQ  = Buffer.from([0xC0, 0x00]);
const PINGRESP = Buffer.from([0xD0, 0x00]);

// ─── MQTT parser ──────────────────────────────────────────────────────────────
function parseMqtt(buf, h) {
  let off = 0;
  while (off < buf.length) {
    const fb = buf[off], type = (fb >> 4) & 0xF;
    let pos = off + 1, mul = 1, rlen = 0;
    for (let i = 0; i < 4; i++) {
      if (pos >= buf.length) return off;
      const b = buf[pos++]; rlen += (b & 0x7F) * mul; mul *= 128;
      if (!(b & 0x80)) break;
    }
    if (pos + rlen > buf.length) return off;
    const body = buf.slice(pos, pos + rlen); off = pos + rlen;
    if      (type === 2)  h.connack(body[1]);
    else if (type === 3) {
      const qos = (fb >> 1) & 3; let p = 0;
      const tl = body.readUInt16BE(p); p += 2;
      const topic = body.slice(p, p + tl).toString(); p += tl;
      if (qos > 0) p += 2;
      h.publish(topic, body.slice(p));
    }
    else if (type === 9)  h.suback?.();
    else if (type === 12) h.sock.write(PINGRESP);
  }
  return off;
}

// ─── Field labels + scaling ───────────────────────────────────────────────────
const LABELS = {
  // Real device field names (plugInInfo* = already float, no ÷10)
  plugInInfoPvVol:    "PV1 Voltage",
  plugInInfoPv2Vol:   "PV2 Voltage",
  plugInInfoPvCur:    "PV1 Current",
  plugInInfoPv2Cur:   "PV2 Current",
  plugInInfoPvWatts:  "PV1 Power",
  plugInInfoPv2Watts: "PV2 Power",
  plugInInfoPvTemp:   "PV1 Temp",
  plugInInfoPv2Temp:  "PV2 Temp",
  // Doc field names (×10 integers)
  pv1InputVolt:"PV1 Voltage",    pv1InputCur:"PV1 Current",    pv1InputWatts:"PV1 Power",
  pv2InputVolt:"PV2 Voltage",    pv2InputCur:"PV2 Current",    pv2InputWatts:"PV2 Power",
  batInputVolt:"Bat Voltage",    batInputCur:"Bat Current",     batInputWatts:"Bat Power",
  batSoc:"Battery SOC",          batTemp:"Bat Temp",            invOutputWatts:"Inv Output",
  invOutputVolt:"Inv Voltage",   invOutputCur:"Inv Current",    invFreq:"Grid Freq",
  permanentWatts:"Target Power", dynamicWatts:"Dynamic Power",  ratedPower:"Rated Power",
  supplyPriority:"Supply Mode",  lowerLimit:"Bat Lower Limit",  upperLimit:"Bat Upper Limit",
  chgRemainTime:"Chg Remain",    dsgRemainTime:"Dsg Remain",    invOnOff:"Inverter On/Off",
  moduleWifiRssi:"WiFi RSSI",
};

// Already floats from device — no scaling needed
const ALREADY_FLOAT = new Set(["plugInInfoPvVol","plugInInfoPv2Vol","plugInInfoPvCur",
  "plugInInfoPv2Cur","plugInInfoPvWatts","plugInInfoPv2Watts",
  "plugInInfoPvTemp","plugInInfoPv2Temp","moduleWifiRssi"]);

// These need ÷10
const DIV10 = new Set(["pv1InputVolt","pv1InputCur","pv1InputWatts","pv2InputVolt","pv2InputCur",
  "pv2InputWatts","batInputVolt","batInputCur","batInputWatts","batTemp","invOutputVolt",
  "invOutputCur","invOutputWatts","invFreq","permanentWatts","dynamicWatts","ratedPower"]);

function fmtVal(k, v) {
  if (v === undefined || v === null) return "—";
  if (ALREADY_FLOAT.has(k)) return typeof v === "number" ? v.toFixed(2) : v;
  if (DIV10.has(k)) return typeof v === "number" ? (v / 10).toFixed(1) : v;
  return v;
}

// Accumulated state per device — partial updates are merged here
const deviceState = {}; // sn → latest merged data

// ─── Message handler ──────────────────────────────────────────────────────────
function handleMessage(topic, payload, devices) {
  const parts  = topic.split("/");
  const sn     = parts[parts.length - 2] ?? parts[parts.length - 1];
  const device = devices.find(d => d.sn === sn);
  const name   = device ? device.deviceName : sn;
  const time   = new Date().toISOString();

  let data = null;
  try {
    const msg = JSON.parse(payload.toString());
    data = msg.param ?? msg.params ?? msg;
  } catch {
    console.log(`[${name}] non-JSON (${payload.length}B): ${payload.slice(0,32).toString("hex")}`);
    return;
  }

  if (!data || typeof data !== "object" || !Object.keys(data).length) return;

  // Merge partial update into accumulated state
  if (!deviceState[sn]) deviceState[sn] = {};
  Object.assign(deviceState[sn], data);

  const lines = [`\n[${time}] ${name}`];
  for (const [k, v] of Object.entries(data)) {
    const label = (LABELS[k] ?? k).padEnd(22);
    lines.push(`  ${label} ${fmtVal(k, v)}`);
  }
  console.log(lines.join("\n"));
  logText(lines);
  logCsv(sn, name, Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, fmtVal(k, v)])
  ));
}

// ─── MQTT connect ─────────────────────────────────────────────────────────────
function connectMqtt(creds, devices) {
  const host    = creds.url.replace(/^mqtts?:\/\//, "");
  const port    = Number(creds.port);
  const clientId = creds.certificateAccount;

  console.log(`Connecting to ${host}:${port} …`);
  const sock = tls.connect({ host, port, rejectUnauthorized: false });
  sock.setKeepAlive(true, 10000);
  sock.setTimeout(90000, () => {
    console.warn("\n[MQTT] Socket timeout — reconnecting…");
    sock.destroy();
  });
  let buf = Buffer.alloc(0), pid = 1, subscribed = false, pingTimer = null;

  sock.on("secureConnect", () =>
    sock.write(mqttConnect(clientId, creds.certificateAccount, creds.certificatePassword))
  );

  sock.on("data", chunk => {
    buf = Buffer.concat([buf, chunk]);
    const used = parseMqtt(buf, {
      sock,
      connack(rc) {
        if (rc !== 0) { console.error(`MQTT refused rc=${rc}`); return; }
        console.log("✓ MQTT connected\n");
        if (subscribed) return;
        subscribed = true;

        for (const device of devices) {
          // Correct topic from documentation
          const quotaTopic  = `/open/${clientId}/${device.sn}/quota`;
          const statusTopic = `/open/${clientId}/${device.sn}/status`;
          sock.write(mqttSub(pid++, quotaTopic,  1));
          sock.write(mqttSub(pid++, statusTopic, 1));
          console.log(`Subscribed: ${device.deviceName}`);
          console.log(`  ${quotaTopic}`);
          console.log(`  ${statusTopic}`);
        }

        console.log(`\nLogging → ${LOG_FILE}`);
        devices.forEach(d => console.log(`         → ecoflow-${d.sn}.csv`));
        console.log("\nWaiting for data… (Ctrl+C to stop)\n");
        logText([`[${new Date().toISOString()}] Connected — ${devices.length} device(s)`]);

        pingTimer = setInterval(() => { if (!sock.destroyed) sock.write(PINGREQ); }, 20000);
      },
      suback() { console.log("✓ SUBACK"); },
      publish(topic, payload) { handleMessage(topic, payload, devices); },
    });
    if (used > 0) buf = buf.slice(used);
  });

  sock.on("error", err => console.error("Socket error:", err.message));
  sock.on("close", () => {
    console.warn("\nDisconnected — reconnecting in 5s…");
    logText([`[${new Date().toISOString()}] Disconnected`]);
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    subscribed = false;
    setTimeout(() => connectMqtt(creds, devices), 5000);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log("Fetching devices…");
  const devices = await apiGet("/iot-open/sign/device/list");
  console.log(`Found: ${devices.map(d => d.deviceName).join(", ")}\n`);

  console.log("Fetching MQTT credentials…");
  // Correct endpoint from Java demo
  const creds = await apiGet("/iot-open/sign/certification");
  console.log(`Broker: ${creds.url}:${creds.port}`);
  console.log(`Client: ${creds.certificateAccount}\n`);

  connectMqtt(creds, devices);
})().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
