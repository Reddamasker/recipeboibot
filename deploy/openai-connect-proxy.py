#!/usr/bin/env python3
"""Small allowlisted CONNECT tunnel for api.openai.com:443; no request logging."""

import argparse
import select
import socket
import socketserver


class Tunnel(socketserver.BaseRequestHandler):
    def handle(self):
        if self.client_address[0] != self.server.allowed_source:
            return
        client = self.request
        client.settimeout(15)
        header = bytearray()
        while b"\r\n\r\n" not in header:
            block = client.recv(4096)
            if not block or len(header) + len(block) > 8192:
                return
            header.extend(block)
        head, buffered = bytes(header).split(b"\r\n\r\n", 1)
        if head.split(b"\r\n", 1)[0] != b"CONNECT api.openai.com:443 HTTP/1.1":
            client.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
            return
        try:
            upstream = socket.create_connection(("api.openai.com", 443), timeout=10)
        except OSError:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
            return
        with upstream:
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            if buffered:
                upstream.sendall(buffered)
            client.settimeout(None)
            upstream.settimeout(None)
            while True:
                readable, _, _ = select.select((client, upstream), (), (), 240)
                if not readable:
                    return
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is client else client).sendall(data)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--allowed-source", required=True)
    parser.add_argument("--listen", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=3128)
    args = parser.parse_args()
    with Server((args.listen, args.port), Tunnel) as server:
        server.allowed_source = args.allowed_source
        server.serve_forever()


if __name__ == "__main__":
    main()
