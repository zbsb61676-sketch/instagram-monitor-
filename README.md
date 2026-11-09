# ⚡ IG Radar — Realtime Instagram Privacy Status Monitor

A high-performance monitoring web application that tracks targeted Instagram accounts and delivers **instant Telegram push notifications** and **Discord webhook alerts** the exact moment an account switches from **Private ➔ Public**.

---

## 🌟 Key Features

- **⚡ Sub-Second Polling Engine:** Background scheduler capable of monitoring targets at intervals as low as 1 second.
- **📥 Auto-Download on Public:** The exact second an account flips from Private to Public, the system automatically downloads all latest posts, reels, photos, captions, and profile avatars.
- **🛡️ Strict Deduplication:** Tracks media IDs in a persistent registry and skips already downloaded posts, stories, and avatars—never downloading the same item twice.
- **🖼️ Built-in Media Gallery:** Browse, preview, and download extracted photos, reels, and captions right from the web dashboard.
- **📱 Instant Telegram Alerts:** Direct phone notifications via Telegram Bot API with one-click profile links.
- **💬 Discord Channel Alerts:** Rich embed messages sent directly to your Discord server channels.
- **🖥️ Real-time Web Dashboard:** Modern dark-mode interface built with Tailwind CSS, displaying live statuses, interval controls, and profile metadata.
- **🔊 Built-in Audio Siren:** High-tech alert chime synthesized via Web Audio API (no external mp3 files required).
- **🛡️ Cloud & Free-Host Optimized:** Includes anti-bot browser impersonation, optional proxy routing, and keep-alive ping endpoints to run 24/7 on free cloud hosting.

---

## 🚀 Quick Start (Local Setup)

### 1. Requirements
- Node.js 18+ (tested up to Node 26)

### 2. Install & Run
```bash
# Install dependencies
npm install

# Start the server
npm start
```

Open your browser and navigate to:
```
http://localhost:3000
```

---

## 🔔 Setting Up Notifications

You can configure these directly inside the **Web Dashboard (Alerts & Config)** or through environment variables.

### A. Telegram Bot (Free)
1. Open Telegram and search for **`@BotFather`**.
2. Send `/newbot`, name your bot, and copy the **HTTP API Token** (e.g., `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
3. Start a chat with your newly created bot, or add it to a group.
4. To get your **Chat ID**:
   - Message **`@userinfobot`** on Telegram to immediately see your ID number.
5. In the dashboard, click **Alerts & Config**, enter the **Token** and **Chat ID**, and click **Test Telegram**.

### B. Discord Webhook (Free)
1. In Discord, go to your server settings or right-click any channel ➔ **Edit Channel**.
2. Click **Integrations** ➔ **Webhooks** ➔ **New Webhook**.
3. Name your webhook and click **Copy Webhook URL**.
4. In the dashboard, paste the URL into **Discord Webhook URL** and click **Test Discord**.

---

## ☁️ Deploying on Free Servers (24/7 Online)

You can host this 100% free with any of the following platforms:

### Option 1: Render.com (Easiest)
1. Push this project folder to your GitHub account (`git init`, `git add .`, `git commit -m "init"`, `git push`).
2. Go to [render.com](https://render.com) and click **New Web Service**.
3. Connect your GitHub repository.
4. Configure settings:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. Click **Create Web Service**.

> **Keep-Alive Tip (Prevents Sleep):** Render's free tier sleeps after 15 minutes of inactivity. Go to [cron-job.org](https://cron-job.org) or [uptimerobot.com](https://uptimerobot.com) (both 100% free) and add a monitor to ping your Render URL's keep-alive endpoint every 5 minutes:
> `https://your-app-name.onrender.com/api/ping`

---

### Option 2: Koyeb (Micro Free Tier — No Sleep)
1. Create a free account at [koyeb.com](https://www.koyeb.com).
2. Choose **Deploy from GitHub**.
3. Select your repository. Koyeb detects Node.js and builds automatically.
4. Deploy! Koyeb free micro instances run continuously without auto-sleeping.

---

### Option 3: Hugging Face Spaces (Docker Free Tier)
1. Go to [huggingface.co/spaces](https://huggingface.co/spaces) and click **Create new Space**.
2. Space SDK: Select **Docker** (Blank).
3. Clone the space repository and copy all project files including `Dockerfile`.
4. Git commit and push. Hugging Face provides persistent 16GB RAM containers for free.

---

## 🛡️ Avoiding Rate Limits (Free Cloud Datacenter IPs)

Datacenter IPs on cloud platforms (AWS, GCP, Render) can occasionally trigger Instagram's login challenge or HTTP 429 rate limits when checking every second.

**Recommended Solutions:**
1. **Free Proxy:** Sign up for [Webshare.io](https://www.webshare.io) (Free 10 residential/datacenter proxies). Paste the proxy URL into **Settings ➔ Proxy URL** (`http://user:pass@ip:port`).
2. **Session Cookie:** Log into a burner/dummy Instagram account in your browser, copy the `sessionid` cookie from DevTools, and paste it into **Settings ➔ IG Session Cookie**. This eliminates rate limits.

---

## 📁 Project Structure

```
├── src/
│   ├── config.js         # Port, file paths, and environment settings
│   ├── db.js             # Atomic JSON persistence for targets, logs & config
│   ├── igChecker.js      # Anti-detection Instagram profile privacy inspector
│   ├── notifier.js       # Telegram & Discord webhook alert dispatchers
│   ├── monitor.js        # Sub-second async background scheduler & state machine
│   └── server.js         # Express web server & real-time WebSocket hub
├── public/
│   ├── index.html        # Modern dark-mode dashboard
│   └── app.js            # Reactive WebSocket frontend & Web Audio siren
├── Dockerfile            # Container definition for cloud deployment
├── render.yaml           # 1-click Render blueprint
└── package.json          # Dependencies & scripts
```

---

## ⚖️ Disclaimer
This tool is intended for personal notification and educational purposes. Ensure your polling frequency complies with Meta's terms of service and reasonable rate usage.
