"""Watches the account's token use and prints one JSON line per reading.

Two sources:
- local: the transcripts every Claude Code session on this machine writes
  under <config>/projects, tailed as they grow, for the exact token counts of
  each response; the last seven days are read once at start, so the limits
  can be weighed in tokens at once;
- account: the subscription's usage endpoint on api.anthropic.com, polled
  once a minute in a thread of its own, for each window's percentage, which
  every client of the account moves (claude.ai, other machines, other people).

Lines printed:
  {"t": "local", "total": tok/s, "output": tok/s, "sessions": n,
   "windows": {"<window>": {"total": tokens, "output": tokens}, ...}}
  {"t": "account", "limits": [{"kind", "percentUsed", "resetsAt"}, ...],
   "pct_per_min": slope | null, "local_rate": tok/s | null}
  {"t": "calib", "<window>": tokens per percent, ...}

A window's tokens are this machine's since the window opened, counting only
the window's model where it is one model's (Opus, Sonnet).
"""

import datetime
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.request

CONFIG = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
PROJECTS = os.path.join(CONFIG, 'projects')
CREDENTIALS = os.path.join(CONFIG, '.credentials.json')
USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

TICK = 0.1            # seconds between local readings: 10 per second
RESCAN = 5.0          # seconds between looks for new transcript files
QUIET = 3600.0        # a file unchanged this long is checked at rescans only
HISTORY = 7 * 86400   # seconds of responses kept, the longest window
TAU = 15.0            # seconds the local rate takes to fall to a third
FRESH = 30.0          # a response newer than this moves the rate
ACTIVE = 60.0         # a session with a response this recent is active
POLL = 60.0           # seconds between account readings
MAX_BACKOFF = 600.0
SLOPE_SPAN = 300.0    # seconds of account readings a slope needs at least
SLOPE_KEEP = 900.0    # seconds of account readings kept
# Length of each window, and the model names it counts (None: every model).
WINDOWS = {
    'five_hour': (5 * 3600, None),
    'seven_day': (7 * 86400, None),
    'seven_day_opus': (7 * 86400, 'opus'),
    'seven_day_sonnet': (7 * 86400, 'sonnet'),
}
MIN_PERCENT = 1.0     # below this a window is too new to weigh

out = threading.Lock()


def emit(payload):
    with out:
        sys.stdout.write(json.dumps(payload) + '\n')
        sys.stdout.flush()


def stamp(text):
    try:
        return datetime.datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp()
    except (AttributeError, ValueError):
        return None


class Local:
    def __init__(self):
        self.lock = threading.Lock()
        self.offsets = {}
        self.changed = {}  # path -> when it last grew
        self.partial = {}
        # Counted so far per message id: a response is written once per block.
        self.seen = {}
        self.events = []  # (time, total, output, path, model), oldest first
        self.starts = {}  # window -> when it opened, as the account last said
        self.windows = {}  # window -> [total, output] since it opened
        self.total_rate = 0.0
        self.output_rate = 0.0
        self.ticked = time.time()
        self.scanned = 0.0
        self.is_ready = False

    def scan(self, now):
        """Finds transcript files; one untouched for a week is read from its end."""
        self.scanned = now
        for root, _dirs, files in os.walk(PROJECTS):
            for name in files:
                if not name.endswith('.jsonl'):
                    continue
                path = os.path.join(root, name)
                if path in self.offsets:
                    continue
                try:
                    stat = os.stat(path)
                except OSError:
                    continue
                self.offsets[path] = 0 if now - stat.st_mtime < HISTORY else stat.st_size
                self.changed[path] = stat.st_mtime

    def read(self):
        now = time.time()
        is_rescan = now - self.scanned >= RESCAN
        if is_rescan:
            self.scan(now)
        for path, offset in list(self.offsets.items()):
            if not is_rescan and now - self.changed.get(path, 0) > QUIET:
                continue
            try:
                size = os.path.getsize(path)
            except OSError:
                del self.offsets[path]
                continue
            if size < offset:
                offset = 0
                self.partial.pop(path, None)
            if size == offset:
                continue
            try:
                with open(path, 'rb') as f:
                    f.seek(offset)
                    chunk = f.read(size - offset)
            except OSError:
                continue
            self.offsets[path] = size
            self.changed[path] = now
            text = self.partial.pop(path, b'') + chunk
            lines = text.split(b'\n')
            if lines[-1]:
                self.partial[path] = lines[-1]
            for line in lines[:-1]:
                self.count(line, path, now)

        # The rate decays smoothly between responses instead of stepping.
        decay = math.exp(-(now - self.ticked) / TAU)
        self.total_rate *= decay
        self.output_rate *= decay
        self.ticked = now
        with self.lock:
            while self.events and now - self.events[0][0] > HISTORY:
                self.events.pop(0)
        self.is_ready = True

    def count(self, line, path, now):
        if b'"usage"' not in line:
            return
        try:
            entry = json.loads(line)
        except ValueError:
            return
        message = entry.get('message')
        if not isinstance(message, dict) or not isinstance(message.get('usage'), dict):
            return
        usage = message['usage']
        figures = (
            int(usage.get('input_tokens') or 0),
            int(usage.get('output_tokens') or 0),
            int(usage.get('cache_read_input_tokens') or 0),
            int(usage.get('cache_creation_input_tokens') or 0),
        )
        key = message.get('id') or entry.get('requestId') or entry.get('uuid')
        before = self.seen.get(key, (0, 0, 0, 0))
        after = tuple(max(a, b) for a, b in zip(before, figures))
        self.seen[key] = after
        delta = [a - b for a, b in zip(after, before)]
        total = sum(delta)
        if total <= 0:
            return
        at = stamp(entry.get('timestamp')) or now
        model = str(message.get('model') or '')
        with self.lock:
            self.events.append((at, total, delta[1], path, model))
            for kind, start in self.starts.items():
                if at >= start and counts(kind, model):
                    figures = self.windows.setdefault(kind, [0, 0])
                    figures[0] += total
                    figures[1] += delta[1]
        if now - at < FRESH:
            self.total_rate += total / TAU
            self.output_rate += delta[1] / TAU

    def open_window(self, kind, start):
        """Counts the window's tokens again from when it opened."""
        with self.lock:
            if self.starts.get(kind) == start:
                return
            self.starts[kind] = start
            figures = [0, 0]
            for e in self.events:
                if e[0] >= start and counts(kind, e[4]):
                    figures[0] += e[1]
                    figures[1] += e[2]
            self.windows[kind] = figures

    def window_total(self, kind):
        with self.lock:
            return self.windows.get(kind, [0, 0])[0]

    def since(self, start):
        with self.lock:
            return sum(e[1] for e in self.events if e[0] >= start)

    def reading(self):
        now = time.time()
        with self.lock:
            sessions = len({e[3] for e in reversed(self.events[-500:]) if now - e[0] <= ACTIVE})
            windows = {k: {'total': v[0], 'output': v[1]} for k, v in self.windows.items()}
        return {'t': 'local', 'total': self.total_rate, 'output': self.output_rate,
                'sessions': sessions, 'windows': windows}


def counts(kind, model):
    family = WINDOWS.get(kind, (0, None))[1]
    return family is None or family in model.lower()


class Account(threading.Thread):
    def __init__(self, local):
        super().__init__(daemon=True)
        self.local = local
        self.backoff = POLL
        self.history = []  # (time, five-hour percent)

    def run(self):
        while True:
            # Weighing the limits needs the week of transcripts read first.
            while not self.local.is_ready:
                time.sleep(0.2)
            self.poll()
            time.sleep(self.backoff)

    def poll(self):
        now = time.time()
        try:
            with open(CREDENTIALS) as f:
                token = json.load(f)['claudeAiOauth']['accessToken']
        except (OSError, ValueError, KeyError, TypeError):
            emit({'t': 'account', 'error': 'no-credentials'})
            return
        request = urllib.request.Request(USAGE_URL, headers={
            'Authorization': 'Bearer ' + token,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': 'conso-live',
        })
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                body = json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            if error.code == 429:
                self.backoff = min(MAX_BACKOFF, self.backoff * 2)
            emit({'t': 'account', 'error': 'http-%d' % error.code})
            return
        except (OSError, ValueError):
            emit({'t': 'account', 'error': 'network'})
            return
        self.backoff = POLL

        # Every window the account reports, whatever its name.
        limits = []
        for kind, window in body.items():
            if isinstance(window, dict) and isinstance(window.get('utilization'), (int, float)):
                limit = {'kind': kind, 'percentUsed': window['utilization']}
                if window.get('resets_at'):
                    limit['resetsAt'] = window['resets_at']
                limits.append(limit)

        # Each window weighed by this machine's tokens since it opened.
        calibration = {}
        for limit in limits:
            kind = limit['kind']
            resets = stamp(limit.get('resetsAt'))
            if kind not in WINDOWS or not resets:
                continue
            self.local.open_window(kind, resets - WINDOWS[kind][0])
            spent = self.local.window_total(kind)
            if limit['percentUsed'] >= MIN_PERCENT and spent > 0:
                calibration[kind] = spent / limit['percentUsed']
        if calibration:
            emit(dict(calibration, t='calib'))

        five = (body.get('five_hour') or {}).get('utilization')
        slope = None
        local_rate = None
        if isinstance(five, (int, float)):
            if self.history and five < self.history[-1][1]:
                self.history = []  # the window was reset
            self.history.append((now, float(five)))
            self.history = [h for h in self.history if now - h[0] <= SLOPE_KEEP]
            first = self.history[0]
            if now - first[0] >= SLOPE_SPAN:
                slope = (five - first[1]) / ((now - first[0]) / 60.0)
                # This machine over the same span, so the two compare.
                local_rate = self.local.since(first[0]) / (now - first[0])
        emit({'t': 'account', 'limits': limits, 'pct_per_min': slope, 'local_rate': local_rate})


def main():
    local = Local()
    Account(local).start()
    last = None
    while True:
        local.read()
        reading = local.reading()
        # Rounded so a rate at rest prints nothing more.
        shown = (round(reading['total']), round(reading['output']), reading['sessions'],
                 json.dumps(reading['windows'], sort_keys=True))
        if shown != last:
            emit(reading)
            last = shown
        time.sleep(TICK)


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
