#!/usr/bin/env python
"""SlopLobster Companion Server v1.6.0 — Shell + Git + Web Search for SlopLobster Agent."""
import http.server, subprocess, json, os, sys, signal, platform, re, urllib.request, urllib.parse, urllib.error, shutil, threading, time, queue, secrets, codecs
from html.parser import HTMLParser
from collections import deque

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False
    PWTimeout = TimeoutError

_pw = None
_pw_browser = None
_pw_page = None
_pw_console = deque(maxlen=1000)
_pw_launch_time = None

PORT = 8765
DEFAULT_TIMEOUT = 60
MAX_OUTPUT = 100000
MAX_TIMEOUT = 600
MAX_FETCH_LEN = 100000
BUILD_VERSION = "1.6.0"
# Token is generated per launch unless explicitly supplied for local automation.
SESSION_TOKEN = os.environ.get("SLOPLOBSTER_TOKEN") or secrets.token_urlsafe(32)
ALLOWED_ORIGINS = set(filter(None, os.environ.get("SLOPLOBSTER_ORIGINS", "null").split(",")))
CAPABILITIES = set(os.environ.get("SLOPLOBSTER_CAPABILITIES", "command,browser,mcp,dev").split(","))
_commands = {}
_commands_lock = threading.Lock()
MAX_COMMANDS = 64


def start_command(body):
    command = body.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ValueError("command must be a nonempty string")
    timeout = body.get("timeout", DEFAULT_TIMEOUT)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 5 <= timeout <= MAX_TIMEOUT:
        raise ValueError("timeout must be between 5 and 600 seconds")
    command_id = body.get("id") or secrets.token_hex(16)
    if not isinstance(command_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", command_id):
        raise ValueError("invalid command id")
    cwd = body.get("cwd")
    task_id = body.get('taskId')
    if task_id:
        task = managed_task(task_id)
        cwd = task['path']
        if task['kind'] == 'evaluation' and command not in task['checks']:
            raise ValueError('Evaluation command is not one of its declared checks')
    if cwd is not None and (not isinstance(cwd, str) or not os.path.isdir(cwd)):
        raise ValueError("cwd must be an existing directory")
    with _commands_lock:
        if command_id in _commands:
            # Idempotent reconnect: never execute an existing ID again.
            job = _commands[command_id]
            if (job['command'], job['cwd'], job['timeout']) != (command, cwd, timeout):
                raise ValueError("command id already belongs to a different request")
            return command_id
        if len(_commands) >= MAX_COMMANDS:
            completed = next((key for key, job in _commands.items() if job['status'] not in ('running', 'cancelling')), None)
            if completed is None:
                raise ValueError("too many active commands")
            del _commands[completed]
        job = dict(taskId=task_id, command=command, cwd=cwd, timeout=timeout, status='running', events=[], chars=0,
                   exitCode=None, truncated=False, cancel=threading.Event(), lock=threading.Lock())
        _commands[command_id] = job

    def emit(kind, data):
        with job['lock']:
            if kind == 'd':
                job['exitCode'] = int(data)
                return
            remaining = MAX_OUTPUT - job['chars']
            if len(data) > remaining: job['truncated'] = True
            data = data[:max(0, remaining)]
            if data:
                job['events'].append(dict(t=kind, d=data))
                job['chars'] += len(data)

    def run():
        try:
            stream_cmd_fresh(emit, command, cwd=cwd, timeout=timeout, cancel_event=job['cancel'])
            with job['lock']:
                job['status'] = 'cancelled' if job['cancel'].is_set() else ('ok' if job['exitCode'] == 0 else 'error')
        except Exception as exc:
            emit('e', str(exc))
            with job['lock']:
                job['status'] = 'error'
                job['exitCode'] = -1
    job['thread'] = threading.Thread(target=run, daemon=True)
    job['thread'].start()
    return command_id


def stop_all_commands():
    with _commands_lock:
        jobs = list(_commands.values())
        for job in jobs: job['cancel'].set()
    deadline = time.monotonic() + 12
    for job in jobs:
        worker = job.get('thread')
        if worker and worker.ident is not None:
            worker.join(timeout=max(0, deadline-time.monotonic()))


def command_status(command_id, cursor=0):
    with _commands_lock: job = _commands.get(command_id)
    if job is None: raise KeyError("Unknown command id")
    if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 0:
        raise ValueError("cursor must be a nonnegative integer")
    with job['lock']:
        if cursor > len(job['events']): raise ValueError("cursor is beyond available events")
        return dict(id=command_id, status=job['status'], events=job['events'][cursor:],
                    cursor=len(job['events']), exitCode=job['exitCode'], truncated=job['truncated'])


def cancel_command(command_id):
    with _commands_lock: job = _commands.get(command_id)
    if job is None: raise KeyError("Unknown command id")
    with job['lock']:
        if job['status'] == 'running':
            job['status'] = 'cancelling'
            job['cancel'].set()
    return command_status(command_id)


def kill_tree(pid):
    try:
        if platform.system() == "Windows":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, timeout=5)
        else:
            # All owned child processes use their own session. The group can
            # outlive its leader, so do not look up a potentially exited PID.
            os.killpg(pid, signal.SIGKILL)
    except Exception: pass
    try: os.kill(pid, signal.SIGKILL)
    except Exception: pass


def _find_bash():
    if platform.system() != "Windows": return None
    candidates = [
        "C:/Program Files/Git/bin/bash.exe",
        "C:/Program Files (x86)/Git/bin/bash.exe",
        "C:/Program Files/Git/usr/bin/bash.exe",
        os.path.expandvars("%LOCALAPPDATA%/Programs/Git/bin/bash.exe"),
        os.path.expandvars("%USERPROFILE%/AppData/Local/Programs/Git/bin/bash.exe"),
    ]
    for p in candidates:
        if os.path.isfile(p): return p
    wb = shutil.which("bash")
    # CRITICAL: Exclude C:\Windows\System32\bash.exe (WSL launcher that causes 0x80072747 socket buffer exhaustion)
    if wb and not wb.replace("\\", "/").lower().startswith("c:/windows/system32"):
        return wb
    return None

WINDOWS_BASH = _find_bash()
SHELL_NAME = "bash" if WINDOWS_BASH else ("sh" if platform.system() != "Windows" else "cmd.exe")

# Persistent shell pool (Windows/Git-Bash only)
# Avoids spawning a new WSL/HyperV instance per command (0x800705aa).
import uuid as _uuid
_PSHELL_LOCK = threading.Lock()
_pshell_proc = None
_PSHELL_CMD_LOCK = threading.Lock()

def _pshell_get():
    global _pshell_proc
    with _PSHELL_LOCK:
        if _pshell_proc is None or _pshell_proc.poll() is not None:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            _pshell_proc = subprocess.Popen(
                [WINDOWS_BASH, "--norc", "--noprofile", "-s"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace",
                creationflags=flags
            )
        return _pshell_proc

def _pshell_invalidate():
    global _pshell_proc
    with _PSHELL_LOCK:
        if _pshell_proc:
            try: kill_tree(_pshell_proc.pid)
            except Exception: pass
        _pshell_proc = None

def stream_cmd_persistent(write_fn, cmd, cwd=None, timeout=DEFAULT_TIMEOUT):
    sid = _uuid.uuid4().hex
    sentinel_out = "__SLOP_OUT_" + sid + "__"
    sentinel_err = "__SLOP_ERR_" + sid + "__"
    sentinel_rc  = "__SLOP_RC_"  + sid + "__"
    cd_part = "cd " + repr(cwd) + " 2>/dev/null && " if cwd else ""
    script = (
        cd_part +
        "( " + cmd + " ) ; "
        "__rc__=$? ; "
        "echo " + sentinel_out + " ; "
        "echo " + sentinel_rc + "$" + "{__rc__} >&2 ; "
        "echo " + sentinel_err + " >&2\n"
    )
    with _PSHELL_CMD_LOCK:
        for attempt in range(2):
            try:
                proc = _pshell_get()
                out_lines = []; err_lines = []
                out_done = threading.Event(); err_done = threading.Event()
                rc_holder = [0]; lock = threading.Lock()

                def read_out():
                    try:
                        for line in proc.stdout:
                            if sentinel_out in line:
                                out_done.set(); break
                            with lock: out_lines.append(line)
                            write_fn("o", line)
                    except Exception: out_done.set()

                def read_err():
                    try:
                        for line in proc.stderr:
                            if sentinel_err in line:
                                err_done.set(); break
                            if sentinel_rc in line:
                                try: rc_holder[0] = int(line.strip()[len(sentinel_rc):])
                                except Exception: pass
                                continue
                            with lock: err_lines.append(line)
                            write_fn("e", line)
                    except Exception: err_done.set()

                t_out = threading.Thread(target=read_out, daemon=True)
                t_err = threading.Thread(target=read_err, daemon=True)
                t_out.start(); t_err.start()
                proc.stdin.write(script)
                proc.stdin.flush()

                if not out_done.wait(timeout) or not err_done.wait(5):
                    write_fn("e", "\n[Timed out after " + str(timeout) + "s]\n")
                    _pshell_invalidate()
                    try:
                        proc.stdin.close()
                        proc.stdout.close()
                        proc.stderr.close()
                    except Exception: pass
                    t_out.join(timeout=3)
                    t_err.join(timeout=3)
                    write_fn("e", "\n[Timed out]\n")
                    write_fn("d", "1")
                    return

                full = "".join(out_lines) + "".join(err_lines)
                if len(full) > MAX_OUTPUT:
                    full = full[:MAX_OUTPUT] + "\n[Truncated at " + str(MAX_OUTPUT) + "]"
                write_fn("d", str(rc_holder[0]))
                return

            except Exception as e:
                _pshell_invalidate()
                if attempt == 0: continue
                write_fn("e", "[Persistent shell error: " + str(e) + " — using fresh process]\n")
                break

    stream_cmd_fresh(write_fn, cmd, cwd=cwd, timeout=timeout)



def _translate_for_cmd(cmd):
    parts = cmd.strip().split(None, 1)
    if not parts: return cmd
    base, rest = parts[0], (parts[1] if len(parts) > 1 else "")
    m = {"ls": "dir", "cat": "type", "grep": "findstr", "which": "where",
         "pwd": "cd", "rm": "del", "mv": "move", "cp": "copy", "clear": "cls",
         "head": "more", "echo": "echo", "mkdir": "mkdir", "touch": "type nul > "}
    if base in m: return m[base] + " " + rest
    return cmd

def _detect_python_cmd():
    for cmd in ['python3', 'python']:
        if shutil.which(cmd):
            ver = ''
            try:
                r = subprocess.run([cmd, '--version'], capture_output=True, text=True, timeout=5)
                if r.returncode == 0:
                    ver = ' (' + r.stdout.strip().split('\n')[0] + ')'
            except Exception:
                pass
            return cmd + ver
    return sys.executable + ' (sys.executable fallback)'

PYTHON_CMD = _detect_python_cmd()

def _detect_python_env():
    try:
        result = subprocess.run(
            [sys.executable, "-c",
             "import sys; print(sys.prefix); print(sys.executable); "
             "import importlib.util; "
             "conda=importlib.util.find_spec('conda'); print('conda' if conda else 'none'); "
             "ve=hasattr(sys,'real_prefix') or (hasattr(sys,'base_prefix') and sys.base_prefix!=sys.prefix); print('venv' if ve else 'none')"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5
        )
        if result.returncode == 0:
            lines = result.stdout.strip().split("\n")
            return {"prefix": lines[0] if len(lines) > 0 else "",
                    "executable": lines[1] if len(lines) > 1 else "",
                    "type": lines[2] if len(lines) > 2 else "none",
                    "is_venv": lines[3] == "venv" if len(lines) > 3 else False}
    except Exception: pass
    return {"prefix": "", "executable": sys.executable, "type": "none", "is_venv": False}


def _detect_node():
    try:
        node_path = shutil.which("node")
        if not node_path: return None
        result = subprocess.run(
            [node_path, "-e", "console.log(process.execPath); console.log(process.version)"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5
        )
        if result.returncode == 0:
            lines = result.stdout.strip().split("\n")
            return {"path": lines[0] if len(lines) > 0 else "",
                    "version": lines[1] if len(lines) > 1 else ""}
    except Exception: pass
    return None


PYTHON_ENV = _detect_python_env()
NODE_ENV = _detect_node()



class TextExtractor(HTMLParser):
    SKIP = {'script', 'style', 'noscript', 'svg', 'math', 'head', 'meta', 'link', 'iframe'}
    BLOCK = {'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote',
             'pre', 'br', 'hr', 'dt', 'dd', 'figcaption', 'section', 'article',
             'header', 'footer', 'nav', 'aside', 'main', 'figure', 'details', 'summary'}
    NAV_TAGS = {'nav', 'header', 'footer'}
    SKIP_LINK = {'login', 'in', 'exit', 'register', 'subscribe',
                 'accept', 'reject', 'close', 'undo',
                 'read more', 'show more'}

    def __init__(self):
        super().__init__()
        self._skip = 0
        self._parts = []
        self._tag_stack = []
        self._in_nav = 0
        self._href_stack = []
        self._link_buf = []
        self._last_block = True
        self._blanks = 0

    def _in_link(self):
        return bool(self._href_stack) and self._href_stack[-1] is not None

    def _emit(self, t):
        if not t: return
        if t.strip() == '':
            self._blanks += 1
        else:
            self._blanks = 0
            self._parts.append(t)
            self._last_block = False
        if self._blanks <= 2 and t.strip() == '':
            self._parts.append('\n')

    def _emit_block(self, t='\n'):
        if not self._last_block:
            self._emit('\n')
        if t:
            self._emit(t)
            self._last_block = True

    def handle_starttag(self, tag, attrs):
        t = tag.lower()
        ad = dict(attrs)
        if t in self.SKIP:
            self._skip += 1
            return
        if self._skip:
            return
        self._tag_stack.append(t)
        if t in self.NAV_TAGS:
            self._in_nav += 1
            return
        if t == 'a':
            href = ad.get('href', '')
            if href and not href.startswith(('javascript:', '#', 'mailto:')):
                self._href_stack.append(href)
                self._link_buf = []
            else:
                self._href_stack.append(None)
                self._link_buf = []
            return
        if t in self.BLOCK:
            prefixes = {
                'h1': '# ', 'h2': '## ', 'h3': '### ',
                'h4': '#### ', 'h5': '##### ', 'h6': '###### ',
                'li': '- ', 'blockquote': '> ', 'summary': '> ',
                'hr': '\n---\n', 'br': '\n'
            }
            self._emit_block(prefixes.get(t, ''))

    def handle_endtag(self, tag):
        t = tag.lower()
        if t in self.SKIP:
            self._skip = max(0, self._skip - 1)
            return
        if self._skip:
            return
        if t == 'a' and self._href_stack:
            href = self._href_stack.pop()
            lt = ''.join(self._link_buf).strip()
            self._link_buf = []
            if href and lt and lt.lower() not in self.SKIP_LINK:
                np = '[NAV] ' if self._in_nav else ''
                self._emit(np + "[" + lt + "](" + href + ")")
                if not self._in_nav:
                    self._last_block = False
            return
        if self._tag_stack and self._tag_stack[-1] == t:
            self._tag_stack.pop()
        if t in self.NAV_TAGS and self._in_nav > 0:
            self._in_nav -= 1
            return
        if t in self.BLOCK:
            self._emit_block()

    def handle_data(self, data):
        if self._skip:
            return
        if self._in_link():
            self._link_buf.append(data)
        else:
            t = data
            if not self._last_block:
                t = t.replace('\n', ' ')
            self._emit(t)

    def handle_entityref(self, name):
        if self._skip:
            return
        import html.entities as he
        ch = he.html5.get('&' + name + ';', None)
        if ch is None:
            cp = he.name2codepoint.get(name)
            ch = chr(cp) if cp else '?'
        if self._in_link():
            self._link_buf.append(ch)
        else:
            self._emit(ch)

    def handle_charref(self, name):
        if self._skip:
            return
        try:
            ch = chr(int(name[1:], 16)) if name.startswith('x') else chr(int(name))
        except Exception:
            ch = '?'
        if self._in_link():
            self._link_buf.append(ch)
        else:
            self._emit(ch)

    def get_text(self):
        raw = ''.join(self._parts)
        lines = raw.split('\n')
        cl = [' '.join(l.split()) for l in lines]
        r = '\n'.join(cl).strip()
        while '\n\n\n' in r:
            r = r.replace('\n\n\n', '\n\n')
        return r


def html_to_text(html_str):
    ext = TextExtractor()
    ext.feed(html_str)
    return ext.get_text()


def fetch_url_content(url, mode="text", max_bytes=500000):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; SlopLobster-Agent/1.4)",
        "Accept": "text/html,text/plain,text/markdown,application/json,text/xml",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read(max_bytes)
        ct = (resp.headers.get("Content-Type", "") or "").split(";")[0].strip().lower()
        truncated = len(raw) >= max_bytes
        if ct not in ("text/html", "text/xhtml", "application/xhtml+xml"):
            text = raw.decode("utf-8", errors="replace")
            if truncated:
                text += "\n\n[Truncated at " + str(max_bytes) + " bytes]"
            return text
        html_s = raw.decode("utf-8", errors="replace")
        if mode == "raw":
            content = html_s
        else:
            content = html_to_text(html_s)
            # ── Detect JavaScript-rendered pages ──
            if len(content.strip()) < 200 and len(html_s) > 3000:
                domain = url.split("/")[2] if "/" in url else url
                content = (
                    "[This page is JavaScript-rendered — no extractable text in the HTML source. "
                    "The actual content is loaded by JS in a browser, which urllib cannot execute.]\n\n"
                    "[WORKAROUND: Use web_search with query \"site:" + domain + " <your topic>\" "
                    "and fetch_top=1-2. DuckDuckGo's crawler executes JS when indexing, so search "
                    "results will contain the actual page content.]\n\n"
                    "[Raw HTML: " + str(len(html_s)) + " bytes → Extracted text: " + str(len(content.strip())) + " chars]"
                )
        if truncated:
            content += "\n\n[Truncated at " + str(max_bytes) + " bytes]"
        return content


import html
def clean_html(s):
    return html.unescape(re.sub(r'<[^>]+>', '', s)).strip()


def search_ddg(query, num=8):
    import http.cookiejar
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    try:
        req = urllib.request.Request(
            "https://duckduckgo.com/?q=" + urllib.parse.quote(query),
            headers={"User-Agent": ua, "Accept": "text/html"},
        )
        with opener.open(req, timeout=10) as resp:
            page = resp.read(300000).decode("utf-8", errors="replace")
        vqd = None
        for m in re.finditer("vqd", page, re.IGNORECASE):
            start = m.end()
            eq = page.find("=", start)
            if eq < 0 or eq > start + 10:
                continue
            rest = page[eq + 1:].lstrip()
            if not rest or rest[0] not in ("'", '"'):
                continue
            q = rest[0]
            end = rest.find(q, 1)
            if end < 0:
                continue
            vqd = rest[1:end]
            break
        if not vqd:
            return [{"error": "Could not get DDG vqd token."}]
    except Exception as e:
        return [{"error": "Failed to get vqd: " + str(e)}]
    params = urllib.parse.urlencode({"q": query, "vqd": vqd})
    req = urllib.request.Request(
        "https://html.duckduckgo.com/html/?" + params,
        headers={
            "User-Agent": ua,
            "Accept": "text/html,application/xhtml+xml",
            "Referer": "https://duckduckgo.com/",
        },
    )
    try:
        with opener.open(req, timeout=15) as resp:
            page_html = resp.read(500000).decode("utf-8", errors="replace")
    except Exception as e:
        return [{"error": "Search request failed: " + str(e)}]
    if "result__a" not in page_html:
        return [{"error": "DDG returned no results (possibly blocked or CAPTCHA)."}]
    results = []
    link_tags = re.findall(
        r'<a\s[^>]*class=["\']result__a["\'][^>]*>',
        page_html, re.IGNORECASE,
    )
    for tag in link_tags[:num * 2]:
        href_m = re.search(r'href=["\']([^"\']+)["\']', tag)
        if not href_m:
            continue
        raw_url = href_m.group(1)
        actual = raw_url
        m = re.search(r'[?&]uddg=([^&]+)', raw_url)
        if m:
            actual = urllib.parse.unquote(m.group(1))
        elif raw_url.startswith("/"):
            actual = "https://html.duckduckgo.com" + raw_url
        tag_pos = page_html.find(tag)
        if tag_pos == -1:
            continue
        close_pos = page_html.find("</a>", tag_pos + len(tag))
        if close_pos == -1:
            continue
        title = clean_html(page_html[tag_pos + len(tag):close_pos])
        if not title or not actual or not actual.startswith("http"):
            continue
        if "duckduckgo.com" in actual and "uddg=" not in raw_url:
            continue
        if len(title) < 2:
            continue
        results.append({"title": title, "url": actual, "snippet": ""})
        if len(results) >= num:
            break
    snippets = re.findall(
        r'<a[^>]*class=["\']result__snippet["\'][^>]*>(.*?)</a>',
        page_html, re.DOTALL | re.IGNORECASE,
    )
    for i, s in enumerate(snippets):
        if i < len(results):
            results[i]["snippet"] = clean_html(s)
    if not results:
        return [{"error": "No results parsed from HTML."}]
    return results

def _translate_for_cmd_bash(cmd):
    """Translate Windows command syntax to bash equivalents for Git Bash on Windows."""
    import re
    parts = cmd.strip().split(None, 1)
    if not parts: return cmd
    base = parts[0].lower()
    rest = parts[1] if len(parts) > 1 else ""

    cmd_map = {"dir": "ls", "type": "cat", "findstr": "grep", "del": "rm",
               "move": "mv", "copy": "cp", "cls": "clear", "where": "which",
               "rmdir": "rmdir", "ren": "mv", "erase": "rm",
               "xcopy": "cp -r", "robocopy": "cp -r"}
    if base in cmd_map:
        base = cmd_map[base]

    # Convert Windows /flags to Unix -flags: /s → -s, /b → -b, /a → -a
    new_rest = re.sub(r'(?:^|\s+)/([a-zA-Z])', r' -\1', rest).lstrip()

    return base + " " + new_rest

def stream_cmd_fresh(write_fn, cmd, cwd=None, timeout=DEFAULT_TIMEOUT, cancel_event=None):
    stripped = cmd.strip()
    first_word = stripped.split(None, 1)[0] if stripped else ''

    if first_word in ('python', 'python3'):
        if not shutil.which(first_word):
            alt = 'python3' if first_word == 'python' else 'python'
            if shutil.which(alt):
                cmd = alt + stripped[len(first_word):]

    if WINDOWS_BASH:
        translated = _translate_for_cmd_bash(cmd)
        kw = dict(args=[WINDOWS_BASH, "-c", translated], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", cwd=cwd)
    elif platform.system() == "Windows":
        translated = _translate_for_cmd(cmd)
        kw = dict(shell=True, args=translated, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", cwd=cwd)
    else:
        kw = dict(shell=True, args=cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", cwd=cwd, start_new_session=True)

    # Binary read1 drains available output without waiting for a newline or accumulating huge lines.
    kw.pop('text', None); kw.pop('encoding', None); kw.pop('errors', None)
    proc = subprocess.Popen(**kw)
    out_buf = []; err_buf = []; lock = threading.Lock()

    def reader(stream, buf, kind):
        try:
            decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
            size = 0
            truncated = False
            while True:
                chunk = stream.read1(65536 if truncated else 4096)
                if truncated:
                    if not chunk: break
                    # Drain excess output with backpressure instead of decoding,
                    # recording and transmitting every byte in a hot loop.
                    time.sleep(.005)
                    continue
                line = decoder.decode(chunk, final=not chunk)
                with lock:
                    kept = line[:MAX_OUTPUT-size]
                    if kept:
                        buf.append(kept); size += len(kept)
                        write_fn(kind, kept)
                    if len(line)>len(kept):
                        truncated = True
                        write_fn(kind, '\n[Output truncated]\n')
                if not chunk: break
            stream.close()
        except Exception:
            pass

    t1 = threading.Thread(target=reader, args=(proc.stdout, out_buf, 'o'))
    t2 = threading.Thread(target=reader, args=(proc.stderr, err_buf, 'e'))
    t1.daemon = True; t2.daemon = True; t1.start(); t2.start()

    start = time.monotonic()
    timed_out = False
    while proc.poll() is None or t1.is_alive() or t2.is_alive():
        if (cancel_event and cancel_event.is_set()) or time.monotonic() - start > timeout:
            timed_out = not (cancel_event and cancel_event.is_set())
            kill_tree(proc.pid)
            with lock:
                write_fn('e', f"\n[Timed out after {timeout}s]\n" if timed_out else "\n[Cancelled by user]\n")
            break
        time.sleep(0.03)

    # Wait for threads to finish reading the closed pipes
    t1.join(timeout=2)
    t2.join(timeout=2)

    # Fixed: Catch TimeoutExpired if the process is a zombie and won't die
    returncode = -1
    try:
        proc.wait(timeout=3)
        returncode = proc.returncode
    except subprocess.TimeoutExpired:
        kill_tree(proc.pid)
        proc.kill()
        proc.wait(timeout=3)
        returncode = proc.returncode
    if timed_out: returncode = -1

    with lock:
        full = ''.join(out_buf) + ''.join(err_buf)
        if "0x80072747" in full or "0x800705aa" in full or "lacked sufficient buffer space" in full:
            time.sleep(1.0)
            if WINDOWS_BASH:
                _pshell_invalidate()
        if len(full) > MAX_OUTPUT:
            # Fixed: use \n for actual newlines instead of literal \n text
            full = full[:MAX_OUTPUT] + f"\n[Truncated at {MAX_OUTPUT}]"
        write_fn('d', str(int(returncode)))

    return full, returncode

def stream_cmd(write_fn, cmd, cwd=None, timeout=DEFAULT_TIMEOUT):
    # Use the bounded runner for legacy clients too; persistent-shell output
    # was unbounded and retries could replay a partially executed command.
    return stream_cmd_fresh(write_fn, cmd, cwd=cwd, timeout=timeout)

def extract_python_signatures(source, max_lines=300):
    import ast as _ast
    lines = source.split('\n')
    if len(lines) <= max_lines:
        return None
    try:
        tree = _ast.parse(source)
    except SyntaxError:
        return None

    BODY_PREVIEW = 3
    result = []

    # ── Imports section ──
    for node in _ast.iter_child_nodes(tree):
        if isinstance(node, _ast.Import):
            result.append('L%d: import %s' % (node.lineno, ', '.join(a.name for a in node.names)))
        elif isinstance(node, _ast.ImportFrom):
            result.append('L%d: from %s import %s' % (node.lineno, node.module or '.', ', '.join(a.name for a in node.names)))

    # ── Extract docstrings as text ──
    def get_docstring(node):
        ds = _ast.get_docstring(node)
        if not ds:
            return None
        # Return first 2 lines of docstring
        ds_lines = ds.strip().split('\n')[:2]
        return '  ' + '\n  '.join(ds_lines)

    # ── Top-level functions and classes ──
    for node in _ast.iter_child_nodes(tree):
        if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
            prefix = 'async ' if isinstance(node, _ast.AsyncFunctionDef) else ''
            ret = ' -> ' + _ast.unparse(node.returns) if node.returns else ''
            args = [a.arg for a in node.args.args if a.arg not in ('self', 'cls')]
            result.append('L%d: %sdef %s(%s)%s' % (node.lineno, prefix, node.name, ', '.join(args), ret))

            # Docstring
            ds = get_docstring(node)
            if ds:
                result.append(ds)

            # Body preview: first N non-trivial lines
            if hasattr(node, 'body') and len(node.body) > 1:
                preview_count = 0
                for stmt in node.body[1:]:  # skip docstring
                    if preview_count >= BODY_PREVIEW:
                        break
                    src = _ast.get_source_segment(source, stmt)
                    if src:
                        for sl in src.strip().split('\n')[:BODY_PREVIEW - preview_count]:
                            if sl.strip() and not sl.strip().startswith('#'):
                                result.append('L%d: %s' % (stmt.lineno, sl))
                                preview_count += 1
                            if preview_count >= BODY_PREVIEW:
                                break
            result.append('L%d:   ...' % (node.end_lineno or node.lineno))

        elif isinstance(node, _ast.ClassDef):
            bases = [_ast.unparse(b) for b in node.bases]
            result.append('L%d: class %s(%s)' % (node.lineno, node.name, ', '.join(bases)))

            # Class docstring
            ds = get_docstring(node)
            if ds:
                result.append(ds)

            # Class attributes and methods
            for item in node.body:
                if isinstance(item, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
                    p = 'async ' if isinstance(item, _ast.AsyncFunctionDef) else ''
                    a = [x.arg for x in item.args.args if x.arg not in ('self', 'cls')]
                    ret_s = ' -> ' + _ast.unparse(item.returns) if item.returns else ''
                    result.append('L%d:   %sdef %s(%s)%s' % (item.lineno, p, item.name, ', '.join(a), ret_s))
                elif isinstance(item, _ast.Assign):
                    for t in item.targets:
                        if isinstance(t, _ast.Name):
                            val_preview = _ast.unparse(item.value)[:40] if hasattr(_ast, 'unparse') else '...'
                            result.append('L%d:   %s = %s' % (item.lineno, t.id, val_preview))
            result.append('L%d:   ...' % (node.end_lineno or node.lineno))

    return '\n'.join(result) if result else None


def extract_js_signatures(source, max_lines=300):
    import re
    lines = source.split('\n')
    if len(lines) <= max_lines:
        return None
    result = []
    for i, line in enumerate(lines):
        l = line.strip()
        if not l or l.startswith('//') or l.startswith('*') or l.startswith('"""') or l.startswith("'''"):
            continue
        m = re.match(r'^(s*)(exports+(defaults+)?)?(asyncs+)?functions+(*?s*w+)s*(([^)]*))', line)
        if m:
            prefix = '%s%s%s' % (m.group(1) or '', m.group(2) or '', m.group(4) or '')
            result.append('L%d: %sfunction %s(%s)' % (i+1, prefix, m.group(5).strip(), m.group(6).strip()[:80]))
            continue
        m = re.match(r'^(s*)(exports+(defaults+)?)?(const|let|var)s+(w+)s*=s*(([^)]*)|[^=]+?)s*=>', line)
        if m:
            prefix = '%s%s' % (m.group(1) or '', m.group(2) or '')
            result.append('L%d: %s%s %s = %s => ...' % (i+1, prefix, m.group(5), m.group(6), m.group(7).strip()[:60]))
            continue
        m = re.match(r'^(s*)(exports+(defaults+)?)?classs+(w+)', line)
        if m:
            prefix = '%s%s' % (m.group(1) or '', m.group(2) or '')
            result.append('L%d: %sclass %s' % (i+1, prefix, m.group(5)))
            continue
        m = re.match(r'^(s+)(asyncs+)?(w+)s*(([^)]*))s*{', line)
        if m and len(m.group(1)) >= 2:
            prefix = '%s%s' % (m.group(1), m.group(2) or '')
            result.append('L%d: %s%s(%s)' % (i+1, prefix, m.group(3), m.group(4).strip()[:80]))
            continue
        if re.match(r'^(import|export)s', l):
            result.append('L%d: %s' % (i+1, l[:100]))
    return '\n'.join(result) if result else None


def extract_generic_signatures(source, max_lines=300):
    lines = source.split('\n')
    if len(lines) <= max_lines:
        return None
    result = []
    for i, line in enumerate(lines):
        l = line.strip()
        if not l or l.startswith('#') or l.startswith('//'):
            continue
        if re.match(r'^(function|class|def|pubs+fn|fns|module|impl|trait|struct|enum|interface|type)s', l):
            result.append('L%d: %s' % (i+1, l[:120]))
    return '\n'.join(result) if result else None

def _close_browser():
    global _pw, _pw_browser, _pw_page, _pw_console, _pw_launch_time
    if _pw_page is not None:
        try:
            if not _pw_page.is_closed():
                _pw_page.close()
        except Exception:
            pass
    if _pw_browser is not None:
        try:
            if _pw_browser.is_connected():
                _pw_browser.close()
        except Exception:
            pass
    _pw_page = None
    _pw_browser = None
    _pw_console = deque(maxlen=1000)
    _pw_launch_time = None

def _browser_error_hint():
    if not HAS_PLAYWRIGHT:
        return "Playwright not installed. Run: pip install playwright && playwright install chromium"
    try:
        from playwright._impl._driver import compute_driver_executable
        compute_driver_executable()
        return "Playwright installed but browser binary missing. Run: playwright install chromium"
    except Exception:
        return "Playwright import works but browser launch failed. Check: playwright install chromium"

def _ensure_page():
    global _pw, _pw_browser, _pw_page, _pw_console, _pw_launch_time
    if not HAS_PLAYWRIGHT:
        raise Exception("Playwright not installed. Install with: pip install playwright && playwright install chromium")
    try:
        if _pw_page is not None and _pw_page.is_closed():
            _close_browser()
    except Exception: pass
    try:
        if _pw_browser is not None and _pw_browser.is_connected():
            return _pw_page
    except Exception: pass
    if _pw is None:
        _pw = sync_playwright().start()
    _pw_browser = _pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-gpu"])
    _pw_page = _pw_browser.new_page(viewport={"width": 1280, "height": 720})
    _pw_console = deque(maxlen=1000)
    def _on_console(msg):
        _pw_console.append({"type": msg.type, "text": msg.text[:4000], "time": time.time()})
    def _on_pageerror(err):
        _pw_console.append({"type": "error", "text": str(err)[:4000], "time": time.time()})
    _pw_page.on("console", _on_console)
    _pw_page.on("pageerror", _on_pageerror)
    _pw_launch_time = time.time()
    return _pw_page

def _get_console_filtered(types=None, since=None, limit=100):
    msgs = list(_pw_console)
    if types:
        types_set = set(types)
        msgs = [m for m in msgs if m["type"] in types_set]
    if since:
        msgs = [m for m in msgs if m["time"] > since]
    return msgs[-limit:]

_dev_processes = {}
_dev_lock = threading.RLock()

def _start_dev_process(cmd, port, cwd):
    port_s = str(port)
    if port_s in _dev_processes:
        try:
            p = _dev_processes[port_s]
            if p['alive'][0]:
                kill_tree(p['proc'].pid)
        except Exception: pass
    stripped = cmd.strip()
    first_word = stripped.split(None, 1)[0] if stripped else ''
    if first_word in ('python', 'python3'):
        if not shutil.which(first_word):
            alt = 'python3' if first_word == 'python' else 'python'
            if shutil.which(alt):
                cmd = alt + stripped[len(first_word):]
    if WINDOWS_BASH:
        translated = _translate_for_cmd_bash(cmd)
        kw = dict(args=[WINDOWS_BASH, "-c", translated], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", cwd=cwd or os.getcwd())
    elif platform.system() == "Windows":
        kw = dict(shell=True, args=cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", cwd=cwd or os.getcwd())
    else:
        kw = dict(shell=True, args=cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", cwd=cwd or os.getcwd(), start_new_session=True)
    kw['env'] = {**os.environ, 'PORT': str(port)}
    kw.pop('text', None); kw.pop('encoding', None); kw.pop('errors', None)
    proc = subprocess.Popen(**kw)
    buf = []
    lock = threading.Lock()
    alive = [True]
    def reader(stream, kind):
        try:
            decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
            while True:
                chunk = stream.read1(16384)
                line = decoder.decode(chunk, final=not chunk)
                if line:
                    with lock:
                        buf.append(kind + line)
                        while len(buf)>2000 or sum(map(len,buf))>MAX_OUTPUT:
                            del buf[0]
                    time.sleep(.005)
                if not chunk: break
        except Exception: pass
        finally:
            stream.close()
    for s in (proc.stdout, proc.stderr):
        t = threading.Thread(target=reader, args=(s, 'o' if s is proc.stdout else 'e'), daemon=True)
        t.start()
    def monitor():
        try: proc.wait()
        except Exception: pass
        alive[0] = False
    threading.Thread(target=monitor, daemon=True).start()
    _dev_processes[port_s] = {'proc': proc, 'buf': buf, 'lock': lock, 'alive': alive, 'cmd': cmd, 'cwd': cwd or os.getcwd(), 'pid': proc.pid, 'start': time.time()}
    return {'ok': True, 'port': port, 'pid': proc.pid}

def _check_dev_ready(port, timeout=3):
    import socket
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except (OSError, socket.timeout):
        return False

_mcp_servers = {}
_mcp_lock = threading.Lock()

def _mcp_reader_loop(proc, q):
    # One persistent reader per server process, for its whole lifetime.
    # Previously a fresh thread was spawned per call and abandoned on
    # timeout; a late response would then be silently eaten by that zombie
    # thread, and the next call's own fresh reader thread would race it for
    # the following line on the same pipe -- losing or cross-matching
    # responses. A single long-lived reader avoids that race entirely.
    try:
        for l in iter(lambda: proc.stdout.readline(1000001), ''):
            if len(l)>1000000:
                kill_tree(proc.pid)
                break
            l = l.strip()
            if l and (l.startswith('{') or l.startswith('[')):
                try:
                    message = json.loads(l)
                    if isinstance(message,dict) and 'id' in message:
                        try: q.put_nowait(message)
                        except queue.Full:
                            q.get_nowait(); q.put_nowait(message)
                except Exception:
                    pass
    except Exception:
        pass
    finally:
        try: q.put_nowait(None)  # sentinel: stdout closed / process ended
        except queue.Full:
            q.get_nowait(); q.put_nowait(None)

def _mcp_write(proc, request, timeout):
    done = threading.Event()
    errors = []
    def write():
        try:
            proc.stdin.write(json.dumps(request) + '\n')
            proc.stdin.flush()
        except Exception as exc: errors.append(exc)
        finally: done.set()
    threading.Thread(target=write, daemon=True).start()
    if not done.wait(timeout):
        kill_tree(proc.pid)
        raise TimeoutError('MCP server stopped reading input; process tree stopped')
    if errors:
        kill_tree(proc.pid)
        raise errors[0]


def _mcp_send_and_recv(proc, resp_queue, req_obj, timeout=30):
    deadline = time.monotonic() + timeout
    _mcp_write(proc, req_obj, timeout)
    req_id = req_obj.get("id")
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            kill_tree(proc.pid)
            raise TimeoutError("MCP server response timed out after " + str(timeout) + "s; process tree stopped")
        try:
            msg = resp_queue.get(timeout=min(remaining, 1.0))
        except queue.Empty:
            if proc.poll() is not None:
                raise RuntimeError("MCP server process exited unexpectedly")
            continue
        if msg is None:
            kill_tree(proc.pid)
            raise RuntimeError("MCP server closed its output stream")
        # Discard notifications and any stale response left over from a
        # previous call that timed out client-side but answered late --
        # match on id so it can never be mistaken for the current call's
        # response.
        if isinstance(msg, dict) and msg.get("id") == req_id:
            return msg

def _mcp_init_server(name, config):
    with _mcp_lock:
        if name in _mcp_servers:
            old = _mcp_servers[name]
            if old.get('config') == config and old.get('proc') and old['proc'].poll() is None:
                return {'status':'connected','tools':old['tools'],'tool_count':len(old['tools'])}
            if old.get("proc") and old["proc"].poll() is None:
                try: kill_tree(old["proc"].pid)
                except Exception: pass
            del _mcp_servers[name]

        cmd_base = config.get("command", "python3")
        if cmd_base in ("python", "python3"):
            cmd_base = sys.executable
        elif not shutil.which(cmd_base):
            if shutil.which("python"): cmd_base = shutil.which("python")

        args = [cmd_base] + config.get("args", [])
        cwd = config.get("cwd") or None
        env = os.environ.copy()
        if "env" in config and isinstance(config["env"], dict):
            env.update(config["env"])

        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if platform.system() == "Windows" else 0
        proc = subprocess.Popen(
            args,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
            start_new_session=platform.system() != 'Windows'
        )

        resp_queue = queue.Queue(maxsize=256)
        def drain_stderr():
            try:
                stream = getattr(proc.stderr, 'buffer', proc.stderr)
                while stream.read1(16384): pass
            except Exception: pass
        threading.Thread(target=drain_stderr, daemon=True).start()
        reader_thread = threading.Thread(target=_mcp_reader_loop, args=(proc, resp_queue), daemon=True)
        reader_thread.start()

        try:
            # 1. initialize
            init_req = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "SlopLobster", "version": BUILD_VERSION}
                }
            }
            init_res = _mcp_send_and_recv(proc, resp_queue, init_req, timeout=15)
            if "error" in init_res:
                kill_tree(proc.pid)
                raise RuntimeError("MCP initialization failed: " + str(init_res["error"]))

            # 2. initialized notification
            _mcp_write(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"}, 15)

            # 3. tools/list
            list_req = {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            }
            list_res = _mcp_send_and_recv(proc, resp_queue, list_req, timeout=15)
            tools = list_res.get("result", {}).get("tools", [])

            _mcp_servers[name] = {
                "proc": proc,
                "tools": tools,
                "config": config,
                "id_counter": 3,
                "lock": threading.Lock(),
                "resp_queue": resp_queue,
                "reader_thread": reader_thread,
            }
            return {"status": "connected", "tools": tools, "tool_count": len(tools)}
        except Exception:
            kill_tree(proc.pid)
            try: proc.wait(timeout=3)
            except subprocess.TimeoutExpired: pass
            raise

def _mcp_call_tool(server_name, tool_name, arguments, timeout=120):
    srv = _mcp_servers.get(server_name)
    if not srv or not srv.get("proc") or srv["proc"].poll() is not None:
        raise RuntimeError("MCP server '" + str(server_name) + "' is not running")
    with srv["lock"]:
        req_id = srv["id_counter"]
        srv["id_counter"] += 1
        call_req = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments or {}
            }
        }
        res = _mcp_send_and_recv(srv["proc"], srv["resp_queue"], call_req, timeout=timeout)
        if "error" in res:
            err_msg = res["error"].get("message", str(res["error"])) if isinstance(res["error"], dict) else str(res["error"])
            return {"error": err_msg}
        content = res.get("result", {}).get("content", [])
        text_out = []
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                text_out.append(c.get("text", ""))
            elif isinstance(c, str):
                text_out.append(c)
        out_str = "\n".join(text_out) if text_out else json.dumps(res.get("result", {}), indent=2)
        return {"output": out_str, "isError": res.get("result", {}).get("isError", False)}


# BEGIN GENERATED FEATURES
# Generated into the standalone companion by scripts/build.mjs.
import pathlib, tempfile, hashlib, base64, fnmatch, difflib
_managed_tasks = {}
_task_lock = threading.RLock()

def _git(root, *args, check=True):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True,
                            encoding='utf-8', errors='replace', timeout=60)
    if check and result.returncode:
        raise ValueError(result.stderr.strip() or result.stdout.strip() or 'Git operation failed')
    # NUL-delimited Git paths can contain leading/trailing whitespace.
    return result.stdout if '-z' in args else result.stdout.rstrip('\r\n')

def _project_root(value):
    path = pathlib.Path(value).expanduser().resolve(strict=True)
    if not path.is_dir(): raise ValueError('Project path must be a directory')
    root = pathlib.Path(_git(path, 'rev-parse', '--show-toplevel')).resolve()
    if path != root: raise ValueError('Use the Git repository root path')
    return root

def _task_manifest(root):
    directory = root / '.sloplobster'
    if directory.is_symlink() or directory.resolve()!=directory: raise ValueError('Task storage cannot be a symlink or junction')
    directory.mkdir(exist_ok=True)
    return directory / 'tasks.json'

def _save_tasks(root):
    file = _task_manifest(root)
    records = [r for r in _managed_tasks.values() if r.get('root') == str(root) and r.get('kind') == 'worktree']
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=file.parent, delete=False) as tmp:
        json.dump(records, tmp); temporary = tmp.name
    os.replace(temporary, file)

def _load_tasks(root):
    file = _task_manifest(root)
    if file.is_symlink(): raise ValueError('Task manifest cannot be a symlink')
    if not file.exists(): return
    records = json.loads(file.read_text(encoding='utf-8'))
    for record in records:
        tid = record.get('id','')
        if not re.fullmatch(r'[a-f0-9]{32}', tid): continue
        expected = root / '.sloplobster' / 'worktrees' / tid
        if record.get('path') != str(expected) or record.get('branch') != 'slop/' + tid: continue
        record['root'] = str(root)
        _managed_tasks.setdefault(tid, record)

def managed_task(tid):
    with _task_lock:
        record = _managed_tasks.get(tid)
        if not record: raise ValueError('Unknown task; list tasks for its project to restore the registry')
        if record['status'] == 'discarded': raise ValueError('Task was discarded')
        path = pathlib.Path(record['path'])
        if path.is_symlink(): raise ValueError('Managed task path became a symlink')
        if record['kind'] == 'worktree':
            expected = pathlib.Path(record['root']) / '.sloplobster' / 'worktrees' / record['id']
            if path.resolve() != expected: raise ValueError('Task path no longer matches its registry')
        return record

def _managed_path(record, relative='', allow_root=False):
    if not isinstance(relative,str) or '\\' in relative or re.match(r'^[A-Za-z]:',relative):
        raise ValueError('Expected a relative task path')
    parts = pathlib.PurePosixPath(relative).parts
    if relative.startswith('/') or '..' in parts or (not parts and not allow_root):
        raise ValueError('Unsafe task path')
    root = pathlib.Path(record['path']).resolve()
    path = root.joinpath(*parts)
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink(): raise ValueError('Task file operations do not follow symlinks')
    resolved = path.resolve()
    if resolved != root and root not in resolved.parents: raise ValueError('Path escapes task workspace')
    if any(part == '.git' for part in parts): raise ValueError('Git metadata is not a task file')
    return path

def _file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None

def _task_file(body):
    record = managed_task(body.get('taskId'))
    path = _managed_path(record, body.get('path',''), allow_root=True)
    action = body.get('action','stat')
    if action in ('stat','read'):
        if not path.exists(): raise FileNotFoundError(str(body.get('path')))
        if path.is_dir(): return dict(kind='directory',name=path.name)
        if path.stat().st_size > 1500000: raise ValueError('Managed file exceeds 1.5 MB read limit')
        data = path.read_bytes()
        result = dict(kind='file',name=path.name,size=len(data),hash=hashlib.sha256(data).hexdigest())
        if action == 'read': result['base64'] = base64.b64encode(data).decode('ascii')
        return result
    if action == 'list':
        if not path.is_dir(): raise NotADirectoryError(str(path))
        return {'entries':[{'name':p.name,'kind':'directory' if p.is_dir() else 'file'}
                           for p in sorted(path.iterdir()) if p.name not in ('.git','.sloplobster') and not p.is_symlink()]}
    if path == pathlib.Path(record['path']).resolve(): raise ValueError('Cannot mutate task root')
    if record.get('status') == 'merged': raise ValueError('Merged task is read-only; create a new task')
    if action == 'mkdir':
        path.mkdir(parents=True, exist_ok=True); return {'ok':True}
    if action == 'write':
        data = base64.b64decode(body.get('base64',''), validate=True)
        if len(data)>1500000: raise ValueError('Managed file exceeds 1.5 MB write limit')
        if 'expectedHash' not in body or _file_hash(path) != body['expectedHash']:
            raise ValueError('File changed since it was read; refresh before writing')
        path.parent.mkdir(parents=True,exist_ok=True)
        with tempfile.NamedTemporaryFile('wb', dir=path.parent, delete=False) as tmp:
            tmp.write(data); temporary=tmp.name
        os.replace(temporary,path)
        return {'ok':True,'hash':_file_hash(path)}
    if action == 'delete':
        if path.is_dir():
            if body.get('recursive'): shutil.rmtree(path)
            else: path.rmdir()
        else: path.unlink()
        return {'ok':True}
    raise ValueError('Unknown file operation')

def _new_port():
    import socket
    reserved={r.get('port') for r in _managed_tasks.values()}
    for port in range(4000,5000):
        if port in reserved: continue
        try:
            with socket.socket() as sock: sock.bind(('127.0.0.1',port))
            return port
        except OSError: continue
    raise ValueError('No preview ports available')

def _create_worktree(body):
    root=_project_root(body.get('root',''))
    with _task_lock:
        _load_tasks(root)
        tid=secrets.token_hex(16)
        parent=root/'.sloplobster'/'worktrees'
        if parent.is_symlink(): raise ValueError('Worktree storage cannot be a symlink')
        parent.mkdir(parents=True,exist_ok=True)
        # Ignore only harness artifacts; preserve the user's existing exclude rules.
        exclude=pathlib.Path(_git(root,'rev-parse','--git-path','info/exclude'))
        if not exclude.is_absolute(): exclude=root/exclude
        existing=exclude.read_text(encoding='utf-8') if exclude.exists() else ''
        if '\n.sloplobster/\n' not in '\n'+existing:
            exclude.parent.mkdir(parents=True,exist_ok=True)
            with exclude.open('a',encoding='utf-8') as file: file.write('\n.sloplobster/\n')
        path=parent/tid; branch='slop/'+tid
        base=_git(root,'rev-parse','HEAD')
        _git(root,'worktree','add','-b',branch,str(path),base)
        record=dict(id=tid,kind='worktree',root=str(root),path=str(path),branch=branch,base=base,
                    title=str(body.get('title','Task'))[:200],status='active',port=_new_port(),created=time.time())
        _managed_tasks[tid]=record; _save_tasks(root)
        return record

def _task_diff(record):
    path=record['path']
    diff=_git(path,'diff',record['base'],'--','.',' :! .sloplobster'.replace(' ',''))
    untracked=_git(path,'ls-files','--others','--exclude-standard','-z')
    for name in untracked.split('\0'):
        if not name: continue
        file=_managed_path(record,name)
        if file.is_file():
            if file.stat().st_size>1500000: raise ValueError('Untracked file exceeds the review limit: '+name)
            text=file.read_text(encoding='utf-8',errors='replace').splitlines(True)
            diff+='\n'+''.join(difflib.unified_diff([],text,fromfile='/dev/null',tofile=name))
    if len(diff)>200000: raise ValueError('Diff exceeds the review limit; split the task before merging')
    return diff

def _task_changed_files(record):
    names=_git(record['path'],'diff','--name-only','-z',record['base'],'--','.',':!.sloplobster').split('\0')
    names+=_git(record['path'],'ls-files','--others','--exclude-standard','-z').split('\0')
    return sorted(set(name for name in names if name))

def _task_review_hash(record, diff):
    digest=hashlib.sha256(diff.encode())
    digest.update(_git(record['path'],'rev-parse','HEAD').encode())
    for name in _task_changed_files(record):
        path=_managed_path(record,name)
        digest.update(name.encode())
        digest.update((_file_hash(path) or 'deleted').encode())
    return digest.hexdigest()

def _merge_task(body):
    record=managed_task(body.get('taskId'))
    if record['kind']!='worktree': raise ValueError('Only Git worktree tasks can be merged')
    root=pathlib.Path(record['root'])
    if _git(record['path'],'symbolic-ref','--short','HEAD')!=record['branch']: raise ValueError('Task branch changed; restore its generated branch before merging')
    if record['status']!='active': raise ValueError('Task is no longer active')
    if _git(root,'status','--porcelain'): raise ValueError('Original workspace has uncommitted changes; commit or stash them before merging')
    expected=body.get('reviewHash')
    diff=_task_diff(record)
    if not expected or _task_review_hash(record,diff)!=expected: raise ValueError('Changes differ from the reviewed diff; review again')
    if _git(record['path'],'status','--porcelain'):
        _git(record['path'],'add','-A','--','.',' :! .sloplobster'.replace(' ',''))
        if _git(record['path'],'diff','--cached','--name-only'):
            _git(record['path'],'commit','-m',str(body.get('message') or 'SlopLobster: '+record['title'])[:300])
    result=subprocess.run(['git','-C',str(root),'merge','--no-ff','--no-edit',record['branch']],
                          capture_output=True,encoding='utf-8',errors='replace',timeout=60)
    if result.returncode: return {'ok':False,'status':'conflict','output':result.stdout+'\n'+result.stderr}
    record['status']='merged'; _save_tasks(root)
    return {'ok':True,'output':result.stdout,'task':record}

def _discard_task(body):
    record=managed_task(body.get('taskId'))
    if body.get('confirm') is not True: raise ValueError('Discard requires explicit confirmation')
    if any(job.get('taskId')==record['id'] and job['status'] in ('running','cancelling') for job in _commands.values()):
        raise ValueError('Cancel running task commands before discarding')
    dev=_dev_processes.get(str(record.get('port')))
    if dev and dev['proc'].poll() is None: kill_tree(dev['proc'].pid)
    if record['kind']=='worktree':
        expected=pathlib.Path(record['root'])/'.sloplobster'/'worktrees'/record['id']
        actual=pathlib.Path(record['path']).resolve()
        if actual != expected or actual.is_symlink(): raise ValueError('Unsafe discard target')
        _git(record['root'],'worktree','remove','--force',str(actual))
        _git(record['root'],'branch','-D',record['branch'],check=False)
        record['status']='discarded'; _save_tasks(pathlib.Path(record['root']))
    else:
        record['_temporary'].cleanup(); record['status']='discarded'
    return {'ok':True}

def _evaluation_create(body):
    files=body.get('files',{})
    if not isinstance(files,dict) or len(files)>100: raise ValueError('Evaluation needs at most 100 fixture files')
    temporary=tempfile.TemporaryDirectory(prefix='sloplobster-eval-')
    tid=secrets.token_hex(16)
    record=dict(id=tid,kind='evaluation',path=temporary.name,status='active',port=None,
                allowedWrites=body.get('allowedWrites',[]),checks=body.get('checks',[]),_temporary=temporary,baseline={})
    _managed_tasks[tid]=record
    try:
        for name, content in files.items():
            path=_managed_path(record,name)
            if not isinstance(content,str): raise ValueError('Fixture file content must be text')
            path.parent.mkdir(parents=True,exist_ok=True); path.write_text(content,encoding='utf-8')
            record['baseline'][name]=_file_hash(path)
    except Exception:
        temporary.cleanup(); del _managed_tasks[tid]; raise
    return {'id':tid,'kind':'evaluation'}

def _evaluation_result(body):
    record=managed_task(body.get('taskId'))
    if record['kind']!='evaluation': raise ValueError('Not an evaluation workspace')
    files={}
    for path in pathlib.Path(record['path']).rglob('*'):
        if path.is_file() and not path.is_symlink():
            name=path.relative_to(record['path']).as_posix()
            files[name]=_file_hash(path)
    changed=[name for name in set(files)|set(record['baseline']) if files.get(name)!=record['baseline'].get(name)]
    unintended=[name for name in changed if not any(fnmatch.fnmatchcase(name,pattern) for pattern in record['allowedWrites'])]
    assertions=[]
    for assertion in body.get('assertions',[]):
        path=_managed_path(record,assertion.get('path',''))
        text=path.read_text(encoding='utf-8') if path.is_file() else ''
        passed=path.is_file() and ('equals' not in assertion or text==assertion['equals']) and ('contains' not in assertion or assertion['contains'] in text)
        assertions.append({'path':assertion['path'],'passed':passed})
    return {'changedFiles':changed,'unintendedWrites':unintended,'assertions':assertions,
            'passed':bool(assertions) and all(a['passed'] for a in assertions) and not unintended}

def _commit_task(record, message):
    path=record['path']
    _git(path,'add','-A','--','.',':!.sloplobster')
    if _git(path,'diff','--cached','--name-only'):
        _git(path,'commit','-m',str(message)[:300])
    return _git(path,'rev-parse','HEAD')

def _absorb_task(body):
    # Merge one task's branch into another so dependent work builds on upstream changes without touching the original workspace.
    with _task_lock:
        target=managed_task(body.get('taskId')); source=managed_task(body.get('fromTaskId'))
        if target['id']==source['id']: raise ValueError('A task cannot absorb itself')
        if target['kind']!='worktree' or source['kind']!='worktree': raise ValueError('Only Git worktree tasks can be combined')
        if target['root']!=source['root']: raise ValueError('Tasks belong to different projects')
        if target['status']!='active' or source['status']!='active': raise ValueError('Both tasks must be active')
        for record in (target,source):
            if _git(record['path'],'symbolic-ref','--short','HEAD')!=record['branch']: raise ValueError('Task branch changed; restore its generated branch first')
        _commit_task(source,'SlopLobster: '+source['title'])
        _commit_task(target,'SlopLobster: '+target['title'])
        result=subprocess.run(['git','-C',target['path'],'merge','--no-ff','--no-edit',source['branch']],
                              capture_output=True,encoding='utf-8',errors='replace',timeout=60)
        if result.returncode:
            files=[n for n in _git(target['path'],'diff','--name-only','--diff-filter=U','-z').split('\0') if n]
            _git(target['path'],'merge','--abort',check=False)
            return {'ok':False,'status':'conflict','files':files,'output':(result.stdout+'\n'+result.stderr).strip()}
        return {'ok':True,'head':_git(target['path'],'rev-parse','HEAD'),'output':result.stdout.strip()}

def feature_api(path, body):
    if path=='/features/tasks/create': return _create_worktree(body)
    if path=='/features/tasks/list':
        root=_project_root(body.get('root',''))
        with _task_lock:
            _load_tasks(root)
            return {'tasks':[r for r in _managed_tasks.values() if r.get('root')==str(root) and r['status']!='discarded']}
    if path=='/features/tasks/file': return _task_file(body)
    if path=='/features/tasks/diff':
        record=managed_task(body.get('taskId'))
        diff=_task_diff(record)
        return {'diff':diff,'changedFiles':_task_changed_files(record),'reviewHash':_task_review_hash(record,diff)}
    if path=='/features/tasks/absorb': return _absorb_task(body)
    if path=='/features/tasks/merge': return _merge_task(body)
    if path=='/features/tasks/discard': return _discard_task(body)
    if path=='/features/evaluations/create': return _evaluation_create(body)
    if path=='/features/evaluations/result': return _evaluation_result(body)
    if path=='/features/recipes/discover':
        root=pathlib.Path(body.get('root') or os.getcwd()).resolve(strict=True)
        files={}
        for name in ('package.json','pnpm-lock.yaml','yarn.lock','bun.lock','pyproject.toml','pytest.ini','requirements.txt','Cargo.toml','go.mod'):
            file=root/name
            if file.is_file() and not file.is_symlink() and file.stat().st_size<100000:
                files[name]=file.read_text(encoding='utf-8',errors='replace')
        return {'files':files}
    raise ValueError('Unknown feature endpoint')


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

# END GENERATED FEATURES

class Handler(http.server.BaseHTTPRequestHandler):
    timeout = 15  # Idle sockets and incomplete request bodies cannot wait forever.
    def _check_access(self, authenticate=True):
        expected_port = self.server.server_address[1]
        if self.headers.get('Host', '') not in (f'127.0.0.1:{expected_port}', f'localhost:{expected_port}'):
            self.send_json(403, {'error': 'Invalid Host header'})
            return False
        origin = self.headers.get('Origin')
        if origin is not None and origin not in ALLOWED_ORIGINS:
            self.send_json(403, {'error': 'Origin is not paired with this companion'})
            return False
        if authenticate and not secrets.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + SESSION_TOKEN):
            self.send_json(401, {'error': 'Pair this companion: enter its session token in Settings > Companion session token'})
            return False
        return True

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        if not self._check_access(authenticate=False): return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if not self._check_access(): return
        if self.path in ("/status", "/ping"):
            self.send_json(200, {
                "status": "ok",
                "version": BUILD_VERSION,
                "capabilities": sorted(CAPABILITIES),
                "command_lifecycle": True,
                "platform": platform.system(),
                "release": platform.release(),
                "python": platform.python_version(),
                "python_cmd": PYTHON_CMD,
                "cwd": os.getcwd(),
                "shell": SHELL_NAME,
                "python_env": PYTHON_ENV,
                "node_env": NODE_ENV,
                "playwright": HAS_PLAYWRIGHT,
                "browser_open": _browser_service.browser_open
            })
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.startswith('/dev_'):
            with _dev_lock: return self._dispatch_post()
        return self._dispatch_post()

    def _dispatch_post(self):
        if not self._check_access(): return
        path = self.path.split('?')[0]
        capability = ('command' if path == '/execute' or path.startswith('/commands/') else
                      'browser' if path.startswith('/browser_') else
                      'mcp' if path.startswith(('/mcp/', '/api/mcp/')) else
                      'dev' if path.startswith('/dev_') else None)
        if path.startswith('/features/'): capability = 'command'
        if capability and capability not in CAPABILITIES:
            return self.send_json(403, {'error': capability + ' capability disabled by companion policy'})
        if not getattr(self, '_in_service_worker', False) and (path.startswith('/browser_') or path=='/embed'):
            try:
                body = self.read_body()
                if path=='/browser_close':
                    _browser_service.stop()
                    return self.send_json(200, {'ok':True})
                service = _embed_service if path=='/embed' else _browser_service
                limit = 120 if path=='/embed' else 15 if path=='/browser_evaluate' else 45
                if path=='/browser_wait_for': limit=max(5,min(65,float(body.get('timeout',10000))/1000+5))
                code, result = service.call(path, body, limit)
                return self.send_json(code, result)
            except Exception as exc:
                return self.send_json(500, {'error':str(exc)})
        if path.startswith('/features/'):
            try:
                body = self.read_body()
                with _task_lock:
                    result = feature_api(path, body)
                return self.send_json(200, result)
            except Exception as exc:
                name = 'NotFoundError' if isinstance(exc, FileNotFoundError) else 'TypeMismatchError' if isinstance(exc, (NotADirectoryError, IsADirectoryError)) else 'OperationError'
                return self.send_json(400, {'error': str(exc), 'errorName': name})
        if path in ('/commands/start', '/commands/status', '/commands/cancel'):
            try:
                body = self.read_body()
                if path == '/commands/start':
                    return self.send_json(200, {'id': start_command(body)})
                if path == '/commands/cancel':
                    return self.send_json(200, cancel_command(body.get('id')))
                return self.send_json(200, command_status(body.get('id'), body.get('cursor', 0)))
            except KeyError:
                return self.send_json(404, {'error': 'Unknown command id; do not retry execution with a new id'})
            except (ValueError, TypeError) as exc:
                return self.send_json(400, {'error': str(exc)})
        if path == '/execute':
            try:
                body = self.read_body()
                command = body.get("command", "")
                if not command:
                    self.send_json(400, {"error": "No command"})
                    return
                timeout = max(5, min(body.get("timeout", DEFAULT_TIMEOUT), MAX_TIMEOUT))
                cwd = body.get("cwd") or None
            except Exception as e:
                self.send_json(400, {"error": str(e)})
                return
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            def wfn(kind, data):
                try:
                    self.wfile.write((json.dumps({"t": kind, "d": data}, ensure_ascii=False) + "\n").encode("utf-8"))
                    self.wfile.flush()
                except Exception: pass
            try:
                stream_cmd(wfn, command, cwd=cwd, timeout=timeout)
            except Exception as e:
                wfn('e', "[Error: " + str(e) + "]")
                wfn('d', "1")
            return
        elif path == '/search':
            try:
                body = self.read_body()
                query = body.get("query", "").strip()
                if not query:
                    return self.send_json(400, {"error": "No query"})
                num = min(body.get("num_results", 8), 20)
                fetch_top = min(body.get("fetch_top", 0), 3)
                results = search_ddg(query, num)
                if fetch_top > 0 and results and not results[0].get("error"):
                    for r in results[:fetch_top]:
                        try:
                            c = fetch_url_content(r["url"], mode="text", max_bytes=150000)
                            r["content"] = c[:40000]
                            r["content_chars"] = len(c)
                            r["content_truncated"] = len(c) > 40000
                        except Exception as e:
                            r["content_error"] = str(e)
                self.send_json(200, {"query": query, "count": len(results), "results": results})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/fetch':
            try:
                body = self.read_body()
                url = body.get("url", "").strip()
                if not url:
                    return self.send_json(400, {"error": "No URL"})
                if not url.startswith(("http://", "https://")):
                    return self.send_json(400, {"error": "URL must start with http(s)"})
                mode = body.get("mode", "text")
                max_bytes = min(body.get("max_bytes", 500000), 2000000)
                content = fetch_url_content(url, mode, max_bytes)
                self.send_json(200, {"url": url, "mode": mode, "content": content, "size": len(content)})
            except urllib.error.HTTPError as e:
                err = e.read(10000).decode("utf-8", errors="replace")
                self.send_json(200, {"url": url, "error": "HTTP " + str(e.code) + ": " + e.reason, "content": err, "mode": "raw"})
            except Exception as e:
                self.send_json(500, {"error": type(e).__name__ + ": " + str(e)})
        elif path == '/ast_signatures':
            try:
                body = self.read_body()
                source = body.get("source", "")
                language = body.get("language", "").lower().strip()
                if not source or len(source) > 1000000:
                    self.send_json(400, {"error": "Source empty or too large (>1MB)"})
                    return
                lang_map = {"py": extract_python_signatures, "js": extract_js_signatures, "jsx": extract_js_signatures, "ts": extract_js_signatures, "tsx": extract_js_signatures, "mjs": extract_js_signatures, "cjs": extract_js_signatures, "rs": extract_generic_signatures, "go": extract_generic_signatures, "rb": extract_generic_signatures, "java": extract_generic_signatures, "c": extract_generic_signatures, "cpp": extract_generic_signatures, "h": extract_generic_signatures}
                extractor = lang_map.get(language, extract_generic_signatures)
                outline = extractor(source)
                self.send_json(200, {"outline": outline, "total_lines": len(source.split('\n')), "language": language})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_status':
            global _pw, _pw_browser, _pw_page, _pw_console, _pw_launch_time
            self.send_json(200, {
                "playwright_available": HAS_PLAYWRIGHT,
                "browser_open": _pw_browser is not None and _pw_browser.is_connected(),
                "current_url": _pw_page.url if _pw_page and not _pw_page.is_closed() else None,
                "console_count": len(_pw_console),
                "uptime": round(time.time() - _pw_launch_time, 1) if _pw_launch_time else None
            })
        elif path == '/browser_launch':
            try:
                body = self.read_body()
                headless = body.get("headless", True)
                page = _ensure_page()
                start_url = body.get("url")
                if start_url:
                    page.goto(start_url, timeout=30000, wait_until="domcontentloaded")
                self.send_json(200, {"ok": True, "url": page.url, "headless": headless})
            except Exception as e:
                import traceback
                tb = traceback.format_exc()
                err_msg = str(e) or 'Unknown error'
                self.send_json(500, {"error": err_msg, "traceback": tb, "hint": _browser_error_hint()})
        elif path == '/browser_navigate':
            try:
                body = self.read_body()
                url = body.get("url", "")
                if not url:
                    return self.send_json(400, {"error": "url is required"})
                wait = body.get("wait_until", "domcontentloaded")
                page = _ensure_page()
                page.goto(url, timeout=30000, wait_until=wait)
                self.send_json(200, {"ok": True, "url": page.url, "title": page.title()})
            except PWTimeout:
                self.send_json(200, {"ok": True, "url": url, "timeout": True, "note": "Page load timed out but may have partially loaded"})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_screenshot':
            try:
                body = self.read_body()
                page = _ensure_page()
                full_page = body.get("full_page", False)
                selector = body.get("selector")
                if selector:
                    el = page.wait_for_selector(selector, timeout=5000)
                    img_bytes = el.screenshot(type="png")
                elif full_page:
                    img_bytes = page.screenshot(full_page=True, type="png")
                else:
                    img_bytes = page.screenshot(type="png")
                import base64
                b64 = base64.b64encode(img_bytes).decode("ascii")
                self.send_json(200, {"ok": True, "screenshot": "data:image/png;base64," + b64, "size": len(img_bytes)})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_console':
            types = None
            since = None
            try:
                body = self.read_body()
                if body.get("types"):
                    types = body["types"]
                if body.get("since"):
                    since = body["since"]
            except Exception: pass
            msgs = _get_console_filtered(types=types, since=since, limit=200)
            errors = [m for m in msgs if m["type"] == "error"]
            warnings = [m for m in msgs if m["type"] == "warning"]
            self.send_json(200, {
                "total": len(msgs),
                "errors": len(errors),
                "warnings": len(warnings),
                "messages": msgs,
                "recent_errors": errors[-20:],
                "recent_warnings": warnings[-20:]
            })
        elif path == '/browser_click':
            try:
                body = self.read_body()
                selector = body.get("selector", "")
                if not selector:
                    return self.send_json(400, {"error": "selector is required"})
                page = _ensure_page()
                page.click(selector, timeout=10000)
                self.send_json(200, {"ok": True, "selector": selector})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_type':
            try:
                body = self.read_body()
                selector = body.get("selector", "")
                text = body.get("text", "")
                if not selector:
                    return self.send_json(400, {"error": "selector is required"})
                page = _ensure_page()
                page.fill(selector, text, timeout=10000)
                if body.get("submit"):
                    page.press("Enter")
                self.send_json(200, {"ok": True, "selector": selector, "typed": text[:50]})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_evaluate':
            try:
                body = self.read_body()
                script = body.get("script", "")
                if not script:
                    return self.send_json(400, {"error": "script is required"})
                page = _ensure_page()
                result = page.evaluate(script)
                result_str = str(result)
                if len(result_str) > 50000:
                    result_str = result_str[:50000] + "\n... [truncated]"
                self.send_json(200, {"ok": True, "result": result_str, "type": type(result).__name__})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_get_content':
            try:
                body = self.read_body()
                page = _ensure_page()
                selector = body.get("selector")
                mode = body.get("mode", "text")
                max_len = min(body.get("max_length", 30000), MAX_FETCH_LEN)
                if selector:
                    el = page.wait_for_selector(selector, timeout=5000)
                    content = el.inner_text() if mode == "text" else el.inner_html()
                else:
                    if mode == "text":
                        content = page.evaluate("document.body.innerText")
                    else:
                        content = page.content()
                if len(content) > max_len:
                    content = content[:max_len] + "\n... [truncated at " + str(max_len) + " chars]"
                self.send_json(200, {"ok": True, "content": content, "length": len(content), "mode": mode})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_wait_for':
            try:
                body = self.read_body()
                selector = body.get("selector", "")
                if not selector:
                    return self.send_json(400, {"error": "selector is required"})
                timeout = min(body.get("timeout", 10000), 60000)
                state = body.get("state", "visible")
                page = _ensure_page()
                page.wait_for_selector(selector, state=state, timeout=timeout)
                self.send_json(200, {"ok": True, "selector": selector, "state": state})
            except PWTimeout:
                self.send_json(200, {"ok": False, "timeout": True, "selector": selector})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_hover':
            try:
                body = self.read_body()
                selector = body.get("selector", "")
                if not selector:
                    return self.send_json(400, {"error": "selector is required"})
                page = _ensure_page()
                page.hover(selector, timeout=10000)
                self.send_json(200, {"ok": True, "selector": selector})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_select_option':
            try:
                body = self.read_body()
                selector = body.get("selector", "")
                value = body.get("value", "")
                if not selector or not value:
                    return self.send_json(400, {"error": "selector and value are required"})
                page = _ensure_page()
                page.select_option(selector, value, timeout=10000)
                self.send_json(200, {"ok": True, "selector": selector, "value": value})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_press_key':
            try:
                body = self.read_body()
                key = body.get("key", "")
                if not key:
                    return self.send_json(400, {"error": "key is required"})
                page = _ensure_page()
                page.keyboard.press(key)
                self.send_json(200, {"ok": True, "key": key})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_scroll':
            try:
                body = self.read_body()
                page = _ensure_page()
                direction = body.get("direction", "down")
                amount = body.get("amount", 500)
                if direction == "down":
                    page.mouse.wheel(0, amount)
                elif direction == "up":
                    page.mouse.wheel(0, -amount)
                elif direction == "top":
                    page.evaluate("window.scrollTo(0, 0)")
                elif direction == "bottom":
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                self.send_json(200, {"ok": True, "direction": direction, "amount": amount})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_go_back':
            try:
                page = _ensure_page()
                page.go_back(timeout=15000)
                self.send_json(200, {"ok": True, "url": page.url})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_go_forward':
            try:
                page = _ensure_page()
                page.go_forward(timeout=15000)
                self.send_json(200, {"ok": True, "url": page.url})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == '/browser_close':
            _close_browser()
            self.send_json(200, {"ok": True})

        elif path == '/embed':
            try:
                body = self.read_body()
                texts = body.get("texts", [])
                if not texts or not isinstance(texts, list) or len(texts) == 0:
                    return self.send_json(400, {"error": "texts is required (non-empty list of strings)"})
                if len(texts) > 100:
                    return self.send_json(400, {"error": "max 100 texts per batch"})
                try:
                    return self.send_json(200, encode_embeddings(texts))
                except ImportError:
                    return self.send_json(200, {"error": "sentence-transformers not installed", "fallback": True, "hint": "pip install sentence-transformers", "backend": "none"})
            except Exception as e:
                return self.send_json(500, {"error": str(e)})

        elif path == '/dev_start':
            try:
                body = self.read_body()
                cmd = body.get("command", "")
                if not cmd:
                    return self.send_json(400, {"error": "command is required"})
                port = int(body.get("port", 3000))
                cwd = body.get("cwd") or None
                if body.get("taskId"):
                    task = managed_task(body["taskId"])
                    cwd = task["path"]; port = task["port"]
                    cmd = cmd.replace("{port}", str(port))
                result = _start_dev_process(cmd, port, cwd)
                self.send_json(200, result)
            except Exception as e:
                self.send_json(500, {"error": str(e)})

        elif path == '/dev_status':
            try:
                body = self.read_body()
                port = int(body.get("port", 3000))
                ps = _dev_processes.get(str(port))
                if not ps:
                    return self.send_json(200, {"alive": False, "ready": False, "port": port})
                alive = ps['alive'][0]
                ready = alive and _check_dev_ready(port)
                with ps['lock']:
                    output = ''.join(ps['buf'][-50:])
                return self.send_json(200, {"alive": alive, "ready": ready, "port": port, "output_tail": output})
            except Exception as e:
                self.send_json(500, {"error": str(e)})

        elif path == '/dev_output':
            try:
                body = self.read_body()
                port = int(body.get("port", 3000))
                tail = int(body.get("tail", 100))
                ps = _dev_processes.get(str(port))
                if not ps:
                    return self.send_json(200, {"output": "", "alive": False})
                with ps['lock']:
                    output = ''.join(ps['buf'][-tail:])
                return self.send_json(200, {"output": output, "alive": ps['alive'][0]})
            except Exception as e:
                self.send_json(500, {"error": str(e)})

        elif path == '/dev_stop':
            try:
                body = self.read_body()
                port = int(body.get("port", 3000))
                port_s = str(port)
                ps = _dev_processes.get(port_s)
                killed = False
                if ps:
                    try:
                        kill_tree(ps['proc'].pid)
                        killed = True
                    except Exception: pass
                    ps['alive'][0] = False
                    del _dev_processes[port_s]
                self.send_json(200, {"ok": True, "killed": killed, "port": port})
            except Exception as e:
                self.send_json(500, {"error": str(e)})

        elif path in ('/mcp/sync', '/api/mcp/sync'):
            try:
                body = self.read_body()
                servers = body.get("mcpServers") or body.get("servers") or {}
                results = {}
                for srv_name, srv_cfg in servers.items():
                    try:
                        results[srv_name] = _mcp_init_server(srv_name, srv_cfg)
                    except Exception as e:
                        results[srv_name] = {"status": "error", "error": str(e), "tools": []}
                self.send_json(200, {"ok": True, "servers": results})
            except Exception as e:
                self.send_json(500, {"error": str(e)})

        elif path in ('/mcp/call', '/api/mcp/call'):
            try:
                body = self.read_body()
                srv_name = body.get("server", "")
                tool_name = body.get("tool", "")
                args = body.get("arguments", {})
                timeout = min(int(body.get("timeout", 120)), 600)
                res = _mcp_call_tool(srv_name, tool_name, args, timeout=timeout)
                self.send_json(200, res)
            except Exception as e:
                self.send_json(500, {"error": str(e)})

        elif path in ('/mcp/status', '/api/mcp/status'):
            try:
                status = {}
                for name, srv in list(_mcp_servers.items()):
                    alive = srv.get("proc") and srv["proc"].poll() is None
                    status[name] = {"alive": alive, "tool_count": len(srv.get("tools", []))}
                self.send_json(200, {"servers": status})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        else:
            self.send_json(404, {"error": "not found"})

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > 2000000:
            raise ValueError("Body too large")
        return json.loads(self.rfile.read(length) or "{}")

    def _cors(self):
        origin = self.headers.get('Origin')
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def send_json(self, code, data):
        p = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(p)))
        self.end_headers()
        self.wfile.write(p)

    def log_message(self, fmt, *args):
        sys.stderr.write("[companion] " + (fmt % args) + "\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    server = CompanionHTTPServer(("127.0.0.1", port), Handler)
    server.socket.settimeout(None)
    server.timeout = None
    print("\n  SlopLobster Companion " + BUILD_VERSION + "  |  http://127.0.0.1:" + str(port) + "  |  " + platform.system() + "  |  Ctrl+C to stop\n")
    print("  Companion session token (paste into SlopLobster Settings): " + SESSION_TOKEN)
    print("  Enabled capabilities: " + ', '.join(sorted(CAPABILITIES)) + "\n")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        stop_all_commands()
        for entry in list(_dev_processes.values()):
            if entry['proc'].poll() is None: kill_tree(entry['proc'].pid)
        for entry in list(_mcp_servers.values()):
            if entry['proc'].poll() is None: kill_tree(entry['proc'].pid)
        _pshell_invalidate()
        _browser_service.stop()
        _embed_service.stop()
        server.server_close()


if __name__ == "__main__":
    if len(sys.argv)>2 and sys.argv[1]=='--service-worker':
        run_service_worker(sys.argv[2])
    else:
        main()
