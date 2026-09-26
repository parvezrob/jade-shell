"""Setup's speed and words: downloads, progress for the installer, its summary,
and what it says. Runs in the same throwaway home as the other tests."""
import http.server
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
import sandbox  # noqa: F401  (first: a throwaway home for the whole process)

sys.path.insert(0, str(ROOT))

from jade import download, themes


class Server:
    """A local web server whose replies each test writes: `handle(request)`."""

    def __init__(self, test, handle):
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                server.requests += 1
                handle(self)

            def log_message(self, *_args):
                pass

        self.requests = 0
        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        test.addCleanup(self.httpd.server_close)
        test.addCleanup(self.httpd.shutdown)
        self.url = f'http://127.0.0.1:{self.httpd.server_address[1]}'


class Downloads(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = pathlib.Path(tmp.name)
        for patcher in (mock.patch.dict(os.environ, XDG_DATA_HOME=str(self.home)),
                        mock.patch.object(themes, 'RETRY_DELAYS', (0, 0))):
            patcher.start()
            self.addCleanup(patcher.stop)
        # Straight to the local server, whatever proxy the tests set for everything else.
        for name in ('https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'):
            patcher = mock.patch.dict(os.environ, {name: ''})
            patcher.start()
            self.addCleanup(patcher.stop)
        self.theme = themes.load('osaka-jade')

    def serve(self, handle):
        server = Server(self, handle)
        patcher = mock.patch.object(themes, 'WALLPAPER_URL', server.url + '/{theme}/{file}')
        patcher.start()
        self.addCleanup(patcher.stop)
        return server

    def test_a_cut_off_download_is_not_kept(self):
        def short(request):
            request.send_response(200)
            request.send_header('Content-Length', '1000000')
            request.end_headers()
            request.wfile.write(b'RIFF' + b'x' * 996)
            request.close_connection = True

        server = self.serve(short)
        with self.assertRaises(themes.WallpaperUnavailable) as caught:
            self.theme.fetch_wallpaper(0)
        self.assertIn('the connection dropped', str(caught.exception))
        self.assertEqual(server.requests, 3)  # a dropped connection is worth trying again
        self.assertFalse(self.theme.wallpaper(0).exists())
        self.assertEqual(list(self.theme.wallpaper(0).parent.iterdir()), [])  # no partial file either

    def test_a_busy_server_is_tried_again(self):
        def busy_once(request):
            if server.requests == 1:
                request.send_error(503)
                return
            request.send_response(200)
            request.send_header('Content-Length', '5')
            request.end_headers()
            request.wfile.write(b'image')

        server = self.serve(busy_once)
        self.assertEqual(self.theme.fetch_wallpaper(0).read_bytes(), b'image')
        self.assertEqual(server.requests, 2)

    def test_a_missing_file_is_not_asked_for_again(self):
        server = self.serve(lambda request: request.send_error(404))
        with self.assertRaises(themes.WallpaperUnavailable):
            self.theme.fetch_wallpaper(0)
        self.assertEqual(server.requests, 1)

    def test_a_timeout_is_not_waited_through_again(self):
        def stall(request):
            request.send_response(200)
            request.send_header('Content-Length', '5')
            request.end_headers()
            time.sleep(1.5)

        server = self.serve(stall)
        real = download.open_url
        with mock.patch.object(download, 'open_url', lambda url, timeout=20: real(url, timeout=0.5)), \
                self.assertRaises(themes.WallpaperUnavailable):
            self.theme.fetch_wallpaper(0)
        self.assertEqual(server.requests, 1)

    def test_an_address_that_never_answers_costs_seconds_not_minutes(self):
        listener = socket.create_server(('127.0.0.1', 0))
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        # A dead first address (as on a network whose IPv6 route goes nowhere), then one that works.
        dead = (socket.AF_INET6, socket.SOCK_STREAM, 6, '', ('100::1', port, 0, 0))
        alive = (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', port))
        with mock.patch('socket.getaddrinfo', return_value=[dead, dead, alive]), \
                mock.patch.object(download, 'CONNECT_TIMEOUT', 0.5):
            start = time.monotonic()
            sock = download.connect(('example.org', port), 20)
        sock.close()
        self.assertLess(time.monotonic() - start, 1.5)  # one dead address, then IPv4's turn

    def test_families_take_turns(self):
        six = [(socket.AF_INET6, n) for n in range(3)]
        four = [(socket.AF_INET, n) for n in range(2)]
        self.assertEqual(download.alternate(six + four), [six[0], four[0], six[1], four[1], six[2]])

    def test_nothing_answering_is_one_sentence(self):
        with mock.patch('socket.getaddrinfo', side_effect=socket.gaierror(-3, 'Temporary failure')), \
                self.assertRaises(themes.WallpaperUnavailable) as caught:
            self.theme.fetch_wallpaper(0)
        self.assertEqual(str(caught.exception), "couldn't download the Osaka Jade wallpaper (no internet connection)")


if __name__ == '__main__':
    unittest.main()
