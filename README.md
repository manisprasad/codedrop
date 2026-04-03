# CodeDrop

Ephemeral P2P code + file sharing over WebRTC. No data stored anywhere.

## Files

```
codedrop/
├── server.js      ← WebSocket signaling server (deploy to Render)
├── package.json   ← Node.js deps
├── index.html     ← The entire frontend (open locally or host anywhere)
└── README.md
```

## How it works

```
Browser A ──── WebSocket ────► Render Server ◄──── WebSocket ──── Browser B
    │               (signaling: offers/answers/ICE only)               │
    │                                                                   │
    └──────────────── WebRTC DataChannel (P2P) ────────────────────────┘
                     (actual code/files go here, never touches server)
```

1. Both peers connect to your Render signaling server
2. Server helps them exchange WebRTC handshake info
3. Direct P2P DataChannel opens between browsers
4. All messages/code/files go P2P — server sees nothing

---

## Deploy Server to Render (Free)

### Step 1 — Push to GitHub
```bash
git init
git add server.js package.json
git commit -m "codedrop signaling server"
git remote add origin https://github.com/YOUR_USERNAME/codedrop-server
git push -u origin main
```

### Step 2 — Create Web Service on Render
1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Name**: `codedrop-signal` (or anything)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free
4. Click **Deploy**

### Step 3 — Get your URL
After deploy, Render gives you a URL like:
```
https://codedrop-signal.onrender.com
```

Your WebSocket URL is:
```
wss://codedrop-signal.onrender.com
```

---

## Using CodeDrop

1. Open `index.html` in your browser (or host it on GitHub Pages, Netlify, etc.)
2. Paste your signaling server URL: `wss://codedrop-signal.onrender.com`
3. Enter your name → Create room
4. Copy the Room ID → share with teammate
5. Teammate opens `index.html`, enters same server URL + Room ID → joins

### Features
- 💬 Text messages
- {} Code snippets with copy + download
- 🔐 .env files (red-accented warning)
- 📎 Any file (zip, images, etc.) — chunked P2P transfer
- 📡 Broadcast to all or DM individual peers
- Everything vanishes on browser refresh

### Notes
- Render free tier **spins down after 15min** of inactivity — first connection may take ~30s
- To avoid cold starts, upgrade to Render paid ($7/mo) or use Railway/Fly.io free tier
- Files are limited by browser memory — works great for code files, .env, zips under ~50MB
