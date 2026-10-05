
import importlib.util,pathlib,tempfile,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('review_companion',ROOT/'SlopLobster-companion.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
def git(root,*args):
    return subprocess.run(['git','-C',str(root),*args],check=True,capture_output=True,text=True).stdout
with tempfile.TemporaryDirectory(prefix='slop-review-') as temporary:
    root=pathlib.Path(temporary).resolve()
    git(root,'init');git(root,'config','user.name','Review Fixture');git(root,'config','user.email','review@example.invalid')
    (root/'base.txt').write_text('base')
    git(root,'add','.');git(root,'commit','-m','fixture')
    task=c.feature_api('/features/tasks/create',{'root':str(root)})
    try:
        file=pathlib.Path(task['path'])/' unreviewed.txt';file.write_text('never shown in the review')
        review=c.feature_api('/features/tasks/diff',{'taskId':task['id']})
        assert 'never shown in the review' in review['diff'],repr(review['diff'])
        assert ' unreviewed.txt' in review['changedFiles'],review
        result=c.feature_api('/features/tasks/merge',{'taskId':task['id'],'reviewHash':review['reviewHash']})
        assert result['ok'],result
        assert (root/' unreviewed.txt').read_text()=='never shown in the review'
        print('PASS: the leading-space filename and contents appear in the review before merge.')
    finally:
        c.feature_api('/features/tasks/discard',{'taskId':task['id'],'confirm':True})
