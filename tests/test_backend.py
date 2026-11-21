import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from groundtruth_backend import Backend, SupabaseStore


class FakeRemote:
    def __init__(self): self.calls = []; self.fail = False
    def upsert(self, table, rows, conflict):
        if self.fail: raise RuntimeError('Supabase is unreachable; predictions remain queued locally.')
        self.calls.append((table, rows, conflict))


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.remote = FakeRemote()
        self.backend = Backend(runtime=self.temp.name, remote=self.remote)
        self.street = self.backend.find_streets('Miner Road')[0]['id']

    def tearDown(self):
        self.backend.close(); self.temp.cleanup()

    def test_scoring_validation_and_durable_history(self):
        prediction = self.backend.score(self.street, 171.5, 76.5)
        self.assertAlmostEqual(prediction['score'], 43.2, delta=.1)
        self.assertFalse(prediction['calibrated'])
        self.assertEqual(len(prediction['explanation']), 4)
        run = self.backend.save([prediction], 'ask', 171.5, 76.5)
        self.assertEqual(self.backend.history(self.street)[0]['run']['id'], run['id'])
        self.assertEqual(self.backend.history(-1), [])
        self.assertEqual(self.backend.status()['pending_sync'], 1)
        for values in [(self.street, float('nan'), 10), (True, 10, 10), (-1, 10, 10), (self.street, 401, 10), (self.street, 10, 281)]:
            with self.assertRaises(ValueError): self.backend.score(*values)

    def test_outage_retries_same_run_and_seeds_streets(self):
        p = self.backend.score(self.street, 60, 120)
        run = self.backend.save([p], 'ask', 60, 120)
        self.remote.fail = True; self.backend.sync_once()
        self.assertEqual(self.backend.status()['pending_sync'], 1)
        self.remote.fail = False; self.backend.sync_once()
        self.assertEqual(self.backend.status()['pending_sync'], 0)
        self.assertEqual(self.backend.status()['persistence'], 'supabase')
        runs = [rows[0]['id'] for table, rows, _ in self.remote.calls if table=='gt_prediction_runs']
        self.assertEqual(runs, [run['id']])
        before = len(self.remote.calls); self.backend.sync_once()
        self.assertEqual(len(self.remote.calls), before)
        streets = [s for table, rows, _ in self.remote.calls if table=='gt_streets' for s in rows]
        self.assertEqual(len(streets), len(self.backend.streets))

    def test_supabase_secret_header_and_invalid_url(self):
        for bad in ['http://example.com', 'https://example.com', 'https://a.supabase.co/path', 'https://user:pass@a.supabase.co']:
            with self.assertRaises(ValueError): SupabaseStore(bad, 'secret')
        with patch('urllib.request.urlopen') as opener:
            SupabaseStore('https://test.supabase.co', 'sb_secret_test').upsert('gt_predictions', [], 'run_id,street_id')
            request = opener.call_args[0][0]
            self.assertEqual(request.get_header('Apikey'), 'sb_secret_test')
            self.assertIsNone(request.get_header('Authorization'))
        self.assertNotIn('sb_secret_test', json.dumps(self.backend.status()))


if __name__ == '__main__': unittest.main()
