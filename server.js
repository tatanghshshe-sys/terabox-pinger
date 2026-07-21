const https = require("https");
const http = require("http");
const cron = require("node-cron");

const TB_BASE = "https://www.terabox.com";
const TB_APP_ID = "250528";
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

function parseShareUrl(url) {
  const patterns = [
    /\/s\/([a-zA-Z0-9_-]+)/,
    /surl=([a-zA-Z0-9_-]+)/,
    /\/sharing\/link\?surl=([a-zA-Z0-9_-]+)/,
    /shorturl=([a-zA-Z0-9_-]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "s") return parts[1];
    return parts[parts.length - 1];
  } catch (_) { return null; }
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  if (bytes > 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

function getCookieStr() {
  return `ndus=${NDUS}; browserid=${BROWSERID}; lang=id; PANWEB=1`;
}

function getApiHeaders() {
  return {
    "User-Agent": TB_UA,
    "Cookie": getCookieStr(),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    "Referer": `${TB_BASE}/main?category=all`,
    "Origin": TB_BASE,
  };
}

function apiFetch(urlPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlPath);
    const httpModule = parsed.protocol === "https:" ? https : http;
    const req = httpModule.request(urlPath, {
      method: "GET",
      headers: getApiHeaders(),
      rejectUnauthorized: false,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { resolve(null); }
      });
    });
    req.on("error", (e) => reject(e));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
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

async function handleList(shareUrl) {
  if (!NDUS) return { success: false, error: "NDUS not set" };
  const surl = parseShareUrl(shareUrl);
  if (!surl) return { success: false, error: "Gagal parse URL Terabox" };

  try {
    const data = await apiFetch(`${TB_BASE}/share/list?app_id=${TB_APP_ID}&shorturl=${encodeURIComponent(surl)}&root=1`);

    if (!data || data.errno !== 0) {
      const errors = { 111: "Link expired", 105: "Need login", 2: "File not found", "-6": "Need login" };
      return { success: false, errno: data?.errno, error: errors[data?.errno] || `errno=${data?.errno}` };
    }

    const files = [];
    function extract(list) {
      for (const item of list || []) {
        if (item.isdir === "1") {
          extract(item.list || []);
        } else {
          files.push({
            filename: item.server_filename || item.filename,
            size_bytes: parseInt(item.size) || 0,
            size: formatSize(parseInt(item.size) || 0),
            fs_id: item.fs_id,
            md5: item.md5,
            dlink: item.dlink,
            category: item.category,
            path: item.path,
          });
        }
      }
    }
    extract(data.list);

    return { success: true, shareid: data.shareid, uk: data.uk, sign: data.sign, timestamp: data.timestamp, file_count: files.length, files };
  } catch (e) {
    return { success: false, error: `Network: ${e.message}` };
  }
}

async function handleDownload(shareUrl, fsId) {
  if (!NDUS) return { success: false, error: "NDUS not set" };
  const surl = parseShareUrl(shareUrl);
  if (!surl) return { success: false, error: "Gagal parse URL" };

  try {
    const data = await apiFetch(`${TB_BASE}/share/download?app_id=${TB_APP_ID}&shorturl=${encodeURIComponent(surl)}&fid_list=[${fsId}]`);

    if (!data || data.errno !== 0) {
      return { success: false, errno: data?.errno, error: `Download errno=${data?.errno}` };
    }

    const dlink = data.dlink || data.list?.[0]?.dlink || "";
    const filename = data.list?.[0]?.server_filename || data.list?.[0]?.filename || "file";
    const size = parseInt(data.list?.[0]?.size) || 0;

    return { success: true, filename, size, size_formatted: formatSize(size), dlink_direct: dlink, note: "Gunakan dlink_direct untuk download. Kalau diblokir (IP/Referer), pakai proxy." };
  } catch (e) {
    return { success: false, error: `Network: ${e.message}` };
  }
}

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health
  if (url.pathname === "/" || url.pathname === "/health") {
    return jsonRes(res, { status: lastError ? "degraded" : "ok", ndus_configured: !!NDUS, last_ping: lastPing, ping_count: pingCount, uptime: process.uptime() });
  }

  // Manual ping trigger
  if (url.pathname === "/ping" && req.method === "POST") {
    return ping().then((result) => jsonRes(res, result));
  }

  // List files from share URL
  if (url.pathname === "/list" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    return req.on("end", async () => {
      try {
        const d = JSON.parse(body);
        const shareUrl = d.url || d.share_url;
        if (!shareUrl) return jsonRes(res, { success: false, error: "url/share_url wajib diisi" }, 400);
        const result = await handleList(shareUrl);
        const status = result.success ? 200 : (result.errno ? 401 : 400);
        return jsonRes(res, result, status);
      } catch (e) {
        return jsonRes(res, { success: false, error: "Invalid JSON" }, 400);
      }
    });
  }

  // Generate download link
  if (url.pathname === "/download" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    return req.on("end", async () => {
      try {
        const d = JSON.parse(body);
        const shareUrl = d.url || d.share_url;
        const fsId = d.fs_id;
        if (!shareUrl || !fsId) return jsonRes(res, { success: false, error: "url & fs_id wajib diisi" }, 400);
        const result = await handleDownload(shareUrl, fsId);
        const status = result.success ? 200 : (result.errno ? 401 : 400);
        return jsonRes(res, result, status);
      } catch (e) {
        return jsonRes(res, { success: false, error: "Invalid JSON" }, 400);
      }
    });
  }

  // Update cookie runtime
  if (url.pathname === "/update-cookie" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    return req.on("end", () => {
      try {
        const d = JSON.parse(body);
        process.env.NDUS = d.ndus || NDUS; process.env.BROWSERID = d.browserid || BROWSERID;
        log("🔄", "NDUS updated");
        jsonRes(res, { ok: true });
      } catch (e) { jsonRes(res, { error: "Invalid JSON" }, 400); }
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
