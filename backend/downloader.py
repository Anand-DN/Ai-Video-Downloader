import threading
import time
from pathlib import Path
from yt_dlp import YoutubeDL

def sanitize_filename(title):
    """Remove characters not allowed in Windows/Linux filenames"""
    # Remove: \ / : * ? " < > |
    return ''.join(c for c in title if c not in r'\/:*?"<>|').strip()

def run_download_in_thread(url, download_dir, mode, format_id, progress_callback, cancel_event):
    def download_task():
        try:
            output_template = str(Path(download_dir) / "%(title)s.%(ext)s")
            
            ydl_opts = {
                'format': format_id if mode == 'video' else 'bestaudio/best',
                'outtmpl': output_template,
                'noplaylist': True,
                'progress_hooks': [lambda d: progress_hook(d, progress_callback, cancel_event)],
                'quiet': True,
                'no_warnings': True,
                'nocheckcertificate': True,
                'windowsfilenames': True,  # Let yt-dlp handle sanitization
                'retries': 3,
            }
            
            if mode == 'audio':
                ydl_opts['postprocessors'] = [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': '192',
                }]
            
            with YoutubeDL(ydl_opts) as ydl:
                # Extract info first
                info = ydl.extract_info(url, download=False)
                
                if cancel_event.is_set():
                    progress_callback({'status': 'cancelled'})
                    return
                
                # Get the sanitized title (what yt-dlp will actually use)
                original_title = info.get('title', 'Unknown')
                sanitized_title = ydl.prepare_filename(info)  # This gives us the actual filename yt-dlp will use
                sanitized_title = Path(sanitized_title).stem  # Remove extension
                
                # Download
                ydl.download([url])
                
                # Build the actual final path
                if mode == 'audio':
                    ext = 'mp3'
                else:
                    ext = info.get('ext', 'mp4')
                
                # Use the sanitized title
                final_filename = f"{sanitized_title}.{ext}"
                final_path = str(Path(download_dir) / final_filename)
                
                print(f"✅ Download complete: {final_path}")
                
                progress_callback({
                    'status': 'finished',
                    'result': {
                        'final_path': final_path,
                        'filename': final_filename
                    }
                })
                
        except Exception as e:
            print(f"❌ Download error: {e}")
            progress_callback({
                'status': 'error',
                'error': str(e)
            })
    
    thread = threading.Thread(target=download_task, daemon=True)
    thread.start()
    return thread

def progress_hook(d, callback, cancel_event):
    if cancel_event.is_set():
        raise Exception("Download cancelled")
    
    if d['status'] == 'downloading':
        total = d.get('total_bytes') or d.get('total_bytes_estimate', 0)
        downloaded = d.get('downloaded_bytes', 0)
        speed = d.get('speed', 0)
        eta = d.get('eta', 0)
        callback({
            'status': 'downloading',
            'downloaded_bytes': downloaded,
            'total_bytes': total,
            'speed': speed,
            'eta': eta,
        })
    elif d['status'] == 'finished':
        callback({
            'status': 'processing',
            'message': 'Processing file...'
        })

def get_thumbnail_for_url(url):
    try:
        with YoutubeDL({'quiet': True}) as ydl:
            info = ydl.extract_info(url, download=False)
            return info.get('thumbnail', '')
    except Exception:
        return ''