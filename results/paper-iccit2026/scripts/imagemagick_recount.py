import json, subprocess, os, sys
import numpy as np
from PIL import Image
R=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..'))
S={'python':('python-30-Aug-2026(12_38PM)','python-final-30-Aug-2026(12_49PM)'),
'nodejs':('nodejs-30-Aug-2026(12_40PM)','nodejs-final-30-Aug-2026(12_51PM)'),
'mdn':('mdn-30-Aug-2026(12_42PM)','mdn-final-30-Aug-2026(12_54PM)'),
'wikipedia':('wikipedia-30-Aug-2026(12_44PM)','wikipedia-final-30-Aug-2026(12_56PM)'),
'github-docs':('github-docs-30-Aug-2026(12_47PM)','github-docs-final-30-Aug-2026(12_58PM)')}
rows=[r for r in json.load(open(R+'/evl_final_rows.json')) if r['verdict']=='REACHED_ARITH']
agree=0; out=[]
for r in rows:
    a=f"{R}/{S[r['subject']][0]}/screenshots/{r['page']}"; b=f"{R}/{S[r['subject']][1]}/screenshots/{r['page']}"
    A=Image.open(a).convert('RGB'); B=Image.open(b).convert('RGB')
    w=min(A.width,B.width); h=min(A.height,B.height)
    x=np.array(A)[:h,:w]; y=np.array(B)[:h,:w]
    mine=int(np.any(x!=y,axis=-1).sum())
    import glob
    im=0; bad=False
    for k,y0 in enumerate(range(0,h,4000)):
        A.crop((0,y0,w,min(y0+4000,h))).save('/tmp/_sa.png'); B.crop((0,y0,w,min(y0+4000,h))).save('/tmp/_sb.png')
        p=subprocess.run(['compare','-metric','AE','-fuzz','0%','/tmp/_sa.png','/tmp/_sb.png','null:'],capture_output=True,text=True)
        txt=(p.stderr or p.stdout).strip()
        if not txt or not txt[0].isdigit(): bad=True; print('IMERR',r['subject'],r['page'],txt[:120]); break
        im+=int(float(txt.split()[0]))
    if bad: continue
    agree+=(mine==im)
    out.append((r['subject'],r['page'],mine,im,mine==im,round(r['tool_pct']*w*h/100) ))
print(len(rows),'pairs; exact agreement mine vs ImageMagick:',agree)
for o in out:
    if not o[4]: print('DIFF',o)
json.dump(out,open(os.path.join(os.path.dirname(__file__),'im_check.json'),'w'))
