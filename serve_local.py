"""App server with a continuously running historical simulation.

Loopback-only by default. On a host such as Render, pass --host 0.0.0.0; the port
comes from $PORT and the public origin from $PUBLIC_ORIGIN or $RENDER_EXTERNAL_URL.
"""
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import threading
import urllib.request
from urllib.parse import urlsplit, parse_qs
import webbrowser

ROOT = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--host', default=os.environ.get('HOST', '127.0.0.1'))
    ap.add_argument('--port', type=int, default=int(os.environ.get('PORT', '8765')))
    args = ap.parse_args()
    url = f'http://127.0.0.1:{args.port}'
    loopback = args.host in ('127.0.0.1', 'localhost', '::1')
    public = (os.environ.get('PUBLIC_ORIGIN') or os.environ.get('RENDER_EXTERNAL_URL') or '').rstrip('/')
    origins = {url, public} - {''}
    simulation = None
    backend = None

    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query)
            try:
                if parsed.path == '/api/simulation': self.send_json(simulation.snapshot())
                elif parsed.path == '/api/backend': self.send_json(backend.status())
                elif parsed.path == '/api/model': self.send_json(dict(model_id=backend.model_id, report=backend.report))
                elif parsed.path == '/api/streets': self.send_json(backend.find_streets(query.get('q', [''])[0]))
                elif parsed.path == '/api/predictions':
                    street = int(query['street_id'][0]) if 'street_id' in query else None
                    self.send_json(backend.history(street, int(query.get('limit', ['20'])[0])))
                elif parsed.path.startswith('/api/'): self.send_json({'error':'Unknown API endpoint.'}, 404)
                else: super().do_GET()
            except (ValueError, TypeError): self.send_json({'error':'Invalid query parameters.'}, 400)

        def send_json(self, obj, status=200):
            data = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.headers.get('Origin') not in origins:
                self.send_error(403); return
            if self.path == '/api/predict':
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= 4096: raise ValueError('Invalid request length.')
                    if self.headers.get_content_type() != 'application/json': raise ValueError('Send application/json.')
                    body = json.loads(self.rfile.read(length))
                    result = backend.score(body['street_id'], body['rain_72h_mm'], body['api_mm'])
                    run = backend.save([result], 'ask', result['r72'], result['api'])
                    self.send_json(dict(prediction=result, run_id=run['id'], persistence=backend.status()['persistence']))
                except (ValueError, TypeError, KeyError) as exc:
                    self.send_json({'error':str(exc) if isinstance(exc, ValueError) else 'Missing or invalid prediction fields.'}, 400)
            elif self.path == '/api/simulation/pause':
                self.send_json(simulation.set_paused(True))
            elif self.path == '/api/simulation/resume':
                self.send_json(simulation.set_paused(False))
            elif self.path == '/api/shutdown' and loopback:
                self.send_json({'stopping': True})
                threading.Thread(target=server.shutdown, daemon=True).start()
            else: self.send_error(404)

    handler = functools.partial(Handler, directory=str(ROOT/'site'))
    try:
        server = http.server.ThreadingHTTPServer((args.host, args.port), handler)
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
        from groundtruth_backend import Backend
        simulation = Simulation()
        backend = Backend()
        simulation.start()
        backend.start(simulation)
        print('GroundTruth local simulation: '+url+'/#ask', flush=True)
        if not args.no_browser:
            threading.Timer(.8, lambda: webbrowser.open(url+'/#ask')).start()
        server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        if simulation: simulation.close()
        if backend: backend.close()
        server.server_close()


if __name__ == '__main__': main()
