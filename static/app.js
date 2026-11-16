const $=id=>document.getElementById(id);
const sides = ['before', 'after'];
const panes = {};
let viewer, pdfs, renderVersion = 0;
const files={before:null,after:null};let result=null,pageIndex=0,zoom=1,regions=[],syncing=false,selectedRegion=null;
const names={line:'直線',curve:'向量路徑',rect:'矩形',char:'文字',image:'圖片',annotation:'批註'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function selectFile(side,file){if(!file)return;files[side]=file;$(side+'Name').textContent=file.name;updateButton();}
function updateButton(){$('compare').disabled=!files.before||!files.after;}
for(const side of ['before','after']){const input=$(side+'File'),drop=$(side+'Drop');input.onchange=()=>selectFile(side,input.files[0]);drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag');};drop.ondragleave=()=>drop.classList.remove('drag');drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');if(!$('compare').dataset.busy)selectFile(side,e.dataTransfer.files[0]);};}
$('compare').onclick=async()=>{
 const before=files.before,after=files.after;if(!before||!after)return;
 if(before.size+after.size>80*1024*1024){$('status').textContent='兩份檔案合計不可超過 80 MB。';return;}
 $('compare').disabled=true;$('compare').dataset.busy='1';$('beforeFile').disabled=$('afterFile').disabled=true;
 $('status').className='busy';$('status').textContent='正在本機解析文字、向量線條與批註，再比對物件… 大型施工圖可能需要一至數分鐘。';$('results').hidden=true;$('empty').hidden=true;
 try{const response=await fetch('/api/compare',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Before-Length':String(before.size)},body:new Blob([before,after])});const data=await response.json();if(!response.ok)throw Error(data.error||'比對失敗');viewer ??= await import('/viewer.mjs');
 const next = {before: viewer.openPdf(before), after: viewer.openPdf(after)};
 try {
   await Promise.all(sides.map(side => next[side].document));
 } catch (error) {
   await Promise.allSettled(sides.map(side => next[side].destroy()));
   throw error;
 }
 clearPanes();
 if (pdfs) await Promise.allSettled(sides.map(side => pdfs[side].destroy()));
 pdfs = next;
 result=data;result.filenames={before:before.name,after:after.name};pageIndex=0;zoom=1;selectedRegion=null;resetScroll();
 $('pageSelect').innerHTML=result.pages.map((_,i)=>`<option value="${i}">第 ${i+1} 頁</option>`).join('');$('results').hidden=false;$('status').textContent='';await render();
 }catch(e){$('status').className='';$('status').textContent=e.message||'無法連線至本機服務，請確認網站已啟動。';$('empty').hidden=false;}
 finally{delete $('compare').dataset.busy;$('beforeFile').disabled=$('afterFile').disabled=false;updateButton();}
};
function changes(page){return(page?.changes||[]).filter(o=>$('annotations').checked||o.kind!=='annotation');}
function vector(o,color,highlight){const width=Math.max(.65,Number(o.style?.[0])||0),fill=o.style?.[2]?color:'none';let d=(o.path||[]).map(seg=>seg[0].toUpperCase()+' '+seg.slice(1).flat().join(' ')).join(' ');if(o.kind==='rect')d+=' Z';return `<path d="${esc(d)}" fill="${fill}" fill-opacity="${highlight ? .2 : 1}" fill-rule="${o.style?.[6]?'evenodd':'nonzero'}" stroke="${(highlight || o.style?.[1])?color:'none'}" stroke-width="${width}"/>`;}
function diagram(page, side, box, annotationRegions) {
 const color = side === 'before' ? '#cc4747' : '#07875c';
 const diffOnly = $('mode').value === 'diff';
 const [left, top, width, height] = box;
 const marks = [], annotations = [], clips = [];
 for (const o of changes(page)) {
   const [x, y, right, bottom] = o.box;
   const w = Math.max(right - x, .5), h = Math.max(bottom - y, .5);
   const annotation = o.kind === 'annotation';
   const raster = annotation || o.kind === 'char' || o.kind === 'image';
   if (!raster) {
     marks.push(vector(o, color, !diffOnly));
     continue;
   }
   const pad = annotation ? 2 : .3;
   if (diffOnly) {
     clips.push(`<rect x="${(x - left - pad) / width}" y="${(y - top - pad) / height}"
        width="${(w + 2 * pad) / width}" height="${(h + 2 * pad) / height}"/>`);
   }
   const target = annotationRegions.get(o);
   const action = annotation
     ? `class="annotation-target" data-region-index="${target?.regionIndex}" data-annotation-key="${target?.key}" role="button" tabindex="0"
        aria-label="${esc(`顯示批註 · 區域 ${(target?.regionIndex ?? 0) + 1}：${o.text || '批註'}`)}"`
     : '';
   (annotation ? annotations : marks).push(`<rect ${action} x="${x - pad}" y="${y - pad}" width="${w + 2 * pad}" height="${h + 2 * pad}"
       fill="${annotation ? 'none' : color}" fill-opacity=".17" stroke="${color}"
       stroke-width="1" vector-effect="non-scaling-stroke" ${annotation ? 'stroke-dasharray="3 3"' : ''}>
       <title>${esc(annotation ? o.text || '批註' : o.kind === 'char' ? o.text : '圖片')}</title></rect>`);
 }
 return `<div class="pdf-layer" aria-hidden="true"
   style="${diffOnly ? `clip-path:url(#${side}-clips)` : $('mode').value === 'faded' ? 'opacity:.23' : ''}"></div>
   <svg class="diff-overlay" viewBox="${box.join(' ')}" preserveAspectRatio="none"
       role="group" aria-label="${side} 差異圖面">
       <defs><clipPath id="${side}-clips" clipPathUnits="objectBoundingBox">${clips.join('')}</clipPath></defs>
       ${marks.join('')}${annotations.join('')}<rect class="focus-box" fill="none" stroke="#dc9c22" stroke-width="3" vector-effect="non-scaling-stroke" visibility="hidden"/>
   </svg>`;
}

function clearPanes() {
 for (const side of sides) {
   panes[side]?.dispose();
   delete panes[side];
 }
}

async function render() {
 if (!result) return;
 const version = ++renderVersion;
 const positions = Object.fromEntries(sides.map(side => {
   const view = $(side+'Viewport');
   return [side, [view.scrollLeft, view.scrollTop]];
 }));
 clearPanes();
 let removed=0,added=0;result.pages.forEach(p=>{removed+=changes(p.before).length;added+=changes(p.after).length;});$('removedTotal').textContent=removed.toLocaleString();$('addedTotal').textContent=added.toLocaleString();$('summaryTitle').textContent=`${result.pages.length} 頁已解析 · ${result.pages.filter(p=>changes(p.before).length+changes(p.after).length>0).length} 頁有差異`;
 const page = result.pages[pageIndex], number = pageIndex + 1;
 buildRegions(page);
 for (const side of sides) {
   $(side+'Canvas').innerHTML = `<div class="missing">${page[side] ? '載入原始圖面…' : '此版本沒有對應頁面'}</div>`;
   $(side+'Canvas').style.height = '';
   $(side+'Caption').textContent = result.filenames[side];
 }
 await Promise.all(sides.map(async side => {
   if (!page[side]) return;
   const report = error => {
     if (version !== renderVersion) return;
     console.error(error);
     $('status').textContent = '無法顯示部分原始 PDF 圖面。';
   };
   try {
     const pdfPage = await (await pdfs[side].document).getPage(number);
     if (version !== renderVersion) return;
     const canvas = $(side+'Canvas');
     const box = viewer.displayBox(page[side].mediaBox, pdfPage.view, pdfPage.rotate);
     const annotationRegions = new Map();
     regions.forEach((region, index) => {
       region.objects[side].forEach((object, objectIndex) => {
         if (object.kind === 'annotation') {
           annotationRegions.set(object, { regionIndex: index, key: `${side}-${objectIndex}` });
         }
       });
     });
     canvas.innerHTML = diagram(page[side], side, box, annotationRegions);
     let lastClick;
     for (const target of canvas.querySelectorAll('.annotation-target')) {
       const select = selected => {
         const { regionIndex, annotationKey } = selected.dataset;
         focusRegion(Number(regionIndex), false, annotationKey);
         selected.classList.add('selected-annotation');
       };
       target.addEventListener('click', event => {
         if (event.detail === 0) {
           lastClick = null;
           select(target);
           return;
         }
         const hits = document.elementsFromPoint(event.clientX, event.clientY)
           .filter(element => element.matches('.annotation-target') && canvas.contains(element));
         const bounds = canvas.getBoundingClientRect();
         const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
         const previous = lastClick && Math.hypot(x - lastClick.x, y - lastClick.y) <= 5
           ? lastClick.target : null;
         const selected = pickAnnotation(hits, previous) || target;
         lastClick = { x, y, target: selected };
         select(selected);
       });
       target.addEventListener('keydown', event => {
         if (event.key !== 'Enter' && event.key !== ' ') return;
         event.preventDefault();
         lastClick = null;
         select(target);
       });
     }
     panes[side] = new viewer.PdfPane(pdfPage, box,
         canvas.querySelector('.pdf-layer'), $(side+'Viewport'), $('annotations').checked, report);
   } catch (error) {
     report(error);
     if (version === renderVersion) $(side+'Canvas').textContent = '無法顯示原始 PDF 圖面。';
   }
 }));
 if (version !== renderVersion) return;
 const warning=[];if(!page.sameSize)warning.push('兩頁尺寸不同，尚未自動對齊；位置差異可能造成大量標示。');if([page.before,page.after].some(p=>p?.counts.image&&!p?.counts.char&&!p?.counts.line&&!p?.counts.curve))warning.push('此頁可能為掃描圖，會以整個圖片物件比對，沒有 OCR。');$('pageWarning').hidden=!warning.length;$('pageWarning').textContent=warning.join(' ');
 sizeCanvases();
 for (const side of sides) $(side+'Viewport').scrollTo(...positions[side]);
 if (selectedRegion !== null && regions[selectedRegion]) focusRegion(selectedRegion, false);
 $('parseInfo').innerHTML='<table><thead><tr><th>本頁解析物件</th><th>Before</th><th>After</th></tr></thead><tbody>'+Object.entries(names).map(([k,n])=>`<tr><td>${n}</td><td>${(page.before?.counts[k]||0).toLocaleString()}</td><td>${(page.after?.counts[k]||0).toLocaleString()}</td></tr>`).join('')+'</tbody></table><p>原始 PDF 由瀏覽器繪製。總覽先顯示低解析度預覽，放大後會重新繪製可見區域。</p>';
}
function buildRegions(page){const map=new Map(),w=Math.max(page.before?.width||0,page.after?.width||0),h=Math.max(page.before?.height||0,page.after?.height||0);
 for(const side of ['before','after'])for(const o of changes(page[side])){const b=o.box,x=(b[0]+b[2])/2,y=(b[1]+b[3])/2,key=`${Math.floor(y/h*6)}:${Math.floor(x/w*8)}`;if(!map.has(key))map.set(key,{box:[...b],before:0,after:0,kinds:new Set(),texts:[],objects:{before:[],after:[]}});const r=map.get(key);r.box=[Math.min(r.box[0],b[0]),Math.min(r.box[1],b[1]),Math.max(r.box[2],b[2]),Math.max(r.box[3],b[3])];r[side]++;r.objects[side].push(o);r.kinds.add(names[o.kind]);if(o.kind==='annotation'&&o.text)r.texts.push(o.text);}
 regions=[...map.values()].sort((a,b)=>a.box[1]-b.box[1]||a.box[0]-b.box[0]);$('regionCount').textContent=regions.length;$('regions').innerHTML=regions.length?regions.map((r,i)=>`<button class="region" data-index="${i}" title="${esc(r.texts.join(' / '))}">區域 ${String(i+1).padStart(2,'0')}<small>${esc([...r.kinds].join('、'))}</small></button>`).join(''):'<p>本頁沒有差異。</p>';
 document.querySelectorAll('.region').forEach(b=>b.onclick=()=>focusRegion(Number(b.dataset.index)));
 showRegionObjects(null);
}
function sizeCanvases(preserveCenter = false) {
 for (const side of sides) {
   const view = $(side+'Viewport'), canvas = $(side+'Canvas'), pane = panes[side];
   const inset = parseFloat(getComputedStyle(view).paddingLeft);
   const width = Math.max(100, (view.clientWidth - 2 * inset) * zoom);
   const previousWidth = canvas.clientWidth;
   const ratio = width / previousWidth;
   canvas.style.width = width + 'px';
   if (!pane) continue;
   canvas.style.height = width * pane.box[3] / pane.box[2] + 'px';
   pane.resize(width, zoom > 1);
   if (preserveCenter && previousWidth) {
     const centerX = view.clientWidth / 2 - inset;
     const centerY = view.clientHeight / 2 - inset;
     view.scrollTo((view.scrollLeft + centerX) * ratio - centerX,
                   (view.scrollTop + centerY) * ratio - centerY);
   }
 }
 $('zoomLabel').textContent = Math.round(zoom * 100) + '%';
}

function clearObjectSelection() {
 document.querySelectorAll('.selected-object, .selected-annotation').forEach(element =>
   element.classList.remove('selected-object', 'selected-annotation'));
}

function showRegionObjects(index, annotationKey) {
 $('objectTable').hidden = index === null;
 $('objectPrompt').hidden = index !== null;
 $('objectTitle').textContent = index === null
   ? '區域物件差異' : `區域 ${String(index + 1).padStart(2, '0')} · 物件差異`;
 $('objectRows').innerHTML = index === null ? '' : attributeSummary(regions[index], annotationKey);
}

$('objectRows').onclick = event => {
 const row = event.target.closest('tr[data-object-keys]');
 if (!row || selectedRegion === null) return;
 const region = regions[selectedRegion];
 document.querySelector('.columns').scrollIntoView({ block: 'nearest', inline: 'nearest' });
 clearObjectSelection();
 row.classList.add('selected-object');
 syncing = true;
 for (const side of sides) {
   const pane = panes[side];
   if (!pane?.viewport) continue;
   const key = row.dataset.objectKeys.split(' ').find(value => value.startsWith(side + '-'));
   const object = key && region.objects[side][Number(key.slice(side.length + 1))];
   const rect = $(side+'Canvas').querySelector('.focus-box');
   rect.setAttribute('visibility', object ? 'visible' : 'hidden');
   if (!object) continue;
   const [x, y, right, bottom] = object.box;
   const scale = pane.viewport.width / pane.box[2];
   const padding = 5 / scale;
   for (const [name, value] of Object.entries({
     x: x - padding, y: y - padding,
     width: right - x + 2 * padding, height: bottom - y + 2 * padding,
   })) rect.setAttribute(name, value);
   const view = $(side+'Viewport');
   const inset = parseFloat(getComputedStyle(view).paddingLeft);
   const [cx, cy] = viewer.pagePoint(pane.box, scale, (x + right) / 2, (y + bottom) / 2);
   view.scrollTo(cx + inset - view.clientWidth / 2, cy + inset - view.clientHeight / 2);
 }
 requestAnimationFrame(() => { syncing = false; });
};

function focusRegion(index, moveView = true, annotationKey) {
 clearObjectSelection();
 selectedRegion = index;
 showRegionObjects(index, annotationKey);
 const [x, y, x1, y1] = regions[index].box;
 const reference = panes.before || panes.after;
 if (!reference) return;
 if (moveView) {
   zoom = Math.max(zoom, Math.min(8, Math.max(2, reference.box[2] / (x1 - x + 80) * .85)));
   sizeCanvases();
 }
 document.querySelectorAll('.region').forEach(button =>
   button.classList.toggle('active', Number(button.dataset.index) === index));
 for (const side of sides) {
   const pane = panes[side];
   if (!pane) continue;
   const canvas = $(side+'Canvas'), view = $(side+'Viewport');
   const inset = parseFloat(getComputedStyle(view).paddingLeft);
   const rect = canvas.querySelector('.focus-box');
   for (const [key, value] of Object.entries({
     x: x - 10, y: y - 10, width: x1 - x + 20, height: y1 - y + 20, visibility: 'visible',
   })) rect.setAttribute(key, value);
   if (!moveView) continue;
   const [cx, cy] = viewer.pagePoint(pane.box, pane.viewport.width / pane.box[2], (x + x1) / 2, (y + y1) / 2);
   view.scrollTo(cx + inset - view.clientWidth / 2, cy + inset - view.clientHeight / 2);
 }
 return document.querySelector('.region.active');
}

function resetScroll() {
 for (const side of sides) $(side+'Viewport').scrollTo(0, 0);
}

$('pageSelect').onchange = () => {
 selectedRegion = null;
 pageIndex = Number($('pageSelect').value);
 resetScroll();
 render();
};
$('annotations').onchange = () => { selectedRegion = null; render(); };
$('mode').onchange = render;
$('zoomIn').onclick = () => { zoom = Math.min(8, zoom + .5); sizeCanvases(true); };
$('zoomOut').onclick = () => { zoom = Math.max(.5, zoom - .5); sizeCanvases(true); };
$('fit').onclick = () => {
 clearObjectSelection();
 selectedRegion = null;
 showRegionObjects(null);
 document.querySelectorAll('.focus-box').forEach(rect => rect.setAttribute('visibility', 'hidden'));
 document.querySelector('.region.active')?.classList.remove('active');
 zoom = 1;
 sizeCanvases();
 resetScroll();
};
window.addEventListener('resize', () => { if (result) sizeCanvases(true); });
for (const side of sides) {
 $(side+'Viewport').onscroll = () => {
   panes[side]?.schedule();
   if (syncing) return;
   const source = $(side+'Viewport');
   const target = $((side === 'before' ? 'after' : 'before')+'Viewport');
   syncing = true;
   target.scrollTo(source.scrollLeft, source.scrollTop);
   requestAnimationFrame(() => { syncing = false; });
 };
}

function attributeSummary(region, selectedKey){
 const group=items=>{const map=new Map();for(const o of items){if(o.kind==='char'&&!o.text.trim())continue;if(o.kind==='char'&&o.word){const key=JSON.stringify(o.word);if(!map.has(key))map.set(key,{...o,source:o,text:o.word.text,box:o.word.box});}else map.set('object-'+map.size,o);}return [...map.values()].sort((a,b)=>(a.kind==='char'?0:1)-(b.kind==='char'?0:1));};
 const before=group(region.objects.before),after=group(region.objects.after),used=new Set(),rows=[];
 const fmt=n=>String(Number(Number(n).toFixed(2)));
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const center=o=>[(o.box[0]+o.box[2])/2,(o.box[1]+o.box[3])/2];
 const text=t=>`「${t}」`;
 const objectKeys = new Map();
 for (const side of ['before', 'after']) {
   region.objects[side].forEach((object, index) => {
     objectKeys.set(object, `${side}-${index}`);
   });
 }
 let fields = [];
 const row = (label, a, b) => fields.push([label, a, b]);
 const describe = object => {
   if (object.kind === 'char' || object.kind === 'annotation') return text(object.text || '批註');
   if (object.kind === 'image') return '圖片';
   return '';
 };
 const addObject = (before, after) => {
   const object = before || after;
   const keys = [before, after].map(item => objectKeys.get(item?.source ?? item)).filter(Boolean);
   const status = before && after ? '修改' : before ? '移除' : '新增';
   const cell = (item, column, color) => {
     if (!item) return '<td class="object-empty">—</td>';
     const content = describe(item);
     const details = fields.map(field =>
       `<div><small>${esc(field[0])}</small> ${esc(field[column])}</div>`).join('');
     return `<td><div class="${color}">${esc(content || names[item.kind])}</div>
       <div class="object-position">${esc(boxText(item.box))} pt</div>${details}</td>`;
   };
   const attributes = ` data-object-keys="${keys.join(' ')}"`;
   const selected = selectedKey && keys.includes(selectedKey) ? ' class="selected-object"' : '';
   rows.push({
     box: object.box,
     html: `<tr${attributes}${selected}><th scope="row"><button type="button" class="locate-object">${esc(names[object.kind])}${status}</button></th>
       ${cell(before, 1, 'old-value')}${cell(after, 2, 'new-value')}</tr>`,
   });
   fields = [];
 };
 for(const a of before){let best=-1,bestScore=Infinity;after.forEach((b,i)=>{if(used.has(i)||a.kind!==b.kind)return;const ac=center(a),bc=center(b),dist=Math.hypot(ac[0]-bc[0],ac[1]-bc[1]);const edge=Math.max(...a.box.map((v,j)=>Math.abs(v-b.box[j])));const exactText=a.text&&a.text===b.text;const threshold=a.kind==='char'?45:12;if(dist>threshold||edge>(a.kind==='char'?100:25))return;const score=(a.kind==='char'?Math.hypot(a.box[0]-b.box[0],a.box[1]-b.box[1]):dist)+(exactText?-5:0);if(score<bestScore){best=i;bestScore=score;}});
 if(best<0){addObject(a,null);continue;}
 used.add(best);const b=after[best];let changed=false;
 if(a.text!==b.text){row(a.kind==='image'?'圖片內容':a.kind==='annotation'?'批註內容':'文字',a.kind==='image'?'原圖片':text(a.text||''),a.kind==='image'?'新圖片':text(b.text||''));changed=true;}
 if(a.kind==='char'){for(const [index,label]of [[0,'字型'],[1,'字級'],[2,'文字顏色']])if(!same(a.style?.[index],b.style?.[index])){row(label,styleText(a.style?.[index]),styleText(b.style?.[index]));changed=true;}}
 else if(a.kind!=='annotation'&&a.kind!=='image'){for(const [index,label]of [[0,'線寬 (pt)'],[1,'描邊'],[2,'填色'],[3,'線條顏色'],[4,'填色顏色'],[5,'虛線樣式']])if(!same(a.style?.[index],b.style?.[index])){row(label,styleText(a.style?.[index]),styleText(b.style?.[index]));changed=true;}}
 if(!same(a.box,b.box)&&(!changed||a.text===b.text)){row('位置 / 範圍 (pt)',boxText(a.box),boxText(b.box));changed=true;}
 if(!changed&&!same(a.path,b.path))row('路徑節點',JSON.stringify(a.path).slice(0,180),JSON.stringify(b.path).slice(0,180));
 else if(!changed&&!same(a.style,b.style))row('批註樣式',styleText(a.style),styleText(b.style));
 else if(!changed&&!same(a.matrix,b.matrix))row('文字變換',JSON.stringify(a.matrix),JSON.stringify(b.matrix));
 addObject(a,b);
 }
 after.forEach((b,i)=>{if(!used.has(i))addObject(null,b);});
 return rows.sort((a,b)=>a.box[1]-b.box[1]||a.box[0]-b.box[0]).map(row=>row.html).join('');
 function boxText(box){return '('+box.map(fmt).join(', ')+')';}
 function styleText(v){if(v==null)return '無';if(typeof v==='boolean')return v?'是':'否';if(typeof v==='number')return fmt(v);if(Array.isArray(v))return JSON.stringify(v);return String(v);}
}

function pickAnnotation(hits, previous) {
 const area = element => Number(element.getAttribute('width')) * Number(element.getAttribute('height'));
 const ordered = [...hits].sort((a, b) => area(a) - area(b));
 return ordered[(ordered.indexOf(previous) + 1) % ordered.length];
}
