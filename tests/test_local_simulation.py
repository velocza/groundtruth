import json
from pathlib import Path
import sys
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
import urllib.error

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from local_simulation import Simulation, predict
from model.train_local import provenance


class LocalSimulationTests(unittest.TestCase):
    def test_server_controls_and_shutdown(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        process = subprocess.Popen([sys.executable, str(ROOT/'serve_local.py'), '--no-browser', '--port', str(port)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def request(path, origin_header=None):
            headers = {'Origin': origin_header} if origin_header else {}
            req = urllib.request.Request(origin+path, data=b'' if origin_header else None, headers=headers)
            with urllib.request.urlopen(req, timeout=2) as response: return json.load(response)
        try:
            deadline = time.monotonic()+10
            while True:
                try:
                    state = request('/api/simulation'); break
                except (OSError, ValueError):
                    if time.monotonic() > deadline: raise
                    time.sleep(.1)
            self.assertTrue(state['running'])
            with self.assertRaises(urllib.error.HTTPError) as denied:
                request('/api/simulation/pause', 'https://example.com')
            self.assertEqual(denied.exception.code, 403)
            self.assertFalse(request('/api/simulation/pause', origin)['running'])
            self.assertTrue(request('/api/simulation/resume', origin)['running'])
            self.assertTrue(request('/api/shutdown', origin)['stopping'])
            self.assertEqual(process.wait(timeout=5), 0)
        finally:
            if process.poll() is None: process.terminate(); process.wait(timeout=5)

    def test_export_predictions_match_trainer(self):
        artifact = json.loads((ROOT/'local_model/trees.json').read_text())
        fixture = json.loads((ROOT/'local_model/parity.json').read_text())
        np.testing.assert_allclose(predict(artifact, np.array(fixture['X'])), fixture['scores'], atol=1e-9)

    def test_inputs_are_repository_only(self):
        result = provenance()
        self.assertFalse(result['external_downloads'])
        self.assertEqual(len(result['git_blobs']), 4)
        self.assertEqual(result['repository'], 'https://github.com/velocza/groundtruth')

    def test_continuous_playback_pause_resume_and_wrap(self):
        with tempfile.TemporaryDirectory() as folder:
            sim = Simulation(interval=.05, runtime=folder)
            try:
                self.assertEqual(sim.snapshot()['simulation_date'], '2022-12-26')
                self.assertEqual(len(sim.snapshot()['streets']), 3)
                self.assertFalse(sim.snapshot()['forecast'])
                self.assertFalse(sim.snapshot()['training'])
                sim.start()
                deadline = time.monotonic()+3
                while sim.snapshot()['step'] < 2 and time.monotonic() < deadline: time.sleep(.02)
                self.assertGreaterEqual(sim.snapshot()['step'], 2)
                sim.set_paused(True)
                time.sleep(.15)
                step = sim.snapshot()['step']
                time.sleep(.15)
                self.assertEqual(sim.snapshot()['step'], step)
                sim.set_paused(False)
                deadline = time.monotonic()+3
                while sim.snapshot()['step'] == step and time.monotonic() < deadline: time.sleep(.02)
                self.assertGreater(sim.snapshot()['step'], step)
                sim.close()
                sim.position = len(sim.days)
                sim.step()
                self.assertEqual(sim.snapshot()['simulation_date'], '2022-12-26')
                saved = json.loads((Path(folder)/'simulation.json').read_text())
                self.assertEqual(saved['step'], sim.snapshot()['step'])
            finally: sim.close()


if __name__ == '__main__': unittest.main()
