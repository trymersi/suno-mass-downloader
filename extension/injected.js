(function () {
  console.log('[Suno Downloader & Generator] Injected hook initialized in page context');

  let authToken = null;

  function extractClipsFromObject(obj, clips = []) {
    if (!obj || typeof obj !== 'object') return clips;

    // Check if current object is a Suno clip
    if (obj.id && typeof obj.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj.id)) {
      if (obj.title || obj.audio_url || obj.metadata || obj.media_urls) {
        let mediaUrl = null;
        if (Array.isArray(obj.media_urls) && obj.media_urls.length > 0) {
          mediaUrl = obj.media_urls[0]?.url;
        } else if (obj.audio_url && !obj.audio_url.includes('forbidden')) {
          mediaUrl = obj.audio_url;
        }

        clips.push({
          id: obj.id,
          title: obj.title || obj.metadata?.prompt?.slice(0, 40) || `Song ${obj.id.slice(0, 8)}`,
          audioUrl: mediaUrl || null,
          imageUrl: obj.image_url || obj.image_large_url || null,
          prompt: obj.metadata?.prompt || null,
          duration: obj.metadata?.duration || null,
          status: obj.status || null,
          createdAt: obj.created_at || null,
        });
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        extractClipsFromObject(item, clips);
      }
    } else {
      for (const key of Object.keys(obj)) {
        if (key === 'clips' || key === 'project_clips' || key === 'playlist_clips' || key === 'feed' || key === 'data') {
          extractClipsFromObject(obj[key], clips);
        }
      }
    }
    return clips;
  }

  function handleData(data) {
    try {
      const clips = extractClipsFromObject(data);
      if (clips.length > 0) {
        window.postMessage(
          {
            source: 'SUNO_DOWNLOADER_INJECTED',
            type: 'SONGS_FOUND',
            songs: clips,
          },
          '*'
        );
      }
    } catch (e) {
      // Ignore parsing errors
    }
  }

  // Intercept window.fetch to capture auth token & song feeds
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      const init = args[1];
      if (init && init.headers) {
        let auth = null;
        if (typeof init.headers.get === 'function') {
          auth = init.headers.get('Authorization');
        } else if (init.headers['Authorization']) {
          auth = init.headers['Authorization'];
        } else if (init.headers['authorization']) {
          auth = init.headers['authorization'];
        }
        if (auth && auth.startsWith('Bearer ')) {
          if (!authToken) {
            console.log('[Suno Generator] Auth token captured successfully!');
          }
          authToken = auth;
          window.postMessage({ source: 'SUNO_DOWNLOADER_INJECTED', type: 'AUTH_CAPTURED', hasAuth: true }, '*');
        }
      }
    } catch (e) {}

    const res = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (url.includes('suno.com') || url.includes('studio-api')) {
        const clone = res.clone();
        clone.json().then((json) => handleData(json)).catch(() => {});
      }
    } catch (err) {}
    return res;
  };

  // Intercept XMLHttpRequest
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener('load', function () {
      try {
        if (this.responseType === '' || this.responseType === 'text' || this.responseType === 'json') {
          const text = typeof this.response === 'string' ? this.response : JSON.stringify(this.response);
          const json = JSON.parse(text);
          handleData(json);
        }
      } catch (e) {}
    });
    return originalXhrOpen.apply(this, args);
  };

  // Listen for batch generate requests from content.js
  window.addEventListener('message', async (event) => {
    if (event.data?.source === 'SUNO_DOWNLOADER_CONTENT' && event.data?.type === 'GENERATE_SONG') {
      const { taskId, title, prompt, tags, make_instrumental, mv } = event.data.payload;
      try {
        let token = authToken;
        if (!token && window.Clerk?.session) {
          try {
            const raw = await window.Clerk.session.getToken();
            if (raw) token = 'Bearer ' + raw;
          } catch (e) {}
        }

        if (!token) {
          window.postMessage(
            {
              source: 'SUNO_DOWNLOADER_INJECTED',
              type: 'GENERATE_RESULT',
              taskId,
              needDomFallback: true,
            },
            '*'
          );
          return;
        }

        console.log(`[Suno Generator] Triggering API generate for "${title}"...`);
        const payload = {
          prompt: prompt || '',
          tags: tags || '',
          title: title || '',
          make_instrumental: Boolean(make_instrumental),
          mv: mv || 'chirp-v4',
        };

        const genRes = await originalFetch('https://studio-api.prod.suno.com/api/generate/v2/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': token,
            'Origin': 'https://suno.com',
            'Referer': 'https://suno.com/create',
          },
          body: JSON.stringify(payload),
        });

        const genData = await genRes.json();
        if (!genRes.ok) {
          throw new Error(genData.detail || genData.message || `API Error ${genRes.status}`);
        }

        console.log(`[Suno Generator] Successfully sent to Suno:`, genData);
        window.postMessage(
          {
            source: 'SUNO_DOWNLOADER_INJECTED',
            type: 'GENERATE_RESULT',
            taskId,
            ok: true,
            clips: genData.clips || [],
          },
          '*'
        );
      } catch (err) {
        console.error(`[Suno Generator] Generation failed:`, err);
        window.postMessage(
          {
            source: 'SUNO_DOWNLOADER_INJECTED',
            type: 'GENERATE_RESULT',
            taskId,
            ok: false,
            error: err.message,
          },
          '*'
        );
      }
    }
  });
})();
