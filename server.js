import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import TorrentManager from './torrentManager.js';
import srt2vtt from 'srt-to-vtt';
import { PassThrough } from 'stream';

// --- إعدادات أساسية ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- دالة مساعدة للتسجيل الملون ---
function logMessage(type, message) { /* ... نفس الدالة ... */
     const colors = { info: "\x1b[32m", error: "\x1b[31m", warn: "\x1b[33m", debug: "\x1b[34m", ws: "\x1b[36m" };
    const color = colors[type] || "";
    const reset = "\x1b[0m";
    console.log(`${color}[Server:${type.toUpperCase()}] ${message}${reset}`);
}

// --- تهيئة Express و HTTP و WebSocket ---
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// --- خدمة الملفات الثابتة ---
const publicPath = join(__dirname, 'public');
logMessage('info', `Serving static files from: ${publicPath}`);
app.use(express.static(publicPath));

// --- إنشاء وإدارة TorrentManager ---
const torrentManager = new TorrentManager();

// --- معالجة اتصالات WebSocket ---
wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    logMessage('ws', `Client connected from IP: ${clientIp}`);
    let currentFileId = null; // يتتبع التورنت *النشط* لهذا الاتصال المحدد

    // --- دالة كول باك للحالة ---
    const sendStatusUpdate = (status) => {
        if (ws.readyState === ws.OPEN) {
            if (status.fileId === currentFileId) { // إرسال فقط إذا كان للتورنت النشط
                ws.send(JSON.stringify(status));
            }
        }
    };

    // --- معالجة الرسائل ---
    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message.toString());
            logMessage('ws', `Received message type: ${data.type} from ${clientIp} (Index: ${data.videoIndex ?? 'N/A'})`);
        } catch (error) {
            logMessage('error', `Failed to parse message from ${clientIp}: ${message.toString().substring(0, 100)}`); // Log truncated message
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message format.' }));
            return;
        }

        try {
            let torrentPromise = null;
            const options = {};
            if (data.videoIndex !== undefined && !isNaN(parseInt(data.videoIndex, 10))) {
                options.preferredVideoIndex = parseInt(data.videoIndex, 10);
                logMessage('info', `Client ${clientIp} requested video index: ${options.preferredVideoIndex}`);
            } else {
                logMessage('debug', `No valid video index provided by ${clientIp}, using default.`);
            }

            // 1. التنظيف *قبل* البدء
            const previousFileId = currentFileId; // Store previous ID before clearing
            if (previousFileId) {
                 logMessage('warn', `Cleaning up previous torrent ${previousFileId} for new request from ${clientIp}.`);
                 currentFileId = null; // Clear active ID immediately
                 await torrentManager.cleanup(previousFileId); // Perform cleanup
                 logMessage('info', `Cleanup completed for ${previousFileId}`);
            }


            // 2. تحديد دالة الإضافة
            if (data.type === 'torrentFile' && data.fileData) {
                logMessage('info', `Processing 'torrentFile' request from ${clientIp}...`);
                const fileBuffer = Buffer.from(data.fileData, 'base64');
                torrentPromise = torrentManager.addTorrentFile(fileBuffer, sendStatusUpdate, options);

            } else if (data.type === 'magnetLink' && data.magnetLink) {
                logMessage('info', `Processing 'magnetLink' request from ${clientIp}...`);
                torrentPromise = torrentManager.addTorrent(data.magnetLink, sendStatusUpdate, options);

            } else {
                logMessage('warn', `Unknown message type or missing data from ${clientIp}: ${JSON.stringify(data)}`);
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: 'Unknown request type or missing data.' }));
                return;
            }

            // 3. انتظار النتيجة والتعامل معها
            if (torrentPromise) {
                const result = await torrentPromise;

                if (ws.readyState !== ws.OPEN) {
                    logMessage('warn', `WS closed for ${clientIp} before processing finished for ${result?.fileId}. Cleaning up new torrent.`);
                    if (result?.success && result.fileId) {
                        await torrentManager.cleanup(result.fileId);
                    }
                    return;
                }

                if (result.success) {
                    currentFileId = result.fileId; // *** تعيين المعرف النشط الجديد ***

                    logMessage('info', `Torrent added successfully for ${clientIp}. File ID: ${currentFileId}, Video: ${result.fileName} (Index: ${result.videoFileIndex})`);

                    // *** إرسال المعلومات الشاملة للعميل ***
                    ws.send(JSON.stringify({
                        type: 'videoInfo',
                        url: `/stream/${result.fileId}`,
                        fileName: result.fileName,          // اسم الفيديو المشغل
                        fileId: result.fileId,              // المعرف الفريد للبث
                        videoFileIndex: result.videoFileIndex, // فهرس الفيديو المشغل فعليًا
                        videoFiles: result.videoFiles,      // كل ملفات الفيديو المتاحة [{name, length, index}]
                        subtitleFiles: result.subtitleFiles, // ملفات الترجمة المتاحة [{name, index}]
                        allFiles: result.allFiles           // كل الملفات [{name, length, index}]
                    }));
                } else {
                     logMessage('error', `Torrent add failed for ${clientIp}.`);
                     if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: result.error || 'Failed to add torrent.' }));
                     currentFileId = null; // Ensure no active ID if failed
                }
            }
        } catch (error) {
            logMessage('error', `Error processing message for ${clientIp}: ${error.message}`);
            logMessage('debug', error.stack);
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: `Server error: ${error.message}` }));
            }
             // No need to cleanup here as cleanup happens *before* add attempts
        }
    });

    // --- معالجة إغلاق الاتصال ---
    ws.on('close', async (code, reason) => {
        const reasonMsg = reason ? reason.toString('utf8') : 'No reason given';
        const wasClean = code === 1000 || code === 1001 || code === 1005; // Common clean codes
        logMessage('ws', `Client disconnected ${clientIp}. Code: ${code}, Reason: "${reasonMsg}", Clean: ${wasClean}`);
        const idToClean = currentFileId; // Capture ID before clearing
        currentFileId = null; // Clear active ID for this closed connection
        if (idToClean) {
            logMessage('info', `Cleaning up torrent ${idToClean} for disconnected client ${clientIp}.`);
            await torrentManager.cleanup(idToClean); // Use captured ID
        } else {
            logMessage('debug', `Client ${clientIp} disconnected without an active torrent to clean.`);
        }
    });

    // --- معالجة أخطاء الاتصال ---
    ws.on('error', (error) => {
         logMessage('error', `WebSocket error for ${clientIp}: ${error.message}`);
         // The 'close' event will likely follow, triggering cleanup.
         // Avoid redundant cleanup here unless necessary.
         // If cleanup needed here, capture currentFileId before clearing it.
         const idToCleanOnError = currentFileId;
         currentFileId = null; // Assume connection is lost
         if (idToCleanOnError) {
             logMessage('warn', `Cleaning up torrent ${idToCleanOnError} due to WebSocket error for ${clientIp}.`);
             torrentManager.cleanup(idToCleanOnError).catch(cleanupErr => {
                 logMessage('error', `Error during cleanup after WS error: ${cleanupErr.message}`);
             });
         }
    });

    // --- رسالة الترحيب ---
    if (ws.readyState === ws.OPEN) {
         ws.send(JSON.stringify({ type: 'info', message: 'أهلاً بك! أدخل رابط ماجنت أو اختر ملف تورنت للبدء.' }));
    }
});

// --- نقاط نهاية HTTP (stream, subtitles) ---
app.get('/stream/:fileId', async (req, res) => {
    // ... (نفس كود نقطة نهاية /stream السابق، يعتمد على getVideoFile/getVideoStream المُحسَّن) ...
     const fileId = req.params.fileId;
    const range = req.headers.range;
    logMessage('info', `Stream request for fileId: ${fileId}${range ? ` Range: ${range}` : ''}`);

    // getVideoStream now includes checks for destroyed torrents
    const videoStream = torrentManager.getVideoStream(fileId); // Get stream first to ensure validity

    if (!videoStream) {
        // getVideoStream handles logging the reason (not found or destroyed)
        return res.status(404).send('Video stream not available or session expired.');
    }

    // If stream is valid, get the file object to read size (should still exist if stream is valid)
    const videoFile = torrentManager.getVideoFile(fileId);
     if (!videoFile) {
         // This case should be rare if getVideoStream succeeded, but handle defensively
         logMessage('error', `Stream Error: videoFile object missing for ${fileId} even though stream was obtained.`);
         if (!videoStream.destroyed) videoStream.destroy(); // Clean up the obtained stream
         return res.status(500).send('Internal server error retrieving file details.');
     }


    const fileSize = videoFile.length;
    const mimeType = getVideoMimeType(videoFile.name);
    let streamOptions = {}; // Options passed to createReadStream *inside* getVideoStream
    let responseHeaders = { 'Accept-Ranges': 'bytes', 'Content-Type': mimeType };
    let statusCode = 200;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (start >= fileSize || end >= fileSize || start < 0 || end < 0 || start > end) {
            logMessage('warn', `Invalid range: ${range} for size ${fileSize}`);
            res.setHeader('Content-Range', `bytes */${fileSize}`);
             if (!videoStream.destroyed) videoStream.destroy(); // Destroy unused stream
            return res.status(416).send('Range Not Satisfiable');
        }

        const chunksize = (end - start) + 1;
        streamOptions = { start, end }; // Store options to potentially pass again if needed
        responseHeaders['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
        responseHeaders['Content-Length'] = chunksize;
        statusCode = 206;
        logMessage('debug', `Serving range ${start}-${end} (${chunksize} bytes) for ${fileId}`);

         // Re-get the stream with range options (more correct with webtorrent)
         const rangedStream = torrentManager.getVideoStream(fileId, streamOptions);
          if (!rangedStream) {
              logMessage('error', `Stream Error: Failed to create *ranged* stream for ${fileId}`);
               if (!videoStream.destroyed) videoStream.destroy(); // Destroy original stream
              return res.status(500).send('Error creating ranged video stream.');
          }
           // Destroy the initial full stream if we created a new ranged one
           if (!videoStream.destroyed) videoStream.destroy();
           // Use the ranged stream from now on
           pipeStreamToResponse(rangedStream, res, req, fileId, statusCode, responseHeaders);


    } else {
        responseHeaders['Content-Length'] = fileSize;
        statusCode = 200;
        logMessage('debug', `Serving full file (${fileSize} bytes) for ${fileId}`);
        // Pipe the initially obtained full stream
         pipeStreamToResponse(videoStream, res, req, fileId, statusCode, responseHeaders);
    }
});

// Helper function to pipe stream and handle events
function pipeStreamToResponse(stream, res, req, fileId, statusCode, headers) {
     res.writeHead(statusCode, headers);

     req.on('close', () => {
        logMessage('warn', `Client closed stream connection for ${fileId}. Destroying stream.`);
        if (stream && !stream.destroyed) {
            stream.destroy();
        }
    });

    stream.pipe(res).on('error', (streamErr) => {
        logMessage('error', `Error piping stream for ${fileId}: ${streamErr.message}`);
        if (stream && !stream.destroyed) {
            stream.destroy();
        }
        if (!res.headersSent) {
            res.status(500).send('Streaming error occurred.');
        } else if (!res.writableEnded) {
             // Try to end the response if possible
             res.end();
        }
    }).on('finish', () => {
        logMessage('debug', `Piping finished successfully for ${fileId}`);
    });
}


app.get('/subtitles/:fileId/:index', async (req, res) => {
    // ... (نفس كود نقطة نهاية /subtitles السابق، يعتمد على getSubtitleFile المُحسَّن) ...
     const { fileId, index: indexStr } = req.params;
    const index = parseInt(indexStr, 10);

    if (isNaN(index) || index < 0) {
        logMessage('warn', `Invalid subtitle index: ${indexStr} for fileId: ${fileId}`);
        return res.status(400).send('Invalid subtitle index.');
    }

    logMessage('info', `Subtitle request for fileId: ${fileId}, index: ${index}`);
    const subtitleFile = torrentManager.getSubtitleFile(fileId, index); // Use the index directly

    if (!subtitleFile) {
        logMessage('warn', `Subtitle not found for fileId: ${fileId}, index: ${index}`);
        return res.status(404).send('Subtitle file not found or session expired.');
    }

    const isSrt = subtitleFile.name.toLowerCase().endsWith('.srt');
    logMessage('debug', `Serving subtitle: ${subtitleFile.name} (${isSrt ? 'SRT' : 'VTT'})`);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');

    try {
        const sourceStream = subtitleFile.createReadStream();
        sourceStream.on('error', (err) => {
            logMessage('error', `Error reading subtitle stream (${subtitleFile.name}): ${err.message}`);
            if (!res.headersSent) res.status(500).send('Error reading subtitle.'); else if (!res.writableEnded) res.end();
        });

        req.on('close', () => {
            logMessage('warn', `Client closed subtitle connection for ${subtitleFile.name}.`);
            if (sourceStream && !sourceStream.destroyed) sourceStream.destroy();
        });

        if (isSrt) {
            const converterStream = srt2vtt();
            converterStream.on('error', (err) => {
                logMessage('error', `SRT conversion error (${subtitleFile.name}): ${err.message}`);
                if (sourceStream && !sourceStream.destroyed) sourceStream.destroy();
                if (!res.headersSent) res.status(500).send('Error converting subtitle.'); else if (!res.writableEnded) res.end();
            });
            sourceStream.pipe(converterStream).pipe(res);
        } else {
            sourceStream.pipe(res);
        }
    } catch (error) {
        logMessage('error', `Unexpected error serving subtitle ${subtitleFile.name}: ${error.message}`);
        if (!res.headersSent) res.status(500).send('Server error serving subtitle.'); else if (!res.writableEnded) res.end();
    }
});

// --- دالة مساعدة لتحديد نوع MIME ---
function getVideoMimeType(fileName = '') { /* ... نفس الدالة ... */
     const lowerCaseName = fileName.toLowerCase();
    if (lowerCaseName.endsWith('.mp4')) return 'video/mp4';
    if (lowerCaseName.endsWith('.webm')) return 'video/webm';
    if (lowerCaseName.endsWith('.mkv')) return 'video/mp4';
    if (lowerCaseName.endsWith('.mov')) return 'video/quicktime';
    if (lowerCaseName.endsWith('.avi')) return 'video/x-msvideo';
    return 'video/mp4';
}

// --- بدء تشغيل الخادم ---
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    logMessage('info', `Server running on http://localhost:${PORT}`);
    logMessage('info', 'WebSocket server ready.');
});

// --- معالجة إيقاف التشغيل النظيف ---
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
async function handleShutdown() { /* ... نفس الدالة ... */
     logMessage('warn', 'Shutdown signal received. Closing server gracefully...');
    let exitCode = 0;
    try {
        logMessage('info', 'Closing WebSocket connections...');
        await new Promise(resolve => { wss.close(() => { logMessage('info', 'WebSocket server closed.'); resolve(); }); setTimeout(() => { logMessage('warn', 'Forcibly terminating remaining WS connections.'); wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.terminate(); }); resolve(); }, 3000); });
        logMessage('info', 'Closing HTTP server...');
        await new Promise(resolve => server.close(resolve)); logMessage('info', 'HTTP server closed.');
        logMessage('info', 'Cleaning up active torrents...');
        const cleanupPromises = Array.from(torrentManager.torrents.keys()).map(fileId => { logMessage('warn', `Cleaning up torrent ${fileId} during shutdown.`); return torrentManager.cleanup(fileId).catch(err => logMessage('error', `Error cleaning up ${fileId}: ${err.message}`)); });
        await Promise.all(cleanupPromises); logMessage('info', 'Active torrents cleaned up.');
        logMessage('info', 'Destroying WebTorrent client...');
        await new Promise(resolve => torrentManager.client.destroy(resolve)); logMessage('info', 'WebTorrent client destroyed.');
    } catch (err) { logMessage('error', `Error during graceful shutdown: ${err.message}`); exitCode = 1; }
    finally { logMessage('info', `Shutdown complete. Exiting with code ${exitCode}.`); process.exit(exitCode); }
}
