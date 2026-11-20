import json,os,numpy as np
from PIL import Image
R=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..'))+'/'
S={'python':['python-30-Aug-2026(12_38PM)','python-final-30-Aug-2026(12_49PM)','python-full-30-Aug-2026(1_01PM)'],
'wikipedia':['wikipedia-30-Aug-2026(12_44PM)','wikipedia-final-30-Aug-2026(12_56PM)','wikipedia-full-30-Aug-2026(1_03PM)'],
'github-docs':['github-docs-30-Aug-2026(12_47PM)','github-docs-final-30-Aug-2026(12_58PM)','github-docs-full-30-Aug-2026(1_05PM)'],
'nodejs':['nodejs-30-Aug-2026(12_40PM)','nodejs-final-30-Aug-2026(12_51PM)'],'mdn':['mdn-30-Aug-2026(12_42PM)','mdn-final-30-Aug-2026(12_54PM)']}
def raw(a,b):
    A=np.array(Image.open(a).convert('RGB'));B=np.array(Image.open(b).convert('RGB'))
    h=min(A.shape[0],B.shape[0]);w=min(A.shape[1],B.shape[1])
    return int(np.any(A[:h,:w]!=B[:h,:w],axis=-1).sum())
tot=0;imp=[];out={}
for s,ss in S.items():
    i,j=(1,2) if len(ss)==3 else (0,1)
    summ=json.load(open(R+f'visual_diffs/{s}/visual_diff_summary.json'))
    for e in summ:
        a=R+ss[i]+'/screenshots/'+e['page']; b=R+ss[j]+'/screenshots/'+e['page']
        if not(os.path.exists(a) and os.path.exists(b)): print('missing',s,e['page']); continue
        d=raw(a,b); tot+=1; out[f"{s}/{e['page']}"]=(e['diffPixels'],d)
        if e['diffPixels']>d: imp.append((s,e['page'],e['diffPixels'],d))
print('records',tot,'impossible against their true pair',len(imp)); print(imp)
json.dump(out,open(os.path.join(os.path.dirname(__file__),'realign.json'),'w'))
