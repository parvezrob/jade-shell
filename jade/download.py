"""Downloads that neither hang on a dead address nor keep a cut-off file.

urllib tries a server's addresses one after another, each with the whole
timeout: on a network whose IPv6 route goes nowhere, every file waits 20 s
before IPv4 gets a turn. Here each address has a few seconds to answer,
IPv6 and IPv4 take turns (as curl and browsers do), and the timeout given
applies to reading once connected.
"""
import http.client
import socket
import urllib.error
import urllib.request

CONNECT_TIMEOUT = 3  # seconds for one address to answer


class Unreachable(ConnectionError):
    """No address of the server answered."""


class Incomplete(ConnectionError):
    """The connection closed before the whole file came."""


def alternate(addresses):
    """The addresses with their families taking turns, the first one's first."""
    if not addresses:
        return []
    first = [a for a in addresses if a[0] == addresses[0][0]]
    other = [a for a in addresses if a[0] != addresses[0][0]]
    out = []
    for i in range(max(len(first), len(other))):
        out += first[i:i + 1] + other[i:i + 1]
    return out


def connect(address, timeout=None, source_address=None, *_args):
    """socket.create_connection, with a short wait for each address."""
    host, port = address
    reading = timeout if isinstance(timeout, (int, float)) else None
    last = None
    for family, kind, proto, _name, sockaddr in alternate(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)):
        sock = socket.socket(family, kind, proto)
        try:
            sock.settimeout(min(CONNECT_TIMEOUT, reading) if reading else CONNECT_TIMEOUT)
            if source_address:
                sock.bind(source_address)
            sock.connect(sockaddr)
            sock.settimeout(reading)
            return sock
        except OSError as error:
            sock.close()
            last = error
    raise Unreachable(f'no address of {host} answered ({last})')


class _HTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = connect


class _HTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = connect


class _HTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_HTTPConnection, req)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_HTTPSConnection, req)


def open_url(url, timeout=20):
    """urllib.request.urlopen, connecting as above (proxies still apply)."""
    return urllib.request.build_opener(_HTTPHandler, _HTTPSHandler).open(url, timeout=timeout)


def copy(response, out):
    """The whole body into `out`. A server that closes early does not raise in
    urllib, it just ends: raise, so no cut-off file is kept as a whole one."""
    while chunk := response.read(1 << 16):
        out.write(chunk)
    if response.length:  # bytes the server announced and never sent
        raise Incomplete(f'the connection closed with {response.length} bytes still to come')


def transient(error):
    """Whether trying again may help: a busy server, or a dropped connection.
    Not a timeout (it would only wait as long again), nor a missing file."""
    if isinstance(error, urllib.error.HTTPError):
        return error.code == 429 or error.code >= 500
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    return isinstance(reason, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, Incomplete,
                               http.client.IncompleteRead))
