#!/usr/bin/env python
"""SlopLobster Companion Server v1.4 — Shell + Git + Web Search for SlopLobster Agent."""
import http.server, subprocess, json, os, sys, signal, platform, re, urllib.request, urllib.parse, urllib.error, shutil, threading, time
from html.parser import HTMLParser

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

_pw = None
_pw_browser = None
_pw_page = None
_pw_console = []
_pw_launch_time = None

PORT = 8765
DEFAULT_TIMEOUT = 60
MAX_OUTPUT = 100000
MAX_TIMEOUT = 600
MAX_FETCH_LEN = 100000


def kill_tree(pid):
    try:
        if platform.system() == "Windows":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, timeout=5)
        else:
            pgid = os.getpgid(pid)
            if pgid > 0: os.killpg(pgid, signal.SIGKILL)
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
            try: _pshell_proc.kill()
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

def stream_cmd_fresh(write_fn, cmd, cwd=None, timeout=DEFAULT_TIMEOUT):
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
        
    proc = subprocess.Popen(**kw)
    out_buf = []; err_buf = []; lock = threading.Lock()
    
    def reader(stream, buf, kind):
        try:
            for line in iter(stream.readline, ''):
                with lock: 
                    buf.append(line)
                    write_fn(kind, line)
            stream.close()
        except Exception: 
            pass
            
    t1 = threading.Thread(target=reader, args=(proc.stdout, out_buf, 'o'))
    t2 = threading.Thread(target=reader, args=(proc.stderr, err_buf, 'e'))
    t1.daemon = True; t2.daemon = True; t1.start(); t2.start()
    
    start = time.time()
    while t1.is_alive() or t2.is_alive():
        if time.time() - start > timeout:
            kill_tree(proc.pid)
            with lock: 
                # Fixed: use \n for actual newlines instead of literal \n text
                write_fn('e', f"\n[Timed out after {timeout}s]\n")
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
        pass
        
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
    # On Windows with Git Bash, reuse a persistent shell to avoid
    # spawning a new Hyper-V/WSL VM instance per command (0x800705aa).
    if WINDOWS_BASH:
        stream_cmd_persistent(write_fn, cmd, cwd=cwd, timeout=timeout)
    else:
        stream_cmd_fresh(write_fn, cmd, cwd=cwd, timeout=timeout)

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
    _pw_console = []
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
    _pw_console = []
    def _on_console(msg):
        _pw_console.append({"type": msg.type, "text": msg.text, "time": time.time()})
    def _on_pageerror(err):
        _pw_console.append({"type": "error", "text": str(err), "time": time.time()})
    _pw_page.on("console", _on_console)
    _pw_page.on("pageerror", _on_pageerror)
    _pw_launch_time = time.time()
    return _pw_page

def _get_console_filtered(types=None, since=None, limit=100):
    msgs = _pw_console
    if types:
        types_set = set(types)
        msgs = [m for m in msgs if m["type"] in types_set]
    if since:
        msgs = [m for m in msgs if m["time"] > since]
    return msgs[-limit:]    

_dev_processes = {}

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
    proc = subprocess.Popen(**kw)
    buf = []
    lock = threading.Lock()
    alive = [True]
    def reader(stream, kind):
        try:
            for line in iter(stream.readline, ''):
                if not alive[0]: break
                with lock:
                    buf.append(kind + line)
                    if len(buf) > 2000:
                        buf.pop(0)
        except Exception: pass
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

def _mcp_send_and_recv(proc, req_obj, timeout=30):
    line = json.dumps(req_obj) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()
    res_line = [None]
    done_evt = threading.Event()
    
    def read_stdout():
        try:
            for l in proc.stdout:
                l = l.strip()
                if l and (l.startswith('{') or l.startswith('[')):
                    res_line[0] = l
                    done_evt.set()
                    break
        except Exception:
            done_evt.set()
            
    t = threading.Thread(target=read_stdout, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if not done_evt.is_set() or not res_line[0]:
        raise TimeoutError("MCP server response timed out after " + str(timeout) + "s")
    return json.loads(res_line[0])

def _mcp_init_server(name, config):
    with _mcp_lock:
        if name in _mcp_servers:
            old = _mcp_servers[name]
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
            creationflags=flags
        )
        
        # 1. initialize
        init_req = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "SlopLobster", "version": "1.4"}
            }
        }
        init_res = _mcp_send_and_recv(proc, init_req, timeout=15)
        
        # 2. initialized notification
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()
        
        # 3. tools/list
        list_req = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        }
        list_res = _mcp_send_and_recv(proc, list_req, timeout=15)
        tools = list_res.get("result", {}).get("tools", [])
        
        _mcp_servers[name] = {
            "proc": proc,
            "tools": tools,
            "config": config,
            "id_counter": 3,
            "lock": threading.Lock()
        }
        return {"status": "connected", "tools": tools, "tool_count": len(tools)}

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
        res = _mcp_send_and_recv(srv["proc"], call_req, timeout=timeout)
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


class Handler(http.server.BaseHTTPRequestHandler):
    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path in ("/status", "/ping"):
            self.send_json(200, {
                "status": "ok",
                "platform": platform.system(),
                "release": platform.release(),
                "python": platform.python_version(),
                "python_cmd": PYTHON_CMD,
                "cwd": os.getcwd(),
                "shell": SHELL_NAME,
                "python_env": PYTHON_ENV,
                "node_env": NODE_ENV,
                "playwright": HAS_PLAYWRIGHT,
                "browser_open": _pw_browser is not None and _pw_browser.is_connected()
            })
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split('?')[0]
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
                    from sentence_transformers import SentenceTransformer
                    model = SentenceTransformer('all-MiniLM-L6-v2')
                    embeddings = model.encode(texts, normalize_embeddings=True)
                    return self.send_json(200, {"embeddings": embeddings.tolist(), "dim": int(embeddings.shape[1]), "backend": "companion"})
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
                for name, srv in _mcp_servers.items():
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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

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
    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    server.socket.settimeout(None)
    server.timeout = None
    print("\n  SlopLobster Companion v1.4  |  http://127.0.0.1:" + str(port) + "  |  " + platform.system() + "  |  Ctrl+C to stop\n")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
