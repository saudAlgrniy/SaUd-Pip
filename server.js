// كود server.js (معدّل)
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
function logMessage(type, message) {
    const colors = { info: "\x1b[32m", error: "\x1b[31m", warn: "\x1b[33m", debug: "\x1b[34m", ws: "\x1b[36m" };
    const color = colors[type] || "\x1b[37m"; // Default to white if type unknown
    const reset = "\x1b[0m";
    // Add timestamp for better debugging
    const timestamp = new Date().toISOString();
    console.log(`${color}[${timestamp}] [Server:${type.toUpperCase()}] ${message}${reset}`);
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
            // تحقق إضافي للتأكد من أن fileId يتطابق مع آخر ما طلبه هذا العميل
            if (status.fileId === currentFileId) {
                try {
                    ws.send(JSON.stringify(status));
                } catch (sendError) {
                    logMessage('error', `Failed to send status update to ${clientIp} for ${currentFileId}: ${sendError.message}`);
                    if (ws.readyState === ws.OPEN) {
                        ws.terminate(); // إغلاق قسري إذا كان الإرسال فشل
                    }
                    // *** تم التعليق: لا تقم بالتنظيف التلقائي عند فشل الإرسال بعد الآن ***
                    // if (currentFileId) {
                    //     const idToClean = currentFileId;
                    //     currentFileId = null;
                    //     logMessage('warn', `Terminating WS and cleaning up torrent ${idToClean} due to send error for ${clientIp}.`);
                    //     torrentManager.cleanup(idToClean).catch(cleanupErr => {
                    //         logMessage('error', `Error during cleanup after WS send error: ${cleanupErr.message}`);
                    //     });
                    // }
                }
            } else {
                // logMessage('debug', `Status update for ${status.fileId} ignored, current active is ${currentFileId} for ${clientIp}`);
            }
        }
    };

    // --- معالجة الرسائل ---
    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message.toString());
            logMessage('ws', `Received message type: ${data.type} from ${clientIp} (VideoIndex: ${data.videoIndex ?? 'N/A'})`);
        } catch (error) {
            logMessage('error', `Failed to parse message from ${clientIp}: ${message.toString().substring(0, 100)}...`);
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

            // 1. التنظيف *قبل* البدء (تنظيف التورنت *السابق* المرتبط بهذا الاتصال المحدد)
            const previousFileId = currentFileId;
            if (previousFileId) {
                logMessage('warn', `Cleaning up previous torrent ${previousFileId} for new request from ${clientIp}.`);
                currentFileId = null; // قم بإلغاء تعيين المعرف النشط *قبل* بدء التنظيف غير المتزامن
                await torrentManager.cleanup(previousFileId);
                logMessage('info', `Cleanup completed for ${previousFileId} for ${clientIp}`);
            } else {
                currentFileId = null; // تأكد من أنه فارغ إذا لم يكن هناك سابق
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

                // تحقق من حالة الاتصال مرة أخرى *بعد* اكتمال العملية وقبل الإرسال
                if (ws.readyState !== ws.OPEN) {
                    logMessage('warn', `WS closed for ${clientIp} before processing finished for ${result?.fileId}. Torrent might persist.`);
                    // *** تم التعليق: لا تقم بالتنظيف هنا تلقائيًا ***
                    // if (result?.success && result.fileId) {
                    //     await torrentManager.cleanup(result.fileId);
                    // }
                    return;
                }

                if (result.success) {
                    currentFileId = result.fileId; // *** فقط قم بتعيين المعرف النشط إذا كان الاتصال لا يزال مفتوحًا ***
                    logMessage('info', `Torrent added successfully for ${clientIp}. File ID: ${currentFileId}, Video: ${result.fileName} (Index: ${result.videoFileIndex})`);

                    const subtitleFilesForClient = result.subtitleFilesInfo.map((subInfo, index) => ({
                        name: subInfo.name,
                        originalIndex: subInfo.index,
                        subtitleArrayIndex: index
                    }));

                    ws.send(JSON.stringify({
                        type: 'videoInfo',
                        url: `/stream/${result.fileId}`,
                        fileName: result.fileName,
                        fileId: result.fileId,
                        videoFileIndex: result.videoFileIndex,
                        videoFiles: result.videoFiles,
                        subtitleFiles: subtitleFilesForClient,
                        allFiles: result.allFiles
                    }));
                } else {
                    logMessage('error', `Torrent add failed for ${clientIp}. Reason: ${result.error || 'Unknown'}`);
                    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: result.error || 'Failed to add torrent.' }));
                    currentFileId = null; // لا تعيّن المعرف إذا فشلت الإضافة
                }
            }
        } catch (error) {
            logMessage('error', `Error processing message for ${clientIp}: ${error.message}`);
            logMessage('debug', error.stack);
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: `Server error during processing: ${error.message}` }));
            }
            currentFileId = null; // لا ينبغي تعيين المعرف إذا حدث خطأ أثناء الإضافة
        }
    });

    // --- معالجة إغلاق الاتصال ---
    ws.on('close', async (code, reason) => {
        const reasonMsg = reason ? reason.toString('utf8') : 'No reason given';
        const wasClean = code === 1000 || code === 1001 || code === 1005;
        logMessage('ws', `Client disconnected ${clientIp}. Code: ${code}, Reason: "${reasonMsg}", Clean: ${wasClean}`);

        const idAssociatedWithClosedWs = currentFileId; // احصل على المعرف المرتبط بهذا الاتصال
        currentFileId = null; // امسح المعرف النشط لهذا الاتصال المغلق فورًا

        // ------------------------------------------------------------------
        // --- بداية التعديل: إزالة التنظيف التلقائي ---
        // ------------------------------------------------------------------
        if (idAssociatedWithClosedWs) {
            logMessage('info', `Client ${clientIp} disconnected. Torrent ${idAssociatedWithClosedWs} will continue running unless cleaned up manually or by other means.`);
            // *** تم التعليق على الكود التالي لمنع التنظيف التلقائي ***
            // logMessage('info', `Initiating cleanup for torrent ${idAssociatedWithClosedWs} due to WS close for ${clientIp}.`);
            // try {
            //     await torrentManager.cleanup(idAssociatedWithClosedWs);
            //     logMessage('info', `Cleanup completed successfully for ${idAssociatedWithClosedWs} (Client ${clientIp}).`);
            // } catch (cleanupError) {
            //     logMessage('error', `Error during cleanup for ${idAssociatedWithClosedWs} (Client ${clientIp}): ${cleanupError.message}`);
            // }
        } else {
            logMessage('debug', `Client ${clientIp} disconnected without an active torrent ID (currentFileId was null). No cleanup needed for this connection closure.`);
        }
        // ------------------------------------------------------------------
        // --- نهاية التعديل ---
        // ------------------------------------------------------------------
    });

    // --- معالجة أخطاء الاتصال ---
    ws.on('error', (error) => {
        logMessage('error', `WebSocket error for ${clientIp}: ${error.message}`);
        const idAssociatedWithErroringWs = currentFileId;
        currentFileId = null; // افترض أن الاتصال فُقد ومنع الاستخدام الإضافي

        // ------------------------------------------------------------------
        // --- بداية التعديل: إزالة التنظيف التلقائي ---
        // ------------------------------------------------------------------
        if (idAssociatedWithErroringWs) {
            logMessage('warn', `WebSocket error occurred for ${clientIp}. Torrent ${idAssociatedWithErroringWs} will continue running.`);
            // *** تم التعليق على الكود التالي لمنع التنظيف التلقائي ***
            // logMessage('warn', `Initiating cleanup for torrent ${idAssociatedWithErroringWs} due to WebSocket error for ${clientIp}.`);
            // torrentManager.cleanup(idAssociatedWithErroringWs).catch(cleanupErr => {
            //     logMessage('error', `Error during cleanup triggered by WS error for ${idAssociatedWithErroringWs}: ${cleanupErr.message}`);
            // });
        } else {
            logMessage('debug', `WebSocket error for ${clientIp} occurred, but no active torrent ID was associated.`);
        }
        // ------------------------------------------------------------------
        // --- نهاية التعديل ---
        // ------------------------------------------------------------------
        // لا تحاول إرسال رسائل هنا، لأن الاتصال غالبًا ما يكون معطلاً.
    });

    // --- رسالة الترحيب ---
    if (ws.readyState === ws.OPEN) {
        try {
            ws.send(JSON.stringify({ type: 'info', message: 'أهلاً بك! أدخل رابط ماجنت أو اختر ملف تورنت للبدء.' }));
        } catch (welcomeError) {
            logMessage('error', `Failed to send welcome message to ${clientIp}: ${welcomeError.message}`);
            if (ws.readyState === ws.OPEN) ws.terminate(); // أغلق إذا فشلت رسالة الترحيب
        }
    }
});

// --- نقاط نهاية HTTP (stream, subtitles) ---
app.get('/stream/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    const range = req.headers.range;
    const clientIp = req.ip || req.socket.remoteAddress;
    logMessage('info', `[/stream] Request for fileId: ${fileId}${range ? ` Range: ${range}` : ''} from ${clientIp}`);

    // تحقق من الوجود أولاً (أكثر كفاءة)
    if (!torrentManager.torrents.has(fileId)) {
        logMessage('warn', `[/stream] Torrent data for ${fileId} not found in map.`);
        return res.status(404).send('Video stream session not found or expired.');
    }

    // الحصول على الدفق (يشمل التحقق من التدمير)
    const streamOptions = {}; // سيتم ملؤها لطلبات النطاق لاحقًا
    const videoStream = torrentManager.getVideoStream(fileId); // احصل على الدفق الكامل المحتمل أولاً

    if (!videoStream) {
        // getVideoStream يسجل السبب (غير موجود أو تم تدميره)
        return res.status(404).send('Video stream not available or session expired.');
    }

    // الحصول على تفاصيل الملف (يجب أن تكون موجودة إذا كان الدفق صالحًا)
    const videoFile = torrentManager.getVideoFile(fileId);
    if (!videoFile) {
        logMessage('error', `[/stream] videoFile object missing for ${fileId} even though stream was obtained. This shouldn't happen.`);
        if (videoStream && !videoStream.destroyed) videoStream.destroy();
        return res.status(500).send('Internal server error retrieving file details.');
    }

    const fileSize = videoFile.length;
    const mimeType = getVideoMimeType(videoFile.name);
    const responseHeaders = { 'Accept-Ranges': 'bytes', 'Content-Type': mimeType };
    let statusCode = 200;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const endRequested = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        // تأكد من أن النهاية لا تتجاوز fileSize - 1
        const end = Math.min(endRequested, fileSize - 1);

        if (isNaN(start) || isNaN(end) || start < 0 || end < 0 || start >= fileSize || start > end) {
            logMessage('warn', `[/stream] Invalid range requested: ${range} for size ${fileSize}. Sending 416.`);
            res.setHeader('Content-Range', `bytes */${fileSize}`);
            if (videoStream && !videoStream.destroyed) videoStream.destroy();
            return res.status(416).send('Range Not Satisfiable');
        }

        const chunksize = (end - start) + 1;
        streamOptions.start = start;
        streamOptions.end = end;
        responseHeaders['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
        responseHeaders['Content-Length'] = chunksize;
        statusCode = 206; // Partial Content
        logMessage('debug', `[/stream] Serving range ${start}-${end} (${chunksize} bytes) for ${fileId}`);

        // تدمير الدفق الأولي (الكامل المحتمل) إذا حصلنا على واحد
        if (videoStream && !videoStream.destroyed) {
            //logMessage('debug', '[/stream] Destroying initial full stream before creating ranged stream.');
            videoStream.destroy();
        }

        // الحصول على الدفق المحدد النطاق
        const rangedStream = torrentManager.getVideoStream(fileId, streamOptions);
        if (!rangedStream) {
            logMessage('error', `[/stream] Failed to create *ranged* stream for ${fileId} (${start}-${end}). Torrent might have been destroyed between checks.`);
            return res.status(500).send('Error creating ranged video stream.');
        }
        pipeStreamToResponse(rangedStream, res, req, fileId, statusCode, responseHeaders);

    } else {
        // لم يتم طلب نطاق، قدم الملف بالكامل
        responseHeaders['Content-Length'] = fileSize;
        statusCode = 200;
        logMessage('debug', `[/stream] Serving full file (${fileSize} bytes) for ${fileId}`);
        // قم بتمرير الدفق الكامل الذي تم الحصول عليه في البداية
        pipeStreamToResponse(videoStream, res, req, fileId, statusCode, responseHeaders);
    }
});

// دالة مساعدة لتمرير الدفق ومعالجة الأحداث
function pipeStreamToResponse(stream, res, req, fileId, statusCode, headers) {
    const clientIp = req.ip || req.socket.remoteAddress;
    logMessage('debug', `[pipeStream] Piping stream for ${fileId} to ${clientIp} with status ${statusCode}`);
    res.writeHead(statusCode, headers);

    const onReqClose = () => {
        logMessage('warn', `[pipeStream] Client ${clientIp} closed stream connection for ${fileId}. Destroying stream.`);
        if (stream && !stream.destroyed) {
            stream.destroy();
        }
    };

    req.on('close', onReqClose);

    stream.pipe(res)
        .on('error', (streamErr) => {
            logMessage('error', `[pipeStream] Error piping stream for ${fileId} to ${clientIp}: ${streamErr.message}`);
            req.removeListener('close', onReqClose); // تنظيف المستمع
            if (stream && !stream.destroyed) {
                stream.destroy();
            }
            // لا تحاول إرسال الترويسات إذا تم إرسالها بالفعل
            if (!res.headersSent) {
                res.status(500).send('Streaming error occurred.');
            } else if (!res.writableEnded) {
                // حاول إنهاء الاستجابة بأمان إن أمكن
                res.end();
            }
        })
        .on('finish', () => {
            logMessage('debug', `[pipeStream] Piping finished successfully for ${fileId} to ${clientIp}`);
            req.removeListener('close', onReqClose); // تنظيف المستمع
        });
}


// *** نقطة النهاية المعدلة للترجمة ***
app.get('/subtitles/:fileId/:subtitleArrayIndex', async (req, res) => {
    const { fileId, subtitleArrayIndex: indexStr } = req.params; // اسم أوضح للمتغير
    const index = parseInt(indexStr, 10);
    const clientIp = req.ip || req.socket.remoteAddress;

    logMessage('debug', `[/subtitles] Received request for fileId: ${fileId}, subtitleArrayIndex: ${index} from ${clientIp}`);

    if (isNaN(index) || index < 0) {
        logMessage('warn', `[/subtitles] Invalid subtitle array index: ${indexStr} (parsed as ${index}) for fileId: ${fileId}`);
        return res.status(400).send('Invalid subtitle index.');
    }

    // --- تحقق مبدئي لوجود التورنت ---
    if (!torrentManager.torrents.has(fileId)) {
        logMessage('warn', `[/subtitles] Torrent data for ${fileId} not found in map. Request from ${clientIp}.`);
        return res.status(404).send('Subtitle session not found (likely cleaned up or invalid ID).');
    }

    // --- تحقق إضافي (اختياري) لحالة التدمير وطول المصفوفة قبل الاستدعاء ---
    const tempData = torrentManager.torrents.get(fileId);
    if (tempData && tempData.torrent && tempData.torrent.destroyed) {
        logMessage('warn', `[/subtitles] Torrent ${fileId} is marked as destroyed BEFORE calling getSubtitleFile. Request from ${clientIp}.`);
        // يمكن إرجاع 404 هنا أيضًا
        return res.status(404).send('Subtitle session expired (torrent destroyed).');
    }
     if (tempData && tempData.subtitleFiles) {
         logMessage('debug', `[/subtitles] Stored subtitleFiles array length for ${fileId}: ${tempData.subtitleFiles.length}. Requesting index: ${index}.`);
         if (index >= tempData.subtitleFiles.length) {
             logMessage('warn', `[/subtitles] Requested subtitleArrayIndex ${index} is out of bounds (length: ${tempData.subtitleFiles.length}) for ${fileId}. Request from ${clientIp}.`);
             return res.status(404).send('Subtitle index out of bounds.');
         }
     } else if (tempData) {
         logMessage('warn', `[/subtitles] Stored subtitleFiles array is MISSING for ${fileId}. Request from ${clientIp}.`);
         return res.status(404).send('Subtitle data missing for this session.');
     }
     // --- نهاية التحقق الإضافي ---


    logMessage('info', `[/subtitles] Attempting to get subtitle for fileId: ${fileId}, subtitleArrayIndex: ${index}. Request from ${clientIp}.`);
    const subtitleFile = torrentManager.getSubtitleFile(fileId, index); // *** استخدام الفهرس الصحيح ***

    logMessage('debug', `[/subtitles] Result from getSubtitleFile for ${fileId}, index ${index}: ${subtitleFile ? `'${subtitleFile.name}'` : 'null'}`);

    if (!subtitleFile) {
        // الأسباب المحتملة تم تسجيلها داخل getSubtitleFile أو في التحققات أعلاه
        logMessage('warn', `[/subtitles] Subtitle file object not obtained for fileId: ${fileId}, subtitleArrayIndex: ${index}. Returning 404.`);
        return res.status(404).send('Subtitle file not found or session expired.');
    }

    const isSrt = subtitleFile.name.toLowerCase().endsWith('.srt');
    logMessage('debug', `[/subtitles] Serving subtitle: ${subtitleFile.name} (Type: ${isSrt ? 'SRT' : 'VTT'}) for ${fileId}`);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8'); // دائما VTT بسبب التحويل

    try {
        const sourceStream = subtitleFile.createReadStream();
        let streamToPipe = sourceStream; // Start with the source stream

        sourceStream.on('error', (err) => {
            logMessage('error', `[/subtitles] Error reading source subtitle stream (${subtitleFile.name}): ${err.message}`);
            // Ensure converter stream (if exists) is also destroyed
            if (streamToPipe !== sourceStream && streamToPipe && !streamToPipe.destroyed) {
                 streamToPipe.destroy();
            }
            if (!res.headersSent) res.status(500).send('Error reading subtitle file.');
            else if (!res.writableEnded) res.end();
        });

        // Handle client closing the connection
        req.on('close', () => {
            logMessage('warn', `[/subtitles] Client ${clientIp} closed subtitle connection for ${subtitleFile.name}. Destroying stream(s).`);
            if (sourceStream && !sourceStream.destroyed) sourceStream.destroy();
            // Destroy converter stream too if it was created
             if (streamToPipe !== sourceStream && streamToPipe && !streamToPipe.destroyed) {
                streamToPipe.destroy();
            }
        });

        if (isSrt) {
            logMessage('debug', `[/subtitles] Converting SRT to VTT for ${subtitleFile.name}`);
            const converterStream = srt2vtt();
            converterStream.on('error', (err) => {
                logMessage('error', `[/subtitles] SRT to VTT conversion error (${subtitleFile.name}): ${err.message}`);
                if (sourceStream && !sourceStream.destroyed) sourceStream.destroy(); // Destroy source on converter error
                if (!res.headersSent) res.status(500).send('Error converting subtitle.');
                else if (!res.writableEnded) res.end();
            });
            // Pipe source to converter, and update the stream we will pipe to the response
            streamToPipe = sourceStream.pipe(converterStream);
        } else {
            // It's already VTT (or another format we serve directly as VTT)
            logMessage('debug', `[/subtitles] Serving non-SRT subtitle directly as VTT: ${subtitleFile.name}`);
        }

        // Pipe the final stream (either source or converter) to the response
        streamToPipe.pipe(res)
         .on('error', (pipeErr) => {
             // This usually catches errors writing to the response
             logMessage('error', `[/subtitles] Error piping final subtitle stream to response for ${subtitleFile.name}: ${pipeErr.message}`);
              // Clean up streams if possible
             if (sourceStream && !sourceStream.destroyed) sourceStream.destroy();
             if (streamToPipe !== sourceStream && streamToPipe && !streamToPipe.destroyed) streamToPipe.destroy();
             // Don't try sending headers again
             if (!res.writableEnded) res.end();
         })
         .on('finish', () => {
             logMessage('debug', `[/subtitles] Successfully finished piping subtitle ${subtitleFile.name} to ${clientIp}`);
         });

    } catch (error) {
        logMessage('error', `[/subtitles] Unexpected error serving subtitle ${subtitleFile.name}: ${error.message}`);
        logMessage('debug', error.stack);
        if (!res.headersSent) res.status(500).send('Server error serving subtitle.');
        else if (!res.writableEnded) res.end();
    }
});

// --- دالة مساعدة لتحديد نوع MIME ---
function getVideoMimeType(fileName = '') {
     const lowerCaseName = fileName.toLowerCase();
    if (lowerCaseName.endsWith('.mp4')) return 'video/mp4';
    if (lowerCaseName.endsWith('.webm')) return 'video/webm';
    // Treat MKV as MP4 for wider browser compatibility in <video> tag
    if (lowerCaseName.endsWith('.mkv')) return 'video/mp4';
    if (lowerCaseName.endsWith('.mov')) return 'video/quicktime';
    if (lowerCaseName.endsWith('.avi')) return 'video/x-msvideo';
    // Default to MP4 if unknown or other types
    logMessage('debug', `[MimeType] Unknown video extension for "${fileName}", defaulting to video/mp4.`);
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

async function handleShutdown() {
     logMessage('warn', 'Shutdown signal received. Closing server gracefully...');
    let exitCode = 0;

    try {
        // 1. Close WebSocket Server (stops accepting new connections)
        logMessage('info', 'Closing WebSocket server...');
        await new Promise((resolve, reject) => {
            wss.close((err) => {
                if (err) {
                    logMessage('error', `Error closing WebSocket server: ${err.message}`);
                    reject(err);
                } else {
                    logMessage('info', 'WebSocket server closed.');
                    resolve();
                }
            });

            // Force close existing connections after a timeout
            setTimeout(() => {
                logMessage('warn', `Forcibly terminating ${wss.clients.size} remaining WS connections...`);
                wss.clients.forEach(client => {
                    if (client.readyState === client.OPEN) {
                        client.terminate();
                    }
                });
                resolve(); // Resolve even if termination takes time or fails silently
            }, 3000); // 3 second grace period
        });

        // 2. Close HTTP Server
        logMessage('info', 'Closing HTTP server...');
        await new Promise((resolve, reject) => {
            server.close((err) => {
                if (err) {
                    logMessage('error', `Error closing HTTP server: ${err.message}`);
                    reject(err); // Should not happen often
                } else {
                    logMessage('info', 'HTTP server closed.');
                    resolve();
                }
            });
        });

        // 3. Cleanup Active Torrents (after servers are closed)
        // <<< هذا الجزء مهم جدًا الآن لأنه الوسيلة الرئيسية للتنظيف >>>
        logMessage('info', 'Cleaning up active torrents...');
        const activeTorrentIds = Array.from(torrentManager.torrents.keys());
        logMessage('info', `Found ${activeTorrentIds.length} torrents to clean up.`);
        const cleanupPromises = activeTorrentIds.map(fileId => {
            logMessage('warn', `Cleaning up torrent ${fileId} during shutdown.`);
            // Add individual catch to prevent one failure from stopping others
            return torrentManager.cleanup(fileId)
                .catch(err => logMessage('error', `Error cleaning up torrent ${fileId}: ${err.message}`));
        });
        await Promise.all(cleanupPromises);
        logMessage('info', 'Active torrents cleanup process finished.');

        // 4. Destroy WebTorrent Client (Last step)
        logMessage('info', 'Destroying WebTorrent client...');
        await new Promise((resolve, reject) => {
             if (torrentManager.client && !torrentManager.client.destroyed) {
                torrentManager.client.destroy((err) => {
                     if (err) {
                         logMessage('error', `Error destroying WebTorrent client: ${err.message}`);
                         reject(err); // Propagate error
                     } else {
                         logMessage('info', 'WebTorrent client destroyed successfully.');
                         resolve();
                     }
                 });
             } else {
                logMessage('info', 'WebTorrent client already destroyed or not initialized.');
                resolve();
             }
        });

    } catch (err) {
        logMessage('error', `Error during graceful shutdown sequence: ${err.message}`);
        exitCode = 1;
    } finally {
        logMessage('info', `Shutdown complete. Exiting with code ${exitCode}.`);
        process.exit(exitCode);
    }
}
