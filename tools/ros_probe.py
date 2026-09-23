#!/usr/bin/env python3
import socket
import struct
import threading
import time
import urllib.request


def frame(fields):
    body = b"".join(struct.pack("<I", len(field)) + field for field in fields)
    return struct.pack("<I", len(body)) + body


def read_exact(sock, size):
    chunks = []
    while size:
        chunk = sock.recv(size)
        if not chunk:
            raise EOFError("socket closed")
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)


def request(method, path, body=None):
    req = urllib.request.Request(
        "http://127.0.0.1:8765" + path,
        data=body,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=2) as response:
        response.read()


def pulse():
    time.sleep(0.4)
    request("PUT", "/v1/drive", b'{"linear":0.2,"angular":0}')
    time.sleep(0.5)
    request("POST", "/v1/drive/stop", b"")


sock = socket.create_connection(("127.0.0.1", 40007), timeout=3)
sock.sendall(frame([
    b"callerid=/alfred_diag",
    b"topic=/comm/SendData",
    b"type=comm/SendData",
    b"md5sum=5a7f134de1b7437eae7d27ef3b79b5b2",
    b"tcp_nodelay=1",
]))
header_size = struct.unpack("<I", read_exact(sock, 4))[0]
read_exact(sock, header_size)
threading.Thread(target=pulse, daemon=True).start()
sock.settimeout(2)
deadline = time.monotonic() + 2
while time.monotonic() < deadline:
    try:
        payload_size = struct.unpack("<I", read_exact(sock, 4))[0]
        payload = read_exact(sock, payload_size)
    except socket.timeout:
        break
    data_size = struct.unpack_from("<I", payload)[0]
    data = payload[4 : 4 + data_size]
    if data.startswith(b"WA"):
        print(data.hex())
