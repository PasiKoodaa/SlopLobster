import importlib.util, pathlib, tempfile, unittest, json, subprocess, sys, time
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('feature_companion',ROOT/'SlopLobster-companion.py')
c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
def git(root,*args):
    p=subprocess.run(['git','-C',str(root),*args],capture_output=True,text=True)
    if p.returncode: raise AssertionError(p.stderr)
    return p.stdout.strip()
class WorktreeFeatures(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='slop-feature-test-')
        self.root=pathlib.Path(self.temp.name).resolve()
        git(self.root,'init'); git(self.root,'config','user.name','Harness Test'); git(self.root,'config','user.email','test@example.invalid')
        (self.root/'fixture.txt').write_text('original',encoding='utf-8')
        git(self.root,'add','.'); git(self.root,'commit','-m','fixture')
        self.task=c.feature_api('/features/tasks/create',{'root':str(self.root),'title':'Test'})
    def tearDown(self):
        for record in list(c._managed_tasks.values()):
            if record.get('root')==str(self.root) and record['status']!='discarded':
                try: c.feature_api('/features/tasks/discard',{'taskId':record['id'],'confirm':True})
                except Exception: pass
        self.temp.cleanup()
    def read(self,path='fixture.txt'):
        return c.feature_api('/features/tasks/file',{'taskId':self.task['id'],'action':'read','path':path})
    def write(self,text):
        before=self.read()
        return c.feature_api('/features/tasks/file',{'taskId':self.task['id'],'action':'write','path':'fixture.txt','base64':c.base64.b64encode(text.encode()).decode(),'expectedHash':before['hash']})
    def test_worktree_file_edits_leave_original_unchanged(self):
        self.write('task changed')
        self.assertEqual((self.root/'fixture.txt').read_text(),'original')
        self.assertEqual((pathlib.Path(self.task['path'])/'fixture.txt').read_text(),'task changed')
        self.assertFalse(git(self.root,'status','--porcelain'))
    def test_stale_managed_write_is_rejected(self):
        before=self.read(); self.write('newer')
        with self.assertRaises(ValueError):
            c.feature_api('/features/tasks/file',{'taskId':self.task['id'],'action':'write','path':'fixture.txt','base64':'eA==','expectedHash':before['hash']})
    def test_review_merge_and_stale_diff_protection(self):
        self.write('changed')
        reviewed=c.feature_api('/features/tasks/diff',{'taskId':self.task['id']})
        self.write('different')
        with self.assertRaises(ValueError):
            c.feature_api('/features/tasks/merge',{'taskId':self.task['id'],'reviewHash':reviewed['reviewHash']})
        reviewed=c.feature_api('/features/tasks/diff',{'taskId':self.task['id']})
        result=c.feature_api('/features/tasks/merge',{'taskId':self.task['id'],'reviewHash':reviewed['reviewHash']})
        self.assertTrue(result['ok']); self.assertEqual((self.root/'fixture.txt').read_text(),'different')
    def test_dirty_original_blocks_merge(self):
        self.write('changed'); (self.root/'fixture.txt').write_text('user change')
        reviewed=c.feature_api('/features/tasks/diff',{'taskId':self.task['id']})
        with self.assertRaises(ValueError):
            c.feature_api('/features/tasks/merge',{'taskId':self.task['id'],'reviewHash':reviewed['reviewHash']})
        self.assertEqual((self.root/'fixture.txt').read_text(),'user change')
    def test_manifest_restores_tasks_after_registry_reset(self):
        c._managed_tasks.pop(self.task['id'])
        tasks=c.feature_api('/features/tasks/list',{'root':str(self.root)})['tasks']
        self.assertEqual(tasks[0]['id'],self.task['id'])
    def test_task_paths_and_git_metadata_are_protected(self):
        for path in ('../outside','/outside','C:/outside','.git','dir/../../outside'):
            with self.assertRaises(ValueError): c.feature_api('/features/tasks/file',{'taskId':self.task['id'],'action':'read','path':path})
    def test_command_cwd_and_idempotency_follow_task(self):
        body={'id':'task-cwd-'+self.task['id'],'taskId':self.task['id'],'command':'git rev-parse --show-toplevel','timeout':5}
        tid=c.start_command(body)
        self.assertEqual(c.start_command(body),tid)
        deadline=time.monotonic()+10
        while c.command_status(tid)['status']=='running' and time.monotonic()<deadline: time.sleep(.02)
        result=c.command_status(tid)
        self.assertEqual(result['exitCode'],0)
        output=''.join(e['d'] for e in result['events']).strip().replace('\\','/').lower()
        self.assertEqual(output,str(pathlib.Path(self.task['path'])).replace('\\','/').lower())
    def test_preview_ports_are_unique(self):
        other=c.feature_api('/features/tasks/create',{'root':str(self.root),'title':'Other'})
        self.assertNotEqual(self.task['port'],other['port'])
    def test_discard_requires_confirmation(self):
        with self.assertRaises(ValueError): c.feature_api('/features/tasks/discard',{'taskId':self.task['id']})
        c.feature_api('/features/tasks/discard',{'taskId':self.task['id'],'confirm':True})
        self.assertFalse(pathlib.Path(self.task['path']).exists())
        self.assertEqual((self.root/'fixture.txt').read_text(),'original')

    def test_binary_changes_invalidate_review_hash(self):
        path=pathlib.Path(self.task['path'])/'fixture.txt'
        path.write_bytes(b'\x00one')
        reviewed=c.feature_api('/features/tasks/diff',{'taskId':self.task['id']})
        path.write_bytes(b'\x00two')
        with self.assertRaises(ValueError):
            c.feature_api('/features/tasks/merge',{'taskId':self.task['id'],'reviewHash':reviewed['reviewHash']})
    def test_oversized_diff_is_never_silently_merged(self):
        self.write('large\n'*40000)
        with self.assertRaises(ValueError):
            c.feature_api('/features/tasks/diff',{'taskId':self.task['id']})


    def test_leading_space_filename_is_reviewed_and_stale_changes_block_merge(self):
        path=pathlib.Path(self.task['path'])/' leading space.txt'
        path.write_text('reviewed content',encoding='utf-8')
        review=c.feature_api('/features/tasks/diff',{'taskId':self.task['id']})
        self.assertIn(' leading space.txt',review['changedFiles'])
        self.assertIn('reviewed content',review['diff'])
        path.write_text('changed after review',encoding='utf-8')
        with self.assertRaises(ValueError):
            c.feature_api('/features/tasks/merge',{'taskId':self.task['id'],'reviewHash':review['reviewHash']})
        review=c.feature_api('/features/tasks/diff',{'taskId':self.task['id']})
        result=c.feature_api('/features/tasks/merge',{'taskId':self.task['id'],'reviewHash':review['reviewHash']})
        self.assertTrue(result['ok'])
        self.assertEqual((self.root/' leading space.txt').read_text(),'changed after review')

class EvaluationFeatures(unittest.TestCase):
    def setUp(self):
        self.task=c.feature_api('/features/evaluations/create',{'files':{'a.txt':'before'},'allowedWrites':['a.txt'],'checks':[]})
    def tearDown(self):
        c.feature_api('/features/tasks/discard',{'taskId':self.task['id'],'confirm':True})
    def test_file_assertions_and_unintended_write_metrics(self):
        task=c.managed_task(self.task['id']); path=pathlib.Path(task['path'])
        (path/'a.txt').write_text('after'); (path/'unexpected.txt').write_text('oops')
        result=c.feature_api('/features/evaluations/result',{'taskId':self.task['id'],'assertions':[{'path':'a.txt','equals':'after'}]})
        self.assertFalse(result['passed']); self.assertEqual(result['unintendedWrites'],['unexpected.txt'])
    def test_evaluation_commands_must_be_declared(self):
        with self.assertRaises(ValueError): c.start_command({'taskId':self.task['id'],'command':'echo undeclared','timeout':5})
    def test_fixture_traversal_is_rejected(self):
        with self.assertRaises(ValueError): c.feature_api('/features/evaluations/create',{'files':{'../outside':'x'}})
if __name__=='__main__': unittest.main()
