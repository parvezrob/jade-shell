"""The usage collector: Omarchy's collectors plus our publishing wrapper."""
import datetime
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from jade.usage import collect as update


def load(name):
    """The vendored collectors are scripts, run as their own processes."""
    spec = importlib.util.spec_from_file_location(f'jade_usage_{name}', ROOT / 'jade/usage' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


claude = load('claude')
codex = load('codex')


def iso(hours):
    return (datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=hours)).isoformat()


class CarryLimits(unittest.TestCase):
    def test_failed_probe_keeps_open_windows(self):
        previous = {'limits': [{'label': 'Weekly (7-day)', 'percent': 0.4, 'resetsAt': iso(5)}]}
        record = update.carry_limits({'limits': [], 'usageStatusText': 'Codex limits unavailable'}, previous)
        self.assertEqual(record['limits'], previous['limits'])
        self.assertTrue(record['limitsStale'])

    def test_reset_windows_are_not_carried(self):
        previous = {'limits': [{'label': 'Weekly (7-day)', 'percent': 1.0, 'resetsAt': iso(-1)}]}
        record = update.carry_limits({'limits': [], 'usageStatusText': 'Codex limits unavailable'}, previous)
        self.assertEqual(record['limits'], [])
        self.assertNotIn('limitsStale', record)

    def test_healthy_record_is_untouched(self):
        record = {'limits': [{'percent': 0.1}], 'usageStatusText': ''}
        self.assertIs(update.carry_limits(record, {'limits': [{'percent': 0.9}]}), record)


class Publish(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.records = pathlib.Path(self.dir.name)
        patcher = mock.patch.object(update, 'records_dir', return_value=self.records)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.dir.cleanup)

    def test_records_are_published_without_leftover_temp_files(self):
        def fake(provider, flags):
            return {'id': provider, 'limits': [], 'flags': flags}
        with mock.patch.object(update, 'collect', side_effect=fake):
            self.assertEqual(update.collect_all('force'), 0)
        for provider in update.PROVIDERS:
            record = json.loads((self.records / f'{provider}.json').read_text())
            self.assertEqual(record['flags'], ['--force'])
        self.assertEqual(sorted(p.name for p in self.records.iterdir()), ['.lock', 'claude.json', 'codex.json'])

    def test_failed_collector_keeps_previous_record(self):
        (self.records / 'codex.json').write_text('{"id":"codex","limits":[]}')
        def fake(provider, flags):
            if provider == 'codex':
                raise RuntimeError('codex collector exited with 1')
            return {'id': provider}
        with mock.patch.object(update, 'collect', side_effect=fake), mock.patch('sys.stderr'):
            self.assertEqual(update.collect_all(), 1)
        self.assertEqual(json.loads((self.records / 'codex.json').read_text()), {'id': 'codex', 'limits': []})
        self.assertTrue((self.records / 'claude.json').exists())

    def test_timer_run_skips_while_another_run_holds_the_lock(self):
        self.records.mkdir(exist_ok=True)
        with (self.records / '.lock').open('w') as held:
            update.fcntl.flock(held, update.fcntl.LOCK_EX)
            with mock.patch.object(update, 'collect') as collect:
                self.assertEqual(update.collect_all(), 0)
            collect.assert_not_called()


class ClaudeLimits(unittest.TestCase):
    def test_percent_scale_reads_one_as_one_percent(self):
        self.assertAlmostEqual(claude.normalize_utilization(1.0, True), 0.01)
        self.assertAlmostEqual(claude.normalize_utilization(0.37, False), 0.37)

    def test_scoped_limits_are_titled_by_model_and_window(self):
        payload = {'limits': [
            {'kind': 'weekly_scoped', 'percent': 12, 'resets_at': None, 'scope': {'model': {'display_name': 'Fable'}}},
            {'kind': 'weekly_scoped', 'percent': 12, 'resets_at': None, 'scope': {'model': {'display_name': 'Fable'}}},
            {'kind': 'session', 'percent': 3, 'scope': None},
        ]}
        rows = claude.scoped_limits(payload, True)
        self.assertEqual([r['title'] for r in rows], ['Fable Weekly'])


class CodexLimits(unittest.TestCase):
    def test_window_labels(self):
        self.assertEqual(codex.limit_window({'usedPercent': 100, 'windowDurationMins': 10080})['label'], 'Weekly (7-day)')
        self.assertEqual(codex.limit_window({'usedPercent': 5, 'windowDurationMins': 300})['label'], '5h window')
        self.assertIsNone(codex.limit_window({'windowDurationMins': 300}))

    def test_reset_credits_count_only_available(self):
        replies = {
            'initialize': {},
            'account/read': {'result': {'account': {'planType': 'pro'}}},
            'account/rateLimits/read': {'result': {
                'rateLimits': {'planType': 'pro',
                               'primary': {'usedPercent': 100, 'windowDurationMins': 10080, 'resetsAt': 1790240188}},
                'rateLimitResetCredits': {'credits': [{'status': 'available'}, {'status': 'redeemed'}]},
            }},
        }
        with mock.patch.object(codex, 'find_command', return_value='/bin/true'), \
             mock.patch.object(codex.subprocess, 'Popen'), \
             mock.patch.object(codex, 'rpc_request', side_effect=lambda _p, _i, method, *a, **k: replies[method]):
            result = codex.fetch_codex_rpc()
        self.assertEqual(result['resetCredits'], 1)
        self.assertEqual(result['tierLabel'], 'pro')
        self.assertEqual(result['limits'][0]['percent'], 1.0)


if __name__ == '__main__':
    unittest.main()
