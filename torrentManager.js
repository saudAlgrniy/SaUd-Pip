import WebTorrent from 'webtorrent';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';

// --- دالة مساعدة للتسجيل الملون ---
function logMessage(type, message) {
    const colors = { info: "\x1b[32m", error: "\x1b[31m", warn: "\x1b[33m", debug: "\x1b[34m" };
    const color = colors[type] || "";
    const reset = "\x1b[0m";
    console.log(`${color}[TorrentManager:${type.toUpperCase()}] ${message}${reset}`);
}

// --- دوال مساعدة للتحقق من الامتدادات ---
function isVideoFile(fileName) { return /\.(mp4|webm|mkv|avi|mov|flv|wmv)$/i.test(fileName); }
function isSubtitleFile(fileName) { return /\.(srt|vtt|sub|ssa|ass)$/i.test(fileName); }

// --- تحديد مسار التنزيل المطلوب ---
const BASE_DOWNLOAD_PATH = 'C:/Users/acer/Desktop/my-webtor/downloads';
logMessage('warn', `Using hardcoded base download path: ${BASE_DOWNLOAD_PATH}`);

class TorrentManager {
    constructor() {
        fsp.mkdir(BASE_DOWNLOAD_PATH, { recursive: true })
            .then(() => logMessage('info', `Base download directory ensured: ${BASE_DOWNLOAD_PATH}`))
            .catch(err => logMessage('error', `Failed to create base download directory: ${err.message}`));

        this.client = new WebTorrent();
        this.torrents = new Map(); // Stores { torrent, videoFile, subtitleFiles, fileId, torrentPath }
        this.statusIntervals = new Map();
        logMessage('info', 'WebTorrent client initialized.');
        this.client.on('error', (err) => logMessage('error', `WebTorrent client error: ${err.message}`));
    }

    // --- دالة إضافة التورنت (تستخدم المسار المؤقت كنهائي) ---
    async addTorrent(magnetLink, statusCallback, options = {}) {
        logMessage('info', `Adding magnet: ${magnetLink.substring(0, 50)}... Options: ${JSON.stringify(options)}`);
        // *** استخدام اسم فريد للمجلد يعتمد على الوقت والعشوائية ***
        const folderName = `magnet-${Date.now()}-${Math.random().toString(16).substring(2, 8)}`;
        const torrentPath = path.join(BASE_DOWNLOAD_PATH, folderName);

        return new Promise((resolve, reject) => {
            fsp.mkdir(torrentPath, { recursive: true })
                .then(() => {
                    logMessage('debug', `Created download path: ${torrentPath}`);
                    this.client.add(magnetLink, { path: torrentPath }, (torrent) => {
                        logMessage('info', `Metadata received for torrent: ${torrent.name}`);
                        // *** تمرير المسار الذي تم إنشاؤه إلى _processTorrent ***
                        this._processTorrent(torrent, statusCallback, resolve, reject, options, torrentPath);
                    }).on('error', (err) => {
                        logMessage('error', `Error adding magnet link: ${err.message}`);
                        reject(new Error(`Error adding magnet link: ${err.message}`));
                    });
                })
                .catch(err => {
                     logMessage('error', `Failed to create download directory ${torrentPath}: ${err.message}`);
                     reject(new Error(`Failed to create download directory: ${err.message}`));
                });
        });
    }

    async addTorrentFile(torrentBuffer, statusCallback, options = {}) {
        logMessage('info', `Adding torrent file buffer. Options: ${JSON.stringify(options)}`);
        const folderName = `file-${Date.now()}-${Math.random().toString(16).substring(2, 8)}`;
        const torrentPath = path.join(BASE_DOWNLOAD_PATH, folderName);

        return new Promise((resolve, reject) => {
            fsp.mkdir(torrentPath, { recursive: true })
                .then(() => {
                    logMessage('debug', `Created download path: ${torrentPath}`);
                    this.client.add(torrentBuffer, { path: torrentPath }, (torrent) => {
                        logMessage('info', `Metadata received for torrent: ${torrent.name}`);
                        // *** تمرير المسار الذي تم إنشاؤه إلى _processTorrent ***
                        this._processTorrent(torrent, statusCallback, resolve, reject, options, torrentPath);
                    }).on('error', (err) => {
                        logMessage('error', `Error adding torrent file: ${err.message}`);
                        reject(new Error(`Error adding torrent file: ${err.message}`));
                    });
                })
                .catch(err => {
                    logMessage('error', `Failed to create download directory ${torrentPath}: ${err.message}`);
                    reject(new Error(`Failed to create download directory: ${err.message}`));
                });
        });
    }

    // --- تعديل _processTorrent لإزالة إعادة التسمية واستخدام المسار المُمرر ---
    _processTorrent(torrent, statusCallback, resolve, reject, options, torrentPath) { // استقبال torrentPath
        const { preferredVideoIndex } = options;
        logMessage('debug', `Processing torrent: ${torrent.name}. Path: ${torrentPath}. Preferred Index: ${preferredVideoIndex}`);

        // 1. جمع معلومات الملفات (نفس الكود السابق)
        const allFilesInfo = [];
        const videoFilesInfo = [];
        const subtitleFileObjects = [];
        const subtitleFilesInfo = [];
        torrent.files.forEach((file, index) => {
            allFilesInfo.push({ name: file.name, length: file.length, index: index });
            if (isVideoFile(file.name)) videoFilesInfo.push({ name: file.name, length: file.length, index: index });
            if (isSubtitleFile(file.name)) { subtitleFileObjects.push(file); subtitleFilesInfo.push({ name: file.name, index: index }); }
        });
        logMessage('info', `Found ${videoFilesInfo.length} video file(s) and ${subtitleFilesInfo.length} subtitle file(s).`);

        // 2. اختيار ملف الفيديو المطلوب (نفس الكود السابق)
        let selectedVideoFile = null; let selectedVideoIndex = -1;
        if (preferredVideoIndex !== undefined && preferredVideoIndex >= 0 && preferredVideoIndex < torrent.files.length) {
            const potentialFile = torrent.files[preferredVideoIndex];
            if (isVideoFile(potentialFile.name)) { selectedVideoFile = potentialFile; selectedVideoIndex = preferredVideoIndex; logMessage('info', `Selected preferred video index: ${preferredVideoIndex} ('${selectedVideoFile.name}')`); }
            else { logMessage('warn', `Preferred index ${preferredVideoIndex} ('${potentialFile.name}') is not video. Falling back.`); }
        }
        if (!selectedVideoFile) {
            if (videoFilesInfo.length > 0) {
                 const largestVideoInfo = videoFilesInfo.reduce((l, c) => (!l || c.length > l.length) ? c : l, null);
                 if (largestVideoInfo) { selectedVideoFile = torrent.files[largestVideoInfo.index]; selectedVideoIndex = largestVideoInfo.index; logMessage('info', `Selected largest video file: '${selectedVideoFile.name}' (Index: ${selectedVideoIndex})`); }
            }
        }

        // 3. التعامل مع عدم وجود فيديو (نفس الكود السابق مع تعديل بسيط لحذف المجلد)
        if (!selectedVideoFile) {
            logMessage('error', `No suitable video file found in torrent: ${torrent.name}. Destroying torrent and removing dir.`);
             fsp.rm(torrentPath, { recursive: true, force: true }).catch(rmErr => logMessage('warn', `Could not remove dir ${torrentPath}: ${rmErr.message}`)); // محاولة حذف المجلد الفارغ
            torrent.destroy((err) => { if (err) logMessage('error', `Error destroying torrent: ${err.message}`); reject(new Error('No video file found')); });
            return;
        }

        // 4. التنزيل الانتقائي (نفس الكود السابق)
        logMessage('info', `Prioritizing download for: ${selectedVideoFile.name}`);
        const totalPieces = torrent.pieces ? torrent.pieces.length : Math.ceil(torrent.length / torrent.pieceLength);
        if (totalPieces > 0) {
             logMessage('debug', `Total pieces: ${totalPieces}. Setting priorities...`);
             torrent.deselect(0, totalPieces - 1, false);
             torrent.files.forEach(file => {
                 if (!torrent.pieceLength || file.length === 0) return;
                 const startPiece = Math.floor(file.offset / torrent.pieceLength);
                 const endPiece = Math.ceil((file.offset + file.length) / torrent.pieceLength) - 1;
                 if (startPiece < 0 || endPiece >= totalPieces || startPiece > endPiece) { logMessage('warn', `Invalid piece range for ${file.name}: ${startPiece}-${endPiece}. Skipping.`); return; }
                 if (file === selectedVideoFile || isSubtitleFile(file.name)) {
                     logMessage('debug', `Selecting pieces ${startPiece}-${endPiece} for: ${file.name}`);
                     torrent.select(startPiece, endPiece, true); file.select();
                 } else { file.deselect(); }
             });
             logMessage('info', 'Selective download priorities set.');
        } else { logMessage('warn', 'Cannot perform selective download: Piece info missing.'); }

        // 5. إنشاء معرف فريد للملف (للاستخدام الداخلي وفي الـ API)
        const uniqueName = `${selectedVideoFile.name}_${selectedVideoFile.length}`;
        const fileId = Buffer.from(uniqueName).toString('base64url'); // هذا لا يزال مفيدًا كمعرف للجلسة

        // 6. *** تخزين بيانات التورنت مع المسار الصحيح (بدون إعادة تسمية) ***
        this.torrents.set(fileId, {
            torrent,
            videoFile: selectedVideoFile,
            subtitleFiles: subtitleFileObjects,
            fileId: fileId,
            torrentPath: torrentPath // <<< تخزين المسار الأصلي الذي تم إنشاؤه
        });
        logMessage('debug', `Torrent data stored with fileId: ${fileId} using path: ${torrentPath}`);

        // 7. بدء تحديثات الحالة
        this.setupStatusUpdates(torrent, fileId, statusCallback);

        // 8. حل الوعد بالنجاح
        resolve({
            success: true,
            fileId: fileId,
            fileName: selectedVideoFile.name,
            videoFileIndex: selectedVideoIndex,
            videoFiles: videoFilesInfo,
            subtitleFiles: subtitleFilesInfo,
            allFiles: allFilesInfo
        });

        // 9. معالجات الأحداث للتورنت (تبقى كما هي)
        torrent.on('done', () => logMessage('info', `Torrent done: ${torrent.name} (Path: ${torrentPath})`));
        torrent.on('error', (err) => {
            logMessage('error', `Torrent error (${torrent.name} / ${fileId}): ${err.message}`);
            if (statusCallback) statusCallback({ type: 'error', fileId: fileId, message: `Torrent error: ${err.message}` });
            this.cleanup(fileId);
        });
    }

    // --- setupStatusUpdates (نفس الكود السابق الذي يحسب تقدم الملف) ---
    setupStatusUpdates(torrent, fileId, statusCallback) {
        const existingInterval = this.statusIntervals.get(fileId);
        if (existingInterval) clearInterval(existingInterval);

        const interval = setInterval(() => {
            const torrentData = this.torrents.get(fileId);
            if (!torrentData || !torrentData.torrent || torrentData.torrent.destroyed || !torrentData.videoFile) {
                clearInterval(interval); this.statusIntervals.delete(fileId); return;
            }
            const currentTorrent = torrentData.torrent; const selectedVideoFile = torrentData.videoFile;
            const fileProgress = selectedVideoFile.length > 0 ? (selectedVideoFile.downloaded / selectedVideoFile.length) : 0;
            if (currentTorrent.destroyed || !currentTorrent.wires) {
                clearInterval(interval); this.statusIntervals.delete(fileId);
                logMessage('warn', `Torrent ${fileId} invalid during status. Cleaning up.`);
                this.cleanup(fileId).catch(e => logMessage('error', `Cleanup error from status: ${e.message}`));
                return;
            }
            const seeds = currentTorrent.wires.filter(w => w.peerInterested && !w.peerChoking).length;
            const leechers = Math.max(0, currentTorrent.numPeers - seeds);
            const status = { type: 'status', fileId: fileId, progress: fileProgress, fileSize: selectedVideoFile.length, fileDownloaded: selectedVideoFile.downloaded, downloadSpeed: currentTorrent.downloadSpeed, uploadSpeed: currentTorrent.uploadSpeed, peers: currentTorrent.numPeers, seeds: seeds, leechers: leechers };
            if (statusCallback) statusCallback(status);
        }, 1500);
        this.statusIntervals.set(fileId, interval);
    }


    // --- getVideoFile, getVideoStream, getSubtitleFile (تبقى كما هي مع التحققات المضافة سابقًا) ---
    getVideoFile(fileId) { /* ... نفس الكود ... */
         const data = this.torrents.get(fileId);
        if (!data || !data.videoFile || !data.torrent || data.torrent.destroyed) return null;
        return data.videoFile;
    }
    getVideoStream(fileId, options = {}) { /* ... نفس الكود ... */
         const data = this.torrents.get(fileId);
        if (!data) { logMessage('warn', `getVideoStream: No data for fileId: ${fileId}`); return null; }
        if (!data.videoFile) { logMessage('warn', `getVideoStream: Video file missing for fileId: ${fileId}`); return null; }
        if (!data.torrent || data.torrent.destroyed) { logMessage('error', `getVideoStream: Parent torrent destroyed for fileId: ${fileId}`); this.torrents.delete(fileId); return null; }
        logMessage('debug', `Creating read stream for ${data.videoFile.name} (fileId: ${fileId}) Options: ${JSON.stringify(options)}`);
        try {
             const stream = data.videoFile.createReadStream(options);
             stream.on('error', (error) => logMessage('error', `Video stream error (${fileId}): ${error.message}`));
             stream.on('close', () => logMessage('debug', `Video stream closed (${fileId})`));
             return stream;
        } catch (error) { logMessage('error', `Error creating read stream for ${fileId}: ${error.message}`); if (!data.torrent || data.torrent.destroyed) logMessage('error', `Parent torrent likely destroyed just before stream creation for ${fileId}.`); return null; }
    }
    getSubtitleFile(fileId, clientProvidedIndex) { /* ... نفس الكود ... */
         const data = this.torrents.get(fileId);
        if (!data || !data.subtitleFiles || !data.torrent || data.torrent.destroyed) { logMessage('warn', `getSubtitleFile: Invalid state for fileId: ${fileId}`); return null; }
        if (clientProvidedIndex < 0 || clientProvidedIndex >= data.subtitleFiles.length) { logMessage('warn', `Subtitle index ${clientProvidedIndex} out of bounds for fileId: ${fileId}`); return null; }
        const subtitleFileObject = data.subtitleFiles[clientProvidedIndex];
        if (!subtitleFileObject) { logMessage('error', `Subtitle object not found at index ${clientProvidedIndex} for fileId ${fileId}.`); return null; }
        logMessage('debug', `Retrieving subtitle object: ${subtitleFileObject.name} for index ${clientProvidedIndex}`);
        return subtitleFileObject;
    }

    // --- تعديل cleanup لاستخدام المسار الصحيح للحذف ---
    async cleanup(fileId) {
        logMessage('warn', `Cleanup requested for fileId: ${fileId}`);
        const data = this.torrents.get(fileId); // الحصول على البيانات قبل الحذف

        // 1. إيقاف تحديثات الحالة
        const interval = this.statusIntervals.get(fileId);
        if (interval) { clearInterval(interval); this.statusIntervals.delete(fileId); }

        // 2. إزالة من الخريطة الداخلية
        let torrentToDestroy = null;
        let torrentPathToRemove = null; // <<< الحصول على المسار الصحيح
        if (this.torrents.has(fileId)) {
             const torrentData = this.torrents.get(fileId);
             torrentToDestroy = torrentData?.torrent;
             torrentPathToRemove = torrentData?.torrentPath; // <<< الحصول على المسار المخزن
            this.torrents.delete(fileId);
            logMessage('debug', `Removed torrent data from map for ${fileId}`);
        } else {
            logMessage('debug', `No entry found in map for ${fileId} during cleanup.`);
            // Attempt to find path from data if cleanup called after deletion somehow
            torrentPathToRemove = data?.torrentPath;
        }


        // 3. تدمير كائن التورنت
        if (torrentToDestroy && !torrentToDestroy.destroyed) {
            const torrentName = torrentToDestroy.name || 'Unknown';
            logMessage('info', `Destroying torrent instance: ${torrentName} (fileId: ${fileId})`);
            await new Promise((resolve) => {
                torrentToDestroy.destroy({ destroyStore: false }, (err) => { // لا ندمر المتجر هنا
                    if (err) logMessage('error', `Error destroying torrent ${torrentName}: ${err.message}`);
                    else logMessage('info', `Torrent instance destroyed: ${torrentName}`);
                    resolve();
                });
            });
        }

        // 4. *** حذف المجلد المحدد ***
        if (torrentPathToRemove) {
            logMessage('info', `Attempting to remove download directory: ${torrentPathToRemove}`);
            try {
                await fsp.rm(torrentPathToRemove, { recursive: true, force: true });
                logMessage('info', `Successfully removed directory: ${torrentPathToRemove}`);
            } catch (rmErr) {
                 logMessage('error', `Failed to remove directory ${torrentPathToRemove}: ${rmErr.message}`);
            }
        } else {
            logMessage('warn', `No specific download path found to remove for fileId: ${fileId}.`);
        }
        // ----------------------------

        logMessage('info', `Cleanup finished for fileId: ${fileId}`);
    }
}

export default TorrentManager;