
import WebTorrent from 'webtorrent';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';

// --- دالة مساعدة للتسجيل الملون ---
function logMessage(type, message) {
    const colors = { info: "\x1b[32m", error: "\x1b[31m", warn: "\x1b[33m", debug: "\x1b[34m" };
    const color = colors[type] || "\x1b[37m";
    const reset = "\x1b[0m";
    const timestamp = new Date().toISOString();
    console.log(`${color}[${timestamp}] [TorrentManager:${type.toUpperCase()}] ${message}${reset}`);
}

// --- دوال مساعدة للتحقق من الامتدادات ---
function isVideoFile(fileName = '') { return fileName && /\.(mp4|webm|mkv|avi|mov|flv|wmv)$/i.test(fileName); }
function isSubtitleFile(fileName = '') { return fileName && /\.(srt|vtt|sub|ssa|ass)$/i.test(fileName); }

// --- تحديد مسار التنزيل المطلوب ---
// Consider making this configurable via environment variables
const BASE_DOWNLOAD_PATH = process.env.DOWNLOAD_PATH || 'C:/Users/acer/Desktop/my-webtor/downloads';
logMessage('info', `Using base download path: ${BASE_DOWNLOAD_PATH}`);

class TorrentManager {
    constructor() {
        // Ensure directory exists on startup
        fsp.mkdir(BASE_DOWNLOAD_PATH, { recursive: true })
            .then(() => logMessage('info', `Base download directory ensured: ${BASE_DOWNLOAD_PATH}`))
            .catch(err => {
                logMessage('error', `FATAL: Failed to create base download directory "${BASE_DOWNLOAD_PATH}": ${err.message}. Check permissions.`);
                // Depending on severity, you might want to exit
                // process.exit(1);
            });

        this.client = new WebTorrent();
        this.torrents = new Map(); // Stores { torrent, videoFile, subtitleFiles[], fileId, torrentPath, statusCallback }
        this.statusIntervals = new Map();

        logMessage('info', 'WebTorrent client initialized.');

        this.client.on('error', (err) => {
            // More specific logging for client errors
            if (typeof err === 'string') {
                 logMessage('error', `WebTorrent client error: ${err}`);
            } else if (err instanceof Error) {
                 logMessage('error', `WebTorrent client error: ${err.message}`);
                 logMessage('debug', err.stack);
            } else {
                 logMessage('error', `WebTorrent client unknown error: ${JSON.stringify(err)}`);
            }
        });

         this.client.on('torrent', (torrent) => {
             logMessage('debug', `[Client Event] Torrent added internally: ${torrent.name || torrent.infoHash}`);
             // Note: This event fires *after* the callback in client.add usually.
             // Useful for generic handling if needed later.
         });
    }

    _generateUniqueFolderName(type) {
        // Generates names like 'magnet-1678886400000-a3f7b1'
        return `${type}-${Date.now()}-${Math.random().toString(16).substring(2, 8)}`;
    }

    async addTorrent(magnetLink, statusCallback, options = {}) {
        const folderName = this._generateUniqueFolderName('magnet');
        const torrentPath = path.join(BASE_DOWNLOAD_PATH, folderName);
        logMessage('info', `Adding magnet: ${magnetLink.substring(0, 50)}... Path: ${torrentPath} Options: ${JSON.stringify(options)}`);

        return new Promise((resolve, reject) => {
            fsp.mkdir(torrentPath, { recursive: true })
                .then(() => {
                    logMessage('debug', `Created download directory: ${torrentPath}`);
                    const torrent = this.client.add(magnetLink, { path: torrentPath }, (torrentInstance) => {
                        // This callback fires when metadata is ready
                        logMessage('info', `Metadata received for torrent: ${torrentInstance.name || torrentInstance.infoHash}. Processing...`);
                        this._processTorrent(torrentInstance, statusCallback, resolve, reject, options, torrentPath);
                    });

                    // Handle errors during the *initial* add phase (e.g., invalid magnet)
                    torrent.once('error', (err) => {
                        // Make sure we only reject once
                        if (!torrent.metadata) { // Error likely happened before metadata resolved
                             logMessage('error', `Error adding magnet link (before metadata): ${err.message}`);
                             // Attempt cleanup of the potentially empty folder
                             fsp.rm(torrentPath, { recursive: true, force: true })
                                .catch(rmErr => logMessage('warn', `Could not remove dir ${torrentPath} after initial add error: ${rmErr.message}`));
                             reject({ success: false, error: `Error adding magnet: ${err.message}` });
                        }
                        // If metadata arrived, the error will be handled by the 'error' listener set in _processTorrent
                    });

                     // Handle cases where the torrent is destroyed before metadata is ready
                     torrent.once('destroyed', () => {
                         if (!torrent.metadata) {
                             logMessage('warn', `Torrent for magnet ${magnetLink.substring(0,20)}... destroyed before metadata ready.`);
                              fsp.rm(torrentPath, { recursive: true, force: true })
                                .catch(rmErr => logMessage('warn', `Could not remove dir ${torrentPath} after destroy before metadata: ${rmErr.message}`));
                             reject({ success: false, error: 'Torrent processing cancelled before metadata.'});
                         }
                     });

                })
                .catch(mkdirErr => {
                     logMessage('error', `Failed to create download directory ${torrentPath}: ${mkdirErr.message}`);
                     reject({ success: false, error: `Server setup error: Failed to create download directory.` });
                });
        });
    }

    async addTorrentFile(torrentBuffer, statusCallback, options = {}) {
        const folderName = this._generateUniqueFolderName('file');
        const torrentPath = path.join(BASE_DOWNLOAD_PATH, folderName);
         logMessage('info', `Adding torrent file buffer. Path: ${torrentPath} Options: ${JSON.stringify(options)}`);

        return new Promise((resolve, reject) => {
            fsp.mkdir(torrentPath, { recursive: true })
                .then(() => {
                    logMessage('debug', `Created download directory: ${torrentPath}`);
                     // Validate buffer minimally
                    if (!Buffer.isBuffer(torrentBuffer) || torrentBuffer.length === 0) {
                        logMessage('error', 'Invalid or empty torrent file buffer provided.');
                         fsp.rm(torrentPath, { recursive: true, force: true }).catch(() => {}); // Cleanup dir
                        return reject({ success: false, error: 'Invalid torrent file data.' });
                    }

                    const torrent = this.client.add(torrentBuffer, { path: torrentPath }, (torrentInstance) => {
                        logMessage('info', `Metadata received for torrent file: ${torrentInstance.name || torrentInstance.infoHash}. Processing...`);
                        this._processTorrent(torrentInstance, statusCallback, resolve, reject, options, torrentPath);
                    });

                    torrent.once('error', (err) => {
                         if (!torrent.metadata) {
                            logMessage('error', `Error adding torrent file (before metadata): ${err.message}`);
                            fsp.rm(torrentPath, { recursive: true, force: true })
                                .catch(rmErr => logMessage('warn', `Could not remove dir ${torrentPath} after initial add error: ${rmErr.message}`));
                            reject({ success: false, error: `Error adding torrent file: ${err.message}` });
                         }
                    });

                     torrent.once('destroyed', () => {
                         if (!torrent.metadata) {
                             logMessage('warn', `Torrent from file destroyed before metadata ready.`);
                              fsp.rm(torrentPath, { recursive: true, force: true })
                                .catch(rmErr => logMessage('warn', `Could not remove dir ${torrentPath} after destroy before metadata: ${rmErr.message}`));
                             reject({ success: false, error: 'Torrent processing cancelled before metadata.'});
                         }
                     });
                })
                .catch(mkdirErr => {
                    logMessage('error', `Failed to create download directory ${torrentPath}: ${mkdirErr.message}`);
                     reject({ success: false, error: `Server setup error: Failed to create download directory.` });
                });
        });
    }


    _processTorrent(torrent, statusCallback, resolve, reject, options, torrentPath) {
        const { preferredVideoIndex } = options;
        const torrentNameForLogs = torrent.name || torrent.infoHash;
        logMessage('debug', `[_processTorrent] Processing: ${torrentNameForLogs}. Path: ${torrentPath}. Preferred Index: ${preferredVideoIndex}`);

        // --- Safety Check: Ensure torrent wasn't destroyed immediately after metadata ---
         if (torrent.destroyed) {
             logMessage('warn', `[_processTorrent] Torrent ${torrentNameForLogs} was already destroyed when processing began. Aborting.`);
             fsp.rm(torrentPath, { recursive: true, force: true }).catch(rmErr => logMessage('warn', `Could not remove dir ${torrentPath} for already destroyed torrent: ${rmErr.message}`));
             // Reject the promise that was passed down
             reject({ success: false, error: 'Torrent processing cancelled (destroyed early).' });
             return; // Stop further processing
         }
         // --- End Safety Check ---


        // 1. Gather File Information
        const allFilesInfo = [];        // { name, length, index (original) }
        const videoFilesInfo = [];      // { name, length, index (original) }
        const subtitleFileObjects = []; // Array of actual WebTorrent File objects for subtitles
        const subtitleFilesInfo = [];   // { name, index (original) } - Sent to client initially

        torrent.files.forEach((file, index) => {
            // Basic info for all files
            allFilesInfo.push({ name: file.name, length: file.length, index: index });

            if (isVideoFile(file.name)) {
                videoFilesInfo.push({ name: file.name, length: file.length, index: index });
            } else if (isSubtitleFile(file.name)) {
                 // Store the actual file object for server-side use (streaming, etc.)
                subtitleFileObjects.push(file);
                 // Store info with original index to send to client
                subtitleFilesInfo.push({ name: file.name, index: index });
            }
        });
        logMessage('info', `[_processTorrent] Found ${videoFilesInfo.length} video(s) and ${subtitleFilesInfo.length} subtitle(s) in ${torrentNameForLogs}.`);
        logMessage('debug', `[_processTorrent] Subtitle files found: ${JSON.stringify(subtitleFilesInfo.map(f => f.name))}`);


        // 2. Select the Target Video File
        let selectedVideoFile = null;
        let selectedVideoIndex = -1; // Store the *original* index of the selected video

        // Try preferred index first
        if (preferredVideoIndex !== undefined && preferredVideoIndex >= 0 && preferredVideoIndex < torrent.files.length) {
            const potentialFile = torrent.files[preferredVideoIndex];
            if (potentialFile && isVideoFile(potentialFile.name)) {
                selectedVideoFile = potentialFile;
                selectedVideoIndex = preferredVideoIndex;
                logMessage('info', `[_processTorrent] Selected preferred video index: ${preferredVideoIndex} ('${selectedVideoFile.name}')`);
            } else {
                logMessage('warn', `[_processTorrent] Preferred index ${preferredVideoIndex} ('${potentialFile?.name || 'N/A'}') is not a video file or invalid. Falling back.`);
            }
        }

        // Fallback to largest video file if no valid preferred index
        if (!selectedVideoFile && videoFilesInfo.length > 0) {
            // Sort by length descending and pick the first one
             const sortedVideos = [...videoFilesInfo].sort((a, b) => b.length - a.length);
             const largestVideoInfo = sortedVideos[0];
             selectedVideoFile = torrent.files[largestVideoInfo.index];
             selectedVideoIndex = largestVideoInfo.index;
             logMessage('info', `[_processTorrent] Selected largest video file: '${selectedVideoFile.name}' (Index: ${selectedVideoIndex}, Size: ${selectedVideoFile.length})`);
        }

        // 3. Handle No Video Found
        if (!selectedVideoFile) {
            logMessage('error', `[_processTorrent] No suitable video file found in torrent: ${torrentNameForLogs}. Destroying torrent and removing directory.`);
            // Attempt to remove the directory first
             fsp.rm(torrentPath, { recursive: true, force: true })
                .catch(rmErr => logMessage('warn', `[_processTorrent] Could not remove directory ${torrentPath} after finding no video: ${rmErr.message}`));
            // Then destroy the torrent
            torrent.destroy((destroyErr) => {
                if (destroyErr) logMessage('error', `[_processTorrent] Error destroying torrent after no video found: ${destroyErr.message}`);
                else logMessage('info', `[_processTorrent] Torrent ${torrentNameForLogs} destroyed (no video found).`);
                // Reject the main promise
                reject({ success: false, error: 'No playable video file found in the torrent.' });
            });
            return; // Stop processing
        }

        // 4. Set Download Priorities (Selective Downloading)
        logMessage('info', `[_processTorrent] Prioritizing download for video: ${selectedVideoFile.name}`);
        if (torrent.pieces && torrent.pieceLength) {
             const totalPieces = torrent.pieces.length;
             if (totalPieces > 0) {
                 logMessage('debug', `[_processTorrent] Total pieces: ${totalPieces}. Deselecting all first.`);
                 torrent.deselect(0, totalPieces - 1, false); // Deselect everything initially

                 // Select pieces for the chosen video file
                 const vidStartPiece = Math.floor(selectedVideoFile.offset / torrent.pieceLength);
                 const vidEndPiece = Math.ceil((selectedVideoFile.offset + selectedVideoFile.length) / torrent.pieceLength) - 1;
                 if (vidStartPiece <= vidEndPiece && vidStartPiece >= 0 && vidEndPiece < totalPieces) {
                    logMessage('debug', `[_processTorrent] Selecting video pieces ${vidStartPiece}-${vidEndPiece} for ${selectedVideoFile.name}`);
                    torrent.select(vidStartPiece, vidEndPiece, true); // Select with high priority
                    selectedVideoFile.select(); // Also mark the file itself
                 } else {
                     logMessage('warn', `[_processTorrent] Invalid piece range for video ${selectedVideoFile.name}: ${vidStartPiece}-${vidEndPiece}. Cannot prioritize.`);
                 }

                 // Select pieces for all subtitle files found
                 subtitleFileObjects.forEach(subFile => {
                     const subStartPiece = Math.floor(subFile.offset / torrent.pieceLength);
                     const subEndPiece = Math.ceil((subFile.offset + subFile.length) / torrent.pieceLength) - 1;
                     if (subStartPiece <= subEndPiece && subStartPiece >= 0 && subEndPiece < totalPieces) {
                         logMessage('debug', `[_processTorrent] Selecting subtitle pieces ${subStartPiece}-${subEndPiece} for ${subFile.name}`);
                         torrent.select(subStartPiece, subEndPiece, true); // Select with high priority
                         subFile.select();
                     } else {
                         logMessage('warn', `[_processTorrent] Invalid piece range for subtitle ${subFile.name}: ${subStartPiece}-${subEndPiece}. Skipping priority.`);
                     }
                 });

                 logMessage('info', `[_processTorrent] Selective download priorities set for ${torrentNameForLogs}.`);
             } else {
                 logMessage('warn', `[_processTorrent] Cannot perform selective download for ${torrentNameForLogs}: No pieces found.`);
             }
         } else {
             logMessage('warn', `[_processTorrent] Cannot perform selective download for ${torrentNameForLogs}: Piece info missing from torrent object.`);
         }


        // 5. Generate Unique File ID for this Session
        // Using infoHash is generally more reliable and unique than filename+length
        const fileId = torrent.infoHash || Buffer.from(`${selectedVideoFile.name}_${selectedVideoFile.length}_${Date.now()}`).toString('base64url');
        logMessage('info', `[_processTorrent] Generated fileId: ${fileId} for ${torrentNameForLogs}`);

        // --- Check if this fileId already exists (collision or duplicate request?) ---
        if (this.torrents.has(fileId)) {
             logMessage('warn', `[_processTorrent] fileId ${fileId} already exists in the map! This might be a duplicate request or hash collision. Attempting cleanup of new torrent.`);
             fsp.rm(torrentPath, { recursive: true, force: true }).catch(rmErr => logMessage('warn', `Could not remove dir ${torrentPath} for duplicate fileId: ${rmErr.message}`));
             torrent.destroy((destroyErr) => { if (destroyErr) logMessage('error', `Error destroying duplicate torrent ${torrentNameForLogs}: ${destroyErr.message}`); });
             reject({ success: false, error: `Torrent session with ID ${fileId} already exists.` });
             return;
        }
        // --- End Collision Check ---


        // 6. Store Torrent Data
        this.torrents.set(fileId, {
            torrent: torrent,                       // The WebTorrent torrent object
            videoFile: selectedVideoFile,           // The selected WebTorrent file object for video
            subtitleFiles: subtitleFileObjects,     // Array of WebTorrent file objects for subtitles
            fileId: fileId,                         // The generated session ID
            torrentPath: torrentPath,               // Path where files are being downloaded
            statusCallback: statusCallback          // Callback function for status updates
        });
        logMessage('debug', `[_processTorrent] Torrent data stored successfully for fileId: ${fileId} using path: ${torrentPath}`);

        // 7. Setup Status Update Interval
        this.setupStatusUpdates(torrent, fileId, statusCallback);

        // 8. Resolve the Promise Successfully
        // Note: We send subtitleFilesInfo (with original index) to the client initially.
        // The client will use the array index (0, 1, 2...) when requesting subtitles via /subtitles/:fileId/:subtitleArrayIndex
        resolve({
            success: true,
            fileId: fileId,
            fileName: selectedVideoFile.name,
            videoFileIndex: selectedVideoIndex, // Original index of the playing video
            videoFiles: videoFilesInfo,         // List of all available videos {name, length, index}
            subtitleFilesInfo: subtitleFilesInfo, // List of subtitles {name, index} - Client needs this structure
            allFiles: allFilesInfo              // List of all files {name, length, index}
        });

        // 9. Attach Torrent Event Listeners (error, done)
        torrent.on('done', () => {
            // This might fire piece by piece if selectively downloading, or when all selected are done.
            logMessage('info', `[Torrent Event: ${fileId}] Download reported as 'done' for selected files in: ${torrentNameForLogs}`);
            // We might not need to do anything special here unless we want to stop seeding, etc.
            const torrentData = this.torrents.get(fileId);
            if (torrentData && torrentData.videoFile) {
                 logMessage('info', `[Torrent Event: ${fileId}] Video file '${torrentData.videoFile.name}' progress: ${torrentData.videoFile.downloaded}/${torrentData.videoFile.length}`);
            }
        });

        torrent.on('error', (err) => {
            // Handle errors that occur *after* the torrent has been added and processed
            logMessage('error', `[Torrent Event: ${fileId}] Error occurred for torrent ${torrentNameForLogs}: ${err.message}`);
             logMessage('debug', err.stack); // Log stack trace
            const torrentData = this.torrents.get(fileId);
            if (torrentData && torrentData.statusCallback) {
                // Notify the client via WebSocket if possible
                torrentData.statusCallback({ type: 'error', fileId: fileId, message: `Torrent runtime error: ${err.message}` });
            }
            // Trigger cleanup for this torrent session
            this.cleanup(fileId).catch(cleanupErr => logMessage('error', `[Torrent Event: ${fileId}] Error during cleanup after torrent error: ${cleanupErr.message}`));
        });

        // Optional: Log wire events for debugging peer connections
        /*
        torrent.on('wire', (wire, addr) => {
            logMessage('debug', `[Torrent Event: ${fileId}] Connected to peer: ${addr}`);
            wire.on('close', () => logMessage('debug', `[Torrent Event: ${fileId}] Disconnected from peer: ${addr}`));
            wire.on('error', (wireErr) => logMessage('warn', `[Torrent Event: ${fileId}] Wire error with peer ${addr}: ${wireErr.message}`));
        });
        */
         logMessage('debug', `[_processTorrent] Finished processing and set up listeners for ${fileId}`);
    }


    setupStatusUpdates(torrent, fileId, statusCallback) {
        // Clear existing interval for this fileId, if any
        const existingInterval = this.statusIntervals.get(fileId);
        if (existingInterval) {
            clearInterval(existingInterval);
            logMessage('debug', `[Status] Cleared existing status interval for ${fileId}`);
        }

        logMessage('debug', `[Status] Setting up new status interval for ${fileId}`);
        const interval = setInterval(() => {
            // Retrieve data fresh each time, as it might be removed by cleanup
            const torrentData = this.torrents.get(fileId);

            // --- Exit conditions for the interval ---
            if (!torrentData) {
                logMessage('warn', `[Status] Torrent data for ${fileId} removed. Stopping status updates.`);
                clearInterval(interval);
                this.statusIntervals.delete(fileId);
                return;
            }
            const currentTorrent = torrentData.torrent;
            if (!currentTorrent || currentTorrent.destroyed) {
                logMessage('warn', `[Status] Torrent object for ${fileId} is destroyed or missing. Stopping status updates.`);
                clearInterval(interval);
                this.statusIntervals.delete(fileId);
                // Ensure cleanup if torrent got destroyed unexpectedly
                 if (this.torrents.has(fileId)) { // Check again in case cleanup is already running
                    logMessage('warn', `[Status] Triggering cleanup for ${fileId} as torrent was found destroyed.`);
                     this.cleanup(fileId).catch(e => logMessage('error', `[Status] Error during cleanup triggered by destroyed torrent: ${e.message}`));
                 }
                return;
            }
             // Sanity check for videoFile existence
             if (!torrentData.videoFile) {
                 logMessage('error', `[Status] Video file missing for active torrent ${fileId}. Stopping status updates and cleaning up.`);
                 clearInterval(interval);
                 this.statusIntervals.delete(fileId);
                 this.cleanup(fileId).catch(e => logMessage('error', `[Status] Cleanup error after missing video file: ${e.message}`));
                 return;
             }
            // --- End Exit Conditions ---


            // Calculate progress based on the selected video file
            const selectedVideoFile = torrentData.videoFile;
            const fileProgress = selectedVideoFile.length > 0 ? (selectedVideoFile.downloaded / selectedVideoFile.length) : (currentTorrent.progress || 0); // Fallback to overall progress if length is 0

            // Calculate peers/seeds more accurately if possible
            let seeds = 0;
            let leechers = 0;
            let totalPeers = currentTorrent.numPeers || 0; // Start with the basic count
            if (currentTorrent.wires) {
                 // Filter wires that seem active and are likely seeds (not choking us)
                 seeds = currentTorrent.wires.filter(wire => wire.peerChoking === false).length;
                 // Leechers are total peers minus seeds (ensure non-negative)
                 leechers = Math.max(0, totalPeers - seeds);
            } else {
                // Fallback if wires array is not available (less accurate)
                seeds = currentTorrent.numPeers; // Assume all are seeds/peers initially
            }


            const status = {
                type: 'status',
                fileId: fileId,
                progress: fileProgress,
                fileSize: selectedVideoFile.length,
                fileDownloaded: selectedVideoFile.downloaded,
                downloadSpeed: currentTorrent.downloadSpeed || 0,
                uploadSpeed: currentTorrent.uploadSpeed || 0,
                peers: totalPeers,
                seeds: seeds,
                leechers: leechers,
                // Optional: Add overall torrent progress if needed
                // overallProgress: currentTorrent.progress || 0,
                // overallDownloaded: currentTorrent.downloaded || 0,
            };

            // Send status if callback exists
            if (statusCallback) {
                 //logMessage('debug', `[Status] Sending update for ${fileId}: P ${Math.round(status.progress * 100)}%, Peers ${status.peers}`);
                 statusCallback(status);
            } else {
                 logMessage('warn', `[Status] No status callback found for ${fileId} during interval.`);
            }

        }, 1500); // Update interval (e.g., every 1.5 seconds)

        this.statusIntervals.set(fileId, interval);
    }


    // --- Getters for Stream/File Data ---

    getVideoFile(fileId) {
        const data = this.torrents.get(fileId);
        // Add check for torrent destruction
        if (!data || !data.videoFile || !data.torrent || data.torrent.destroyed) {
             if (!data) logMessage('warn', `[getVideoFile] No data found for fileId: ${fileId}.`);
             else if (!data.videoFile) logMessage('warn', `[getVideoFile] Video file missing in data for fileId: ${fileId}.`);
             else if (!data.torrent || data.torrent.destroyed) logMessage('warn', `[getVideoFile] Parent torrent destroyed or missing for fileId: ${fileId}.`);
            return null;
        }
        return data.videoFile;
    }

    getVideoStream(fileId, options = {}) {
        const data = this.torrents.get(fileId);
        if (!data) { logMessage('warn', `[getVideoStream] No data found for fileId: ${fileId}`); return null; }
        if (!data.videoFile) { logMessage('warn', `[getVideoStream] Video file missing in data for fileId: ${fileId}`); return null; }
        // Crucial check: ensure torrent is not destroyed before creating stream
        if (!data.torrent || data.torrent.destroyed) {
            logMessage('error', `[getVideoStream] Attempted to create stream for DESTROYED torrent: ${fileId}.`);
            // Clean up the stale entry from the map if it hasn't been cleaned already
            if(this.torrents.has(fileId)) {
                 this.cleanup(fileId).catch(e => logMessage('error', `[getVideoStream] Error cleaning up destroyed torrent ${fileId}: ${e.message}`));
            }
            return null;
        }

        logMessage('debug', `[getVideoStream] Creating read stream for ${data.videoFile.name} (fileId: ${fileId}) Options: ${JSON.stringify(options)}`);
        try {
             const stream = data.videoFile.createReadStream(options);
             stream.on('error', (error) => {
                  // Log stream-specific errors
                  logMessage('error', `[getVideoStream] Video stream error for file ${data.videoFile.name} (${fileId}): ${error.message}`);
                   // Optionally destroy stream on error if not already handled
                   if (!stream.destroyed) { stream.destroy(); }
             });
             stream.on('close', () => {
                  // Log when the stream is closed (naturally or destroyed)
                  //logMessage('debug', `[getVideoStream] Video stream closed for ${data.videoFile.name} (${fileId})`);
             });
             return stream;
        } catch (error) {
             logMessage('error', `[getVideoStream] Exception creating read stream for ${fileId}: ${error.message}`);
             // Check if torrent got destroyed right before stream creation
             if (!data.torrent || data.torrent.destroyed) {
                 logMessage('error', `[getVideoStream] Parent torrent likely destroyed just before stream creation attempt for ${fileId}.`);
                  if(this.torrents.has(fileId)) {
                    this.cleanup(fileId).catch(e => logMessage('error', `[getVideoStream] Error cleaning up destroyed torrent ${fileId} after stream creation failure: ${e.message}`));
                  }
             }
             return null;
        }
    }

    // *** الدالة المعدلة لاستخدام فهرس مصفوفة الترجمة ***
    getSubtitleFile(fileId, subtitleArrayIndex) {
        const data = this.torrents.get(fileId);

        // --- فحوصات أساسية ---
        if (!data) {
            logMessage('warn', `[getSubtitleFile] No data found in torrents map for fileId: ${fileId}. Cleanup likely occurred.`);
            return null;
        }
        if (!data.torrent || data.torrent.destroyed) {
            logMessage('warn', `[getSubtitleFile] Parent torrent is destroyed for fileId: ${fileId}. Cannot serve subtitle.`);
             // Clean up stale entry if needed
             if (this.torrents.has(fileId)) {
                 this.cleanup(fileId).catch(e => logMessage('error', `[getSubtitleFile] Error cleaning up destroyed torrent ${fileId}: ${e.message}`));
             }
            return null;
        }
        if (!data.subtitleFiles) {
            logMessage('warn', `[getSubtitleFile] Subtitle files array (subtitleFileObjects) missing in stored data for fileId: ${fileId}`);
            return null; // Should not happen if _processTorrent worked correctly
        }
        // --- نهاية الفحوصات الأساسية ---


        // --- التحقق من حدود الفهرس مقابل طول المصفوفة الفعلية ***
        if (isNaN(subtitleArrayIndex) || subtitleArrayIndex < 0 || subtitleArrayIndex >= data.subtitleFiles.length) {
            logMessage('warn', `[getSubtitleFile] Subtitle array index ${subtitleArrayIndex} is OUT OF BOUNDS for actual array length ${data.subtitleFiles.length}, fileId: ${fileId}`);
            return null;
        }

        // --- الوصول إلى كائن ملف الترجمة الصحيح ---
        const subtitleFileObject = data.subtitleFiles[subtitleArrayIndex];

        // --- فحص دفاعي إضافي ---
        if (!subtitleFileObject) {
            logMessage('error', `[getSubtitleFile] Subtitle object is unexpectedly null/undefined at array index ${subtitleArrayIndex} for fileId ${fileId}. This indicates a data storage issue.`);
            return null;
        }

        logMessage('debug', `[getSubtitleFile] Successfully retrieving subtitle object: '${subtitleFileObject.name}' at array index ${subtitleArrayIndex} for fileId ${fileId}`);
        return subtitleFileObject; // <<< هذا هو كائن ملف WebTorrent الصحيح
    }


    // --- Cleanup Logic ---
    async cleanup(fileId) {
        logMessage('warn', `[Cleanup] Initiating cleanup for fileId: ${fileId}`);

        // 1. Get data *before* removing from map
        const torrentData = this.torrents.get(fileId);

        // 2. Stop status updates immediately
        const interval = this.statusIntervals.get(fileId);
        if (interval) {
            clearInterval(interval);
            this.statusIntervals.delete(fileId);
            logMessage('debug', `[Cleanup] Cleared status interval for ${fileId}`);
        } else {
             logMessage('debug', `[Cleanup] No status interval found for ${fileId}.`);
        }

        // 3. Remove from internal map *before* async operations
        if (this.torrents.has(fileId)) {
            this.torrents.delete(fileId);
            logMessage('debug', `[Cleanup] Removed torrent data from map for ${fileId}`);
        } else {
            logMessage('warn', `[Cleanup] No entry found in map for ${fileId} during cleanup operation. Maybe already cleaned?`);
            // If data wasn't in map, we likely don't have torrent object or path anyway
            // unless it was passed in somehow, but relying on torrentData captured earlier.
        }

        // 4. Destroy the WebTorrent torrent object (if it exists and isn't already destroyed)
        const torrentToDestroy = torrentData?.torrent;
        if (torrentToDestroy && !torrentToDestroy.destroyed) {
            const torrentName = torrentToDestroy.name || torrentToDestroy.infoHash || 'Unknown';
            logMessage('info', `[Cleanup] Destroying torrent instance: ${torrentName} (fileId: ${fileId})`);
            await new Promise((resolve, reject) => {
                // destroyStore: false - We handle directory removal manually
                torrentToDestroy.destroy({ destroyStore: false }, (err) => {
                    if (err) {
                        logMessage('error', `[Cleanup] Error destroying torrent instance ${torrentName} (${fileId}): ${err.message}`);
                        // Don't necessarily reject the whole cleanup for this, just log it.
                    } else {
                        logMessage('info', `[Cleanup] Torrent instance destroyed: ${torrentName} (${fileId})`);
                    }
                    resolve(); // Resolve whether destroy errored or not, we need to continue.
                });
                // Add a timeout for destroy operation? Might be risky if it hangs.
                // setTimeout(() => {
                //     logMessage('warn', `[Cleanup] Torrent destroy timed out for ${fileId}`);
                //     resolve();
                // }, 5000);
            });
        } else if (torrentToDestroy && torrentToDestroy.destroyed) {
             logMessage('debug', `[Cleanup] Torrent instance for ${fileId} was already destroyed.`);
        } else {
             logMessage('debug', `[Cleanup] No torrent instance found in data for ${fileId} to destroy.`);
        }

        // 5. Remove the Download Directory
        const torrentPathToRemove = torrentData?.torrentPath;
        if (torrentPathToRemove) {
            logMessage('info', `[Cleanup] Attempting to remove download directory: ${torrentPathToRemove}`);
            try {
                // Use fs.rm with recursive and force options
                await fsp.rm(torrentPathToRemove, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
                logMessage('info', `[Cleanup] Successfully removed directory: ${torrentPathToRemove}`);
            } catch (rmErr) {
                 // Log error, but don't let it stop the application usually
                 logMessage('error', `[Cleanup] Failed to remove directory ${torrentPathToRemove}: ${rmErr.message} (Code: ${rmErr.code})`);
                 // Common errors: EBUSY, ENOENT (already gone), EPERM
                 // You might retry or log differently based on rmErr.code
            }
        } else {
            logMessage('warn', `[Cleanup] No specific download path found in data for fileId: ${fileId}. Cannot remove directory.`);
        }

        logMessage('info', `[Cleanup] Cleanup process finished for fileId: ${fileId}`);
    }
}

export default TorrentManager;
