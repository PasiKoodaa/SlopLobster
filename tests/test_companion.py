import importlib.util
import json
from pathlib import Path
import queue
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('companion', ROOT / 'SlopLobster-companion.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def python_command(code):
    args = [sys.executable, '-u', '-c', code]
    return ' '.join(shlex.quote(arg) for arg in args) if c.WINDOWS_BASH or sys.platform != 'win32' else subprocess.list2cmdline(args)


def wait_for(command_id, terminal=True):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        result = c.command_status(command_id)
        if (terminal and result['status'] not in ('running', 'cancelling')) or (not terminal and result['events']):
            return result
        time.sleep(.02)
    raise AssertionError('Command did not reach expected state')


class CommandTests(unittest.TestCase):
    def test_exit_status_and_reconnect_cursor(self):
        command_id = c.start_command({'command': python_command("print('hello'); raise SystemExit(7)"), 'timeout': 5})
        result = wait_for(command_id)
        self.assertEqual(result['status'], 'error')
        self.assertEqual(result['exitCode'], 7)
        self.assertIn('hello', ''.join(event['d'] for event in result['events']))
        self.assertEqual(c.command_status(command_id, result['cursor'])['events'], [])

    def test_idempotent_start_never_repeats_side_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'marker'
            command = python_command(f"from pathlib import Path; p=Path({marker.as_posix()!r}); p.write_text(p.read_text()+'x' if p.exists() else 'x')")
            body = {'id': 'idempotent-test', 'command': command, 'timeout': 5}
            command_id = c.start_command(body)
            self.assertEqual(c.start_command(body), command_id)
            result = wait_for(command_id)
            self.assertEqual(result['status'], 'ok', result)
            self.assertEqual(c.start_command(body), command_id)
            self.assertEqual(marker.read_text(), 'x')
            with self.assertRaises(ValueError): c.start_command({**body, 'command': 'echo changed'})

    def test_cancel_terminates_process_tree(self):
        command_id = c.start_command({'command': python_command("import time; print('ready', flush=True); time.sleep(30)"), 'timeout': 60})
        wait_for(command_id, terminal=False)
        c.cancel_command(command_id)
        result = wait_for(command_id)
        self.assertEqual(result['status'], 'cancelled')
        self.assertNotEqual(result['exitCode'], 0)

    def test_output_is_bounded_even_without_newlines(self):
        command_id = c.start_command({'command': python_command("print('x'*250000, end='')"), 'timeout': 5})
        result = wait_for(command_id)
        self.assertTrue(result['truncated'])
        self.assertLessEqual(sum(len(event['d']) for event in result['events']), c.MAX_OUTPUT)
        self.assertEqual(result['exitCode'], 0)

    def test_bad_arguments_rejected_before_launch(self):
        for body in ({'command': []}, {'command': 'echo x', 'timeout': True}, {'command': 'echo x', 'timeout': 0}):
            with self.assertRaises(ValueError): c.start_command(body)

    def test_mcp_matches_id_and_ignores_notifications(self):
        class Input:
            def write(self, text): pass
            def flush(self): pass
        class Process:
            stdin = Input()
            def poll(self): return None
        responses = queue.Queue()
        responses.put({'method': 'notifications/message'})
        responses.put({'id': 2, 'result': 'stale'})
        responses.put({'id': 3, 'result': 'correct'})
        self.assertEqual(c._mcp_send_and_recv(Process(), responses, {'id': 3}, .1)['result'], 'correct')


class AccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = c.CompanionHTTPServer(('127.0.0.1', 0), c.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = 'http://127.0.0.1:' + str(cls.server.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def request(self, path='/status', headers=None, body=None):
        req = urllib.request.Request(self.url + path, headers=headers or {}, data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(req, timeout=3) as response:
                return response.status, dict(response.headers), json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, dict(error.headers), json.load(error)

    def test_token_required(self):
        self.assertEqual(self.request()[0], 401)
        status, _, body = self.request(headers={'Authorization': 'Bearer ' + c.SESSION_TOKEN})
        self.assertEqual(status, 200)
        self.assertEqual(body['version'], '1.6.0')
        self.assertNotIn('token', body)

    def test_origin_and_host_validation(self):
        headers = {'Authorization': 'Bearer ' + c.SESSION_TOKEN, 'Origin': 'https://unpaired.example'}
        self.assertEqual(self.request(headers=headers)[0], 403)
        headers['Origin'] = 'null'
        status, response_headers, _ = self.request(headers=headers)
        self.assertEqual(status, 200)
        self.assertEqual(response_headers['Access-Control-Allow-Origin'], 'null')
        headers['Host'] = 'unpaired.example'
        self.assertEqual(self.request(headers=headers)[0], 403)

    def test_server_capabilities_enforced(self):
        original = c.CAPABILITIES
        try:
            c.CAPABILITIES = set()
            status, _, _ = self.request('/commands/start', {'Authorization': 'Bearer ' + c.SESSION_TOKEN}, {'command': 'echo forbidden'})
            self.assertEqual(status, 403)
        finally: c.CAPABILITIES = original

    def test_command_lifecycle_over_http(self):
        headers = {'Authorization': 'Bearer ' + c.SESSION_TOKEN}
        status, _, body = self.request('/commands/start', headers, {'command': python_command("print('http')"), 'timeout': 5})
        self.assertEqual(status, 200)
        wait_for(body['id'])
        status, _, result = self.request('/commands/status', headers, {'id': body['id'], 'cursor': 0})
        self.assertEqual(status, 200)
        self.assertEqual(result['exitCode'], 0)


if __name__ == '__main__': unittest.main()
