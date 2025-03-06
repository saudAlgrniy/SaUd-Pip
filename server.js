import express from 'express';
import WebTorrent from 'webtorrent';
import magnetUri from 'magnet-uri';
import { pipeline } from 'stream';
import { EventEmitter } from 'events';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';

EventEmitter.defaultMaxListeners = 100;

const app = express();
const client = new WebTorrent();
const activeTorrents = new Map();
const torrentAccessCount = new Map(); // لتخزين عدد المستمعين لكل تورنت

let currentTorrentHash = null;

// تفعيل الكاش للملفات الثابتة لتحسين سرعة التحميل
app.use(express.static('public', { maxAge: '1d', etag: false }));

const getMimeType = (filename) => {
  if (filename.endsWith('.mp4')) return 'video/mp4';
  if (filename.endsWith('.mkv')) return 'video/x-matroska';
  return 'application/octet-stream';
};

function parseRange(range, fileSize) {
  if (!range) return { start: 0, end: fileSize - 1 };
  const parts = range.replace(/bytes=/, '').split('-');
  let start = parseInt(parts[0], 10);
  let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  if (isNaN(start) || start < 0) start = 0;
  if (isNaN(end) || end >= fileSize) end = fileSize - 1;
  if (start > end) {
    // بدلاً من رمي خطأ، نقوم بتعديل القيمة
    console.warn(`Adjusted range: start (${start}) is greater than end (${end}), setting start to end.`);
    start = end;
  }
  return { start, end };
}

const sendStream = (torrent, file, range, res) => {
  let startByte = 0;
  let endByte = file.length - 1;
  let statusCode = 200;

  if (range) {
    try {
      const parsed = parseRange(range, file.length);
      startByte = parsed.start;
      endByte = parsed.end;
      statusCode = 206;
      res.set('Content-Range', `bytes ${startByte}-${endByte}/${file.length}`);
      res.set('Accept-Ranges', 'bytes');
    } catch (err) {
      console.error('Error parsing range:', err);
      return res.status(416).send('Requested Range Not Satisfiable');
    }
  }

  res.set('Content-Type', getMimeType(file.name));
  res.status(statusCode);

  const readStream = file.createReadStream({ start: startByte, end: endByte });
  pipeline(readStream, res, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error('Stream error:', err);
    }
  });
};

// دالة استخدام ffprobe للحصول على مدة الفيديو (بالثواني)
const getVideoDuration = (filePath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
};

// تعديل handleTorrent بحيث يتم استخدام مدة الفيديو في حالة طلب وقت معين
const handleTorrent = async (torrent, range, res, fileIndex = 0, time) => {
  torrent.lastAccess = Date.now();

  const videoFiles = torrent.files.filter(f => f.name.endsWith('.mp4') || f.name.endsWith('.mkv'));
  if (videoFiles.length === 0) {
    return res.status(404).send('No MP4 or MKV video found in this torrent.');
  }
  if (fileIndex < 0 || fileIndex >= videoFiles.length) {
    return res.status(400).send('Invalid fileIndex parameter.');
  }
  torrent.files.forEach(file => file.deselect());
  const selectedFile = videoFiles[fileIndex];
  selectedFile.select();

  if (torrent._lastFileIndex !== fileIndex) {
    console.log(`Streaming file: "${selectedFile.name}" from torrent: "${torrent.name}"`);
    torrent._lastFileIndex = fileIndex;
  }

  // الحصول على مدة الفيديو الفعلية تلقائيًا
  const filePath = path.resolve('downloads', selectedFile.path);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found at path: ${filePath}`);
    return res.status(404).send('Video file not found.');
  }
  let actualDuration;
  if (selectedFile.actualDuration) {
    actualDuration = selectedFile.actualDuration;
  } else {
    try {
      actualDuration = await getVideoDuration(filePath);
      selectedFile.actualDuration = actualDuration;
      console.log(`Actual video duration: ${actualDuration} seconds`);
    } catch (err) {
      console.error('Error getting video duration:', err);
      actualDuration = 7200; // قيمة احتياطية (120 دقيقة)
      selectedFile.actualDuration = actualDuration;
    }
  }
  
  // إذا تم تمرير وقت محدد (بالثواني) يتم تحويله إلى نطاق بايتات
  if (time !== undefined) {
    const requestedTime = parseFloat(time);
    if (!isNaN(requestedTime) && requestedTime >= 0 && requestedTime <= actualDuration) {
      const offset = Math.floor((requestedTime / actualDuration) * selectedFile.length);
      range = `bytes=${offset}-${selectedFile.length - 1}`;
      console.log(`Seeking to time ${requestedTime}s, which corresponds to byte offset ${offset}`);
    } else {
      console.warn('Invalid time parameter, ignoring.');
    }
  } else if (!range) {
    // إذا لم يتم تمرير range يتم تحديد نطاق افتراضي بناءً على البيانات المتوفرة
    const available = selectedFile.downloaded > 0 ? selectedFile.downloaded : selectedFile.length;
    range = `bytes=0-${Math.min(available, selectedFile.length) - 1}`;
  }

  sendStream(torrent, selectedFile, range, res);
};

const removeTorrent = (torrentHash) => {
  if (activeTorrents.has(torrentHash)) {
    const torrent = activeTorrents.get(torrentHash);
    client.remove(torrentHash, (err) => {
      if (err) {
        console.error('Error removing torrent:', err);
      } else {
        activeTorrents.delete(torrentHash);
        torrentAccessCount.delete(torrentHash);
        console.log(`Closed torrent: "${torrent.name}"`);
      }
    });
  }
};

const addTorrentIfNotExist = (magnetLink, res, range, fileIndex = 0, time) => {
  let parsedMagnet;
  try {
    parsedMagnet = magnetUri(magnetLink);
  } catch (error) {
    console.error('Error parsing magnet URI:', error);
    return res.status(400).send('Invalid Magnet link.');
  }
  const torrentHash = parsedMagnet.infoHash;

  // إزالة التورنتات الأخرى لتقليل استهلاك الموارد
  activeTorrents.forEach((torrent, key) => {
    if (key !== torrentHash) {
      removeTorrent(key);
    }
  });
  currentTorrentHash = torrentHash;

  const currentCount = torrentAccessCount.get(torrentHash) || 0;
  torrentAccessCount.set(torrentHash, currentCount + 1);

  if (activeTorrents.has(torrentHash)) {
    const torrent = activeTorrents.get(torrentHash);
    torrent.lastAccess = Date.now();
    if (!torrent._hasLoggedResume) {
      console.log(`Resuming streaming torrent: "${torrent.name}"`);
      torrent._hasLoggedResume = true;
    }
    handleTorrent(torrent, range, res, parseInt(fileIndex, 10), time)
      .catch(err => {
        console.error(err);
        if (!res.headersSent) res.status(500).send('Error streaming video');
      });
  } else {
    console.log('\nAdding new torrent...');
    client.add(magnetLink, { path: 'downloads' }, (torrent) => {
      torrent.removeAllListeners();
      torrent.setMaxListeners(100);
      torrent.on('error', (err) => {
        console.error('Torrent error:', err);
        if (!res.headersSent) {
          res.status(500).send('An error occurred while processing the torrent.');
        }
      });
      torrent.lastAccess = Date.now();
      activeTorrents.set(torrentHash, torrent);
      console.log(`Started streaming torrent: "${torrent.name}"`);
      torrent._hasLoggedResume = true;
      handleTorrent(torrent, range, res, parseInt(fileIndex, 10), time)
        .catch(err => {
          console.error(err);
          if (!res.headersSent) res.status(500).send('Error streaming video');
        });
    });
  }
};

app.get('/stream', (req, res) => {
  const magnet = req.query.magnet;
  const fileIndex = req.query.fileIndex || 0;
  const range = req.headers.range;
  const time = req.query.t; // وقت البدء (بالثواني)
  if (!magnet) {
    return res.status(400).send('Please provide a Magnet link.');
  }
  addTorrentIfNotExist(magnet, res, range, fileIndex, time);
});

app.get('/torrent-info', (req, res) => {
  const magnet = req.query.magnet;
  if (!magnet) {
    return res.status(400).json({ error: 'Please provide a Magnet link.' });
  }
  let parsedMagnet;
  try {
    parsedMagnet = magnetUri(magnet);
  } catch (error) {
    console.error('Error parsing magnet URI:', error);
    return res.status(400).json({ error: 'Invalid Magnet link.' });
  }
  const torrentHash = parsedMagnet.infoHash;
  if (activeTorrents.has(torrentHash)) {
    const torrent = activeTorrents.get(torrentHash);
    const accessCount = torrentAccessCount.get(torrentHash) || 0;
    let seeds = 0;
    let leechers = 0;
    if (torrent.swarm && torrent.swarm.wires) {
      seeds = torrent.swarm.wires.filter(w => !w.peerChoking).length;
      leechers = torrent.numPeers - seeds;
    }
    const info = {
      name: torrent.name,
      infoHash: torrent.infoHash,
      magnetURI: torrent.magnetURI,
      accessCount: accessCount,
      numPeers: torrent.numPeers,
      seeds: seeds,
      leechers: leechers,
      progress: torrent.progress,
      files: torrent.files.map((f, index) => ({ index, name: f.name, length: f.length }))
    };
    return res.json(info);
  } else {
    return res.status(404).json({ error: 'Torrent is not active currently.' });
  }
});

app.get('/torrent/pause', (req, res) => {
  const magnet = req.query.magnet;
  if (!magnet) {
    return res.status(400).json({ error: 'Please provide a Magnet link.' });
  }
  let parsedMagnet;
  try {
    parsedMagnet = magnetUri(magnet);
  } catch (error) {
    console.error('Error parsing magnet URI:', error);
    return res.status(400).json({ error: 'Invalid Magnet link.' });
  }
  const torrentHash = parsedMagnet.infoHash;
  if (activeTorrents.has(torrentHash)) {
    const torrent = activeTorrents.get(torrentHash);
    if (torrent.pause) {
      torrent.pause();
      return res.json({ message: 'Torrent paused successfully.' });
    } else {
      torrent.files.forEach(file => file.deselect());
      torrent._paused = true;
      return res.json({ message: 'Torrent paused (simulated).' });
    }
  } else {
    return res.status(404).json({ error: 'Torrent is not active.' });
  }
});

app.get('/torrent/resume', (req, res) => {
  const magnet = req.query.magnet;
  if (!magnet) {
    return res.status(400).json({ error: 'Please provide a Magnet link.' });
  }
  let parsedMagnet;
  try {
    parsedMagnet = magnetUri(magnet);
  } catch (error) {
    console.error('Error parsing magnet URI:', error);
    return res.status(400).json({ error: 'Invalid Magnet link.' });
  }
  const torrentHash = parsedMagnet.infoHash;
  if (activeTorrents.has(torrentHash)) {
    const torrent = activeTorrents.get(torrentHash);
    if (torrent.resume) {
      torrent.resume();
      return res.json({ message: 'Torrent resumed successfully.' });
    } else {
      torrent.files.forEach(file => file.select());
      torrent._paused = false;
      return res.json({ message: 'Torrent resumed (simulated).' });
    }
  } else {
    return res.status(404).json({ error: 'Torrent is not active.' });
  }
});

app.get('/torrent/remove', (req, res) => {
  const magnet = req.query.magnet;
  if (!magnet) {
    return res.status(400).json({ error: 'Please provide a Magnet link.' });
  }
  let parsedMagnet;
  try {
    parsedMagnet = magnetUri(magnet);
  } catch (error) {
    console.error('Error parsing magnet URI:', error);
    return res.status(400).json({ error: 'Invalid Magnet link.' });
  }
  const torrentHash = parsedMagnet.infoHash;
  if (!activeTorrents.has(torrentHash)) {
    return res.status(404).json({ error: 'Torrent is not active.' });
  }
  removeTorrent(torrentHash);
  return res.json({ message: 'Torrent removed successfully.' });
});

setInterval(() => {
  const now = Date.now();
  activeTorrents.forEach((torrent, hash) => {
    if (now - torrent.lastAccess > 5 * 60 * 1000) {
      console.log(`Removing idle torrent: "${torrent.name}"`);
      removeTorrent(hash);
    }
  });
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
