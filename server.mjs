import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

// Ensure downloads directory exists
await fs.mkdir(DOWNLOADS_DIR, { recursive: true });

// CORS & JSON middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(DOWNLOADS_DIR));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Referer': 'https://suno.com/',
  'Origin': 'https://suno.com',
};

function sanitizeFilename(name) {
  return (name || 'suno_song')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

let ffmpegCached = null;
async function hasFfmpeg() {
  if (ffmpegCached !== null) return ffmpegCached;
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (err) => {
      ffmpegCached = !err;
      resolve(ffmpegCached);
    });
  });
}

async function extractClipId(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) throw Object.assign(new Error('Missing url parameter'), { status: 400 });
  if (UUID_RE.test(url)) return url;
  let m;
  if ((m = url.match(/suno\.com\/song\/([0-9a-f-]{36})/i))) return m[1];
  if ((m = url.match(/suno\.com\/s\/([^/?#]+)/i))) {
    const res = await fetch(`https://suno.com/s/${m[1]}`, { redirect: 'manual', headers: DEFAULT_HEADERS });
    const loc = res.headers.get('location') || '';
    const lm = loc.match(/song\/([0-9a-f-]{36})/i);
    if (lm) return lm[1];
    const res2 = await fetch(`https://suno.com/s/${m[1]}`, { redirect: 'follow', headers: DEFAULT_HEADERS });
    const fm = res2.url.match(/song\/([0-9a-f-]{36})/i);
    if (fm) return fm[1];
    const html = await res2.text();
    const hm = html.match(/song\/([0-9a-f-]{36})/i);
    if (hm) return hm[1];
    throw Object.assign(new Error('Could not resolve share link'), { status: 400 });
  }
  throw Object.assign(new Error('Unrecognized Suno URL'), { status: 400 });
}

function isAudioData(buf) {
  if (!buf || buf.length < 32) return false;
  // M4A / MP4 ftyp atom check (bytes 4..7 == 'ftyp')
  const isM4A = String.fromCharCode(...buf.slice(4, 8)) === 'ftyp';
  // MP3 ID3 tag or sync header (0xFF 0xFB / 0xFF 0xF3 / 0xFF 0xF2)
  const isMP3 =
    String.fromCharCode(...buf.slice(0, 3)) === 'ID3' ||
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
  return isM4A || isMP3;
}

async function decryptClipAudio(clipId, customAudioUrl = null) {
  // 1. Resolve mediaUrl (filter out placeholder / forbidden URLs)
  let mediaUrl = customAudioUrl && !customAudioUrl.includes('forbidden') ? customAudioUrl : null;

  if (!mediaUrl) {
    try {
      const pageRes = await fetch(`https://suno.com/song/${clipId}`, { headers: DEFAULT_HEADERS });
      if (pageRes.ok) {
        const page = await pageRes.text();
        const m = page.match(/https:\/\/d2lwuy8qc234o3\.cloudfront\.net[^"\\]+\.m4a/);
        if (m) mediaUrl = m[0];
      }
    } catch (e) {
      // Fallback
    }
  }

  // Fallback to standard CloudFront pattern
  if (!mediaUrl) {
    mediaUrl = `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${clipId}.m4a`;
  }

  console.log(`[Decrypt] Clip ${clipId} -> Fetching media from: ${mediaUrl}`);

  // 2. Fetch media stream with browser headers
  const mediaRes = await fetch(mediaUrl, { headers: DEFAULT_HEADERS });
  if (!mediaRes.ok) {
    throw Object.assign(
      new Error(`Media fetch failed with HTTP ${mediaRes.status} from ${mediaUrl}`),
      { status: 502 }
    );
  }

  const encBuffer = await mediaRes.arrayBuffer();
  const enc = new Uint8Array(encBuffer);

  // If the received stream is already valid unencrypted audio (e.g. direct mp3/m4a CDN)
  if (isAudioData(enc)) {
    console.log(`[Decrypt] Media stream is already unencrypted audio (${enc.length} bytes).`);
    return enc;
  }

  // 3. Fetch Mango Rights for decryption keys
  const rightsRes = await fetch('https://studio-api.prod.suno.com/api/mango/rights', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...DEFAULT_HEADERS,
    },
    body: JSON.stringify({ content_params: { content_id: clipId, content_type: 'clip' } }),
  });

  const rights = await rightsRes.json();
  if (!rightsRes.ok) {
    throw Object.assign(
      new Error(`Rights request failed (HTTP ${rightsRes.status}): ${JSON.stringify(rights)}`),
      { status: 502 }
    );
  }

  // 4. Decrypt keys using AES-GCM
  const sha256Key = async (token) => {
    const hash = crypto.createHash('sha256').update(token, 'utf8').digest();
    return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['decrypt']);
  };
  const userKey = await sha256Key(rights.glt);

  const aesGcm = async (wrappedB64, aad) => {
    const wrapped = new Uint8Array(Buffer.from(wrappedB64, 'base64'));
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: wrapped.slice(0, 12), additionalData: Buffer.from(aad, 'utf8') },
        userKey,
        wrapped.slice(12)
      )
    );
  };

  const contentKey = await aesGcm(rights.key, clipId);
  const contentIv = await aesGcm(rights.iv, clipId);

  // 5. Decrypt audio using AES-CTR
  const key = await crypto.subtle.importKey('raw', contentKey, { name: 'AES-CTR' }, false, ['decrypt']);
  const decrypted = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-CTR', counter: contentIv, length: 128 }, key, enc)
  );

  if (!isAudioData(decrypted)) {
    console.warn(`[Decrypt] Warning: Decrypted buffer header check did not match standard audio signature.`);
  }

  return decrypted;
}

// In-memory Queue management
const downloadQueue = [];
const historyList = [];
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (downloadQueue.length > 0) {
    const current = downloadQueue[0];
    current.status = 'downloading';
    current.startedAt = Date.now();

    try {
      console.log(`[Queue] Processing song: "${current.title || current.id}" (${current.id})`);
      const audioBuffer = await decryptClipAudio(current.id, current.audioUrl);

      const ffmpeg = await hasFfmpeg();
      const safeTitle = sanitizeFilename(current.title || current.id);
      const shortId = current.id.slice(0, 8);

      let finalExt = 'm4a';
      let finalFilename = `${safeTitle} - ${shortId}.m4a`;
      let finalFilePath = path.join(DOWNLOADS_DIR, finalFilename);

      if (ffmpeg) {
        // Transcode to MP3 using ffmpeg with safe fallback
        const tmpIn = path.join(os.tmpdir(), `suno_${current.id}_in.m4a`);
        const tmpOut = path.join(os.tmpdir(), `suno_${current.id}_out.mp3`);
        await fs.writeFile(tmpIn, audioBuffer);

        try {
          await new Promise((resolve, reject) => {
            execFile(
              'ffmpeg',
              ['-y', '-v', 'error', '-i', tmpIn, '-c:a', 'libmp3lame', '-b:a', '192k', tmpOut],
              (err) => {
                if (err) reject(err);
                else resolve();
              }
            );
          });

          const mp3 = await fs.readFile(tmpOut);
          finalExt = 'mp3';
          finalFilename = `${safeTitle} - ${shortId}.mp3`;
          finalFilePath = path.join(DOWNLOADS_DIR, finalFilename);
          await fs.writeFile(finalFilePath, mp3);
          current.sizeBytes = mp3.length;
        } catch (ffmpegErr) {
          console.warn(`[Queue] FFmpeg transcoding failed, saving as direct audio file instead:`, ffmpegErr.message);
          await fs.writeFile(finalFilePath, audioBuffer);
          current.sizeBytes = audioBuffer.length;
        } finally {
          fs.unlink(tmpIn).catch(() => {});
          fs.unlink(tmpOut).catch(() => {});
        }
      } else {
        // Save direct audio file
        await fs.writeFile(finalFilePath, audioBuffer);
        current.sizeBytes = audioBuffer.length;
      }

      current.status = 'completed';
      current.filename = finalFilename;
      current.format = finalExt;
      current.completedAt = Date.now();
      console.log(`[Queue] Successfully saved: ${finalFilename} (${(current.sizeBytes / 1048576).toFixed(2)} MB)`);
    } catch (err) {
      console.error(`[Queue] Failed to download ${current.id}:`, err.message || err);
      current.status = 'failed';
      current.error = err.message || 'Download error';
      current.completedAt = Date.now();
    }

    // Move to history
    downloadQueue.shift();
    historyList.unshift(current);
    if (historyList.length > 100) historyList.pop();
  }

  isProcessingQueue = false;
}

// 1. Health check & status API
app.get('/api/status', async (req, res) => {
  const ffmpeg = await hasFfmpeg();
  res.json({
    online: true,
    ffmpegInstalled: ffmpeg,
    downloadsDir: DOWNLOADS_DIR,
    queueCount: downloadQueue.length,
    historyCount: historyList.length,
    isProcessing: isProcessingQueue,
  });
});

// 2. Add songs to download queue
app.post('/api/queue', async (req, res) => {
  try {
    const rawItems = Array.isArray(req.body.songs)
      ? req.body.songs
      : req.body.url || req.body.id
      ? [req.body]
      : [];

    if (rawItems.length === 0) {
      return res.status(400).json({ error: 'No songs provided in request' });
    }

    const added = [];
    for (const item of rawItems) {
      const clipId = await extractClipId(item.id || item.url);
      if (downloadQueue.some((q) => q.id === clipId)) continue;

      const queueItem = {
        id: clipId,
        title: item.title || `Song ${clipId.slice(0, 8)}`,
        imageUrl: item.imageUrl || null,
        audioUrl: item.audioUrl || null,
        prompt: item.prompt || null,
        status: 'pending',
        addedAt: Date.now(),
      };
      downloadQueue.push(queueItem);
      added.push(queueItem);
    }

    processQueue().catch((err) => console.error('[Queue runner error]', err));

    res.json({
      ok: true,
      addedCount: added.length,
      queueTotal: downloadQueue.length,
      added,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to add to queue' });
  }
});

// 3. Get queue and download history
app.get('/api/queue', (req, res) => {
  res.json({
    isProcessing: isProcessingQueue,
    queue: downloadQueue,
    history: historyList.slice(0, 30),
  });
});

// 4. Open downloads folder in OS file manager
app.post('/api/open-folder', (req, res) => {
  const platform = process.platform;
  if (platform === 'win32') {
    execFile('explorer', [DOWNLOADS_DIR]);
  } else if (platform === 'darwin') {
    execFile('open', [DOWNLOADS_DIR]);
  } else {
    execFile('xdg-open', [DOWNLOADS_DIR]);
  }
  res.json({ ok: true, path: DOWNLOADS_DIR });
});

// 5. Existing direct download streaming endpoint
app.get('/api/download', async (req, res) => {
  try {
    const clipId = await extractClipId(req.query.url);
    const audioBuffer = await decryptClipAudio(clipId);
    const ffmpeg = await hasFfmpeg();

    if (ffmpeg) {
      const tmpIn = path.join(os.tmpdir(), `suno_${clipId}_in.m4a`);
      const tmpOut = path.join(os.tmpdir(), `suno_${clipId}_out.mp3`);
      await fs.writeFile(tmpIn, audioBuffer);

      try {
        await new Promise((resolve, reject) => {
          execFile(
            'ffmpeg',
            ['-y', '-v', 'error', '-i', tmpIn, '-c:a', 'libmp3lame', '-b:a', '192k', tmpOut],
            (err) => (err ? reject(err) : resolve())
          );
        });
        const mp3 = await fs.readFile(tmpOut);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', `attachment; filename="${clipId}.mp3"`);
        return res.send(mp3);
      } catch {
        // Fallback to sending direct audio
      } finally {
        fs.unlink(tmpIn).catch(() => {});
        fs.unlink(tmpOut).catch(() => {});
      }
    }

    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${clipId}.m4a"`);
    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Internal error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Suno AI Downloader Server running on http://localhost:${PORT}`);
  console.log(`Downloads directory: ${DOWNLOADS_DIR}`);
});
