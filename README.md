# Terabox NDUS Keep-Alive Pinger

Deploy ke [Suga.app](https://suga.app) untuk keep-alive session Terabox.

## Cara Kerja

1. Tiap 5 menit → load halaman `terabox.com/main` dengan cookie ndus
2. Cek redirect — kalau gak ke login = session **VALID** ✅
3. Kalau redirect ke login = session **EXPIRED** ❌ (perlu re-import)
4. Kirim report ke Worker (opsional)

## Deploy ke Suga.app

### 1. Push ke GitHub

```bash
cd terabox-pinger
git init
git add .
git commit -m "init"
git remote add origin https://github.com/tatanghshshe-sys/terabox-pinger.git
git push -u origin main
```

### 2. Deploy di Suga

1. Buka [dashboard.suga.app](https://dashboard.suga.app)
2. Create New Project → Connect GitHub repo
3. Set Environment Variables:
   ```
   NDUS=YV6Iyd1peHuigwPW7hMZkPEepV4E_Hs27SZwrfpT
   BROWSERID=iWqo1XIBwGS3RHdJeBclbW-zduq4f1wrNoKtZxtsgdZnQQ5m35VAdOB4qyM=
   WORKER_URL=https://terabox-proxy.opoleiej56.workers.dev
   PING_INTERVAL=5
   ```
4. Deploy!

### 3. Cek

```
https://your-app.suga.app/health  → status JSON
https://your-app.suga.app/ping    → trigger manual
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` or `/health` | Status + last ping |
| `POST` | `/ping` | Manual trigger ping |
| `POST` | `/update-cookie` | Update ndus (runtime) |

## Update Cookie

Kalau ndus ganti, update env var di dashboard Suga & redeploy.

Atau POST:
```bash
curl -X POST https://your-app.suga.app/update-cookie \
  -H "Content-Type: application/json" \
  -d '{"ndus":"NEW_NDUS","browserid":"NEW_BID"}'
```