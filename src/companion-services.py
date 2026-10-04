
# Isolated browser/embedding services keep slow calls off HTTP health/cancel paths.
class CompanionHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32

class ServiceProcess:
    def __init__(self, kind):
        self.kind = kind
        self.proc = None
        self.responses = None
        self.browser_open = False
        self._busy = threading.Lock()
        self._state_lock = threading.Lock()

    def _start(self):
        with self._state_lock:
            if self.proc is not None and self.proc.poll() is None:
                return self.proc, self.responses
            kw = dict(stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                      text=True, encoding='utf-8', errors='replace', bufsize=1)
            if platform.system() == 'Windows':
                kw['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
            else:
                kw['start_new_session'] = True
            proc = subprocess.Popen([sys.executable, os.path.abspath(__file__), '--service-worker', self.kind], **kw)
            responses = queue.Queue(maxsize=4)
            self.proc, self.responses = proc, responses
        def read_responses():
            try:
                while True:
                    line = proc.stdout.readline(16000001)
                    if not line: break
                    if len(line)>16000000: raise ValueError('Service response exceeds 16 MB')
                    responses.put_nowait(json.loads(line))
            except Exception as exc:
                try: responses.put_nowait({'code':502,'data':{'error':str(exc)}})
                except queue.Full: pass
            finally:
                proc.stdout.close()
                try: responses.put_nowait({'code':502,'data':{'error':'Service worker exited'}})
                except queue.Full: pass
        threading.Thread(target=read_responses, daemon=True).start()
        return proc, responses

    def stop(self, expected=None):
        with self._state_lock:
            proc, responses = self.proc, self.responses
            if expected is not None and proc is not expected: return
            self.proc = None
            self.responses = None
            self.browser_open = False
        if responses is not None:
            try: responses.put_nowait({'code':503,'data':{'error':'Service worker stopped'}})
            except queue.Full: pass
        if proc is not None:
            kill_tree(proc.pid)
            try: proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                try: proc.wait(timeout=2)
                except subprocess.TimeoutExpired: pass
            if proc.poll() is not None:
                proc.stdin.close()

    def call(self, path, body, timeout):
        if not self._busy.acquire(blocking=False):
            return 503, {'error':self.kind+' worker is busy; wait for the current operation'}
        proc = None
        try:
            proc, responses = self._start()
            def send():
                try:
                    proc.stdin.write(json.dumps({'path':path,'body':body})+'\n')
                    proc.stdin.flush()
                except Exception as exc:
                    try: responses.put_nowait({'code':502,'data':{'error':str(exc)}})
                    except queue.Full: pass
            threading.Thread(target=send, daemon=True).start()
            try:
                response = responses.get(timeout=timeout)
            except queue.Empty:
                self.stop(proc)
                return 504, {'error':self.kind+' operation timed out; its worker and child processes were stopped. Retry explicitly to start a new worker.'}
            with self._state_lock:
                if self.proc is proc:
                    self.browser_open = bool(response.get('browser_open', False))
            if response['code'] == 502: self.stop(proc)
            return response['code'], response['data']
        finally:
            self._busy.release()

_browser_service = ServiceProcess('browser')
_embed_service = ServiceProcess('embed')
_embedding_model = None
_embedding_threads_configured = False

def encode_embeddings(texts):
    global _embedding_model, _embedding_threads_configured
    if not isinstance(texts, list) or not texts or len(texts)>100 or not all(isinstance(t,str) for t in texts):
        raise ValueError('texts must contain 1-100 strings')
    if sum(map(len,texts))>500000: raise ValueError('Embedding batch exceeds 500,000 characters')
    if _embedding_model is None:
        threads = max(1, min(4, int(os.environ.get('SLOPLOBSTER_EMBED_THREADS','2'))))
        os.environ['OMP_NUM_THREADS'] = str(threads)
        os.environ['MKL_NUM_THREADS'] = str(threads)
        import torch
        if not _embedding_threads_configured:
            torch.set_num_threads(threads)
            torch.set_num_interop_threads(1)
            _embedding_threads_configured = True
        from sentence_transformers import SentenceTransformer
        _embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
    embeddings = _embedding_model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    return {'embeddings':embeddings.tolist(),'dim':int(embeddings.shape[1]),'backend':'companion'}

def run_service_worker(kind):
    import contextlib
    if kind not in ('browser', 'embed'): raise ValueError('Invalid service worker')
    for line in sys.stdin:
        try:
            request = json.loads(line)
            path, body = request['path'], request['body']
            if (kind=='browser' and not path.startswith('/browser_')) or (kind=='embed' and path!='/embed'):
                raise ValueError('Invalid worker operation')
            result = {}
            handler = object.__new__(Handler)
            handler.path = path
            handler._in_service_worker = True
            handler._check_access = lambda authenticate=True: True
            handler.read_body = lambda: body
            handler.send_json = lambda code,data: result.update(code=code,data=data)
            # Library progress output cannot corrupt the JSON protocol.
            with contextlib.redirect_stdout(sys.stderr):
                handler.do_POST()
            result['browser_open'] = _pw_browser is not None and _pw_browser.is_connected()
        except Exception as exc:
            result = {'code':500,'data':{'error':str(exc)}}
        sys.stdout.write(json.dumps(result,ensure_ascii=False)+'\n')
        sys.stdout.flush()
