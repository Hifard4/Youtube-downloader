const express = require('express');
const { Innertube, Platform } = require('youtubei.js');
const { FormatUtils } = require('youtubei.js');
const vm = require('vm');
const path = require('path');

// vm context with all globals YouTube's player script needs for URL deciphering.
const vmContext = vm.createContext({
  URL, URLSearchParams,
  encodeURIComponent, decodeURIComponent,
  parseInt, parseFloat, isNaN, isFinite,
  Math, Array, Object, String, Number, Boolean, RegExp,
  Error, Set, Map, Promise, JSON,
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, globalThis: global, global,
});

// Wrap in a function body so top-level `return` in YouTube's player script is valid.
Platform.shim.eval = async (data) => {
  return vm.runInContext(`(function(){\n${data.output}\n})()`, vmContext);
};

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let innertubeInstance = null;
async function getInnertube() {
  if (!innertubeInstance) {
    innertubeInstance = await Innertube.create();
  }
  return innertubeInstance;
}

function sanitizeFilename(name) {
  return (name || 'video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
    if (u.searchParams.has('v')) return u.searchParams.get('v');
    const match = u.pathname.match(/\/(shorts|embed)\/([^/?]+)/);
    if (match) return match[2];
  } catch { return null; }
  return null;
}

// GET /api/info?url=...
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  const videoId = extractVideoId(url || '');
  if (!videoId) return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);
    const details = info.basic_info;
    const thumbnails = details.thumbnail || [];
    const thumbnail = thumbnails.length ? thumbnails[thumbnails.length - 1].url : null;
    res.json({
      title: details.title,
      author: details.author || 'Unknown',
      lengthSeconds: details.duration,
      thumbnail,
    });
  } catch (err) {
    console.error('Info error:', err.message);
    res.status(500).json({ error: 'Could not fetch video info. ' + err.message });
  }
});

// GET /api/download?url=...
// Architecture: decipher the stream URL server-side, then REDIRECT the browser to it.
// The browser downloads directly from YouTube's CDN — Render's IP never touches the stream.
app.get('/api/download', async (req, res) => {
  const { url } = req.query;
  const videoId = extractVideoId(url || '');
  if (!videoId) return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);
    const title = sanitizeFilename(info.basic_info.title);
    const player = yt.session.player;

    // Format preference order: mp4 combined → any combined → mp4 video-only
    const formatAttempts = [
      { type: 'video+audio', quality: 'best', format: 'mp4'  },
      { type: 'video+audio', quality: 'best'                 },
      { type: 'video',       quality: 'best', format: 'mp4'  },
    ];

    let decipheredUrl = null;
    let ext = 'mp4';
    let lastErr;

    for (const opts of formatAttempts) {
      try {
        const format = FormatUtils.chooseFormat(opts, info.streaming_data);
        decipheredUrl = await format.decipher(player);
        ext = (format.mime_type || '').includes('webm') ? 'webm' : 'mp4';
        console.log(`Selected format: ${format.mime_type} quality=${format.quality_label}`);
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`Format attempt failed (${JSON.stringify(opts)}):`, e.message);
      }
    }

    if (!decipheredUrl) throw lastErr || new Error('No suitable format found.');

    // Tell the browser to treat the redirect as a download with the correct filename.
    // We add the Content-Disposition hint via a query param that some CDNs respect,
    // but primarily rely on the browser's own download behaviour for redirected URLs.
    console.log(`Redirecting to deciphered URL for: ${title}`);

    // Send the deciphered CDN URL back as JSON so the frontend can trigger a download.
    // A plain 302 redirect to a YouTube CDN URL causes CORS issues in fetch(), so we
    // let the frontend handle it with a temporary <a> tag instead.
    res.json({ url: decipheredUrl, filename: `${title}.${ext}` });

  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).json({ error: 'Could not download this video. ' + err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
