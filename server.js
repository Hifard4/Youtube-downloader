const express = require('express');
const { Innertube, Platform } = require('youtubei.js');
const vm = require('vm');
const { Readable } = require('stream');
const path = require('path');

// Pre-built vm context with the globals YouTube's player script relies on.
// vm.runInNewContext creates a blank sandbox — we must supply Node globals explicitly.
const vmContext = vm.createContext({
  URL,
  URLSearchParams,
  encodeURIComponent,
  decodeURIComponent,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  Math,
  Array,
  Object,
  String,
  Number,
  Boolean,
  RegExp,
  Error,
  Set,
  Map,
  Promise,
  JSON,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
  globalThis: global,
  global,
});

// Wrap in a function so top-level `return` statements in YouTube's script are valid.
Platform.shim.eval = async (data) => {
  const wrapped = `(function() {\n${data.output}\n})()`;
  return vm.runInContext(wrapped, vmContext);
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
  } catch {
    return null;
  }
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
    console.error('Info error:', err);
    res.status(500).json({ error: 'Could not fetch video info. The URL may be invalid or the video unavailable.' });
  }
});

// GET /api/download?url=...
app.get('/api/download', async (req, res) => {
  const { url } = req.query;
  const videoId = extractVideoId(url || '');
  if (!videoId) return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);
    const title = sanitizeFilename(info.basic_info.title);

    // Try formats in order: mp4 combined → any combined (webm) → video-only mp4
    const attempts = [
      { opts: { type: 'video+audio', quality: 'best', format: 'mp4' }, ext: 'mp4',  mime: 'video/mp4'  },
      { opts: { type: 'video+audio', quality: 'best'                }, ext: 'webm', mime: 'video/webm' },
      { opts: { type: 'video',       quality: 'best', format: 'mp4' }, ext: 'mp4',  mime: 'video/mp4'  },
    ];

    let stream, ext, mime, lastErr;
    for (const attempt of attempts) {
      try {
        stream = await yt.download(videoId, attempt.opts);
        ext  = attempt.ext;
        mime = attempt.mime;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`Format attempt failed (${JSON.stringify(attempt.opts)}):`, e.message);
      }
    }

    if (!stream) throw lastErr || new Error('No suitable format found.');

    res.setHeader('Content-Disposition', `attachment; filename="${title}.${ext}"`);
    res.setHeader('Content-Type', mime);

    const nodeStream = Readable.fromWeb(stream);
    nodeStream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Download failed while streaming: ' + err.message });
      else res.end();
    });
    nodeStream.pipe(res);

  } catch (err) {
    console.error('Download error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not download this video. ' + err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
