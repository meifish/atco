const $=id=>document.getElementById(id);
const files={before:null,after:null};let result=null,pageIndex=0,zoom=1,regions=[],syncing=false,selectedRegion=null;
const names={line:'直線',curve:'向量路徑',rect:'矩形',char:'文字字元',image:'圖片',annotation:'批註'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function selectFile(side,file){if(!file)return;files[side]=file;$(side+'Name').textContent=file.name;updateButton();}
function updateButton(){$('compare').disabled=!files.before||!files.after;}
for(const side of ['before','after']){const input=$(side+'File'),drop=$(side+'Drop');input.onchange=()=>selectFile(side,input.files[0]);drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag');};drop.ondragleave=()=>drop.classList.remove('drag');drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');if(!$('compare').dataset.busy)selectFile(side,e.dataTransfer.files[0]);};}
$('compare').onclick=async()=>{
 const before=files.before,after=files.after;if(!before||!after)return;
 if(before.size+after.size>80*1024*1024){$('status').textContent='兩份檔案合計不可超過 80 MB。';return;}
 $('compare').disabled=true;$('compare').dataset.busy='1';$('beforeFile').disabled=$('afterFile').disabled=true;
 $('status').className='busy';$('status').textContent='正在本機解析文字、向量線條與批註，再比對物件… 大型施工圖可能需要一至數分鐘。';$('results').hidden=true;$('empty').hidden=true;
 try{const response=await fetch('/api/compare',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Before-Length':String(before.size)},body:new Blob([before,after])});const data=await response.json();if(!response.ok)throw Error(data.error||'比對失敗');result=data;result.filenames={before:before.name,after:after.name};pageIndex=0;zoom=1;selectedRegion=null;
 $('pageSelect').innerHTML=result.pages.map((_,i)=>`<option value="${i}">第 ${i+1} 頁</option>`).join('');$('results').hidden=false;$('status').textContent='';render();
 }catch(e){$('status').className='';$('status').textContent=e.message||'無法連線至本機服務，請確認網站已啟動。';$('empty').hidden=false;}
 finally{delete $('compare').dataset.busy;$('beforeFile').disabled=$('afterFile').disabled=false;updateButton();}
};
function changes(page){return(page?.changes||[]).filter(o=>$('annotations').checked||o.kind!=='annotation');}
function vector(o,color){const width=Math.max(.65,Number(o.style?.[0])||0),fill=o.style?.[2]?color:'none';let d=(o.path||[]).map(seg=>seg[0].toUpperCase()+' '+seg.slice(1).flat().join(' ')).join(' ');if(o.kind==='rect')d+=' Z';return `<path d="${esc(d)}" fill="${fill}" fill-rule="${o.style?.[6]?'evenodd':'nonzero'}" stroke="${o.style?.[1]?color:'none'}" stroke-width="${width}"/>`;}
function diagram(page,side){if(!page)return '<div class="missing">此版本沒有對應頁面</div>';const color=side==='before'?'#cc4747':'#07875c',items=changes(page);let defs='',marks='';
 items.forEach((o,i)=>{let[x0,y0,x1,y1]=o.box;const w=Math.max(x1-x0,.5),h=Math.max(y1-y0,.5);
 if(o.kind==='char'||o.kind==='image'){defs+=`<clipPath id="${side}-${i}"><rect x="${x0-.3}" y="${y0-.3}" width="${w+.6}" height="${h+.6}"/></clipPath>`;marks+=`<g clip-path="url(#${side}-${i})"><use href="#${side}-raster"/></g><rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${color}" fill-opacity=".23"/>`;}
 else if(o.kind==='annotation'){marks+=`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${color}" fill-opacity=".08" stroke="${color}" stroke-width="2" stroke-dasharray="5 3"><title>${esc(o.text||'批註範圍')}</title></rect>`;}
 else marks+=vector(o,color);
 });
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}" role="img" aria-label="${side} 差異圖面"><defs><image id="${side}-raster" href="${page.image}" width="${page.width}" height="${page.height}" preserveAspectRatio="none"/>${defs}</defs><rect width="100%" height="100%" fill="white"/>${$('context').checked?`<use href="#${side}-raster" opacity=".23"/>`:''}${marks}<rect class="focus-box" fill="none" stroke="#dc9c22" stroke-width="3" visibility="hidden"/></svg>`;
}
function render(){if(!result)return;let removed=0,added=0;result.pages.forEach(p=>{removed+=changes(p.before).length;added+=changes(p.after).length;});$('removedTotal').textContent=removed.toLocaleString();$('addedTotal').textContent=added.toLocaleString();$('summaryTitle').textContent=`${result.pages.length} 頁已解析 · ${result.pages.filter(p=>changes(p.before).length+changes(p.after).length>0).length} 頁有差異`;
 const page=result.pages[pageIndex];for(const side of ['before','after']){$(side+'Canvas').innerHTML=diagram(page[side],side);$(side+'Caption').textContent=result.filenames[side];}
 const warning=[];if(!page.sameSize)warning.push('兩頁尺寸不同，尚未自動對齊；位置差異可能造成大量標示。');if([page.before,page.after].some(p=>p?.counts.image&&!p?.counts.char&&!p?.counts.line&&!p?.counts.curve))warning.push('此頁可能為掃描圖，會以整個圖片物件比對，沒有 OCR。');$('pageWarning').hidden=!warning.length;$('pageWarning').textContent=warning.join(' ');
 buildRegions(page);sizeCanvases();if(selectedRegion!==null&&regions[selectedRegion])focusRegion(selectedRegion);
 $('parseInfo').innerHTML='<table><thead><tr><th>本頁解析物件</th><th>Before</th><th>After</th></tr></thead><tbody>'+Object.entries(names).map(([k,n])=>`<tr><td>${n}</td><td>${(page.before?.counts[k]||0).toLocaleString()}</td><td>${(page.after?.counts[k]||0).toLocaleString()}</td></tr>`).join('')+'</tbody></table><p>批註以虛線範圍標示；文字使用原 PDF 的局部影像呈現。預覽解析度最高為 2,200 px，放大檢視時細節可能較模糊。</p>';
}
function buildRegions(page){const map=new Map(),w=Math.max(page.before?.width||0,page.after?.width||0),h=Math.max(page.before?.height||0,page.after?.height||0);
 for(const side of ['before','after'])for(const o of changes(page[side])){const b=o.box,x=(b[0]+b[2])/2,y=(b[1]+b[3])/2,key=`${Math.floor(y/h*6)}:${Math.floor(x/w*8)}`;if(!map.has(key))map.set(key,{box:[...b],before:0,after:0,kinds:new Set(),texts:[],objects:{before:[],after:[]}});const r=map.get(key);r.box=[Math.min(r.box[0],b[0]),Math.min(r.box[1],b[1]),Math.max(r.box[2],b[2]),Math.max(r.box[3],b[3])];r[side]++;r.objects[side].push(o);r.kinds.add(names[o.kind]);if(o.kind==='annotation'&&o.text)r.texts.push(o.text);}
 regions=[...map.values()].sort((a,b)=>a.box[1]-b.box[1]||a.box[0]-b.box[0]);$('regionCount').textContent=regions.length;$('regions').innerHTML=regions.length?regions.map((r,i)=>`<button class="region" data-index="${i}" title="${esc(r.texts.join(' / '))}">區域 ${String(i+1).padStart(2,'0')}<small>${esc([...r.kinds].join('、'))}</small>${attributeSummary(r)}</button>`).join(''):'<p>本頁沒有差異。</p>';
 document.querySelectorAll('.region').forEach(b=>b.onclick=()=>focusRegion(Number(b.dataset.index)));
}
function sizeCanvases(){for(const side of ['before','after']){const view=$(side+'Viewport');$(side+'Canvas').style.width=Math.max(100,(view.clientWidth-32)*zoom)+'px';}$('zoomLabel').textContent=Math.round(zoom*100)+'%';}
function focusRegion(index){selectedRegion=index;const r=regions[index],reference=result.pages[pageIndex].before||result.pages[pageIndex].after;zoom=Math.max(zoom,Math.min(8,Math.max(2,reference.width/(r.box[2]-r.box[0]+80)*.85)));sizeCanvases();document.querySelectorAll('.region').forEach(b=>b.classList.toggle('active',Number(b.dataset.index)===index));for(const side of ['before','after']){const page=result.pages[pageIndex][side];if(!page)continue;const canvas=$(side+'Canvas'),view=$(side+'Viewport'),scale=canvas.clientWidth/page.width,rect=canvas.querySelector('.focus-box');const [x,y,x1,y1]=r.box;for(const [k,v]of Object.entries({x:x-10,y:y-10,width:x1-x+20,height:y1-y+20,visibility:'visible'}))rect.setAttribute(k,v);view.scrollLeft=(x+x1)/2*scale-view.clientWidth/2;view.scrollTop=(y+y1)/2*scale-view.clientHeight/2;}}
$('pageSelect').onchange=()=>{selectedRegion=null;pageIndex=Number($('pageSelect').value);render();for(const side of ['before','after'])$(side+'Viewport').scrollTo(0,0);};$('annotations').onchange=()=>{selectedRegion=null;render();};$('context').onchange=render;$('zoomIn').onclick=()=>{zoom=Math.min(8,zoom+.5);sizeCanvases();};$('zoomOut').onclick=()=>{zoom=Math.max(.5,zoom-.5);sizeCanvases();};$('fit').onclick=()=>{selectedRegion=null;zoom=1;sizeCanvases();for(const side of ['before','after'])$(side+'Viewport').scrollTo(0,0);};window.addEventListener('resize',()=>{if(result)sizeCanvases();});
for(const side of ['before','after']){$(side+'Viewport').onscroll=()=>{if(syncing)return;syncing=true;const source=$(side+'Viewport'),target=$((side==='before'?'after':'before')+'Viewport');target.scrollLeft=source.scrollLeft;target.scrollTop=source.scrollTop;requestAnimationFrame(()=>syncing=false);};}

function attributeSummary(region){
 const group=items=>{const map=new Map();for(const o of items){if(o.kind==='char'&&!o.text.trim())continue;if(o.kind==='char'&&o.word){const key=JSON.stringify(o.word);if(!map.has(key))map.set(key,{...o,text:o.word.text,box:o.word.box});}else map.set('object-'+map.size,o);}return [...map.values()].sort((a,b)=>(a.kind==='char'?0:1)-(b.kind==='char'?0:1));};
 const before=group(region.objects.before),after=group(region.objects.after),used=new Set(),rows=[];
 const fmt=n=>Number(n).toFixed(2).replace(/\.?0+$/,'');
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const center=o=>[(o.box[0]+o.box[2])/2,(o.box[1]+o.box[3])/2];
 const text=t=>`「${String(t).length>55?String(t).slice(0,55)+'…':t}」`;
 const row=(label,a,b)=>`<span class="attribute"><span class="attribute-label">${esc(label)}</span><span class="old-value">${esc(a)}</span><span class="attribute-arrow"> → </span><span class="new-value">${esc(b)}</span></span>`;
 for(const a of before){let best=-1,bestScore=Infinity;after.forEach((b,i)=>{if(used.has(i)||a.kind!==b.kind)return;const ac=center(a),bc=center(b),dist=Math.hypot(ac[0]-bc[0],ac[1]-bc[1]);const edge=Math.max(...a.box.map((v,j)=>Math.abs(v-b.box[j])));const exactText=a.text&&a.text===b.text;const threshold=a.kind==='char'?45:12;if(dist>threshold||edge>(a.kind==='char'?100:25))return;const score=(a.kind==='char'?Math.hypot(a.box[0]-b.box[0],a.box[1]-b.box[1]):dist)+(exactText?-5:0);if(score<bestScore){best=i;bestScore=score;}});
 if(best<0){rows.push(row(names[a.kind]+'移除',a.kind==='char'||a.kind==='annotation'?text(a.text||'批註'):boxText(a.box),'—'));continue;}
 used.add(best);const b=after[best];let changed=false;
 if(a.text!==b.text){rows.push(row(a.kind==='image'?'圖片內容':'文字',a.kind==='image'?'原圖片':text(a.text||''),a.kind==='image'?'新圖片':text(b.text||'')));changed=true;}
 if(a.kind==='char'){for(const [index,label]of [[0,'字型'],[1,'字級'],[2,'文字顏色']])if(!same(a.style?.[index],b.style?.[index])){rows.push(row(label,styleText(a.style?.[index]),styleText(b.style?.[index])));changed=true;}}
 else if(a.kind!=='annotation'&&a.kind!=='image'){for(const [index,label]of [[0,'線寬 (pt)'],[1,'描邊'],[2,'填色'],[3,'線條顏色'],[4,'填色顏色'],[5,'虛線樣式']])if(!same(a.style?.[index],b.style?.[index])){rows.push(row(label,styleText(a.style?.[index]),styleText(b.style?.[index])));changed=true;}}
 if(!same(a.box,b.box)&&(!changed||a.text===b.text)){rows.push(row('位置 / 範圍 (pt)',boxText(a.box),boxText(b.box)));changed=true;}
 if(!changed&&!same(a.path,b.path))rows.push(row('路徑節點',JSON.stringify(a.path).slice(0,180),JSON.stringify(b.path).slice(0,180)));
 else if(!changed&&!same(a.style,b.style))rows.push(row('批註樣式',styleText(a.style),styleText(b.style)));
 else if(!changed&&!same(a.matrix,b.matrix))rows.push(row('文字變換',JSON.stringify(a.matrix),JSON.stringify(b.matrix)));
 }
 after.forEach((b,i)=>{if(!used.has(i))rows.push(row(names[b.kind]+'新增','—',b.kind==='char'||b.kind==='annotation'?text(b.text||'批註'):boxText(b.box)));});
 const unique=[...new Set(rows)];return '<span class="attribute-list">'+(unique.length?unique.join(''):'<span class="attribute-label">空白字元或物件繪製方式變更</span>')+'</span>';
 function boxText(box){return '('+box.map(fmt).join(', ')+')';}
 function styleText(v){if(v==null)return '無';if(typeof v==='boolean')return v?'是':'否';if(typeof v==='number')return fmt(v);if(Array.isArray(v))return JSON.stringify(v);return String(v);}
}
