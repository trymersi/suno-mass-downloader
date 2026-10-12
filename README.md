# Suno AI Downloader & Batch Generator

A full automation suite for **Suno AI** that combines three tools in one:

1. **Batch Music Generator** — Queue and auto-generate multiple songs at once (with custom lyrics, style presets, instrumental mode, and bulk paste).
2. **Auto-Download Pipeline** — Finished songs are automatically sent to the local downloader the moment Suno completes them.
3. **Local Decryptor & Saver** — Decrypts Suno's DRM-protected audio (AES-GCM / AES-CTR) and saves clean MP3 or M4A files to your computer.

> **⚠️ Disclaimer**: This tool is intended for **personal use only**. Use it responsibly and in accordance with [Suno's Terms of Service](https://suno.com/terms). Do not redistribute downloaded audio.

---

## ✨ Features

### ⚡ Batch Music Generator
- **Multi-track queue** — Add multiple songs (title, genre/style, lyrics) before starting.
- **Style preset chips** — One-click presets: *80s Synthwave, Lo-fi Chill, Indie Pop, Rock Ballad, EDM Festival, Dark Ambient, Phonk,* and more.
- **Bulk paste importer** — Paste a block of songs separated by `---` to import them all at once.
- **Sequential runner** — Executes the queue one by one with safe cooldown delays to avoid Suno rate-limits.
- **Auto-download pipeline** — Check *"📥 Auto-download when done"* and every finished track is automatically decrypted and saved to your PC.

### ⬇️ Downloader & Library Extractor
- Automatically detects all songs visible on `suno.com/me` or `suno.com/create`.
- **"⬇️ Send to Local"** button injected next to every song for one-click download.
- **"⬇️ Download All"** button and a song-selector drawer to batch-send specific tracks.

### 🖥️ Local Control Center (`http://localhost:3000`)
- Real-time dashboard showing the current download queue and history.
- Built-in audio preview player.
- Quick button to open the `downloads/` folder directly in Windows Explorer.

---

## 🛠️ Setup & Usage

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or later)
- [ffmpeg](https://ffmpeg.org/) *(optional — enables MP3 transcoding; falls back to M4A if not installed)*
- Google Chrome

---

### Step 1 — Run the Local Server

```sh
npm install
npm start
```

The server starts at `http://localhost:3000`. Keep this terminal open while you use the extension.

---

### Step 2 — Install the Chrome Extension

1. Open **Google Chrome** and go to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `extension/` folder inside this project:
   ```
   /path/to/suno-ai-downloader/extension
   ```

The **🎵 Suno Bridge** widget will appear on `suno.com` pages once the extension is loaded.

---

### Step 3 — Using the Batch Generator

1. Go to [suno.com/create](https://suno.com/create) (make sure you're logged in).
2. Click the **"⚡ Batch Gen"** button in the bottom-right floating widget.
3. In the **Batch Generator** tab:
   - Enter a **Title**, pick a **Style** preset (e.g. *Lo-fi Chill*), and paste your **Lyrics**.
   - Click **➕ Add to Queue**.
   - *(Or use **📋 Bulk Paste** to import many songs at once.)*
4. Click **🚀 Start Batch Generation**.
5. The extension will trigger each song sequentially and auto-download completed tracks to your `downloads/` folder.

---

## 🗂️ Project Structure

```
suno-ai-downloader/
├── extension/          # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── content.js      # Main UI, downloader, and batch generator logic
│   ├── injected.js     # Injected into Suno's main world to intercept network responses
│   ├── content.css     # Styles for the floating widget and modal
│   └── popup.html/js   # Extension popup
├── public/
│   └── index.html      # Local Control Center dashboard
├── downloads/          # Downloaded audio files (git-ignored)
├── server.mjs          # Express server — decrypts & saves audio
└── package.json
```

---

## ⚙️ How It Works

1. **Interception** — `injected.js` hooks into Suno's internal fetch calls to capture song metadata and audio URLs from the page's main world.
2. **Decryption** — The local server fetches Suno's Mango Rights API to get wrapped AES keys, decrypts them with AES-GCM, then decrypts the audio stream with AES-CTR.
3. **Transcoding** — If `ffmpeg` is available, the decrypted M4A is transcoded to 192kbps MP3. Otherwise the raw M4A is saved directly.

---

## 📄 License

MIT — for personal use only. See disclaimer above.
