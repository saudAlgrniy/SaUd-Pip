import express from 'express';
import WebTorrent from 'webtorrent';
import magnetUri from 'magnet-uri';
import { pipeline } from 'stream';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

EventEmitter.defaultMaxListeners = 100;

// دالة مساعدة لتنسيق الرسائل في الـ cmd مع ألوان مختلفة
function logMessage(type, message) {
  const colors = {
    info: "\x1b[32m",   // أخضر للمعلومات
    error: "\x1b[31m",  // أحمر للأخطاء
    warn: "\x1b[33m",   // أصفر للتحذيرات
    debug: "\x1b[34m"   // أزرق للتصحيح
  };
  const color = colors[type] || "";
  const reset = "\x1b[0m";
  // تعطيل التفاف السطر
  process.stdout.write("\x1b[?7l");
  // طباعة الرسالة مع سطر فارغ قبل وبعدها
  console.log(`\n${color}${message}${reset}\n`);
  // إعادة تفعيل التفاف السطر
  process.stdout.write("\x1b[?7h");
}

const app = express();

// إنشاء عميل WebTorrent مع تحديد منفذ ثابت (من خلال متغير البيئة TORRENT_PORT أو القيمة الافتراضية 6881)
// وتعطيل DHT لتقليل عدد المنافذ المفتوحة
const client = new WebTorrent({
  torrentPort: process.env.TORRENT_PORT || 6881,
  dht: false
});

const activeTorrents = new Map();
const torrentAccessCount = new Map();

let currentTorrentHash = null;

app.use(express.static('public', {
  maxAge: '1d',
  etag: false
}));

const getMimeType = (filename) => {
  if (filename.endsWith('.mp4')) return 'video/mp4';
  if (filename.endsWith('.mkv')) return 'video/x-matroska';
  return 'application/octet-stream';
};

function parseRange(range, fileSize) {
  if (!range) return { start: 0, end: fileSize - 1 };

  const parts = range.replace(/bytes=/, '').trim().split('-');
  let start = parseInt(parts[0], 10);
  let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

  if (isNaN(start) || start < 0) start = 0;
  if (isNaN(end) || end >= fileSize) end = fileSize - 1;

  if (start > end) {
    logMessage("warn", 'Invalid range: start is greater than end. Streaming full file.');
    start = 0;
    end = fileSize - 1;
  }
  return { start, end };
}

const sendStream = (torrent, file, range, res, customRange = null) => {
  let startByte = 0;
  let endByte = file.length - 1;
  let statusCode = 200;

  if (customRange) {
    startByte = customRange.startByte;
    endByte = customRange.endByte;
    statusCode = 206;
    res.set('Content-Range', `bytes ${startByte}-${endByte}/${file.length}`);
    res.set('Accept-Ranges', 'bytes');
  } else if (range) {
    try {
      const parsed = parseRange(range, file.length);
      startByte = parsed.start;
      endByte = parsed.end;
      statusCode = 206;
      res.set('Content-Range', `bytes ${startByte}-${endByte}/${file.length}`);
      res.set('Accept-Ranges', 'bytes');
    } catch (err) {
      logMessage("error", `Error parsing range: ${err}`);
      return res.status(416).send('Requested Range Not Satisfiable');
    }
  }

  res.set('Content-Type', getMimeType(file.name));
  res.status(statusCode);

  if (torrent._currentReadStream) {
    torrent._currentReadStream.destroy();
  }

  const readStream = file.createReadStream({ start: startByte, end: endByte });
  torrent._currentReadStream = readStream;
  pipeline(readStream, res, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logMessage("error", `Stream error: ${err}`);
    }
    torrent._currentReadStream = null;
  });
};

const handleTorrent = (torrent, range, res, fileIndex = 0, startMinute = null, endMinute = null) => {
  torrent.lastAccess = Date.now();

  const videoFiles = torrent.files.filter(f => f.name.endsWith('.mp4') || f.name.endsWith('.mkv'));
  if (videoFiles.length === 0) {
    return res.status(404).send('No MP4 or MKV video found in this torrent.');
  }
  if (fileIndex < 0 || fileIndex >= videoFiles.length) {
    return res.status(400).send('Invalid fileIndex parameter.');
  }
  const selectedFile = videoFiles[fileIndex];

  // في حال وجود أكثر من ملف فيديو، يتم تحديد الملف المطلوب وتحميله فقط
  if (videoFiles.length > 1) {
    const totalPieces = Math.ceil(torrent.length / torrent.pieceLength);
    torrent.deselect(0, totalPieces - 1, 0);

    torrent.files.forEach(file => {
      const startPiece = Math.floor(file.offset / torrent.pieceLength);
      const endPiece = Math.ceil((file.offset + file.length) / torrent.pieceLength) - 1;
      if (file === selectedFile) {
        torrent.select(startPiece, endPiece, 0);
        file.select();
      } else {
        torrent.deselect(startPiece, endPiece, 0);
      }
    });
  }

  if (torrent._lastFileIndex !== fileIndex) {
    logMessage("info", `Streaming file: "${selectedFile.name}" from torrent: "${torrent.name}"`);
    torrent._lastFileIndex = fileIndex;
  }

  let customRange = null;
  if (startMinute !== null) {
    const startMin = parseFloat(startMinute);
    const endMin = endMinute ? parseFloat(endMinute) : null;
    if (endMin !== null && startMin > endMin) {
      return res.status(416).send('Invalid minute range: startMinute is greater than endMinute');
    }
    const DEFAULT_VIDEO_DURATION = 7200;
    const startTimeSec = startMin * 60;
    const endTimeSec = endMin ? endMin * 60 : DEFAULT_VIDEO_DURATION;
    customRange = {
      startByte: Math.floor(selectedFile.length * (startTimeSec / DEFAULT_VIDEO_DURATION)),
      endByte: Math.floor(selectedFile.length * (endTimeSec / DEFAULT_VIDEO_DURATION))
    };
  }

  sendStream(torrent, selectedFile, range, res, customRange);
};

const removeTorrent = (torrentHash) => {
  if (activeTorrents.has(torrentHash)) {
    const torrent = activeTorrents.get(torrentHash);
    client.remove(torrentHash, (err) => {
      if (err) {
        logMessage("error", `Error removing torrent: ${err}`);
      } else {
        activeTorrents.delete(torrentHash);
        torrentAccessCount.delete(torrentHash);
        console.clear();
        logMessage("warn", `Closed torrent: "${torrent.name}"`);
        const downloadPath = path.join('downloads', torrentHash);
        fs.rm(downloadPath, { recursive: true, force: true }, (err) => {
          if (err) {
            logMessage("error", `Error removing download folder for torrent "${torrent.name}": ${err}`);
          } else {
            logMessage("debug", `Removed download folder: "${downloadPath}"`);
          }
          setTimeout(() => {
            console.clear();
          }, 2000);
        });
      }
    });
  }
};

const addTorrentIfNotExist = (magnetLink, res, range, fileIndex = 0, startMinute = null, endMinute = null) => {
  let parsedMagnet;
  try {
    parsedMagnet = magnetUri(magnetLink);
  } catch (error) {
    logMessage("error", `Error parsing magnet URI: ${error}`);
    return res.status(400).send('Invalid Magnet link.');
  }
  const torrentHash = parsedMagnet.infoHash;

  // إزالة التورنتات الأخرى غير المطابقة للتورنت الحالي
  activeTorrents.forEach((torrent, key) => {
    if (key !== torrentHash) {
      removeTorrent(key);
    }
  });
  currentTorrentHash = torrentHash;

  const currentCount = torrentAccessCount.get(torrentHash) || 0;
  torrentAccessCount.set(torrentHash, currentCount + 1);

  // التحقق من وجود التورنت في activeTorrents أو في عميل WebTorrent
  let torrent = activeTorrents.get(torrentHash) || client.get(torrentHash);
  if (torrent) {
    torrent.lastAccess = Date.now();
    if (!torrent._loggedResumed) {
      logMessage("info", `Resuming streaming torrent: "${torrent.name}"`);
      torrent._loggedResumed = true;
    }
    activeTorrents.set(torrentHash, torrent);
    handleTorrent(torrent, range, res, parseInt(fileIndex, 10), startMinute, endMinute);
  } else {
    logMessage("info", 'Adding new torrent...');
    client.add(magnetLink, { path: path.join('downloads', torrentHash) }, (torrent) => {
      torrent.removeAllListeners();
      torrent.setMaxListeners(100);
      torrent.on('error', (err) => {
        logMessage("error", `Torrent error: ${err}`);
        if (!res.headersSent) {
          res.status(500).send('An error occurred while processing the torrent.');
        }
      });
      torrent.lastAccess = Date.now();
      activeTorrents.set(torrentHash, torrent);
      logMessage("info", `Started streaming torrent: "${torrent.name}"`);
      handleTorrent(torrent, range, res, parseInt(fileIndex, 10), startMinute, endMinute);
    });
  }
};

app.get('/stream', (req, res) => {
  const magnet = req.query.magnet;
  const fileIndex = req.query.fileIndex || 0;
  const range = req.headers.range;
  const startMinute = req.query.startMinute || null;
  const endMinute = req.query.endMinute || null;
  if (!magnet) {
    return res.status(400).send('Please provide a Magnet link.');
  }
  addTorrentIfNotExist(magnet, res, range, fileIndex, startMinute, endMinute);
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
    logMessage("error", `Error parsing magnet URI: ${error}`);
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
      files: torrent.files.map((f, index) => ({
        index,
        name: f.name,
        length: f.length,
        progress: f.length ? (f.downloaded || 0) / f.length : 0
      }))
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
    logMessage("error", `Error parsing magnet URI: ${error}`);
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
    logMessage("error", `Error parsing magnet URI: ${error}`);
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
    logMessage("error", `Error parsing magnet URI: ${error}`);
    return res.status(400).json({ error: 'Invalid Magnet link.' });
  }
  const torrentHash = parsedMagnet.infoHash;
  if (!activeTorrents.has(torrentHash)) {
    return res.status(404).json({ error: 'Torrent is not active.' });
  }
  removeTorrent(torrentHash);
  return res.json({ message: 'Torrent removed successfully.' });
});

// استخدام متغير البيئة للمنفذ؛ Render ستحدد المنفذ من خلال process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logMessage("info", `Server running on http://localhost:${PORT}`);
});
