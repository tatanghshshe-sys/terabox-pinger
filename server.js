const https = require("https");
const http = require("http");
const cron = require("node-cron");

const TB_BASE = "https://www.terabox.com";
const TB_UA = "Mozilla/5.0 (Linux; Android 14; CPH2581) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const PING_INTERVAL_MINUTES = parseInt(process.env.PING_INTERVAL || "5");
const WORKER_URL = process.env.WORKER_URL || "";
const PORT = parseInt(process.env.PORT || "3000");
const NDUS = process.env.NDUS || "";
const BROWSERID = process.env.BROWSERID || "";

function log(emoji, msg) {
  const time = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  console.log(`[${time}] ${emoji} ${msg}`);
}

function fetchWithRedirect(url, cookieStr, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    let currentUrl = url, redirectCount = 0;
    const allCookies = [], allLocations = [];

    function doFetch(fetchUrl) {
      const parsed = new URL(fetchUrl);
      const httpModule = parsed.protocol === "https:" ? https : http;
      const headers = { "User-Agent": TB_UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "id-ID,id;q=0.9,en;q=0.8" };
      if (cookieStr) headers["Cookie"] = cookieStr;

      const req = httpModule.request(fetchUrl, { method: "GET", headers, rejectUnauthorized: false }, (res) => {
        const setCookies = res.headers["set-cookie"];
        if (setCookies) allCookies.push(...(Array.isArray(setCookies) ? setCookies : [setCookies]));
        const location = res.headers["location"];
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && location) {
          if (redirectCount >= maxRedirects) return resolve({ statusCode: res.statusCode, finalUrl: fetchUrl, cookies: allCookies, locations: allLocations, tooManyRedirects: true });
          redirectCount++;
          allLocations.push(location);
          res.resume();
          return doFetch(new URL(location, fetchUrl).href);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode, finalUrl: fetchUrl, cookies: allCookies, locations: allLocations, body: body.substring(0, 5000), hasLogin: /passport|login-form|signin|login\.php/i.test(body), isIndonesian: /indonesian/i.test(fetchUrl) || /indonesian/i.test(body.substring(0, 500)) }));
      });
      req.on("error", (e) => reject(e));
      req.setTimeout(20000, () => { req.destroy(); reject(new Error("timeout")); });
      req.end();
    }
    doFetch(currentUrl);
  });
}

function parseCookies(setCookieHeaders) {
  const result = {};
  for (const raw of setCookieHeaders) {
    const kv = raw.split(";")[0].trim();
    const eq = kv.indexOf("=");
    if (eq > 0) {
      const name = kv.substring(0, eq).trim(), value = kv.substring(eq + 1).trim();
      if (name && value && value !== "deleted") result[name] = value;
    }
  }
  return result;
}

let lastPing = null, pingCount = 0, lastError = null;

async function ping() {
  if (!NDUS) { lastError = "NDUS not set"; return { ok: false, error: "NDUS not set" }; }
  try {
    pingCount++;
    const cookieStr = `ndus=${NDUS}; browserid=${BROWSERID}; lang=id; PANWEB=1`;
    log("🔄", `Ping #${pingCount} — loading page...`);
    const result = await fetchWithRedirect(`${TB_BASE}/main?category=all`, cookieStr);
    const newCookies = parseCookies(result.cookies);
    const finalDomain = new URL(result.finalUrl).hostname;
    const isLogin = result.finalUrl.includes("login") || result.finalUrl.includes("passport") || result.hasLogin;
    if (isLogin) {
      log("❌", `SESSION EXPIRED! Redirect ke login: ${result.finalUrl}`);
      lastError = "Session expired"; lastPing = { ok: false, status: "expired", time: new Date().toISOString(), url: result.finalUrl };
      await notifyWorker({ status: "expired", error: "Redirect to login" });
      return lastPing;
    }
    const region = result.isIndonesian ? "🇮🇩 Indo" : "🌍 Global";
    log("✅", `OK! HTTP ${result.statusCode} → ${finalDomain} ${region} | ${result.locations.length} redirects | ${Object.keys(newCookies).length} new cookies`);
    if (Object.keys(newCookies).length > 0) log("🍪", `New: ${Object.keys(newCookies).join(", ")}`);
    lastPing = { ok: true, status: "active", time: new Date().toISOString(), url: result.finalUrl, domain: finalDomain, indonesian: result.isIndonesian, redirects: result.locations.length, newCookies: Object.keys(newCookies) };
    lastError = null;
    await notifyWorker({ status: "active", region: result.isIndonesian ? "id" : "global" });
    return lastPing;
  } catch (e) {
    log("💥", `Error: ${e.message}`);
    lastError = e.message; lastPing = { ok: false, status: "error", time: new Date().toISOString(), error: e.message };
    await notifyWorker({ status: "error", error: e.message });
    return lastPing;
  }
}

async function notifyWorker(data) {
  if (!WORKER_URL) return;
  try {
    const url = new URL("/ping", WORKER_URL);
    const httpModule = url.protocol === "https:" ? https : http;
    await new Promise((resolve) => {
      const req = httpModule.request(url.href, { method: "POST", headers: { "Content-Type": "application/json" }, timeout: 10000 }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", () => resolve());
      req.write(JSON.stringify({ type: "keepalive", source: "suga-pinger", ping_count: pingCount, ...data }));
      req.end();
    });
  } catch (_) {}
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: lastError ? "degraded" : "ok", ndus_configured: !!NDUS, last_ping: lastPing, ping_count: pingCount, uptime: process.uptime() }, null, 2));
  }
  if (url.pathname === "/ping" && req.method === "POST") {
    return ping().then((result) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result, null, 2)); });
  }
  if (url.pathname === "/update-cookie" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    return req.on("end", () => {
      try {
        const d = JSON.parse(body);
        process.env.NDUS = d.ndus || NDUS; process.env.BROWSERID = d.browserid || BROWSERID;
        log("🔄", "NDUS updated");
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
  }
  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  log("🚀", `Pinger started on port ${PORT}`);
  log("⏰", `Cron: every ${PING_INTERVAL_MINUTES} minutes`);
  log("🍪", `NDUS: ${NDUS ? NDUS.substring(0, 12) + "..." : "NOT SET!"}`);
  ping();
  cron.schedule(`*/${PING_INTERVAL_MINUTES} * * * *`, () => ping());
  log("📅", `Next ping in ${PING_INTERVAL_MINUTES} minutes`);
});