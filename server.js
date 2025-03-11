import express from 'express';
import WebTorrent from 'webtorrent';
import magnetUri from 'magnet-uri';
import { pipeline } from 'stream';
import { EventEmitter } from 'events';

EventEmitter.defaultMaxListeners = 100;

const app = express();
const client = new WebTorrent();
const activeTorrents = new Map();
const torrentAccessCount = new Map(); // لتخزين عدد المستمعين لكل تورنت

// متغير لتخزين الهاش الخاص بالتورنت الحالي
let currentTorrentHash = null;

// تفعيل الكاش للملفات الثابتة لتحسين سرعة التحميل
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

  // إزالة "bytes=" والتخلص من الفراغات الزائدة
  const parts = range.replace(/bytes=/, '').trim().split('-');
  let start = parseInt(parts[0], 10);
  let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

  if (isNaN(start) || start < 0) start = 0;
  if (isNaN(end) || end >= fileSize) end = fileSize - 1;

  // إذا كانت قيمة البداية أكبر من النهاية، نستخدم النطاق الكامل بدل رمي الخطأ
  if (start > end) {
    console.warn('Invalid range: start is greater than end. Streaming full file.');
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
      console.error('Error parsing range:', err);
      return res.status(416).send('Requested Range Not Satisfiable');
    }
  }

  res.set('Content-Type', getMimeType(file.name));
  res.status(statusCode);

  // إذا وُجد stream سابق للتورنت، يتم تدميره لتحسين الأداء
  if (torrent._currentReadStream) {
    torrent._currentReadStream.destroy();
  }

  const readStream = file.createReadStream({ start: startByte, end: endByte });
  torrent._currentReadStream = readStream;
  pipeline(readStream, res, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error('Stream error:', err);
    }
    torrent._currentReadStream = null;
  });
};

const handleTorrent = (torrent, range, res, fileIndex = 0, startMinute = null, endMinute = null) => {
  // تحديث وقت الوصول الأخير للتورنت
  torrent.lastAccess = Date.now();

  // تصفية الملفات للحصول على ملفات الفيديو فقط (mp4 أو mkv)
  const videoFiles = torrent.files.filter(f => f.name.endsWith('.mp4') || f.name.endsWith('.mkv'));

  if (videoFiles.length === 0) {
    return res.status(404).send('No MP4 or MKV video found in this torrent.');
  }

  if (fileIndex < 0 || fileIndex >= videoFiles.length) {
    return res.status(400).send('Invalid fileIndex parameter.');
  }

  // إلغاء تحديد جميع الملفات لضمان تحميل الملف المحدد فقط
  torrent.files.forEach(file => file.deselect());

  // تحديد الملف المطلوب فقط
  const selectedFile = videoFiles[fileIndex];
  selectedFile.select();

  if (torrent._lastFileIndex !== fileIndex) {
    console.log(`Streaming file: "${selectedFile.name}" from torrent: "${torrent.name}"`);
    torrent._lastFileIndex = fileIndex;
  }

  // حساب النطاق المخصص إذا وُجد طلب للتحميل الجزئي حسب الدقائق
  let customRange = null;
  if (startMinute !== null) {
    const startMin = parseFloat(startMinute);
    const endMin = endMinute ? parseFloat(endMinute) : null;
    // التحقق من صحة معلمات الدقائق
    if (endMin !== null && startMin > endMin) {
      return res.status(416).send('Invalid minute range: startMinute is greater than endMinute');
    }
    // نفترض مدة فيديو افتراضية، مثلاً 120 دقيقة (7200 ثانية)
    const DEFAULT_VIDEO_DURATION = 7200; // بالثواني
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
        console.error('Error removing torrent:', err);
      } else {
        activeTorrents.delete(torrentHash);
        torrentAccessCount.delete(torrentHash);
        console.log(`Closed torrent: "${torrent.name}"`);
      }
    });
  }
};

const addTorrentIfNotExist = (magnetLink, res, range, fileIndex = 0, startMinute = null, endMinute = null) => {
  let parsedMagnet;
  try {
    parsedMagnet = magnetUri(magnetLink);
  } catch (error) {
    console.error('Error parsing magnet URI:', error);
    return res.status(400).send('Invalid Magnet link.');
  }
  const torrentHash = parsedMagnet.infoHash;

  // إزالة كل التورنتات غير التورنت الجاري بثه لتقليل استهلاك الموارد
  activeTorrents.forEach((torrent, key) => {
    if (key !== torrentHash) {
      removeTorrent(key);
    }
  });
  currentTorrentHash = torrentHash;

  // تحديث عدد المستمعين للتورنت الحالي
  const currentCount = torrentAccessCount.get(torrentHash) || 0;
  torrentAccessCount.set(torrentHash, currentCount + 1);

  if (activeTorrents.has(torrentHash)) {
    const torrent = activeTorrents.get(torrentHash);
    torrent.lastAccess = Date.now();
    if (!torrent._hasLoggedResume) {
      console.log(`Resuming streaming torrent: "${torrent.name}"`);
      torrent._hasLoggedResume = true;
    }
    handleTorrent(torrent, range, res, parseInt(fileIndex, 10), startMinute, endMinute);
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
      handleTorrent(torrent, range, res, parseInt(fileIndex, 10), startMinute, endMinute);
    });
  }
};

// نقطة النهاية لبث الفيديو مع دعم fileIndex وطلبات النطاق (range) ومعلمات الدقائق
app.get('/stream', (req, res) => {
  const magnet = req.query.magnet;
  const fileIndex = req.query.fileIndex || 0; // الافتراضي هو 0
  const range = req.headers.range;
  const startMinute = req.query.startMinute || null;
  const endMinute = req.query.endMinute || null;
  if (!magnet) {
    return res.status(400).send('Please provide a Magnet link.');
  }
  addTorrentIfNotExist(magnet, res, range, fileIndex, startMinute, endMinute);
});

// نقطة النهاية لاسترجاع تفاصيل التورنت
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
      progress: torrent.progress, // قيمة التقدم (0 إلى 1)
      files: torrent.files.map((f, index) => ({ index, name: f.name, length: f.length }))
    };
    return res.json(info);
  } else {
    return res.status(404).json({ error: 'Torrent is not active currently.' });
  }
});

// نقطة النهاية لإيقاف التورنت مؤقتًا
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

// نقطة النهاية لاستئناف التورنت
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

// نقطة النهاية لإزالة التورنت نهائيًا
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

// آلية تنظيف للتورنتات غير النشطة بعد 5 دقائق من عدم الاستخدام
setInterval(() => {
  const now = Date.now();
  activeTorrents.forEach((torrent, hash) => {
    if (now - torrent.lastAccess > 5 * 60 * 1000) { // 5 دقائق
      console.log(`Removing idle torrent: "${torrent.name}"`);
      removeTorrent(hash);
    }
  });
}, 60 * 1000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
