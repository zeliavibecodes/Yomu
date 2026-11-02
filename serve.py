#!/usr/bin/env python3
"""Serve Yomu from this folder for testing on the Mac and on an iPhone on the same Wi-Fi.

Run it from the yomu folder:   python3 serve.py
Then open the address it prints on the iPhone.

Besides the app's files, it passes on Kakuyomu story pages at /relay, the same
way the online relay does (relay/worker.js), so "Add from Kakuyomu" works locally.
"""
import http.server, re, socket, socketserver, sys, urllib.error, urllib.parse, urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ALLOWED = re.compile(r"^/works/\d+(/episodes/\d+)?$")
AGENT = "Yomu personal reader (one reader, one episode at a time)"


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path.rstrip("/").endswith("/relay"):
            return self.relay(urllib.parse.parse_qs(url.query).get("path", [""])[0])
        return super().do_GET()

    def relay(self, path):
        if not ALLOWED.match(path):
            return self.send_error(400, "Only Kakuyomu story pages can be fetched.")
        try:
            req = urllib.request.Request("https://kakuyomu.jp" + path, headers={"User-Agent": AGENT})
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read()
        except urllib.error.HTTPError as e:
            return self.send_error(e.code)
        except Exception:
            return self.send_error(502)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Always load the newest files while testing.
        if not self.path.startswith("/relay"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def lan_address():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "localhost"
    finally:
        s.close()


if __name__ == "__main__":
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
        print(f"Yomu is running. On your iPhone, open:  http://{lan_address()}:{PORT}/")
        print("Press Ctrl+C to stop.")
        httpd.serve_forever()
