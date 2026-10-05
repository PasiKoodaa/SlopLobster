"""Regression tests for companion stalls, worker recovery and CPU-heavy output."""
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock
import urllib.request

from test_companion import c, python_command, wait_for

FAKE_WORKER = r'''
import json, os, subprocess, sys, time
for line in sys.stdin:
    request = json.loads(line)
    if request['path'] == '/hangtree':
        marker = request['body']['marker']
        subprocess.Popen([sys.executable,'-c', 'import time; from pathlib import Path; time.sleep(2); Path('+repr(marker)+').write_text("leaked")'])
        from pathlib import Path
        Path(marker).with_suffix('.started').write_text('ready')
        time.sleep(30)
    if request['path'] == '/hang':
        time.sleep(30)
    print(json.dumps({'code':200,'data':{'pid':os.getpid()},'browser_open':True}), flush=True)
'''
FAKE_MCP = r'''
import json, sys, time
sys.stderr.write('diagnostic' * 40000); sys.stderr.flush()
for line in sys.stdin:
    request=json.loads(line)
    if 'id' not in request: continue
    if request['method']=='tools/call': time.sleep(30)
    print(json.dumps({'id':request['id'],'result':{'tools':[]}}), flush=True)
'''

class ServiceTests(unittest.TestCase):
    def test_worker_reused_timeout_reaped_and_next_request_recovers(self):
        service = c.ServiceProcess('browser')
        real_popen = subprocess.Popen
        processes = []
        def launch(args, **kwargs):
            if '--service-worker' not in args: return real_popen(args, **kwargs)
            proc = real_popen([sys.executable, '-u', '-c', FAKE_WORKER], **kwargs)
            processes.append(proc)
            return proc
        try:
            with mock.patch.object(c.subprocess, 'Popen', side_effect=launch):
                code, first = service.call('/ready', {}, 3)
                self.assertEqual(code, 200)
                self.assertEqual(service.call('/ready', {}, 3)[1], first)
                self.assertEqual(len(processes), 1)
                code, result = service.call('/hang', {}, .2)
                self.assertEqual(code, 504, result)
                self.assertIsNotNone(processes[0].poll())
                self.assertFalse(service.browser_open)
                self.assertEqual(service.call('/ready', {}, 3)[0], 200)
                self.assertEqual(len(processes), 2)
        finally:
            service.stop()
            for proc in processes:
                for stream in (proc.stdin, proc.stdout):
                    if stream: stream.close()

    def test_real_worker_protocol_starts_and_reuses_companion(self):
        service = c.ServiceProcess('browser')
        try:
            code, result = service.call('/browser_status', {}, 15)
            self.assertEqual(code, 200, result)
            self.assertIn('playwright_available', result)
            self.assertFalse(result['browser_open'])
            proc = service.proc
            self.assertEqual(service.call('/browser_status', {}, 5)[0], 200)
            self.assertIs(service.proc, proc)
        finally: service.stop()

    def test_timeout_stops_worker_children(self):
        service = c.ServiceProcess('browser')
        real_popen = subprocess.Popen
        def launch(args, **kwargs):
            if '--service-worker' not in args: return real_popen(args, **kwargs)
            return real_popen([sys.executable,'-u','-c',FAKE_WORKER], **kwargs)
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory)/'leaked'
            try:
                with mock.patch.object(c.subprocess,'Popen',side_effect=launch):
                    self.assertEqual(service.call('/ready',{},3)[0],200)
                    code, _ = service.call('/hangtree',{'marker':str(marker)},.5)
                    self.assertEqual(code,504)
                    self.assertTrue(marker.with_suffix('.started').exists())
                time.sleep(2.2)
                self.assertFalse(marker.exists(), 'worker descendant survived the timeout')
            finally: service.stop()

    def test_busy_worker_does_not_queue_another_operation(self):
        service = c.ServiceProcess('browser')
        service._busy.acquire()
        try:
            with mock.patch.object(service, '_start') as start:
                self.assertEqual(service.call('/browser_click', {}, 1)[0], 503)
                start.assert_not_called()
        finally: service._busy.release()

    def test_embedding_model_cached_and_threads_configured_once_after_load_failure(self):
        result = types.SimpleNamespace(shape=(1,2), tolist=lambda: [[.1,.2]])
        model = mock.Mock()
        model.encode.return_value = result
        factory = mock.Mock(side_effect=[RuntimeError('load failed'), model])
        torch = types.SimpleNamespace(set_num_threads=mock.Mock(), set_num_interop_threads=mock.Mock())
        with mock.patch.dict(sys.modules, {'torch':torch, 'sentence_transformers':types.SimpleNamespace(SentenceTransformer=factory)}), \
             mock.patch.dict(os.environ, {'SLOPLOBSTER_EMBED_THREADS':'2'}), \
             mock.patch.object(c, '_embedding_model', None), mock.patch.object(c, '_embedding_threads_configured', False):
            with self.assertRaises(RuntimeError): c.encode_embeddings(['text'])
            self.assertEqual(c.encode_embeddings(['text'])['dim'], 2)
            c.encode_embeddings(['another'])
            self.assertEqual(factory.call_count, 2)
            torch.set_num_threads.assert_called_once_with(2)
            torch.set_num_interop_threads.assert_called_once_with(1)
            self.assertEqual(model.encode.call_count, 2)

    def test_health_and_cancel_respond_during_slow_service(self):
        server = c.CompanionHTTPServer(('127.0.0.1',0), c.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        entered, release = threading.Event(), threading.Event()
        url = 'http://127.0.0.1:' + str(server.server_port)
        headers = {'Authorization':'Bearer '+c.SESSION_TOKEN}
        def request(path, body=None):
            req = urllib.request.Request(url+path, headers=headers, data=None if body is None else json.dumps(body).encode())
            with urllib.request.urlopen(req, timeout=2) as response: return json.load(response)
        def slow(*args):
            entered.set()
            release.wait(5)
            return 200, {'ok':True}
        failures = []
        def background():
            try: request('/embed', {'texts':['text']})
            except Exception as exc: failures.append(exc)
        command_id = c.start_command({'command':python_command("import time; print('ready',flush=True); time.sleep(30)"),'timeout':60})
        wait_for(command_id, terminal=False)
        caller = threading.Thread(target=background)
        try:
            with mock.patch.object(c._embed_service, 'call', side_effect=slow):
                caller.start()
                self.assertTrue(entered.wait(2))
                self.assertEqual(request('/status')['status'], 'ok')
                self.assertEqual(request('/commands/cancel', {'id':command_id})['status'], 'cancelling')
                self.assertFalse(release.is_set())
                release.set()
                caller.join(3)
                self.assertFalse(failures)
            self.assertEqual(wait_for(command_id)['status'], 'cancelled')
        finally:
            release.set()
            if caller.ident: caller.join(3)
            c.cancel_command(command_id)
            server.shutdown(); server.server_close(); thread.join()

class ProcessTests(unittest.TestCase):
    def test_mcp_reconnect_reuses_process_and_drains_stderr(self):
        name = 'cpu-regression'
        config = {'command':sys.executable,'args':['-u','-c',FAKE_MCP]}
        proc = None
        try:
            self.assertEqual(c._mcp_init_server(name,config)['status'],'connected')
            proc = c._mcp_servers[name]['proc']
            c._mcp_init_server(name,dict(config))
            self.assertIs(c._mcp_servers[name]['proc'],proc)
            with self.assertRaises(TimeoutError):
                c._mcp_call_tool(name,'hang',{},timeout=.2)
            proc.wait(timeout=3)
            self.assertIsNotNone(proc.poll())
        finally:
            c._mcp_servers.pop(name,None)
            if proc:
                if proc.poll() is None: c.kill_tree(proc.pid)
                proc.wait(timeout=3)
                for stream in (proc.stdin,proc.stdout,proc.stderr): stream.close()

    def test_failed_mcp_initialization_cleans_up_process(self):
        real_popen = subprocess.Popen
        processes = []
        def launch(*args, **kwargs):
            proc = real_popen(*args, **kwargs)
            processes.append(proc)
            return proc
        try:
            with mock.patch.object(c.subprocess,'Popen',side_effect=launch), \
                 mock.patch.object(c,'_mcp_send_and_recv',side_effect=TimeoutError('test')):
                with self.assertRaises(TimeoutError):
                    c._mcp_init_server('failed-cpu-test',{'command':sys.executable,'args':['-c','import time; time.sleep(30)']})
            self.assertNotIn('failed-cpu-test',c._mcp_servers)
            self.assertIsNotNone(processes[0].poll())
        finally:
            for proc in processes:
                if proc.poll() is None: c.kill_tree(proc.pid)
                proc.wait(timeout=3)
                for stream in (proc.stdin,proc.stdout,proc.stderr):
                    if stream: stream.close()

    def test_blocked_mcp_input_has_deadline(self):
        real_popen = subprocess.Popen
        kwargs = {'stdin':subprocess.PIPE,'stdout':subprocess.PIPE,'stderr':subprocess.PIPE,'text':True}
        if sys.platform != 'win32': kwargs['start_new_session']=True
        proc = real_popen([sys.executable,'-c','import time; time.sleep(30)'],**kwargs)
        try:
            with self.assertRaises(TimeoutError):
                c._mcp_send_and_recv(proc,queue.Queue(),{'id':1,'large':'x'*1000000},.2)
            proc.wait(timeout=3)
        finally:
            if proc.poll() is None: c.kill_tree(proc.pid)
            proc.wait(timeout=3)
            for stream in (proc.stdin,proc.stdout,proc.stderr): stream.close()

    def test_legacy_runner_caps_emitted_output(self):
        events=[]
        output, code = c.stream_cmd(lambda kind,data: events.append((kind,data)),
                                    python_command("print('x'*2000000,end='')"), timeout=5)
        self.assertEqual(code,0)
        self.assertLessEqual(sum(len(data) for kind,data in events if kind!='d'),c.MAX_OUTPUT+100)
        self.assertLessEqual(len(output),c.MAX_OUTPUT+100)
        self.assertIn('truncated',''.join(data for kind,data in events).lower())

    def test_command_can_close_pipes_before_exiting(self):
        real_popen = subprocess.Popen
        def launch(**kwargs):
            kwargs.pop('args'); kwargs.pop('shell',None)
            return real_popen([sys.executable,'-c','import os,time; os.close(1); os.close(2); time.sleep(3.4); os._exit(0)'],**kwargs)
        with mock.patch.object(c.subprocess,'Popen',side_effect=launch):
            _, code = c.stream_cmd_fresh(lambda *args: None,'unused',timeout=5)
        self.assertEqual(code,0)

    def test_dev_output_bounded_without_newlines(self):
        port = 49999
        proc = None
        try:
            c._start_dev_process(python_command("print('x'*300000,end='',flush=True)"), port, None)
            entry = c._dev_processes[str(port)]
            proc = entry['proc']
            proc.wait(timeout=5)
            deadline=time.monotonic()+2
            while entry['alive'][0] and time.monotonic()<deadline: time.sleep(.01)
            with entry['lock']:
                self.assertTrue(entry['buf'])
                self.assertLessEqual(sum(map(len,entry['buf'])),c.MAX_OUTPUT)
        finally:
            c._dev_processes.pop(str(port),None)
            if proc and proc.poll() is None: c.kill_tree(proc.pid)

    def test_shutdown_waits_for_command_cancellation(self):
        command_id=c.start_command({'command':python_command("import time; print('ready',flush=True); time.sleep(30)"),'timeout':60})
        wait_for(command_id,terminal=False)
        c.stop_all_commands()
        self.assertEqual(c.command_status(command_id)['status'],'cancelled')

if __name__ == '__main__': unittest.main()
