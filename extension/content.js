// Suno AI Downloader & Batch Generator - Content Script

(function () {
  console.log('[Suno Suite] Content script active on Suno.com');

  const LOCAL_SERVER_URL = 'http://localhost:3000';
  const songsMap = new Map(); // clipId -> song object
  let isServerOnline = false;
  let activeTab = 'download';

  // Batch Generator Queue
  let batchQueue = [];
  let isBatchRunning = false;
  let autoDownloadGenerated = true;
  const pendingClipTracking = new Map();

  // Restore queue from sessionStorage if resuming across page navigation
  try {
    const savedQueue = sessionStorage.getItem('suno_batch_queue');
    if (savedQueue) {
      batchQueue = JSON.parse(savedQueue);
      sessionStorage.removeItem('suno_batch_queue');
    }
    const wasRunning = sessionStorage.getItem('suno_batch_running');
    if (wasRunning === 'true') {
      sessionStorage.removeItem('suno_batch_running');
      setTimeout(() => {
        if (batchQueue.some((q) => q.status === 'pending')) {
          startBatchRunner();
        }
      }, 1500);
    }
  } catch (e) {}

  // 1. Inject hook script into Suno's Main World
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (err) {
    console.error('[Suno Suite] Failed to inject hook script', err);
  }

  // 2. Listen for messages from injected hook
  window.addEventListener('message', (event) => {
    if (event.data?.source !== 'SUNO_DOWNLOADER_INJECTED') return;

    if (event.data.type === 'SONGS_FOUND') {
      const clips = event.data.songs || [];
      let newCount = 0;
      clips.forEach((c) => {
        if (!songsMap.has(c.id)) {
          songsMap.set(c.id, c);
          newCount++;
        }

        // Auto-download generated songs when completed
        if (autoDownloadGenerated && (c.status === 'complete' || c.audioUrl) && pendingClipTracking.has(c.id)) {
          console.log(`[Batch Gen] Auto-downloading completed track: "${c.title}" (${c.id})`);
          sendSongsToLocal([c]);
          pendingClipTracking.delete(c.id);
          showToast(`🎵 Lagu hasil generate "${c.title}" otomatis dikirim ke downloader!`);
        }
      });
      if (newCount > 0) {
        updateUI();
      }
    }
  });

  // 3. Periodic DOM scanning for songs on page
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function scanDOMForSongs() {
    const songLinks = document.querySelectorAll('a[href*="/song/"]');
    let added = 0;

    songLinks.forEach((a) => {
      const href = a.getAttribute('href') || '';
      const match = href.match(UUID_RE);
      if (!match) return;

      const clipId = match[0];
      const container =
        a.closest('[role="row"], li, div[class*="song"], div[class*="card"], div[class*="item"]') ||
        a.parentElement;

      let title = a.textContent?.trim();
      if (!title || title.length < 2) {
        const titleEl = container?.querySelector('h3, h4, [class*="title"], [class*="name"]');
        title = titleEl?.textContent?.trim() || `Song ${clipId.slice(0, 8)}`;
      }

      const imgEl = container?.querySelector('img');
      const imageUrl = imgEl?.src || null;

      if (!songsMap.has(clipId)) {
        songsMap.set(clipId, {
          id: clipId,
          title: title,
          imageUrl: imageUrl,
          audioUrl: null,
          prompt: null,
        });
        added++;
      }

      injectRowButton(container, clipId, title, imageUrl);
    });

    if (added > 0) updateUI();
  }

  function injectRowButton(container, clipId, title, imageUrl) {
    if (!container || container.querySelector(`[data-suno-dl-id="${clipId}"]`)) return;

    const actionArea =
      container.querySelector('[class*="actions"], [class*="button"], [class*="menu"]') ||
      container;

    const btn = document.createElement('button');
    btn.className = 'suno-dl-inline-btn';
    btn.setAttribute('data-suno-dl-id', clipId);
    btn.innerHTML = '⬇️ Ke Local';
    btn.title = 'Kirim ke local downloader (localhost:3000)';

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      btn.innerHTML = '⏳ Mengirim...';
      try {
        const songObj = songsMap.get(clipId) || { id: clipId, title, imageUrl };
        const res = await sendSongsToLocal([songObj]);
        if (res.ok) {
          btn.innerHTML = '✅ Diantrekan';
          btn.classList.add('sent');
          showToast(`🎵 "${title}" dikirim ke downloader lokal!`);
        } else {
          btn.innerHTML = '❌ Gagal';
          showToast(`Gagal: ${res.error || 'Server error'}`, true);
          setTimeout(() => (btn.innerHTML = '⬇️ Ke Local'), 2500);
        }
      } catch (err) {
        btn.innerHTML = '❌ Server Mati';
        showToast('Pastikan server lokal berjalan di localhost:3000', true);
        setTimeout(() => (btn.innerHTML = '⬇️ Ke Local'), 2500);
      }
    });

    actionArea.appendChild(btn);
  }

  // 4. Server communication
  async function checkServerStatus() {
    try {
      const res = await fetch(`${LOCAL_SERVER_URL}/api/status`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        isServerOnline = data.online === true;
      } else {
        isServerOnline = false;
      }
    } catch (e) {
      isServerOnline = false;
    }
    updateServerStatusUI();
  }

  async function sendSongsToLocal(songsArray) {
    if (!songsArray || songsArray.length === 0) return { ok: false, error: 'Tidak ada lagu' };
    const res = await fetch(`${LOCAL_SERVER_URL}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songs: songsArray }),
    });
    return await res.json();
  }

  // 5. Toast Notifications
  function showToast(message, isError = false) {
    const existing = document.querySelector('.suno-dl-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'suno-dl-toast';
    toast.style.borderColor = isError ? '#ff5252' : '#00e676';
    toast.innerHTML = `<span>${isError ? '⚠️' : '🚀'}</span> <span>${message}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // 6. UI Setup
  let modalOverlay = null;

  function initUI() {
    if (document.getElementById('suno-dl-widget')) return;

    // Floating Widget Pill
    const widget = document.createElement('div');
    widget.id = 'suno-dl-widget';
    widget.innerHTML = `
      <div class="suno-dl-pill">
        <div class="suno-dl-status-dot" id="suno-dl-dot" title="Local Server Status"></div>
        <div class="suno-dl-badge" id="suno-dl-badge-btn" title="Buka Control Panel">
          🎵 Suno Bridge <span class="count" id="suno-dl-count">0</span>
        </div>
        <button class="suno-dl-btn" id="suno-dl-quick-download-all">
          ⬇️ Unduh Semua
        </button>
        <button class="suno-dl-btn accent" id="suno-dl-open-gen-btn">
          ⚡ Batch Gen
        </button>
      </div>
    `;
    document.body.appendChild(widget);

    // Modal Drawer
    modalOverlay = document.createElement('div');
    modalOverlay.id = 'suno-dl-modal-overlay';
    modalOverlay.innerHTML = `
      <div id="suno-dl-modal">
        <!-- Header & Tabs -->
        <div class="suno-dl-modal-header">
          <div class="suno-dl-tabs">
            <button class="suno-dl-tab-btn active" id="tab-btn-download">
              ⬇️ Downloader (<span id="tab-count-download">0</span>)
            </button>
            <button class="suno-dl-tab-btn" id="tab-btn-generate">
              ⚡ Batch Generator (<span id="tab-count-gen">0</span>)
            </button>
          </div>
          <button class="suno-dl-modal-close" id="suno-dl-modal-close">&times;</button>
        </div>

        <!-- TAB 1: DOWNLOADER -->
        <div id="tab-content-download" style="display: flex; flex-direction: column; flex: 1; overflow: hidden;">
          <div class="suno-dl-modal-toolbar">
            <input type="text" class="suno-dl-search-input" id="suno-dl-search" placeholder="Cari judul lagu...">
            <button class="suno-dl-btn secondary" id="suno-dl-toggle-select">Pilih Semua</button>
          </div>
          <div class="suno-dl-modal-body" id="suno-dl-modal-list"></div>
          <div class="suno-dl-modal-footer">
            <div style="font-size: 13px; color: #a0a0b0;" id="suno-dl-selected-count">0 lagu terpilih</div>
            <button class="suno-dl-btn" id="suno-dl-send-selected-btn">
              ⬇️ Kirim Terpilih ke Server Local
            </button>
          </div>
        </div>

        <!-- TAB 2: BATCH GENERATOR -->
        <div id="tab-content-generate" style="display: none; flex-direction: column; flex: 1; overflow-y: auto; padding: 16px 20px; gap: 14px;">
          <!-- Notification if not on /create -->
          <div id="gen-page-warning" style="display: none; background: rgba(255, 171, 0, 0.12); border: 1px solid rgba(255, 171, 0, 0.3); border-radius: 10px; padding: 10px 14px; font-size: 12px; color: #ffd54f; align-items: center; justify-content: space-between;">
            <span>⚠️ Untuk menjalankan Batch Generator, Anda perlu berada di halaman <b>suno.com/create</b></span>
            <button class="suno-dl-btn secondary" id="btn-goto-create" style="padding: 4px 10px; font-size: 11px;">Buka Halaman Create</button>
          </div>

          <!-- Form Input -->
          <div class="suno-gen-form">
            <div style="display: flex; gap: 10px;">
              <input type="text" class="suno-gen-input" id="gen-title" placeholder="Judul Lagu (opsional)">
            </div>

            <div>
              <input type="text" class="suno-gen-input" id="gen-tags" placeholder="Style of Music (contoh: 80s synthwave, energetic)">
              <div class="suno-gen-presets" id="gen-preset-chips">
                <span class="suno-chip" data-tag="80s Synthwave, energetic">80s Synthwave</span>
                <span class="suno-chip" data-tag="Lo-fi Hip Hop, chill, relaxing">Lo-fi Chill</span>
                <span class="suno-chip" data-tag="Indie Pop, acoustic guitar, soft">Indie Pop</span>
                <span class="suno-chip" data-tag="Rock Ballad, powerful drums, guitar solo">Rock Ballad</span>
                <span class="suno-chip" data-tag="Dangdut Koplo, energetic, kendang">Dangdut Koplo</span>
                <span class="suno-chip" data-tag="Dark Ambient, eerie, drone, minimal">Dark Ambient</span>
                <span class="suno-chip" data-tag="EDM Festival, heavy bass, drop">EDM Festival</span>
                <span class="suno-chip" data-tag="Phonk, Memphis rap, aggressive">Phonk</span>
              </div>
            </div>

            <div>
              <input type="text" class="suno-gen-input" id="gen-exclude-tags" placeholder="Exclude Styles (opsional: instrumen/genre yang tidak diinginkan)">
            </div>

            <textarea class="suno-gen-textarea" id="gen-lyrics" placeholder="Lirik lagu di sini... (kosongkan jika membuat lagu Instrumental)"></textarea>

            <div class="suno-gen-row">
              <div class="suno-gen-options">
                <label class="suno-checkbox-label">
                  <input type="checkbox" id="gen-instrumental">
                  <span>Instrumental (Tanpa Vokal)</span>
                </label>
                <label class="suno-checkbox-label">
                  <input type="checkbox" id="gen-auto-download" checked>
                  <span>📥 Auto-download ke PC saat selesai</span>
                </label>
              </div>
              <div style="display: flex; gap: 8px;">
                <button class="suno-dl-btn secondary" id="btn-toggle-bulk-import">📋 Bulk Paste</button>
                <button class="suno-dl-btn" id="btn-add-to-batch">➕ Tambah ke Antrean</button>
              </div>
            </div>

            <!-- Bulk Paste Container -->
            <div id="bulk-paste-container" style="display: none; margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px;">
              <p style="font-size: 11px; color: #a0a0b0; margin-bottom: 6px;">
                Tempel banyak lagu sekaligus. Pisahkan setiap lagu dengan <code>---</code>:
              </p>
              <textarea class="suno-gen-textarea" id="bulk-paste-text" style="height: 120px;" placeholder="[Title]: Kopi Pagi&#10;[Style]: Lo-fi, acoustic&#10;[Lyrics]:&#10;Secangkir kopi di pagi hari...&#10;---&#10;[Title]: Senja Kota (Instrumental)&#10;[Style]: Dark ambient, drone&#10;---&#10;[Title]: Lagu Ketiga&#10;[Style]: Indie rock"></textarea>
              <button class="suno-dl-btn accent" id="btn-import-bulk" style="margin-top: 8px; width: 100%; justify-content: center;">
                📥 Import Semua Lagu ke Antrean Batch
              </button>
            </div>
          </div>

          <!-- Batch Queue Section -->
          <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 8px;">
            <div style="font-weight: 700; font-size: 14px;">
              📋 Antrean Batch (<span id="batch-queue-count">0</span> lagu)
            </div>
            <div style="display: flex; gap: 8px;">
              <button class="suno-dl-btn danger" id="btn-clear-batch" style="padding: 6px 12px;">Kosongkan</button>
              <button class="suno-dl-btn accent" id="btn-start-batch" style="padding: 6px 16px;">
                🚀 Mulai Batch Generation
              </button>
            </div>
          </div>

          <div class="suno-batch-queue" id="batch-queue-list"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modalOverlay);

    setupEvents();
  }

  function setupEvents() {
    document.getElementById('suno-dl-badge-btn').addEventListener('click', () => openModal('download'));
    document.getElementById('suno-dl-quick-download-all').addEventListener('click', handleDownloadAll);
    document.getElementById('suno-dl-open-gen-btn').addEventListener('click', () => openModal('generate'));

    document.getElementById('suno-dl-modal-close').addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });

    document.getElementById('tab-btn-download').addEventListener('click', () => switchTab('download'));
    document.getElementById('tab-btn-generate').addEventListener('click', () => switchTab('generate'));

    document.getElementById('btn-goto-create').addEventListener('click', () => {
      sessionStorage.setItem('suno_batch_queue', JSON.stringify(batchQueue));
      window.location.href = 'https://suno.com/create';
    });

    document.getElementById('suno-dl-search').addEventListener('input', renderModalList);
    document.getElementById('suno-dl-toggle-select').addEventListener('click', toggleSelectAll);
    document.getElementById('suno-dl-send-selected-btn').addEventListener('click', handleSendSelected);

    document.querySelectorAll('.suno-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const tag = chip.getAttribute('data-tag');
        const tagsInput = document.getElementById('gen-tags');
        if (tagsInput.value) {
          tagsInput.value += ', ' + tag;
        } else {
          tagsInput.value = tag;
        }
      });
    });

    document.getElementById('btn-add-to-batch').addEventListener('click', handleAddSingleToBatch);

    const bulkContainer = document.getElementById('bulk-paste-container');
    document.getElementById('btn-toggle-bulk-import').addEventListener('click', () => {
      bulkContainer.style.display = bulkContainer.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('btn-import-bulk').addEventListener('click', handleImportBulk);

    document.getElementById('btn-start-batch').addEventListener('click', toggleBatchRunner);
    document.getElementById('btn-clear-batch').addEventListener('click', () => {
      if (isBatchRunning) {
        showToast('Hentikan batch runner terlebih dahulu.', true);
        return;
      }
      batchQueue.length = 0;
      renderBatchQueue();
    });

    document.getElementById('gen-auto-download').addEventListener('change', (e) => {
      autoDownloadGenerated = e.target.checked;
    });
  }

  function switchTab(tabName) {
    activeTab = tabName;
    const tabDl = document.getElementById('tab-btn-download');
    const tabGen = document.getElementById('tab-btn-generate');
    const contentDl = document.getElementById('tab-content-download');
    const contentGen = document.getElementById('tab-content-generate');
    const pageWarning = document.getElementById('gen-page-warning');

    if (tabName === 'download') {
      tabDl.classList.add('active');
      tabGen.classList.remove('active');
      contentDl.style.display = 'flex';
      contentGen.style.display = 'none';
      renderModalList();
    } else {
      tabGen.classList.add('active');
      tabDl.classList.remove('active');
      contentDl.style.display = 'none';
      contentGen.style.display = 'flex';

      const isCreatePage = window.location.pathname.includes('/create');
      if (pageWarning) pageWarning.style.display = isCreatePage ? 'none' : 'flex';

      renderBatchQueue();
    }
  }

  function openModal(tab = 'download') {
    switchTab(tab);
    modalOverlay.style.display = 'flex';
  }

  function closeModal() {
    modalOverlay.style.display = 'none';
  }

  function updateServerStatusUI() {
    const dot = document.getElementById('suno-dl-dot');
    if (!dot) return;
    if (isServerOnline) {
      dot.className = 'suno-dl-status-dot online';
      dot.title = 'Local Server Siap (localhost:3000)';
    } else {
      dot.className = 'suno-dl-status-dot';
      dot.title = 'Local Server Offline! Jalankan "npm start" di terminal.';
    }
  }

  function updateUI() {
    const countEl = document.getElementById('suno-dl-count');
    const tabCountDl = document.getElementById('tab-count-download');
    if (countEl) countEl.textContent = songsMap.size;
    if (tabCountDl) tabCountDl.textContent = songsMap.size;
    if (modalOverlay && modalOverlay.style.display === 'flex' && activeTab === 'download') {
      renderModalList();
    }
  }

  // --- Downloader List Logic ---
  const selectedSongIds = new Set();

  function renderModalList() {
    const list = document.getElementById('suno-dl-modal-list');
    const query = (document.getElementById('suno-dl-search')?.value || '').toLowerCase();
    list.innerHTML = '';

    const songs = Array.from(songsMap.values()).filter((s) => s.title?.toLowerCase().includes(query));

    if (songs.length === 0) {
      list.innerHTML = `<div style="text-align: center; color: #777; padding: 30px;">Tidak ada lagu yang cocok</div>`;
      updateSelectedCount();
      return;
    }

    songs.forEach((song) => {
      const row = document.createElement('div');
      row.className = 'suno-dl-song-row';
      const isChecked = selectedSongIds.has(song.id);

      row.innerHTML = `
        <input type="checkbox" data-id="${song.id}" ${isChecked ? 'checked' : ''} style="cursor: pointer; width: 16px; height: 16px;">
        <img class="suno-dl-song-thumb" src="${song.imageUrl || 'https://suno.com/favicon.ico'}" onerror="this.src='https://suno.com/favicon.ico'">
        <div class="suno-dl-song-info">
          <div class="suno-dl-song-title" title="${song.title}">${song.title}</div>
          <div class="suno-dl-song-meta">ID: ${song.id}</div>
        </div>
        <button class="suno-dl-btn secondary" style="padding: 4px 10px; font-size: 11px;" data-single-id="${song.id}">
          ⬇️ Kirim
        </button>
      `;

      row.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
        if (e.target.checked) selectedSongIds.add(song.id);
        else selectedSongIds.delete(song.id);
        updateSelectedCount();
      });

      row.querySelector('[data-single-id]').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.innerHTML = '⏳';
        try {
          const res = await sendSongsToLocal([song]);
          if (res.ok) {
            btn.innerHTML = '✅';
            showToast(`🎵 "${song.title}" berhasil diantrekan!`);
          } else {
            btn.innerHTML = '❌';
          }
        } catch {
          btn.innerHTML = '❌';
        }
      });

      list.appendChild(row);
    });

    updateSelectedCount();
  }

  function updateSelectedCount() {
    const el = document.getElementById('suno-dl-selected-count');
    if (el) el.textContent = `${selectedSongIds.size} dari ${songsMap.size} lagu terpilih`;
  }

  function toggleSelectAll() {
    const btn = document.getElementById('suno-dl-toggle-select');
    if (selectedSongIds.size === songsMap.size) {
      selectedSongIds.clear();
      btn.textContent = 'Pilih Semua';
    } else {
      songsMap.forEach((_, id) => selectedSongIds.add(id));
      btn.textContent = 'Batal Pilih Semua';
    }
    renderModalList();
  }

  async function handleDownloadAll() {
    if (songsMap.size === 0) {
      showToast('Belum ada lagu yang terdeteksi di halaman ini.', true);
      return;
    }
    const btn = document.getElementById('suno-dl-quick-download-all');
    btn.innerHTML = '⏳ Mengirim...';

    try {
      const all = Array.from(songsMap.values());
      const res = await sendSongsToLocal(all);
      if (res.ok) {
        showToast(`🚀 ${all.length} lagu berhasil dikirim ke antrean server lokal!`);
        btn.innerHTML = '✅ Terkirim!';
      } else {
        showToast(`Gagal: ${res.error}`, true);
        btn.innerHTML = '❌ Gagal';
      }
    } catch {
      showToast('Server lokal offline! Pastikan npm start aktif di port 3000.', true);
      btn.innerHTML = '❌ Offline';
    }

    setTimeout(() => (btn.innerHTML = '⬇️ Unduh Semua'), 2500);
  }

  async function handleSendSelected() {
    const selected = Array.from(selectedSongIds).map((id) => songsMap.get(id)).filter(Boolean);
    if (selected.length === 0) {
      showToast('Pilih minimal satu lagu.', true);
      return;
    }

    const btn = document.getElementById('suno-dl-send-selected-btn');
    btn.innerHTML = '⏳ Mengirim...';

    try {
      const res = await sendSongsToLocal(selected);
      if (res.ok) {
        showToast(`🚀 ${selected.length} lagu terpilih berhasil dikirim ke server lokal!`);
        btn.innerHTML = '✅ Terkirim!';
        closeModal();
      } else {
        showToast(`Gagal: ${res.error}`, true);
        btn.innerHTML = '❌ Gagal';
      }
    } catch {
      showToast('Server lokal offline (localhost:3000)', true);
      btn.innerHTML = '❌ Offline';
    }

    setTimeout(() => (btn.innerHTML = '⬇️ Kirim Terpilih ke Server Local'), 2500);
  }

  // --- Batch Generator Logic ---
  function handleAddSingleToBatch() {
    const titleInput = document.getElementById('gen-title');
    const tagsInput = document.getElementById('gen-tags');
    const excludeInput = document.getElementById('gen-exclude-tags');
    const lyricsInput = document.getElementById('gen-lyrics');
    const instCheckbox = document.getElementById('gen-instrumental');

    const title = titleInput.value.trim() || `Lagu #${batchQueue.length + 1}`;
    const tags = tagsInput.value.trim();
    const exclude_tags = excludeInput ? excludeInput.value.trim() : '';
    const prompt = lyricsInput.value.trim();

    // Auto-detect Instrumental if lyrics are empty
    const make_instrumental = instCheckbox.checked || !prompt;

    if (!prompt && !make_instrumental && !tags) {
      showToast('Masukkan style atau lirik lagu.', true);
      return;
    }

    batchQueue.push({
      id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      title,
      tags: tags || 'acoustic',
      exclude_tags,
      prompt,
      make_instrumental,
      status: 'pending',
      error: null,
    });

    titleInput.value = '';
    lyricsInput.value = '';
    if (excludeInput) excludeInput.value = '';

    renderBatchQueue();
    showToast(`➕ "${title}" ditambahkan ke antrean batch! (${make_instrumental ? 'Instrumental' : 'Vokal'})`);
  }

  function handleImportBulk() {
    const text = document.getElementById('bulk-paste-text').value.trim();
    if (!text) {
      showToast('Teks bulk paste masih kosong.', true);
      return;
    }

    const blocks = text.split(/\n\s*---\s*\n/).map((b) => b.trim()).filter(Boolean);
    let count = 0;

    blocks.forEach((block) => {
      let title = '';
      let tags = '';
      let exclude_tags = '';
      let lyrics = '';
      let isInst = false;

      const lines = block.split('\n');
      const lyricsLines = [];
      let inLyrics = false;

      for (const line of lines) {
        const trimLine = line.trim();
        if (/^\[?Title\]?:/i.test(trimLine)) {
          title = trimLine.replace(/^\[?Title\]?:/i, '').trim();
          inLyrics = false;
        } else if (/^\[?Exclude\]?:/i.test(trimLine) || /^\[?Negative\]?:/i.test(trimLine)) {
          exclude_tags = trimLine.replace(/^\[?(Exclude|Negative)\]?:/i, '').trim();
          inLyrics = false;
        } else if (/^\[?Style\]?:/i.test(trimLine) || /^\[?Genre\]?:/i.test(trimLine) || /^\[?Tags\]?:/i.test(trimLine)) {
          tags = trimLine.replace(/^\[?(Style|Genre|Tags)\]?:/i, '').trim();
          inLyrics = false;
        } else if (/^\[?Lyrics\]?:/i.test(trimLine)) {
          inLyrics = true;
        } else if (/^\[?Instrumental\]?:/i.test(trimLine)) {
          isInst = trimLine.toLowerCase().includes('true') || trimLine.toLowerCase().includes('ya');
          inLyrics = false;
        } else {
          if (inLyrics) {
            lyricsLines.push(line);
          } else if (!title && !tags) {
            lyricsLines.push(line);
          }
        }
      }

      lyrics = lyricsLines.join('\n').trim();
      title = title || `Lagu Import #${batchQueue.length + 1}`;
      const make_instrumental = isInst || !lyrics;

      batchQueue.push({
        id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        title,
        tags: tags || 'acoustic',
        exclude_tags,
        prompt: lyrics,
        make_instrumental,
        status: 'pending',
        error: null,
      });
      count++;
    });

    document.getElementById('bulk-paste-text').value = '';
    document.getElementById('bulk-paste-container').style.display = 'none';
    renderBatchQueue();
    showToast(`🚀 Berhasil mengimpor ${count} lagu ke antrean batch!`);
  }

  function renderBatchQueue() {
    const list = document.getElementById('batch-queue-list');
    const countEl = document.getElementById('batch-queue-count');
    const tabCount = document.getElementById('tab-count-gen');

    if (countEl) countEl.textContent = batchQueue.length;
    if (tabCount) tabCount.textContent = batchQueue.length;

    if (batchQueue.length === 0) {
      list.innerHTML = `<div style="text-align: center; color: #777; padding: 24px; font-size: 13px;">Antrean batch kosong. Masukkan lagu di atas!</div>`;
      return;
    }

    list.innerHTML = '';
    batchQueue.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'suno-batch-card';

      let statusBadge = `<span class="suno-batch-status pending">⏳ Antre</span>`;
      if (item.status === 'running') {
        statusBadge = `<span class="suno-batch-status running">⚡ Sedang Mengisi...</span>`;
      } else if (item.status === 'done') {
        statusBadge = `<span class="suno-batch-status done">✅ Terkirim ke Suno</span>`;
      } else if (item.status === 'error') {
        statusBadge = `<span class="suno-batch-status error" title="${item.error || ''}">❌ ${item.error || 'Gagal'}</span>`;
      }

      card.innerHTML = `
        <div style="flex: 1; min-width: 0;">
          <div style="font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
            <span>#${idx + 1}</span>
            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.title}</span>
            ${item.make_instrumental ? '<span style="font-size: 10px; background: rgba(0,230,118,0.15); color: #00e676; padding: 1px 6px; border-radius: 4px;">Instrumental</span>' : ''}
          </div>
          <div style="font-size: 11px; color: #888; margin-top: 3px;">
            Style: ${item.tags || 'default'}${item.exclude_tags ? ` <span style="color:#ff8a80;">• Exclude: ${item.exclude_tags}</span>` : ''}
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          ${statusBadge}
          <button class="suno-dl-modal-close" style="font-size: 16px;" data-remove-id="${item.id}" title="Hapus">&times;</button>
        </div>
      `;

      card.querySelector('[data-remove-id]').addEventListener('click', () => {
        if (item.status === 'running') {
          showToast('Lagu sedang diproses, tidak bisa dihapus.', true);
          return;
        }
        const index = batchQueue.findIndex((q) => q.id === item.id);
        if (index > -1) {
          batchQueue.splice(index, 1);
          renderBatchQueue();
        }
      });

      list.appendChild(card);
    });
  }

  // --- Robust DOM Automation Engine for Suno.com/create ---

  async function setReactValue(element, value) {
    if (!element) return;
    element.focus();
    element.click();
    const proto =
      element instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.blur();
    await new Promise((r) => setTimeout(r, 150));
  }

  async function ensureCustomMode() {
    // If Custom toggle is present and not turned on, click it
    const candidates = Array.from(document.querySelectorAll('button, [role="switch"], div, span'));
    const customToggle = candidates.find((el) => {
      if (el.closest('#suno-dl-modal')) return false;
      const txt = el.textContent?.trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      return (txt === 'custom' || aria === 'custom') && el.offsetParent !== null;
    });

    if (customToggle) {
      const isChecked =
        customToggle.getAttribute('aria-checked') === 'true' ||
        customToggle.getAttribute('data-state') === 'checked' ||
        customToggle.classList.contains('active') ||
        customToggle.classList.contains('checked');

      if (!isChecked) {
        console.log('[Batch Gen] Activating Custom mode on Suno...');
        customToggle.click();
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }

  function findInstrumentalSwitch() {
    const candidates = Array.from(
      document.querySelectorAll('button[role="switch"], [role="switch"], button, input[type="checkbox"], label')
    );
    return candidates.find((el) => {
      if (el.closest('#suno-dl-modal')) return false;
      const txt = el.textContent?.toLowerCase() || '';
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const parentTxt = el.parentElement?.textContent?.toLowerCase() || '';
      return txt.includes('instrumental') || aria.includes('instrumental') || parentTxt.includes('instrumental');
    });
  }

  function isInstrumentalActive(switchEl) {
    if (!switchEl) return false;
    if (switchEl.getAttribute('aria-checked') === 'true') return true;
    if (switchEl.getAttribute('data-state') === 'checked') return true;
    if (switchEl.checked === true) return true;
    if (switchEl.classList.contains('active')) return true;
    const input = switchEl.querySelector('input') || switchEl.closest('label')?.querySelector('input');
    if (input && input.checked) return true;
    return false;
  }

  // --- Form Field Identification Helpers for Suno Create Page ---

  function isExcludeElement(el) {
    if (!el) return false;
    const p = (el.placeholder || '').toLowerCase();
    const a = (el.getAttribute('aria-label') || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const testId = (el.getAttribute('data-testid') || '').toLowerCase();

    if (
      p.includes('exclude') ||
      a.includes('exclude') ||
      name.includes('exclude') ||
      id.includes('exclude') ||
      testId.includes('exclude')
    ) {
      return true;
    }

    // Check parent container or label for "exclude"
    const container = el.closest('div, label, section, fieldset');
    if (container) {
      const containerAria = (container.getAttribute('aria-label') || '').toLowerCase();
      if (containerAria.includes('exclude')) return true;

      const labels = container.querySelectorAll('label, span, p, div, h3, h4');
      for (const lbl of labels) {
        if (lbl.children.length === 0) {
          const txt = lbl.textContent?.trim().toLowerCase();
          if (txt && (txt.includes('exclude style') || txt === 'exclude' || txt === 'exclude styles')) {
            return true;
          }
        }
      }
    }

    return false;
  }

  function isLyricsElement(el) {
    if (!el || isExcludeElement(el)) return false;
    const p = (el.placeholder || '').toLowerCase();
    const a = (el.getAttribute('aria-label') || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    const id = (el.id || '').toLowerCase();

    return (
      p.includes('lyric') ||
      a.includes('lyric') ||
      p.includes('prompt') ||
      p.includes('verse') ||
      p.includes('chorus') ||
      p.includes('write your') ||
      p.includes('own lyric') ||
      name.includes('lyric') ||
      id.includes('lyric')
    );
  }

  function isStyleElement(el) {
    if (!el || isExcludeElement(el) || isLyricsElement(el)) return false;
    const p = (el.placeholder || '').toLowerCase();
    const a = (el.getAttribute('aria-label') || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    const id = (el.id || '').toLowerCase();

    if (
      p.includes('style of music') ||
      a.includes('style of music') ||
      p.includes('music style') ||
      a.includes('music style') ||
      p.includes('enter style') ||
      p.includes('style') ||
      a.includes('style') ||
      p.includes('genre') ||
      p.includes('tag') ||
      name.includes('style') ||
      id.includes('style')
    ) {
      return true;
    }

    // Check container label
    const container = el.closest('div, section, fieldset');
    if (container) {
      const containerAria = (container.getAttribute('aria-label') || '').toLowerCase();
      if (containerAria.includes('style of music') || containerAria.includes('style')) {
        return true;
      }
      const labels = container.querySelectorAll('label, span, p, div, h3, h4');
      for (const lbl of labels) {
        if (lbl.children.length === 0) {
          const txt = lbl.textContent?.trim().toLowerCase();
          if (txt === 'style of music' || txt === 'style' || txt?.includes('style of music')) {
            return true;
          }
        }
      }
    }

    return false;
  }

  function getFormFields() {
    const allTextareas = Array.from(document.querySelectorAll('textarea')).filter(
      (t) => t.offsetParent !== null && !t.closest('#suno-dl-modal')
    );
    const allInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).filter(
      (i) => i.offsetParent !== null && !i.closest('#suno-dl-modal')
    );

    // 1. Isolate Exclude field completely
    const excludeField =
      allInputs.find((i) => isExcludeElement(i)) ||
      allTextareas.find((t) => isExcludeElement(t)) ||
      null;

    // Filter out exclude fields from valid textareas and inputs
    const validTextareas = allTextareas.filter((t) => !isExcludeElement(t));
    const validInputs = allInputs.filter((i) => !isExcludeElement(i));

    // 2. Title Input (only from validInputs)
    const titleField =
      validInputs.find((i) => {
        const p = (i.placeholder || '').toLowerCase();
        const a = (i.getAttribute('aria-label') || '').toLowerCase();
        const n = (i.name || '').toLowerCase();
        return p.includes('title') || a.includes('title') || n.includes('title') || p.includes('name');
      }) ||
      validInputs[0] ||
      null;

    let lyricsField = null;
    let styleField = null;

    // 3. Locate Style Textarea vs Lyrics Textarea
    // Explicit matching first
    styleField = validTextareas.find((t) => isStyleElement(t)) || null;
    lyricsField = validTextareas.find((t) => t !== styleField && isLyricsElement(t)) || null;

    // Position-based heuristics on valid textareas:
    if (validTextareas.length === 1) {
      // In Instrumental mode (or simplified view), the sole visible textarea is the Style box!
      styleField = validTextareas[0];
      lyricsField = null;
    } else if (validTextareas.length >= 2) {
      if (!lyricsField && !styleField) {
        // Standard Suno layout: 1st is Lyrics, 2nd is Style of Music ("kotak besar kedua")
        lyricsField = validTextareas[0];
        styleField = validTextareas[1];
      } else if (!styleField && lyricsField) {
        styleField = validTextareas.find((t) => t !== lyricsField) || validTextareas[1];
      } else if (styleField && !lyricsField) {
        lyricsField = validTextareas.find((t) => t !== styleField) || validTextareas[0];
      }
    }

    // Safety fallback: if no textarea at all, check validInputs (excluding titleField and excludeField)
    if (!styleField) {
      styleField = validInputs.find((i) => i !== titleField && isStyleElement(i)) || null;
    }

    return { lyricsField, styleField, titleField, excludeField };
  }

  function findCreateButton() {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.find((b) => {
      if (b.closest('#suno-dl-modal')) return false;
      const txt = b.textContent?.trim().toLowerCase();
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return (
        (txt === 'create' || aria === 'create' || /^create\b/i.test(txt)) &&
        !b.disabled &&
        b.offsetParent !== null
      );
    });
  }

  async function automateGenerateSong(item) {
    console.log(`[Batch Gen] Automating Suno for: "${item.title}"`);

    // Ensure we are on /create
    if (!window.location.pathname.includes('/create')) {
      showToast('Mengarahkan ke suno.com/create untuk melanjutkan...', false);
      sessionStorage.setItem('suno_batch_queue', JSON.stringify(batchQueue));
      sessionStorage.setItem('suno_batch_running', 'true');
      window.location.href = 'https://suno.com/create';
      return;
    }

    // 1. Ensure Custom mode is active
    await ensureCustomMode();
    await new Promise((r) => setTimeout(r, 400));

    // 2. Check & adjust Instrumental switch
    const shouldBeInstrumental = Boolean(item.make_instrumental || !item.prompt?.trim());
    const instSwitch = findInstrumentalSwitch();

    if (instSwitch) {
      const isCurrentlyInst = isInstrumentalActive(instSwitch);
      if (shouldBeInstrumental !== isCurrentlyInst) {
        console.log(`[Batch Gen] Toggling Instrumental to: ${shouldBeInstrumental}`);
        instSwitch.click();
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // 3. Resolve form fields after instrumental toggle
    let { lyricsField, styleField, titleField, excludeField } = getFormFields();

    // If item has exclude_tags and excludeField is not visible yet, try opening Advanced options
    if (item.exclude_tags && !excludeField) {
      const advancedToggle = Array.from(document.querySelectorAll('button, div, span')).find((el) => {
        if (el.closest('#suno-dl-modal')) return false;
        const txt = el.textContent?.trim().toLowerCase();
        return (txt === 'advanced' || txt === 'advanced options' || txt?.includes('advanced options')) && el.offsetParent !== null;
      });
      if (advancedToggle) {
        advancedToggle.click();
        await new Promise((r) => setTimeout(r, 400));
        const refetched = getFormFields();
        excludeField = refetched.excludeField;
        if (!styleField) styleField = refetched.styleField;
      }
    }

    if (!styleField && !lyricsField) {
      throw new Error('Input Suno tidak ditemukan. Pastikan halaman /create terbuka.');
    }

    // 4. Fill Style (ALWAYS into the large Style of Music box!)
    if (styleField && item.tags) {
      console.log(`[Batch Gen] Filling Style of Music (kotak besar): "${item.tags}"`, styleField);
      await setReactValue(styleField, item.tags);
    } else {
      console.warn(`[Batch Gen] Style field missing!`);
    }

    // 5. Fill Exclude Styles (only if exclude field exists)
    if (excludeField) {
      if (item.exclude_tags) {
        console.log(`[Batch Gen] Filling Exclude Styles: "${item.exclude_tags}"`, excludeField);
        await setReactValue(excludeField, item.exclude_tags);
      } else if (excludeField.value) {
        // Clear old unwanted value in Exclude Styles so it doesn't corrupt this song
        console.log('[Batch Gen] Clearing Exclude Styles field to prevent unwanted exclusion');
        await setReactValue(excludeField, '');
      }
    }

    // 6. Fill Lyrics (only if NOT instrumental and lyrics are provided)
    if (!shouldBeInstrumental && lyricsField && item.prompt) {
      console.log(`[Batch Gen] Filling lyrics...`);
      await setReactValue(lyricsField, item.prompt);
    }

    // 7. Fill Title
    if (titleField && item.title) {
      console.log(`[Batch Gen] Filling title: "${item.title}"`);
      await setReactValue(titleField, item.title);
    }

    await new Promise((r) => setTimeout(r, 600));

    // 8. Click Create Button
    const createBtn = findCreateButton();
    if (!createBtn) {
      throw new Error('Tombol "Create" tidak ditemukan atau sedang loading.');
    }

    createBtn.click();
    item.status = 'done';
    showToast(`🚀 "${item.title}" berhasil di-submit ke Suno!`);
    renderBatchQueue();
  }

  async function toggleBatchRunner() {
    if (isBatchRunning) {
      isBatchRunning = false;
      const btn = document.getElementById('btn-start-batch');
      if (btn) {
        btn.innerHTML = '🚀 Mulai Batch Generation';
        btn.className = 'suno-dl-btn accent';
      }
      showToast('Batch runner dihentikan.');
      return;
    }

    const pending = batchQueue.filter((q) => q.status === 'pending');
    if (pending.length === 0) {
      showToast('Tidak ada lagu yang berstatus antre.', true);
      return;
    }

    if (!window.location.pathname.includes('/create')) {
      sessionStorage.setItem('suno_batch_queue', JSON.stringify(batchQueue));
      sessionStorage.setItem('suno_batch_running', 'true');
      showToast('Membuka halaman Create (suno.com/create)...');
      window.location.href = 'https://suno.com/create';
      return;
    }

    startBatchRunner();
  }

  async function startBatchRunner() {
    isBatchRunning = true;
    const btn = document.getElementById('btn-start-batch');
    if (btn) {
      btn.innerHTML = '⏹️ Hentikan Batch';
      btn.className = 'suno-dl-btn danger';
    }

    showToast('🚀 Memulai batch generator...');

    while (isBatchRunning) {
      const nextItem = batchQueue.find((q) => q.status === 'pending');
      if (!nextItem) {
        showToast('🎉 Semua lagu di antrean batch selesai diproses!');
        isBatchRunning = false;
        if (btn) {
          btn.innerHTML = '🚀 Mulai Batch Generation';
          btn.className = 'suno-dl-btn accent';
        }
        break;
      }

      nextItem.status = 'running';
      renderBatchQueue();

      try {
        await automateGenerateSong(nextItem);
      } catch (err) {
        console.error('[Batch Gen] Error:', err);
        nextItem.status = 'error';
        nextItem.error = err.message || 'Gagal generate';
        showToast(`❌ Gagal: ${nextItem.error}`, true);
        renderBatchQueue();
      }

      // Safe cooldown of 25 seconds between generations
      console.log('[Batch Gen] Cooldown 25 detik sebelum lagu berikutnya...');
      for (let i = 0; i < 25; i++) {
        if (!isBatchRunning) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  // Lifecycle
  function start() {
    initUI();
    checkServerStatus();
    scanDOMForSongs();

    setInterval(scanDOMForSongs, 1500);
    setInterval(checkServerStatus, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
