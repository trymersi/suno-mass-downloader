const LOCAL_SERVER_URL = 'http://localhost:3000';

async function updateStatus() {
  const badge = document.getElementById('server-status');
  const badgeText = document.getElementById('server-status-text');
  const detail = document.getElementById('server-detail');

  try {
    const res = await fetch(`${LOCAL_SERVER_URL}/api/status`);
    if (res.ok) {
      const data = await res.json();
      badge.className = 'status-badge online';
      badgeText.textContent = 'Online';
      detail.textContent = `Antrean: ${data.queueCount} | Riwayat: ${data.historyCount} | FFmpeg: ${data.ffmpegInstalled ? 'Aktif (MP3)' : 'Tidak (m4a)'}`;
    } else {
      throw new Error();
    }
  } catch (err) {
    badge.className = 'status-badge';
    badgeText.textContent = 'Offline';
    detail.textContent = 'Server mati. Jalankan "npm start" di terminal!';
  }
}

document.getElementById('open-generator-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://suno.com/create' });
});

document.getElementById('open-suno-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://suno.com/me' });
});

document.getElementById('open-dashboard-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://localhost:3000' });
});

document.getElementById('open-folder-btn').addEventListener('click', async () => {
  try {
    await fetch(`${LOCAL_SERVER_URL}/api/open-folder`, { method: 'POST' });
  } catch (e) {
    alert('Gagal membuka folder. Pastikan server lokal aktif.');
  }
});

updateStatus();
