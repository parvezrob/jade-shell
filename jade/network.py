"""The network, as Omarchy's network panel shows it: the connection, a speed
test, the Wi-Fi as a QR code, DNS presets and the Wi-Fi band.

Everything goes through NetworkManager's own nmcli (on every GNOME desktop),
so GNOME's Settings and Quick Settings see the same connections. DNS and
band changes are recorded the first time, and `jade restore` puts them back.

The speed test downloads from and uploads to Cloudflare's speed test (the
one behind speed.cloudflare.com), only when asked, and counts only its own
bytes, so other traffic on the machine doesn't inflate it.
"""

import http.client
import itertools
import json
import re
import shutil
import ssl
import statistics
import subprocess
import threading
import time

from . import engine
from .store import write_text

SPEED_HOST = 'speed.cloudflare.com'
PROBE = '1.1.1.1'
DNS = {
    'cloudflare': (['1.1.1.1', '1.0.0.1'], ['2606:4700:4700::1111', '2606:4700:4700::1001']),
    'google': (['8.8.8.8', '8.8.4.4'], ['2001:4860:4860::8888', '2001:4860:4860::8844']),
}
BANDS = {'auto': '', '2.4': 'bg', '5': 'a', '6': '6GHz'}  # NetworkManager's names (6GHz needs NM 1.44+)


class NetworkError(Exception):
    """A sentence for the person."""


def nmcli(*args, check=True):
    if not shutil.which('nmcli'):
        raise NetworkError('NetworkManager (nmcli) is not installed')
    result = subprocess.run(['nmcli', *args], capture_output=True, text=True, timeout=30)
    if check and result.returncode:
        raise NetworkError(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else 'nmcli failed')
    return result.stdout


def fields(line):
    """nmcli -t: colon-separated, with \\: and \\\\ escaped."""
    return [part.replace('\\:', ':').replace('\\\\', '\\') for part in re.split(r'(?<!\\):', line)]


# ---------------------------------------------------------------- status

def route_device():
    """The device the internet goes out through."""
    try:
        out = subprocess.run(['ip', '-j', 'route', 'get', PROBE], capture_output=True, text=True, timeout=5).stdout
        route = json.loads(out)[0]
        return route.get('dev'), route.get('gateway')
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        return None, None


def device_details(device):
    out = {}
    for line in nmcli('-t', '-f', 'GENERAL,IP4,IP6', 'device', 'show', device).splitlines():
        key, _, value = line.partition(':')
        out.setdefault(re.sub(r'\[\d+\]$', '', key), []).append(value)
    return out


def wifi_now(device):
    """The access point in use: ssid, frequency (MHz), channel, rate, signal, security."""
    listing = nmcli('-t', '-f', 'IN-USE,SSID,FREQ,CHAN,RATE,SIGNAL,SECURITY', 'device', 'wifi', 'list',
                    'ifname', device, '--rescan', 'no', check=False)
    for line in listing.splitlines():
        parts = fields(line)
        if len(parts) >= 7 and parts[0] == '*':
            freq = int(re.match(r'\d+', parts[2])[0]) if re.match(r'\d+', parts[2]) else None
            return {'ssid': parts[1], 'freq': freq, 'channel': parts[3], 'rate': parts[4],
                    'signal': int(parts[5]) if parts[5].isdigit() else None, 'security': parts[6]}
    return None


def band_of(freq):
    if not freq:
        return None
    return '2.4' if freq < 2500 else '5' if freq < 5925 else '6'


def ping(host, count=3):
    """Average round trip in ms, or None."""
    if not host or not shutil.which('ping'):
        return None
    try:
        out = subprocess.run(['ping', '-n', '-q', '-c', str(count), '-i', '0.2', '-W', '1', host],
                             capture_output=True, text=True, timeout=count + 3).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = re.search(r'= [\d.]+/([\d.]+)/', out)
    return round(float(match[1]), 1) if match else None


def connection_setting(uuid, *keys):
    values = nmcli('-g', ','.join(keys), 'connection', 'show', uuid, check=False).splitlines()
    return dict(zip(keys, values + [''] * (len(keys) - len(values)), strict=True))


def resolved_dns(device):
    """The DNS servers systemd-resolved uses on `device` (Ubuntu's, where
    NetworkManager doesn't list them)."""
    if not shutil.which('resolvectl'):
        return []
    try:
        out = subprocess.run(['resolvectl', 'dns', device], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    return out.partition(':')[2].split()


def dns_mode(servers, ignore_auto):
    if ignore_auto != 'yes' or not servers:
        return 'auto'
    for name, (v4, _v6) in DNS.items():
        if servers[:len(v4)] == v4:
            return name
    return 'custom'


def status(latency=True):
    device, gateway = route_device()
    if not device:
        return {'connected': False}
    info = device_details(device)
    kind = (info.get('GENERAL.TYPE') or [''])[0]
    uuid = (info.get('GENERAL.CON-UUID') or [''])[0]
    out = {
        'connected': True, 'device': device, 'type': kind,
        'connection': (info.get('GENERAL.CONNECTION') or [''])[0],
        'address': (info.get('IP4.ADDRESS') or [''])[0].split('/')[0] or None,
        'gateway': gateway or (info.get('IP4.GATEWAY') or [''])[0] or None,
        'dns_servers': [d for d in info.get('IP4.DNS', []) if d] or resolved_dns(device),
    }
    if uuid:
        conn = connection_setting(uuid, 'ipv4.dns', 'ipv4.ignore-auto-dns', '802-11-wireless.band')
        servers = [s for s in re.split(r'[,\s]+', conn['ipv4.dns']) if s]
        out['dns'] = dns_mode(servers, conn['ipv4.ignore-auto-dns'])
        out['band_pin'] = {v: k for k, v in BANDS.items()}.get(conn['802-11-wireless.band'], 'auto')
    if kind == 'wifi':
        wifi = wifi_now(device)
        if wifi:
            out.update(wifi)
            out['band'] = band_of(wifi['freq'])
    if latency:
        out['ping_router'] = ping(out['gateway'])
        out['ping_internet'] = ping(PROBE)
    return out


# ---------------------------------------------------------------- speed test

def _connection():
    return http.client.HTTPSConnection(SPEED_HOST, timeout=10, context=ssl.create_default_context())


def latency(samples=9):
    """Round trips to Cloudflare's edge (ms), median and jitter, timed as TCP
    handshakes (what ping measures; a whole HTTP request adds the server's
    own time), and the data centre that answered."""
    import socket
    address = socket.getaddrinfo(SPEED_HOST, 443, type=socket.SOCK_STREAM)[0][4]
    times = []
    for _ in range(samples):
        start = time.monotonic()
        with socket.create_connection(address[:2], timeout=5):
            times.append((time.monotonic() - start) * 1000)
    times = times[1:]  # the first one may still warm a route
    jitter = statistics.mean(abs(a - b) for a, b in itertools.pairwise(times))
    conn = _connection()
    try:
        conn.request('GET', '/__down?bytes=0')
        response = conn.getresponse()
        response.read()
        colo = response.getheader('cf-meta-colo') or (response.getheader('cf-ray') or '').rpartition('-')[2] or None
    finally:
        conn.close()
    return round(statistics.median(times), 1), round(jitter, 1), colo


def transfer(direction, seconds, emit, streams=6):
    """Mbps over `seconds`, from `streams` connections; emits progress."""
    counted = [0]
    lock = threading.Lock()
    stop = threading.Event()
    chunk = b'\0' * (1 << 16)  # counted as it goes, so the reading is smooth

    def worker():
        while not stop.is_set():
            conn = _connection()
            try:
                if direction == 'down':
                    conn.request('GET', '/__down?bytes=50000000')
                    response = conn.getresponse()
                    while not stop.is_set() and (data := response.read(65536)):
                        with lock:
                            counted[0] += len(data)
                else:
                    conn.putrequest('POST', '/__up')
                    conn.putheader('Content-Length', str(len(chunk) * 256))
                    conn.putheader('Content-Type', 'application/octet-stream')
                    conn.endheaders()
                    for _ in range(256):
                        if stop.is_set():
                            break
                        conn.send(chunk)
                        with lock:
                            counted[0] += len(chunk)
                    if not stop.is_set():
                        conn.getresponse().read()
            except OSError:
                time.sleep(0.2)
            finally:
                conn.close()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(streams)]
    for thread in threads:
        thread.start()
    start = time.monotonic()
    samples = []
    last_bytes, last_time = 0, start
    try:
        while (now := time.monotonic()) - start < seconds:
            time.sleep(0.25)
            now = time.monotonic()
            with lock:
                total = counted[0]
            rate = (total - last_bytes) * 8 / (now - last_time) / 1e6
            last_bytes, last_time = total, now
            if now - start > seconds * 0.25:  # ramp-up (TCP slow start) doesn't count
                samples.append(rate)
            emit({'phase': direction, 'mbps': round(rate, 1), 'progress': round(min(1, (now - start) / seconds), 2)})
    finally:
        stop.set()
    if not samples:
        return 0.0
    samples.sort()
    # The steady state: the middle of what was measured, not a burst or a stall.
    middle = samples[len(samples) // 5: max(len(samples) // 5 + 1, len(samples) * 9 // 10)]
    return round(statistics.mean(middle), 1)


def speedtest(emit=lambda _event: None, seconds=8):
    try:
        ping_ms, jitter, colo = latency()
        emit({'phase': 'ping', 'ms': ping_ms, 'jitter': jitter, 'server': colo})
        down = transfer('down', seconds, emit)
        up = transfer('up', seconds, emit)
    except OSError as error:
        raise NetworkError(f'could not reach {SPEED_HOST} ({getattr(error, "reason", None) or error})') from None
    result = {'phase': 'done', 'down': down, 'up': up, 'ping': ping_ms, 'jitter': jitter, 'server': colo,
              'when': int(time.time())}
    write_text(engine.state_dir() / 'speedtest.json', json.dumps(result) + '\n')
    emit(result)
    return result


def last_speedtest():
    try:
        return json.loads((engine.state_dir() / 'speedtest.json').read_text())
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------- Wi-Fi QR

def wifi_escape(text):
    return re.sub(r'([\\;,:"])', r'\\\1', text)


def wifi_payload(ssid, key_mgmt, password, hidden):
    """The WIFI: string phones read (the ZXing format)."""
    if not password:
        kind = 'nopass'
    elif key_mgmt == 'none':
        kind = 'WEP'
    elif key_mgmt == 'sae':
        kind = 'SAE'  # WPA3 only
    else:
        kind = 'WPA'
    payload = f'WIFI:T:{kind};S:{wifi_escape(ssid)};'
    if kind != 'nopass':
        payload += f'P:{wifi_escape(password)};'
    if hidden == 'yes':
        payload += 'H:true;'
    return payload + ';'


def wep_expected(uuid):
    return bool(connection_setting(uuid, '802-11-wireless-security.wep-key-type')['802-11-wireless-security.wep-key-type'])


def wifi_qr():
    """The current Wi-Fi as a QR matrix: {'ssid', 'matrix': ['0110…', …]}."""
    device, _ = route_device()
    info = device_details(device) if device else {}
    if (info.get('GENERAL.TYPE') or [''])[0] != 'wifi':
        device = next((fields(line)[0] for line in nmcli('-t', '-f', 'DEVICE,TYPE,STATE', 'device').splitlines()
                       if fields(line)[1:3] == ['wifi', 'connected']), None)
        info = device_details(device) if device else {}
    uuid = (info.get('GENERAL.CON-UUID') or [''])[0]
    if not uuid:
        raise NetworkError('not connected to Wi-Fi')
    keys = ('802-11-wireless.ssid', '802-11-wireless-security.key-mgmt', '802-11-wireless-security.psk',
            '802-11-wireless-security.wep-key0', '802-11-wireless.hidden')
    values = nmcli('--show-secrets', '--escape', 'no', '-g', ','.join(keys), 'connection', 'show', uuid).splitlines()
    ssid, key_mgmt, psk, wep, hidden = (values + [''] * len(keys))[:len(keys)]
    secured = key_mgmt not in ('', 'none') or (key_mgmt == 'none' and wep_expected(uuid))
    if secured and not (psk or wep):
        # Secured, but NetworkManager kept the password to itself (outside
        # your desktop session, or kept in a keyring it won't open): a code
        # without it would say the network is open.
        raise NetworkError(f"can't read the {ssid} password (NetworkManager did not share it)")
    try:
        import qrcode
    except ImportError:
        raise NetworkError('showing the Wi-Fi as a QR code needs python3-qrcode') from None
    code = qrcode.QRCode(border=0, error_correction=qrcode.constants.ERROR_CORRECT_M)
    code.add_data(wifi_payload(ssid, key_mgmt, psk or wep, hidden))
    code.make(fit=True)
    return {'ssid': ssid, 'matrix': [''.join('1' if cell else '0' for cell in row) for row in code.get_matrix()]}


# ---------------------------------------------------------------- DNS and band

def state_file():
    return engine.state_dir() / 'network.json'


def load_state():
    try:
        return json.loads(state_file().read_text())
    except (OSError, ValueError):
        return {'connections': {}}


def active():
    device, _ = route_device()
    if not device:
        raise NetworkError('not connected')
    info = device_details(device)
    uuid = (info.get('GENERAL.CON-UUID') or [''])[0]
    if not uuid:
        raise NetworkError(f'{device} has no connection to change')
    return device, uuid, (info.get('GENERAL.TYPE') or [''])[0]


def change(uuid, settings, reconnect_device=None):
    """Set connection `settings`, remembering the values from before Jade
    Shell first changed each one; then apply them."""
    state = load_state()
    had = json.dumps(state, indent=2) + '\n' if state_file().exists() else None
    before = state['connections'].setdefault(uuid, {})
    missing = [key for key in settings if key not in before]
    if missing:
        before.update(connection_setting(uuid, *missing))
    # The old values are on disk before anything changes, so a full disk or
    # a killed process can never leave a change `jade restore` can't undo.
    write_text(state_file(), json.dumps(state, indent=2) + '\n')
    args = [item for key, value in settings.items() for item in (key, value)]
    try:
        nmcli('connection', 'modify', uuid, *args)
    except NetworkError:  # refused (not allowed, say): nothing changed, nothing to remember
        if had is None:
            state_file().unlink(missing_ok=True)
        else:
            write_text(state_file(), had)
        raise
    if reconnect_device:
        nmcli('connection', 'up', uuid, 'ifname', reconnect_device)


def set_dns(choice):
    device, uuid, _kind = active()
    if choice == 'auto':
        v4, v6 = [], []
    elif choice in DNS:
        v4, v6 = DNS[choice]
    else:
        servers = [s for s in re.split(r'[,\s]+', choice) if s]
        if not servers or not all(re.fullmatch(r'[\d.]+|[0-9a-fA-F:]+', s) for s in servers):
            raise NetworkError(f'{choice} is not auto, cloudflare, google or a list of DNS server addresses')
        v4, v6 = [s for s in servers if '.' in s], [s for s in servers if ':' in s]
    ignore = 'no' if choice == 'auto' else 'yes'
    change(uuid, {'ipv4.dns': ' '.join(v4), 'ipv4.ignore-auto-dns': ignore,
                  'ipv6.dns': ' '.join(v6), 'ipv6.ignore-auto-dns': 'yes' if v6 else ignore})
    nmcli('device', 'reapply', device)


def set_band(choice):
    device, uuid, kind = active()
    if kind != 'wifi':
        raise NetworkError('the band is for Wi-Fi, and this connection is not')
    if choice not in BANDS:
        raise NetworkError(f'{choice} is not auto, 2.4, 5 or 6')
    change(uuid, {'802-11-wireless.band': BANDS[choice]}, reconnect_device=device)


def restore():
    """Put back every DNS and band setting Jade Shell changed; returns lines
    for connections that are gone."""
    state = load_state()
    skipped, kept = [], {}
    for uuid, before in state['connections'].items():
        args = [item for key, value in before.items() for item in (key, value)]
        try:
            nmcli('connection', 'modify', uuid, *args)
        except NetworkError as error:
            gone = 'unknown connection' in str(error).lower() or 'not found' in str(error).lower()
            skipped.append(f'network connection {uuid} ({"no longer there" if gone else error})')
            if not gone:
                kept[uuid] = before  # e.g. not allowed right now: try again next time
    if kept:
        write_text(state_file(), json.dumps({'connections': kept}, indent=2) + '\n')
    else:
        state_file().unlink(missing_ok=True)
    return skipped
