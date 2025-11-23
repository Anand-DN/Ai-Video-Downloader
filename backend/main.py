# backend/main.py
"""
Main FastAPI backend for AI Video Downloader
Updated to work with the new high-performance torrent_downloader.py API.

Torrent downloader expected API (from torrent_downloader.py):
    manager.add_torrent(torrent_id: str, magnet: str, callback: Callable)
    manager.cancel_torrent(torrent_id: str)
    manager.get_status(torrent_id: str)
"""

import asyncio
import json
import os
import subprocess
import platform
import threading
import time
from pathlib import Path
from typing import Dict, Optional, Any, Callable

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from yt_dlp import YoutubeDL

# Local modules (assumed present in your project)
from downloader import run_download_in_thread, get_thumbnail_for_url
from db import create_tables, add_history_entry, list_history, delete_history
from torrent_downloader import get_torrent_manager

# --- App setup ---
app = FastAPI(title="AI Video Downloader Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Default directories ---
DEFAULT_DL_DIR = Path.home() / "Downloads"
DEFAULT_DL_DIR.mkdir(parents=True, exist_ok=True)

TORRENT_DL_DIR = Path.home() / "Downloads" / "Torrents"
TORRENT_DL_DIR.mkdir(parents=True, exist_ok=True)

# Ensure DB tables exist
create_tables()

# --- WebSocket manager (simple) ---
class WSManager:
    def __init__(self):
        self.connections: Dict[str, WebSocket] = {}
        self._lock = threading.Lock()

    def add_connection(self, id: str, websocket: WebSocket):
        with self._lock:
            self.connections[id] = websocket

    def remove_connection(self, id: str):
        with self._lock:
            if id in self.connections:
                try:
                    del self.connections[id]
                except Exception:
                    pass

    async def send(self, id: str, message: dict):
        # Send JSON message to connection if present
        ws = None
        with self._lock:
            ws = self.connections.get(id)
        if ws:
            try:
                await ws.send_json(message)
            except Exception as e:
                # swallow errors (client may have disconnected)
                print(f"[ws send error] {e}")

ws_manager = WSManager()

# --- Job manager for non-torrent downloads (threads) ---
class JobManager:
    def __init__(self):
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def register(self, id: str, thread: threading.Thread, cancel_event: threading.Event):
        with self._lock:
            self._jobs[id] = {"thread": thread, "cancel_event": cancel_event}

    def get_cancel_event(self, id: str) -> Optional[threading.Event]:
        with self._lock:
            item = self._jobs.get(id)
            return item["cancel_event"] if item else None

    def unregister(self, id: str):
        with self._lock:
            if id in self._jobs:
                try:
                    del self._jobs[id]
                except Exception:
                    pass

    def is_running(self, id: str) -> bool:
        with self._lock:
            return id in self._jobs

job_manager = JobManager()

# -------------------------
# Helper utilities
# -------------------------
def safe_hash_id(s: str) -> str:
    # short deterministic id for clients
    return str(abs(hash(s)))[:12]

def format_filesize(bytes_val: int) -> str:
    try:
        if not bytes_val:
            return ""
        mb = bytes_val / (1024 * 1024)
        if mb >= 1024:
            return f"{(mb/1024):.2f} GB"
        return f"{mb:.0f} MB"
    except Exception:
        return ""

# -------------------------
# VIDEO FORMATS ROUTE
# -------------------------
@app.get("/formats")
async def get_formats(url: str = Query(...)):
    """
    Extract available video/audio formats using yt_dlp.
    Returns a JSON object:
    {
      title, thumbnail, duration,
      video_formats: [{format_id, quality, resolution, ext, filesize, height}, ...],
      audio_formats: [{format_id, quality, ext, filesize, abr}, ...]
    }
    """
    try:
        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "nocheckcertificate": True,
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "http_headers": {
                "User-Agent": "Mozilla/5.0",
                "Accept-Language": "en-US,en;q=0.9",
            },
            "extractor_retries": 3,
            "socket_timeout": 30,
        }

        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            formats = info.get("formats", [])
            title = info.get("title", "Unknown")
            thumbnail = info.get("thumbnail", "")
            duration = info.get("duration", 0)

            def get_quality_label(height):
                if not height:
                    return "Auto"
                if height >= 4320:
                    return "8K"
                if height >= 2160:
                    return "4K"
                if height >= 1440:
                    return "2K"
                if height >= 1080:
                    return "1080p"
                if height >= 720:
                    return "720p"
                if height >= 480:
                    return "480p"
                if height >= 360:
                    return "360p"
                if height >= 240:
                    return "240p"
                if height >= 144:
                    return "144p"
                return f"{height}p"

            combined_formats = {}
            video_only_formats = {}

            for f in formats:
                format_id = f.get("format_id")
                ext = f.get("ext", "mp4")
                height = f.get("height")
                vcodec = f.get("vcodec", "none")
                acodec = f.get("acodec", "none")
                filesize = f.get("filesize") or f.get("filesize_approx") or 0

                if not height or height == 0:
                    continue

                label = get_quality_label(height)

                if vcodec != "none" and acodec != "none":
                    if label not in combined_formats:
                        combined_formats[label] = {
                            "format_id": format_id,
                            "quality": label,
                            "resolution": f"{height}p",
                            "ext": ext,
                            "filesize": filesize,
                            "height": height,
                        }
                elif vcodec != "none" and acodec == "none":
                    if label not in video_only_formats:
                        # prefer MP4 container for muxing
                        video_only_formats[label] = {
                            "format_id": f"{format_id}+bestaudio",
                            "quality": label,
                            "resolution": f"{height}p",
                            "ext": "mp4",
                            "filesize": filesize,
                            "height": height,
                        }

            all_video_formats = {}
            all_video_formats.update(video_only_formats)
            for q, fmt in combined_formats.items():
                if q not in all_video_formats:
                    all_video_formats[q] = fmt

            video_formats = sorted(all_video_formats.values(), key=lambda x: x.get("height", 0), reverse=True)

            # audio formats (pick best)
            audio_formats = []
            best_audio = None
            for f in formats:
                format_id = f.get("format_id")
                ext = (f.get("ext") or "").lower()
                vcodec = f.get("vcodec", "none")
                acodec = f.get("acodec", "none")
                abr = f.get("abr") or 0
                filesize = f.get("filesize") or f.get("filesize_approx") or 0
                if acodec != "none" and vcodec == "none":
                    if not best_audio or abr > best_audio.get("abr", 0):
                        best_audio = {
                            "format_id": format_id,
                            "quality": "Best Quality",
                            "ext": ext if ext in ["webm", "opus", "m4a"] else "webm",
                            "filesize": filesize,
                            "abr": abr,
                        }
            if best_audio:
                audio_formats.append(best_audio)
            else:
                audio_formats = [{"format_id": "bestaudio", "quality": "Best Quality", "ext": "webm", "filesize": 0}]

            if not video_formats:
                video_formats = [{"format_id": "bestvideo+bestaudio/best", "quality": "Best Available", "resolution": "Auto", "ext": "mp4", "filesize": 0}]

            return {
                "title": title,
                "thumbnail": thumbnail,
                "duration": duration,
                "video_formats": video_formats,
                "audio_formats": audio_formats,
            }

    except Exception as e:
        msg = str(e)
        print(f"[formats error] {msg}")
        return JSONResponse({"error": "fetch_failed", "message": f"Failed to fetch video information: {msg}"}, status_code=500)

# -------------------------
# SINGLE VIDEO DOWNLOAD (yt_dlp)
# -------------------------
@app.post("/download")
async def start_download(payload: dict):
    """
    Start a single video/audio download.
    Expects payload: {url, id (optional), mode: video|audio, format_id}
    Streams progress to websocket id (same id returned).
    """
    url = payload.get("url")
    if not url:
        return JSONResponse({"error": "url required"}, status_code=400)

    client_id = payload.get("id") or safe_hash_id(url)
    mode = payload.get("mode", "video")
    format_id = payload.get("format_id", "best")

    if job_manager.is_running(client_id):
        return JSONResponse({"error": "job already running"}, status_code=400)

    cancel_event = threading.Event()
    loop = asyncio.get_event_loop()

    # progress sender (from downloader thread)
    def progress_sender(msg: dict):
        try:
            asyncio.run_coroutine_threadsafe(ws_manager.send(client_id, msg), loop).result(timeout=1.0)
        except Exception as e:
            # ignore if client disconnected
            # print(f"[progress_sender err] {e}")
            pass

    thread = run_download_in_thread(url, str(DEFAULT_DL_DIR), mode, format_id, progress_sender, cancel_event)
    job_manager.register(client_id, thread, cancel_event)

    # watcher to add history and cleanup
    def watcher():
        thread.join()
        # best-effort: try to find final filename for history
        final_name = None
        try:
            entries = sorted(DEFAULT_DL_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
            for p in entries:
                if p.is_file() and p.suffix.lower() in [".mp4", ".mkv", ".webm", ".m4a", ".mp3"]:
                    final_name = p.name
                    break
        except Exception:
            final_name = None

        try:
            add_history_entry({
                "id": client_id,
                "url": url,
                "filename": final_name,
                "mode": mode,
                "status": "completed"
            })
        except Exception:
            pass

        job_manager.unregister(client_id)

        # notify client via ws (so frontend shows toast / open-show actions)
        try:
            asyncio.run_coroutine_threadsafe(
                ws_manager.send(client_id, {"status": "finished", "result": {"final_path": final_name}}),
                loop
            ).result(timeout=2.0)
        except Exception:
            pass

    threading.Thread(target=watcher, daemon=True).start()

    return {"id": client_id, "status": "started"}

# -------------------------
# CANCEL NON-TORRENT DOWNLOAD
# -------------------------
@app.post("/cancel")
async def cancel_download(payload: dict):
    id = payload.get("id")
    if not id:
        return JSONResponse({"error": "id required"}, status_code=400)

    cancel_event = job_manager.get_cancel_event(id)
    if cancel_event:
        cancel_event.set()
        return {"id": id, "status": "cancelling"}
    return JSONResponse({"error": "not found"}, status_code=404)

# -------------------------
# PLAYLIST INFO + DOWNLOAD
# -------------------------
@app.post("/playlist/info")
async def get_playlist_info(request: Request):
    try:
        data = await request.json()
        url = data.get("url")
        if not url:
            return JSONResponse({"error": "URL required"}, status_code=400)

        ydl_opts = {"extract_flat": True, "quiet": True, "no_warnings": True}

        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if "entries" not in info:
                return JSONResponse({"error": "Not a playlist URL"}, status_code=400)

            videos = []
            for entry in info["entries"]:
                if entry:
                    videos.append({
                        "id": entry.get("id", ""),
                        "title": entry.get("title", "Unknown"),
                        "url": f"https://www.youtube.com/watch?v={entry.get('id','')}",
                        "duration": entry.get("duration", 0),
                        "thumbnail": entry.get("thumbnail", "")
                    })

            return {"success": True, "playlist_title": info.get("title", "Playlist"), "playlist_count": len(videos), "videos": videos[:50]}
    except Exception as e:
        print(f"[playlist info] {e}")
        return JSONResponse({"error": str(e)}, status_code=500)

@app.post("/playlist/download")
async def download_playlist(request: Request):
    """
    Start downloads for a list of video URLs (playlist).
    This will start individual yt_dlp downloads for each video and send finished messages to
    websocket channel 'playlist_{index}' where index is 0-based.
    """
    try:
        data = await request.json()
        video_ids = data.get("video_ids", [])
        mode = data.get("mode", "video")
        quality = data.get("quality", "best")

        if not video_ids:
            return JSONResponse({"error": "no videos"}, status_code=400)

        loop = asyncio.get_event_loop()

        def start_single_download(video_url: str, index: int):
            client_id = f"playlist_{index}"
            cancel_event = threading.Event()

            def progress_sender(msg: dict):
                try:
                    asyncio.run_coroutine_threadsafe(ws_manager.send(client_id, msg), loop).result(timeout=1.0)
                except Exception:
                    pass

            thread = run_download_in_thread(video_url, str(DEFAULT_DL_DIR), mode, quality, progress_sender, cancel_event)

            def watcher():
                thread.join()
                final_name = None
                try:
                    entries = sorted(DEFAULT_DL_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
                    for p in entries:
                        if p.is_file() and p.suffix.lower() in [".mp4", ".mkv", ".webm", ".m4a", ".mp3"]:
                            final_name = p.name
                            break
                except Exception:
                    final_name = None

                try:
                    add_history_entry({
                        "id": client_id,
                        "url": video_url,
                        "filename": final_name,
                        "mode": mode,
                        "status": "completed"
                    })
                except Exception:
                    pass

                # final ws notification to trigger frontend toast
                try:
                    asyncio.run_coroutine_threadsafe(ws_manager.send(client_id, {"status": "finished", "result": {"final_path": final_name}}), loop).result(timeout=2.0)
                except Exception:
                    pass

            threading.Thread(target=watcher, daemon=True).start()

        for idx, vid in enumerate(video_ids):
            # vid may be a full URL or id; assume URL
            start_single_download(vid, idx)

        return {"success": True, "message": f"Started {len(video_ids)} downloads"}
    except Exception as e:
        print(f"[playlist download] {e}")
        return JSONResponse({"error": str(e)}, status_code=500)

# -------------------------
# FILE OPERATIONS (open / show)
# -------------------------
@app.post("/open-file")
async def open_file(payload: dict):
    file_path = payload.get("path")
    if not file_path:
        return JSONResponse({"error": "File path required"}, status_code=400)

    file_path = Path(file_path)
    if not file_path.is_absolute():
        file_path = DEFAULT_DL_DIR / file_path

    if not file_path.exists():
        return JSONResponse({"error": f"File not found: {file_path}"}, status_code=404)

    try:
        system = platform.system()
        file_path_str = str(file_path.absolute())
        if system == "Windows":
            os.startfile(file_path_str)
        elif system == "Darwin":
            subprocess.run(["open", file_path_str])
        else:
            subprocess.run(["xdg-open", file_path_str])
        return {"status": "opened", "path": file_path_str}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.post("/show-in-folder")
async def show_in_folder(payload: dict):
    file_path = payload.get("path")
    if not file_path:
        return JSONResponse({"error": "File path required"}, status_code=400)

    file_path = Path(file_path)
    if not file_path.is_absolute():
        file_path = DEFAULT_DL_DIR / file_path

    if not file_path.exists():
        file_path = file_path.parent

    try:
        system = platform.system()
        file_path_str = str(file_path.absolute())
        if system == "Windows":
            if file_path.is_file():
                subprocess.run(["explorer", "/select,", file_path_str])
            else:
                subprocess.run(["explorer", file_path_str])
        elif system == "Darwin":
            subprocess.run(["open", "-R", file_path_str])
        else:
            folder_path = str(file_path.parent if file_path.is_file() else file_path)
            subprocess.run(["xdg-open", folder_path])
        return {"status": "shown", "path": file_path_str}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

# -------------------------
# TORRENT ENDPOINTS (updated to new manager API)
# -------------------------
@app.post("/torrent/add")
async def add_torrent(payload: dict):
    """
    Add magnet link (or torrent) using torrent_downloader manager.
    Expects payload: {magnet: <magnet_uri>, id: optional}
    Sends websocket progress updates to channel "torrent_{id}".
    """
    magnet_link = payload.get("magnet")
    if not magnet_link:
        return JSONResponse({"error": "magnet link required"}, status_code=400)

    torrent_id = payload.get("id") or safe_hash_id(magnet_link)
    manager = get_torrent_manager(str(TORRENT_DL_DIR))

    # loop for websocket calls
    loop = asyncio.get_event_loop()

    # callback used by torrent manager to stream progress/status
    def torrent_progress_callback(msg: dict):
        """
        msg is a dict emitted by torrent manager's monitor.
        We'll forward it to websocket channel "torrent_{torrent_id}".
        ALSO triggers toast popup when finished.
        """
        try:
            asyncio.run_coroutine_threadsafe(
                ws_manager.send(f"torrent_{torrent_id}", msg),
                loop
            ).result(timeout=1.0)
        except Exception:
            pass

        # ---- TORRENT TOAST PATCH ----
        # When torrent finishes, send a popup-trigger message
        try:
            if msg.get("status") == "finished":
                save_path = msg.get("save_path", "")

                # Add history
                try:
                    add_history_entry({
                        "id": torrent_id,
                        "url": magnet_link,
                        "filename": Path(save_path).name if save_path else "",
                        "mode": "torrent",
                        "status": "completed"
                    })
                except:
                    pass

                # 🔥 SEND FINAL TOAST CALL TO FRONTEND
                toast_msg = {
                    "event": "torrent_completed",
                    "status": "finished",
                    "id": torrent_id,
                    "save_path": save_path
                }

                try:
                    asyncio.run_coroutine_threadsafe(
                        ws_manager.send(f"torrent_{torrent_id}", toast_msg),
                        loop
                    ).result(timeout=1.0)
                except:
                    pass
        except Exception:
            pass

    # Use new manager.add_torrent(torrent_id, magnet, callback)
    try:
        manager.add_torrent(torrent_id, magnet_link, torrent_progress_callback)
    except TypeError as te:
        # If developer's manager has different signature, try swapping params
        try:
            # older variants may be add_torrent(magnet, torrent_id, callback)
            manager.add_torrent(magnet_link, torrent_id, torrent_progress_callback)
        except Exception as e:
            print(f"[torrent add error - fallback] {e}")
            return JSONResponse({"error": str(e)}, status_code=500)
    except Exception as e:
        print(f"[torrent add error] {e}")
        return JSONResponse({"error": str(e)}, status_code=500)

    return {"id": torrent_id, "status": "started"}

@app.post("/torrent/cancel")
async def cancel_torrent_download(payload: dict):
    torrent_id = payload.get("id")
    if not torrent_id:
        return JSONResponse({"error": "id required"}, status_code=400)

    manager = get_torrent_manager(str(TORRENT_DL_DIR))
    try:
        # manager.cancel_torrent is expected
        if hasattr(manager, "cancel_torrent"):
            manager.cancel_torrent(torrent_id)
        elif hasattr(manager, "cancel_download"):
            manager.cancel_download(torrent_id)
        else:
            raise RuntimeError("torrent manager has no cancel API")
    except Exception as e:
        print(f"[torrent cancel error] {e}")
        return JSONResponse({"error": str(e)}, status_code=500)

    return {"id": torrent_id, "status": "cancelling"}

@app.get("/torrent/status/{torrent_id}")
async def get_torrent_status(torrent_id: str):
    manager = get_torrent_manager(str(TORRENT_DL_DIR))
    try:
        # prefer manager.get_status
        if hasattr(manager, "get_status"):
            return manager.get_status(torrent_id)
        elif hasattr(manager, "status"):
            return manager.status(torrent_id)
        else:
            return JSONResponse({"error": "no status API"}, status_code=500)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.websocket("/ws/torrent_{torrent_id}")
async def torrent_websocket_endpoint(websocket: WebSocket, torrent_id: str):
    """
    Websocket endpoint for torrent progress.
    Each client should connect to /ws/torrent_<id>
    """
    await websocket.accept()
    ws_manager.add_connection(f"torrent_{torrent_id}", websocket)
    print(f"[ws] Torrent WebSocket connected: {torrent_id}")

    try:
        while True:
            # We don't expect inbound messages; keep connection alive
            try:
                await websocket.receive_text()
            except WebSocketDisconnect:
                raise
            except Exception:
                # ignore non-text pings; small sleep prevents busy loop
                await asyncio.sleep(0.1)
    except WebSocketDisconnect:
        print(f"[ws] Torrent WebSocket disconnected: {torrent_id}")
    except Exception as e:
        print(f"[ws] Torrent WebSocket error: {e}")
    finally:
        ws_manager.remove_connection(f"torrent_{torrent_id}")

# -------------------------
# GENERAL websocket for downloads
# -------------------------
@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await websocket.accept()
    ws_manager.add_connection(client_id, websocket)
    print(f"[ws] WebSocket connected: {client_id}")

    try:
        while True:
            try:
                await websocket.receive_text()
            except WebSocketDisconnect:
                raise
            except Exception:
                await asyncio.sleep(0.1)
    except WebSocketDisconnect:
        print(f"[ws] WebSocket disconnected: {client_id}")
    except Exception as e:
        print(f"[ws] WebSocket error: {e}")
    finally:
        ws_manager.remove_connection(client_id)

# -------------------------
# Thumbnail, History endpoints
# -------------------------
@app.get("/thumbnail")
async def thumbnail(url: str = Query(...)):
    try:
        thumb = get_thumbnail_for_url(url)
        return {"thumbnail": thumb}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.get("/history/list")
async def api_history_list(limit: int = 200):
    try:
        items = list_history(limit=limit)
        return {"history": items}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.delete("/history/delete/{id}")
async def api_history_delete(id: str):
    try:
        ok = delete_history(id)
        return {"ok": True} if ok else JSONResponse({"error": "not found"}, status_code=404)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

# -------------------------
# Health + root
# -------------------------
@app.get("/ping")
async def ping():
    return {"status": "ok"}

@app.get("/")
async def root():
    return {
        "message": "AI Video Downloader API",
        "status": "running",
        "version": "2.0",
        "features": [
            "Video Download (up to 8K)",
            "Audio Extraction",
            "Torrent Download",
            "Playlist Support",
            "History Tracking"
        ]
    }

# --- End of file ---
