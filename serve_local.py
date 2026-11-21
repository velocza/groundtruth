"""Loopback-only app server with a continuously running historical simulation."""
import argparse
import functools
import http.server
import json
from pathlib import Path
import threading
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--port', type=int, default=8765)
    args = ap.parse_args()
    url = f'http://127.0.0.1:{args.port}'
    simulation = None

    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.path.split('?')[0] == '/api/simulation':
                self.send_json(simulation.snapshot())
            else: super().do_GET()

        def send_json(self, obj):
            data = json.dumps(obj).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.headers.get('Origin') != url:
                self.send_error(403); return
            if self.path == '/api/simulation/pause':
                self.send_json(simulation.set_paused(True))
            elif self.path == '/api/simulation/resume':
                self.send_json(simulation.set_paused(False))
            elif self.path == '/api/shutdown':
                self.send_json({'stopping': True})
                threading.Thread(target=server.shutdown, daemon=True).start()
            else: self.send_error(404)

    handler = functools.partial(Handler, directory=str(ROOT/'site'))
    try:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    except OSError:
        try:
            with urllib.request.urlopen(url+'/api/simulation', timeout=2) as response:
                if json.load(response).get('mode') != 'offline historical simulation': raise ValueError('Not GroundTruth')
        except Exception as exc:
            raise SystemExit(f'Port {args.port} is already in use: {exc}')
        if not args.no_browser: webbrowser.open(url+'/#ask')
        return
    try:
        from local_simulation import Simulation
        simulation = Simulation()
        simulation.start()
        print('GroundTruth local simulation: '+url+'/#ask', flush=True)
        if not args.no_browser:
            threading.Timer(.8, lambda: webbrowser.open(url+'/#ask')).start()
        server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        if simulation: simulation.close()
        server.server_close()


if __name__ == '__main__': main()
