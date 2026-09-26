"""Why something failed, in words anyone can read.

Errno numbers and library names are for the log (setup.log, `jade debug`);
people see what happened: no internet, GitHub out of reach, a full home
folder, a damaged picture.
"""
import errno
import http.client
import socket
import ssl
import urllib.error

from . import download


def plain(error, server='GitHub'):
    """A short reason for `error`, to go in parentheses or after a colon."""
    if isinstance(error, urllib.error.HTTPError):
        if error.code == 404:
            return f'the file is no longer on {server}'
        return f'{server} is busy right now' if error.code == 429 or error.code >= 500 else f'{server} refused it'
    if isinstance(error, urllib.error.URLError) and isinstance(error.reason, BaseException):
        error = error.reason
    number = getattr(error, 'errno', None)
    if number == errno.ENOSPC:
        return 'your home folder is full'
    if isinstance(error, socket.gaierror) or number in (errno.ENETUNREACH, errno.ENETDOWN):
        return 'no internet connection'
    if isinstance(error, ssl.SSLCertVerificationError):
        return 'the network blocked the download; it may want you to sign in first'
    if isinstance(error, (download.Unreachable, ConnectionRefusedError)) or number == errno.EHOSTUNREACH:
        return f"couldn't reach {server}"
    if isinstance(error, (TimeoutError, ConnectionError, http.client.HTTPException)):
        return 'the connection dropped'
    if type(error).__name__ == 'GError':  # GdkPixbuf could not read it
        return 'the picture is damaged'
    if isinstance(error, OSError) and error.strerror:
        return error.strerror[0].lower() + error.strerror[1:]
    return 'something went wrong'


def detail(error):
    """The error as Python has it, on one line, for the log."""
    text = ' '.join(str(error).split())
    return f'{type(error).__name__}: {text}' if text else type(error).__name__
