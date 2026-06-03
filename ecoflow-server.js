/**
 * EcoFlow Monitor — Local Server
 * Fixed per official docs: correct topic, endpoint, signature, JSON payload.
 * Run:  node ecoflow-server.js
 * Open: http://localhost:8765
 */
"use strict";

const http   = require("http");
const tls    = require("tls");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");

// ── Credentials ───────────────────────────────────────────────────────────────
const ACCESS_KEY = "your_access_key_here";
const SECRET_KEY = "your_secret_key_here";
const BASE_URL   = "https://api-e.ecoflow.com";
const HTTP_PORT  = 8765;
const LOG_DIR    = __dirname;

// ── Signature (Java demo) ─────────────────────────────────────────────────────
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
    } else { out[key] = v; }
  }
  return out;
}

function buildSign(params, nonce, ts) {
  const flat  = params ? flattenObject(params) : {};
  const kvStr = Object.keys(flat).sort().map(k => `${k}=${flat[k]}`).join("&");
  const payload = kvStr
    ? `${kvStr}&accessKey=${ACCESS_KEY}&nonce=${nonce}&timestamp=${ts}`
    : `accessKey=${ACCESS_KEY}&nonce=${nonce}&timestamp=${ts}`;
  return crypto.createHmac("sha256", SECRET_KEY).update(payload).digest("hex");
}

async function apiGet(p, params = null) {
  const ts = String(Date.now()), nonce = makeNonce();
  const headers = { accessKey: ACCESS_KEY, timestamp: ts, nonce,
    sign: buildSign(params, nonce, ts), "Content-Type": "application/json;charset=UTF-8" };
  let url = `${BASE_URL}${p}`;
  if (params) {
    const flat = flattenObject(params);
    const qs = Object.keys(flat).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(flat[k])}`).join("&");
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, { method: "GET", headers });
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) throw new Error(`[${json.code}] ${json.message}`);
  return json.data;
}

// ── CSV logging ───────────────────────────────────────────────────────────────
const csvInit = {};
const ALREADY_FLOAT = new Set([
  "plugInInfoPvVol","plugInInfoPv2Vol","plugInInfoPvAmp","plugInInfoPv2Amp",
  "powGetPv","powGetPv2","gridConnectionPower","gridConnectionVol",
  "gridConnectionFreq","gridConnectionAmp","gridConnectionReactivePower",
  "moduleWifiRssi","invNtcTemp3","feedGridModePowMax","feedGridModePowLimit",
]);
const DIV10 = new Set(["batInputVolt","batInputCur","batInputWatts","batTemp",
  "invOutputVolt","invOutputCur","invOutputWatts","invFreq",
  "permanentWatts","dynamicWatts","ratedPower"]);

function fmtVal(k, v) {
  if (v === undefined || v === null) return "";
  if (ALREADY_FLOAT.has(k)) return typeof v === "number" ? v.toFixed(2) : v;
  if (DIV10.has(k)) return typeof v === "number" ? (v / 10).toFixed(1) : v;
  return v;
}

// Accumulated state per device — merge partial updates
const deviceState = {};

// In-memory history: sn → [{timestamp, ...fields}]
// Stores one snapshot per full upload cycle (~2 min)
const history = {};
const MAX_HISTORY = 2016; // ~7 days at 1 entry per 5 min

// All known key fields to track in history snapshots
const HISTORY_KEYS = [
  "powGetPv","powGetPv2","gridConnectionPower","gridConnectionVol","gridConnectionFreq",
  "gridConnectionAmp","plugInInfoPvVol","plugInInfoPv2Vol","plugInInfoPvAmp","plugInInfoPv2Amp",
  "batSoc","batInputWatts","batTemp","gridConnectionSta","moduleWifiRssi","feedGridModePowMax",
];

function snapshotHistory(sn, name, data) {
  // Only snapshot when we have the key power fields
  if (!data.powGetPv && !data.gridConnectionPower) return;
  if (!history[sn]) history[sn] = [];
  const snap = { timestamp: new Date().toISOString(), device: name };
  for (const k of HISTORY_KEYS) {
    if (data[k] !== undefined) snap[k] = typeof data[k] === "number" ? +data[k].toFixed(3) : data[k];
  }
  history[sn].push(snap);
  if (history[sn].length > MAX_HISTORY) history[sn].shift();
}

function historyToCsv(snFilter) {
  const sns = snFilter ? [snFilter] : Object.keys(history);
  const rows = [];
  const allKeys = ["timestamp","device",...HISTORY_KEYS];
  rows.push(allKeys.join(","));
  for (const sn of sns) {
    for (const snap of (history[sn] ?? [])) {
      rows.push(allKeys.map(k => {
        const v = snap[k] ?? "";
        return typeof v === "string" && v.includes(",") ? `"${v}"` : v;
      }).join(","));
    }
  }
  return rows.join("\n");
}

function logCsv(sn, name, data) {
  const file = path.join(LOG_DIR, `ecoflow-${sn}.csv`);
  const keys = Object.keys(data), ts = new Date().toISOString();
  if (!csvInit[sn] && !fs.existsSync(file))
    fs.writeFileSync(file, ["timestamp","device",...keys].join(",") + "\n", "utf8");
  csvInit[sn] = true;
  fs.appendFileSync(file, [ts, `"${name}"`, ...keys.map(k => fmtVal(k, data[k]))].join(",") + "\n", "utf8");
}

// ── WebSocket server ──────────────────────────────────────────────────────────
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const wsClients = new Set();

function wsHandshake(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
    `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  wsClients.add(socket);
  socket.on("close", () => wsClients.delete(socket));
  socket.on("error", () => wsClients.delete(socket));
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  const len  = Buffer.byteLength(data);
  let hdr;
  if (len <= 125) hdr = Buffer.from([0x81, len]);
  else if (len < 65536) hdr = Buffer.from([0x81, 126, len >> 8, len & 0xFF]);
  else { hdr = Buffer.alloc(10); hdr[0]=0x81; hdr[1]=127; hdr.writeUInt32BE(0,2); hdr.writeUInt32BE(len,6); }
  const frame = Buffer.concat([hdr, Buffer.from(data)]);
  for (const s of wsClients) { try { if (!s.destroyed) s.write(frame); } catch { wsClients.delete(s); } }
}

// ── MQTT ──────────────────────────────────────────────────────────────────────
function encLen(n){const o=[];do{let b=n%128;n=Math.floor(n/128);if(n)b|=0x80;o.push(b);}while(n);return Buffer.from(o);}
function mStr(s){const b=Buffer.from(s,"utf8"),h=Buffer.alloc(2);h.writeUInt16BE(b.length,0);return Buffer.concat([h,b]);}
function mqttConnect(id,u,p){const vh=Buffer.concat([mStr("MQTT"),Buffer.from([4,0xC2,0,30])]);const pl=Buffer.concat([mStr(id),mStr(u),mStr(p)]);const body=Buffer.concat([vh,pl]);return Buffer.concat([Buffer.from([0x10]),encLen(body.length),body]);}
function mqttSub(pid,t,q=1){const p=Buffer.alloc(2);p.writeUInt16BE(pid,0);const b=Buffer.concat([p,mStr(t),Buffer.from([q])]);return Buffer.concat([Buffer.from([0x82]),encLen(b.length),b]);}

function parseMqtt(buf, h) {
  let off=0;
  while(off<buf.length){
    const fb=buf[off],type=(fb>>4)&0xF;let pos=off+1,mul=1,rlen=0;
    for(let i=0;i<4;i++){if(pos>=buf.length)return off;const b=buf[pos++];rlen+=(b&0x7F)*mul;mul*=128;if(!(b&0x80))break;}
    if(pos+rlen>buf.length)return off;
    const body=buf.slice(pos,pos+rlen);off=pos+rlen;
    if(type===2) h.connack(body[1]);
    else if(type===3){
      const qos=(fb>>1)&3;let p=0;
      const tl=body.readUInt16BE(p);p+=2;const topic=body.slice(p,p+tl).toString();p+=tl;
      if(qos>0)p+=2; h.publish(topic,body.slice(p));
    }
    else if(type===9) h.suback?.();
    else if(type===12) h.sock.write(Buffer.from([0xD0,0x00]));
  }
  return off;
}

// ── Device offline detection ──────────────────────────────────────────────────
// Track last message time per device — if > 120s with no data → offline
const lastSeen = {};   // sn → timestamp
const OFFLINE_MS = 120_000;

function startOfflineWatcher(devices) {
  setInterval(() => {
    for (const device of devices) {
      const last = lastSeen[device.sn];
      const isOffline = !last || (Date.now() - last) > OFFLINE_MS;
      if (isOffline) {
        broadcast({ type: "offline", sn: device.sn, name: device.deviceName,
          timestamp: new Date().toISOString() });
      }
    }
  }, 15000); // check every 15s
}

// ── Message handler ───────────────────────────────────────────────────────────
function onMessage(topic, rawBuf, devices) {
  const parts  = topic.split("/");
  const sn     = parts[parts.length - 2];
  const kind   = parts[parts.length - 1];  // "quota" or "status"
  const device = devices.find(d => d.sn === sn);
  const name   = device ? device.deviceName : sn;

  try {
    const msg = JSON.parse(rawBuf.toString());

    if (kind === "status") {
      const online = msg?.params?.status === 1 || msg?.status === 1;
      broadcast({ type: "status", sn, name, online, timestamp: new Date().toISOString() });
      if (online) lastSeen[sn] = Date.now();
      console.log(`[${name}] ${online ? "✓ Online" : "✗ Offline"}`);
      return;
    }

    // quota message — extract param/params
    const incoming = msg.param ?? msg.params ?? msg;
    if (!incoming || typeof incoming !== "object" || !Object.keys(incoming).length) return;

    // Merge partial update into accumulated state
    if (!deviceState[sn]) deviceState[sn] = {};
    Object.assign(deviceState[sn], incoming);
    const data = deviceState[sn];

    lastSeen[sn] = Date.now();
    logCsv(sn, name, incoming);
    snapshotHistory(sn, name, data);

    broadcast({ type: "data", sn, name, timestamp: new Date().toISOString(), data });

    // Pick best power fields — device sends plugInInfo* fields (already float)
    const pv1 = data.powGetPv  ?? 0;
    const pv2 = data.powGetPv2 ?? 0;
    const inv = data.gridConnectionPower ?? (data.invOutputWatts ? data.invOutputWatts/10 : 0);
    process.stdout.write(`\r[${name}] pv1=${pv1.toFixed(1)}W pv2=${pv2.toFixed(1)}W grid=${inv.toFixed(1)}W bat=${data.batSoc ?? "?"}%    `);

  } catch (e) {
    console.error(`[${name}] parse error:`, e.message);
  }
}

// ── MQTT connect ──────────────────────────────────────────────────────────────
function connectMqtt(creds, devices) {
  const host = creds.url.replace(/^mqtts?:\/\//, "");
  const port = Number(creds.port);
  const clientId = creds.certificateAccount;

  console.log(`Connecting to ${host}:${port} …`);
  const sock = tls.connect({ host, port, rejectUnauthorized: false });
  sock.setKeepAlive(true, 10000);
  sock.setTimeout(90000, () => { console.warn("\n[MQTT] Socket timeout — reconnecting…"); sock.destroy(); });
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
        broadcast({ type: "mqtt", status: "connected", devices });
        if (subscribed) return;
        subscribed = true;
        for (const d of devices) {
          sock.write(mqttSub(pid++, `/open/${clientId}/${d.sn}/quota`,  1));
          sock.write(mqttSub(pid++, `/open/${clientId}/${d.sn}/status`, 1));
        }
        // Mark all devices as potentially offline until we hear from them
        for (const d of devices) {
          if (!lastSeen[d.sn])
            broadcast({ type: "offline", sn: d.sn, name: d.deviceName, timestamp: new Date().toISOString() });
        }
        pingTimer = setInterval(() => { if (!sock.destroyed) sock.write(Buffer.from([0xC0,0x00])); }, 20000);
      },
      suback() {},
      publish(topic, payload) { onMessage(topic, payload, devices); },
    });
    if (used > 0) buf = buf.slice(used);
  });

  sock.on("error", err => { console.error("Socket error:", err.message); broadcast({ type: "mqtt", status: "error" }); });
  sock.on("close", () => {
    console.warn("\nDisconnected — reconnecting in 5s…");
    broadcast({ type: "mqtt", status: "disconnected" });
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    subscribed = false;
    setTimeout(() => connectMqtt(creds, devices), 5000);
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const MANIFEST = JSON.stringify({ name:"EcoFlow Monitor", short_name:"EcoFlow",
  start_url:"/", display:"standalone", background_color:"#0a0f1e", theme_color:"#0a0f1e",
  icons:[{src:"/icon.svg",sizes:"any",type:"image/svg+xml"}] });
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#0a0f1e"/><polygon points="55,10 20,55 48,55 45,90 80,45 52,45" fill="#f5a623"/></svg>`;
const SW   = `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',()=>clients.claim());self.addEventListener('fetch',e=>e.respondWith(fetch(e.request).catch(()=>caches.match(e.request))));`;

function serveApp(server) {
  server.on("request", (req, res) => {
    const url = new URL(req.url, `http://localhost`);

    // ── API: history CSV download ──────────────────────────────────────────────
    if (url.pathname === "/api/history.csv") {
      const sn  = url.searchParams.get("sn") || null;
      const csv = historyToCsv(sn);
      const dev = sn || "all";
      const filename = `ecoflow-history-${dev}-${new Date().toISOString().slice(0,10)}.csv`;
      res.writeHead(200, {
        "Content-Type"                : "text/csv;charset=utf-8",
        "Content-Disposition"         : `attachment; filename="${filename}"`,
        "Access-Control-Allow-Origin" : "*",
      });
      return res.end(csv);
    }

    // ── API: history JSON (for PWA chart) ─────────────────────────────────────
    if (url.pathname === "/api/history.json") {
      const sn = url.searchParams.get("sn");
      const data = sn ? { [sn]: history[sn] ?? [] } : history;
      res.writeHead(200, { "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*" });
      return res.end(JSON.stringify(data));
    }

    // ── Static files ──────────────────────────────────────────────────────────
    const map = { "/manifest.json":["application/manifest+json",MANIFEST],
      "/icon.svg":["image/svg+xml",ICON], "/sw.js":["application/javascript",SW] };
    if (map[url.pathname]) { res.writeHead(200,{"Content-Type":map[url.pathname][0]}); return res.end(map[url.pathname][1]); }
    const f = path.join(__dirname, "ecoflow-app.html");
    if (fs.existsSync(f)) { res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"}); return fs.createReadStream(f).pipe(res); }
    res.writeHead(404); res.end("Not found.");
  });
  server.on("upgrade", (req, sock, head) => { if (req.url==="/ws") wsHandshake(req,sock); else sock.destroy(); });
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("Fetching devices…");
  const devices = await apiGet("/iot-open/sign/device/list");
  console.log(`Found: ${devices.map(d=>d.deviceName).join(", ")}\n`);

  console.log("Fetching MQTT credentials…");
  const creds = await apiGet("/iot-open/sign/certification");
  console.log(`Broker: ${creds.url}:${creds.port}\n`);

  const server = http.createServer();
  serveApp(server);
  server.listen(HTTP_PORT, "0.0.0.0", () => {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter(n => n.family === "IPv4" && !n.internal).map(n => n.address);
    console.log(`✓ Dashboard: http://localhost:${HTTP_PORT}`);
    ips.forEach(ip => console.log(`  LAN:        http://${ip}:${HTTP_PORT}`));
    console.log();
  });

  connectMqtt(creds, devices);
  startOfflineWatcher(devices);
})().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
