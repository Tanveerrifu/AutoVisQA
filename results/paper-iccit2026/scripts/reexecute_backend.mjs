// Re-executes the archive diff back-end (pixelmatch 5.3.0, threshold 0.1, includeAA) on every session pair
// and reports which pair reproduces each stored record. Usage: node reexecute_backend.mjs <subject>
import fs from 'fs'; import path from 'path';
const NM=new URL('../../../analysis/node_modules/', import.meta.url).pathname;
const {PNG}=await import(NM+'pngjs/lib/png.js');
const pixelmatch=(await import(NM+'pixelmatch/index.js')).default;
const R=new URL('../../', import.meta.url).pathname;
const S={python:['python-30-Aug-2026(12_38PM)','python-final-30-Aug-2026(12_49PM)','python-full-30-Aug-2026(1_01PM)'],
wikipedia:['wikipedia-30-Aug-2026(12_44PM)','wikipedia-final-30-Aug-2026(12_56PM)','wikipedia-full-30-Aug-2026(1_03PM)'],
'github-docs':['github-docs-30-Aug-2026(12_47PM)','github-docs-final-30-Aug-2026(12_58PM)','github-docs-full-30-Aug-2026(1_05PM)'],
nodejs:['nodejs-30-Aug-2026(12_40PM)','nodejs-final-30-Aug-2026(12_51PM)'],mdn:['mdn-30-Aug-2026(12_42PM)','mdn-final-30-Aug-2026(12_54PM)']};
function crop(src,w,h){const o=new PNG({width:w,height:h});for(let y=0;y<h;y++)src.data.copy(o.data,y*w*4,y*src.width*4,y*src.width*4+w*4);return o;}
function pm(a,b){let A=PNG.sync.read(fs.readFileSync(a)),B=PNG.sync.read(fs.readFileSync(b));const w=Math.min(A.width,B.width),h=Math.min(A.height,B.height);if(A.width!==B.width||A.height!==B.height){A=crop(A,w,h);B=crop(B,w,h);}
 return pixelmatch(A.data,B.data,null,w,h,{threshold:0.1,includeAA:true});}
const subj=process.argv[2]; const pages=process.argv.slice(3);
const summ=JSON.parse(fs.readFileSync(R+`visual_diffs/${subj}/visual_diff_summary.json`));
const rep=Object.fromEntries(summ.map(e=>[e.page,e.diffPixels]));
const ss=S[subj]; const pairs=[];for(let i=0;i<ss.length;i++)for(let j=i+1;j<ss.length;j++)pairs.push([i,j]);
const todo=pages.length?pages:Object.keys(rep);
const tally={}; const ALL={};
for(const p of todo){const res={};for(const [i,j] of pairs){const a=R+ss[i]+'/screenshots/'+p,b=R+ss[j]+'/screenshots/'+p;if(fs.existsSync(a)&&fs.existsSync(b))res[`${i}-${j}`]=pm(a,b);}
 const m=Object.entries(res).filter(([k,v])=>v===rep[p]).map(([k])=>k);
 tally[m.join('|')||'none']=(tally[m.join('|')||'none']||0)+1;
 ALL[p]={rep:rep[p],res};}
console.log(subj,'match tally',JSON.stringify(tally)); fs.writeFileSync(new URL('rep_'+subj+'.json', import.meta.url).pathname, JSON.stringify(ALL));
