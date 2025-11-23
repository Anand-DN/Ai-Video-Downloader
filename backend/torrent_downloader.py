import libtorrent as lt
import time
import threading
from pathlib import Path
from typing import Callable

# Extended list of high-stability public trackers
BEST_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.openbittorrent.com:80/announce",
    "udp://tracker.coppersurfer.tk:6969/announce",
    "udp://glotorrents.pw:6969/announce",
    "udp://tracker.leechers-paradise.org:6969/announce",
    "udp://p4p.arenabg.com:1337/announce",
    "udp://tracker.internetwarriors.net:1337/announce",
    "http://tracker.opentrackr.org:1337/announce",
    "udp://9.rarbg.to:2710/announce",
    "udp://9.rarbg.me:2780/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.tiny-vps.com:6969/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.moeking.me:6969/announce",
    "udp://ipv4.tracker.harry.lu:80/announce",
]


class TorrentDownloader:
    def __init__(self, download_dir: str):
        self.download_dir = Path(download_dir)
        self.download_dir.mkdir(parents=True, exist_ok=True)
        
        # Create Session
        self.session = lt.session()
        
        # ============================
        # 🚀 MAXIMUM SPEED SETTINGS
        # ============================
        settings = {
            'user_agent': 'qBittorrent/4.6.0',
            'enable_dht': True,
            'enable_lsd': True,
            'enable_upnp': True,
            'enable_natpmp': True,
            'cache_size': 8192,
            'cache_expiry': 120,
            'connections_limit': 50000,
            'active_downloads': 100,
            'active_seeds': 100,
            'active_limit': 20000,
            'peer_connect_timeout': 10,
            'request_timeout': 3,
            'connection_speed': 1000,
            'max_out_request_queue': 2000,
            'max_allowed_in_request_queue': 5000,
            'max_queued_disk_bytes': 100 * 1024 * 1024,
            'send_buffer_low_watermark': 20 * 1024,
            'send_buffer_watermark': 1024 * 1024,
            'download_rate_limit': 0,
            'upload_rate_limit': 1024 * 1024,
            'tick_interval': 100,
            'inactivity_timeout': 120,
            'unchoke_slots_limit': 100,
            'choking_algorithm': 1,
            'seed_choking_algorithm': 1,
            'mixed_mode_algorithm': 0,
        }
        
        self.session.apply_settings(settings)
        self.session.listen_on(40000, 60000)
        
        dht_routers = [
            ("router.bittorrent.com", 6881),
            ("router.utorrent.com", 6881),
            ("router.bitcomet.com", 6881),
            ("dht.transmissionbt.com", 6881),
            ("dht.aelitis.com", 6881),
        ]
        for router, port in dht_routers:
            self.session.add_dht_router(router, port)
        
        self.session.start_dht()
        self.handles = {}
        self.cancel_events = {}

    def add_torrent(self, torrent_id: str, magnet: str, callback: Callable):
        # ✅ FIXED: Use add_torrent_params object (compatible with all libtorrent versions)
        params = lt.add_torrent_params()
        params.save_path = str(self.download_dir)
        
        # Parse magnet URI
        try:
            params = lt.parse_magnet_uri(magnet)
            params.save_path = str(self.download_dir)
        except Exception as e:
            print(f"[Torrent Error] Failed to parse magnet: {e}")
            raise e
        
        # Add torrent to session
        try:
            handle = self.session.add_torrent(params)
        except Exception as e:
            print(f"[Torrent Error] Failed to add torrent: {e}")
            raise e
        
        # Resume immediately (not paused)
        handle.resume()
        
        # 🔥 SPEED BOOST: Inject ALL trackers immediately
        print(f"[⚡] Injecting {len(BEST_TRACKERS)} trackers for max peer discovery...")
        for tracker_url in BEST_TRACKERS:
            handle.add_tracker({"url": tracker_url})
        
        # Aggressive peer discovery
        handle.force_reannounce()
        handle.force_dht_announce()
        
        # Set per-torrent speed limits (unlimited download, 1MB/s upload)
        handle.set_download_limit(0)
        handle.set_upload_limit(1024 * 1024)
        
        # Set max connections per torrent
        handle.set_max_connections(1000)
        handle.set_max_uploads(100)
        
        self.handles[torrent_id] = handle
        self.cancel_events[torrent_id] = threading.Event()
        
        threading.Thread(
            target=self._monitor,
            args=(torrent_id, handle, callback),
            daemon=True
        ).start()
        
        return {"status": "started", "id": torrent_id}

    def _monitor(self, torrent_id, handle, callback: Callable):
        # Metadata Phase
        attempts = 0
        while not handle.has_metadata():
            if self.cancel_events[torrent_id].is_set():
                callback({"status": "cancelled"})
                return
            
            attempts += 1
            if attempts % 10 == 0:
                handle.force_dht_announce()
                handle.force_reannounce()
            
            callback({"status": "fetching_metadata", "peers": handle.status().num_peers})
            time.sleep(0.3)
        
        info = handle.get_torrent_info()
        callback({
            "status": "metadata",
            "name": info.name(),
            "total_size": info.total_size(),
            "num_files": info.num_files()
        })
        
        # Download Phase
        while not handle.is_seed():
            if self.cancel_events[torrent_id].is_set():
                self.session.remove_torrent(handle)
                if torrent_id in self.handles:
                    del self.handles[torrent_id]
                callback({"status": "cancelled"})
                return
            
            s = handle.status()
            
            eta = 0
            if s.download_rate > 0:
                remaining = s.total_wanted - s.total_wanted_done
                eta = int(remaining / s.download_rate)
            
            callback({
                "status": "downloading",
                "progress": round(s.progress * 100, 2),
                "download_rate": s.download_rate,
                "upload_rate": s.upload_rate,
                "num_peers": s.num_peers,
                "num_seeds": s.num_seeds,
                "eta": eta,
                "state": str(s.state)
            })
            
            time.sleep(0.5)
        
        # Finished
        final_name = info.name()
        save_path = self.download_dir / final_name

        # Normal finished callback
        callback({
            "status": "finished",
            "save_path": str(save_path),
            "name": final_name
        })

        # 🔥 EXTRA EVENT → triggers toast popup in frontend
        callback({
            "event": "completed",
            "id": torrent_id,
            "file_path": str(save_path),
            "name": final_name
        })
        print(f"[✔] Torrent finished: {torrent_id}")


    def cancel_torrent(self, torrent_id: str):
        if torrent_id in self.cancel_events:
            self.cancel_events[torrent_id].set()
        return {"status": "cancelling"}

    def get_status(self, torrent_id: str):
        if torrent_id not in self.handles:
            return {"error": "not found"}
        s = self.handles[torrent_id].status()
        return {
            "progress": round(s.progress * 100, 2),
            "download_rate": s.download_rate,
            "peers": s.num_peers,
        }


# GLOBAL INSTANCE
torrent_manager = None

def get_torrent_manager(download_dir: str):
    global torrent_manager
    if torrent_manager is None:
        torrent_manager = TorrentDownloader(download_dir)
    return torrent_manager
