"""Watches the account's token use and prints one JSON line per reading.

Two sources:
- local: the transcripts every Claude Code session on this machine writes
  under <config>/projects, tailed as they grow, for the exact token counts of
  each response; the last seven days are read once at start, so the limits
  can be weighed in tokens at once;
- account: the subscription's usage endpoint on api.anthropic.com, read once
  a minute, for each window's percentage, which every client of the account
  moves (claude.ai, other machines, other people).

Every session runs its own watcher, but the account is read by one of them at
a time: the reading, its recent history and any back-off are shared through a
cache file, so ten open sessions cost the endpoint what one does.

Lines printed:
  {"t": "local", "total": tok/s, "output": tok/s, "sessions": n,
   "windows": {"<window>": {"total": tokens, "output": tokens}, ...}}
  {"t": "account", "limits": [{"kind", "percentUsed", "resetsAt"}, ...],
   "at": when read, "pct_per_min": slope | null, "local_rate": tok/s | null}
  {"t": "account", "error": reason, "at": when it failed}
  {"t": "calib", "<window>": [tokens per percent, percent it was weighed at], ...}

A window's tokens are this machine's since the window opened, counting only
the window's model where it is one model's (Opus, Sonnet). When a window's
reset time passes, its count starts again from zero at once, and the account
is read again a few seconds later.
"""

import datetime
import fcntl
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
CACHE_DIR = os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache'), 'conso-live')
CACHE = os.path.join(CACHE_DIR, 'usage.json')
LOCK = os.path.join(CACHE_DIR, 'usage.lock')

TICK = 0.1            # seconds between local readings: 10 per second
RESCAN = 2.0          # seconds between looks for new transcript files
QUIET = 3600.0        # a file unchanged this long is checked at rescans only
HISTORY = 7 * 86400   # seconds of responses kept, the longest window
TAU = 15.0            # seconds the local rate takes to fall to a third
FRESH = 30.0          # a response newer than this moves the rate
IDLE = 20.0           # with no response for this long, the rate falls fast
IDLE_TAU = 2.0
ACTIVE = 45.0         # a session whose transcript grew this recently is active
POLL = 60.0           # seconds between account readings
CHECK = 2.0           # seconds between looks at the shared reading
AFTER_RESET = 5.0     # seconds after a reset before the account is read again
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


def session_of(path):
    """The session a transcript belongs to: a subagent's is its parent's."""
    parts = os.path.relpath(path, PROJECTS).split(os.sep)
    return parts[1][:-6] if len(parts) == 2 and parts[1].endswith('.jsonl') else parts[1] if len(parts) > 1 else path


class Local:
    def __init__(self):
        self.lock = threading.Lock()
        self.offsets = {}
        self.changed = {}  # path -> when it last grew
        self.partial = {}
        # Counted so far per message id: a response is written once per block.
        self.seen = {}
        self.events = []  # (time, total, output, path, model), oldest first
        self.starts = {}  # window -> when it opened
        self.windows = {}  # window -> [total, output] since it opened
        self.total_rate = 0.0
        self.output_rate = 0.0
        self.last_event = 0.0  # when the rate last took a response in
        self.ticked = time.time()
        self.scanned = 0.0
        self.is_ready = threading.Event()

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
                stat = os.stat(path)
            except OSError:
                del self.offsets[path]
                self.changed.pop(path, None)
                self.partial.pop(path, None)
                continue
            size = stat.st_size
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
            # When the session wrote, not when this read it: a week read at
            # start leaves only the sessions still at work active.
            self.changed[path] = stat.st_mtime
            text = self.partial.pop(path, b'') + chunk
            lines = text.split(b'\n')
            if lines[-1]:
                self.partial[path] = lines[-1]
            for line in lines[:-1]:
                self.count(line, path, now)

        # The rate decays smoothly between responses instead of stepping, and
        # falls to nothing within seconds once no session answers any more.
        tau = TAU if now - self.last_event < IDLE else IDLE_TAU
        decay = math.exp(-(now - self.ticked) / tau)
        self.total_rate *= decay
        self.output_rate *= decay
        if self.total_rate < 0.5:
            self.total_rate = self.output_rate = 0.0
        self.ticked = now
        with self.lock:
            drop = 0
            while drop < len(self.events) and now - self.events[drop][0] > HISTORY:
                drop += 1
            if drop:
                del self.events[:drop]
        self.roll(now)
        self.is_ready.set()

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
            self.last_event = now

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

    def roll(self, now):
        """Starts a window's count again once its reset time has passed."""
        for kind, start in list(self.starts.items()):
            length = WINDOWS[kind][0]
            if now >= start + length:
                self.open_window(kind, start + length * math.floor((now - start) / length))

    def window_total(self, kind):
        with self.lock:
            return self.windows.get(kind, [0, 0])[0]

    def since(self, start):
        with self.lock:
            return sum(e[1] for e in self.events if e[0] >= start)

    def reading(self):
        now = time.time()
        sessions = len({session_of(p) for p, t in list(self.changed.items()) if now - t <= ACTIVE})
        with self.lock:
            windows = {k: {'total': v[0], 'output': v[1]} for k, v in self.windows.items()}
        return {'t': 'local', 'total': self.total_rate, 'output': self.output_rate,
                'sessions': sessions, 'windows': windows}


def counts(kind, model):
    family = WINDOWS.get(kind, (0, None))[1]
    return family is None or family in model.lower()


def load_cache():
    try:
        with open(CACHE) as f:
            cache = json.load(f)
        return cache if isinstance(cache, dict) else {}
    except (OSError, ValueError):
        return {}


def save_cache(cache):
    temp = '%s.%d' % (CACHE, os.getpid())
    with open(temp, 'w') as f:
        json.dump(cache, f)
    os.replace(temp, CACHE)


def limits_of(body):
    """Every window the account reports, whatever its name."""
    limits = []
    for kind, window in (body or {}).items():
        if isinstance(window, dict) and isinstance(window.get('utilization'), (int, float)):
            limit = {'kind': kind, 'percentUsed': window['utilization']}
            if window.get('resets_at'):
                limit['resetsAt'] = window['resets_at']
            limits.append(limit)
    return limits


def is_due(cache, now):
    """Whether the shared reading is old enough, or a window reset since."""
    if now < cache.get('next_at', 0):
        return False
    at = cache.get('at', 0)
    if now - at >= POLL:
        return True
    for limit in limits_of(cache.get('body')):
        resets = stamp(limit.get('resetsAt'))
        if resets and at < resets + AFTER_RESET <= now:
            return True
    return False


class Account(threading.Thread):
    def __init__(self, local):
        super().__init__(daemon=True)
        self.local = local
        self.shown = None  # the cache's reading this watcher last printed

    def run(self):
        os.makedirs(CACHE_DIR, exist_ok=True)
        while True:
            try:
                self.step()
            except Exception as error:  # a bad cache or a full disk must not end the thread
                emit({'t': 'account', 'error': type(error).__name__, 'at': time.time()})
            time.sleep(CHECK)

    def step(self):
        now = time.time()
        cache = load_cache()
        if is_due(cache, now):
            # One watcher reads the account; the others wait for its reading.
            with open(LOCK, 'w') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return
                cache = load_cache()
                if is_due(cache, now):
                    cache = self.fetch(cache, now)
                    save_cache(cache)
        # Weighing the limits needs the week of transcripts read first.
        mark = (cache.get('at'), cache.get('error'), self.local.is_ready.is_set())
        if mark != self.shown:
            self.shown = mark
            self.show(cache)

    def fetch(self, cache, now):
        cache = dict(cache)
        backoff = cache.get('backoff') or POLL
        try:
            with open(CREDENTIALS) as f:
                token = json.load(f)['claudeAiOauth']['accessToken']
            request = urllib.request.Request(USAGE_URL, headers={
                'Authorization': 'Bearer ' + token,
                'anthropic-beta': 'oauth-2025-04-20',
                'User-Agent': 'conso-live',
            })
            with urllib.request.urlopen(request, timeout=15) as response:
                body = json.loads(response.read().decode())
        except (OSError, ValueError, KeyError, TypeError) as error:
            if isinstance(error, urllib.error.HTTPError):
                reason = 'http-%d' % error.code
                if error.code == 429:
                    backoff = min(MAX_BACKOFF, backoff * 2)
                    try:
                        backoff = max(backoff, min(MAX_BACKOFF, float(error.headers.get('Retry-After') or 0)))
                    except ValueError:
                        pass
            elif isinstance(error, (KeyError, TypeError)) or getattr(error, 'filename', None) == CREDENTIALS:
                reason = 'no-credentials'
            else:
                reason = 'network'
            cache.update(error=reason, failed_at=now, next_at=now + backoff, backoff=backoff)
            return cache

        # The five-hour percent over the last minutes, for the account's rate.
        history = [h for h in cache.get('history') or [] if now - h[0] <= SLOPE_KEEP]
        five = (body.get('five_hour') or {}).get('utilization')
        if isinstance(five, (int, float)):
            if history and five < history[-1][1]:
                history = []  # the window was reset
            history.append([now, float(five)])
        # A reset passing reads the account again before the minute is up.
        return {'at': now, 'body': body, 'history': history, 'next_at': 0, 'backoff': POLL}

    def show(self, cache):
        # The last good reading is still shown after a failure, marked stale.
        error = cache.get('error') if cache.get('failed_at', 0) >= cache.get('at', 0) else None
        body = cache.get('body')
        if not body:
            if error:
                emit({'t': 'account', 'error': error})
            return
        at = cache.get('at', 0)
        limits = limits_of(body)
        payload = {'t': 'account', 'limits': limits, 'at': at, 'error': error,
                   'pct_per_min': None, 'local_rate': None}
        if not self.local.is_ready.is_set():
            emit(payload)
            return

        # Each window weighed by this machine's tokens since it opened; a
        # window whose reset passed since the reading is left to roll.
        calibration = {}
        for limit in limits:
            kind = limit['kind']
            resets = stamp(limit.get('resetsAt'))
            if kind not in WINDOWS or not resets or resets <= time.time():
                continue
            self.local.open_window(kind, resets - WINDOWS[kind][0])
            spent = self.local.window_total(kind)
            if limit['percentUsed'] >= MIN_PERCENT and spent > 0:
                calibration[kind] = [spent / limit['percentUsed'], limit['percentUsed']]
        if calibration:
            emit(dict(calibration, t='calib'))

        history = cache.get('history') or []
        if history and at - history[0][0] >= SLOPE_SPAN:
            first = history[0]
            payload['pct_per_min'] = (history[-1][1] - first[1]) / ((at - first[0]) / 60.0)
            # This machine over the same span, so the two compare.
            payload['local_rate'] = self.local.since(first[0]) / (at - first[0])
        emit(payload)


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
