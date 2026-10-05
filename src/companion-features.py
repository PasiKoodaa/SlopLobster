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
