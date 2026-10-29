"""Sample concurrent worker-tree RSS and build scratch bytes; no shared-page claims."""
import os
from pathlib import Path
import subprocess
import threading


class ResourceSampler:
    def __init__(self, directory, interval=1):
        self.directory = Path(directory)
        self.interval = interval
        self.stop = threading.Event()
        self.samples = 0
        self.peak_rss = None
        self.peak_disk = 0
        self.rss_error = None
        self.thread = threading.Thread(target=self.sample, daemon=True)
        self.thread.start()

    def sample(self):
        while True:
            disk = 0
            for path in self.directory.rglob('*'):
                try:
                    if path.is_file(): disk += path.stat().st_size
                except FileNotFoundError:
                    pass  # scratch files can be atomically removed by a writer
            self.peak_disk = max(self.peak_disk, disk)
            try:
                result = subprocess.run(['ps', '-axo', 'pid=,ppid=,rss='], capture_output=True, text=True, check=True)
                processes = [tuple(map(int, row.split())) for row in result.stdout.splitlines()]
                owned = {os.getpid()}
                for _ in range(len(processes)):
                    added = {pid for pid, parent, rss in processes if parent in owned} - owned
                    if not added: break
                    owned |= added
                rss = sum(rss*1024 for pid,parent,rss in processes if pid in owned)
                self.peak_rss = max(self.peak_rss or 0, rss)
            except (OSError, ValueError, subprocess.CalledProcessError) as error:
                self.rss_error = type(error).__name__
            self.samples += 1
            if self.stop.wait(self.interval): break

    def finish(self):
        self.stop.set(); self.thread.join()
        return {'sampleIntervalSeconds': self.interval, 'samples': self.samples,
                'peakConcurrentRssBytes': self.peak_rss, 'peakScratchBytes': self.peak_disk,
                'rssUnavailableReason': self.rss_error,
                'method': 'sampled sum of worker and concurrent descendant RSS; shared pages may be counted more than once; scratch uses logical file sizes',
                'physicalPeakRamBytes': None}
