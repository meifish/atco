const $=id=>document.getElementById(id);
const sides = ['before', 'after'];
const panes = {};
let viewer, pdfs, renderVersion = 0;
const files={before:null,after:null};let result=null,pageIndex=0,zoom=1,regions=[],syncing=false,selectedRegion=null;
const names={line:'Line',curve:'Vector path',rect:'Rectangle',char:'Text',image:'Image',annotation:'Annotation'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function selectFile(side,file){if(!file)return;files[side]=file;$(side+'Name').textContent=file.name;updateButton();}
function updateButton(){$('compare').disabled=!files.before||!files.after;}
for(const side of ['before','after']){const input=$(side+'File'),drop=$(side+'Drop');input.onchange=()=>selectFile(side,input.files[0]);drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag');};drop.ondragleave=()=>drop.classList.remove('drag');drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');if(!$('compare').dataset.busy)selectFile(side,e.dataTransfer.files[0]);};}
let auth, appConfig, polling = 0;
const VIEW_KEY = 'redline-diff:view';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const api = (path, options) => auth.apiFetch(path, options);
async function apiJson(path, options) {
 const response = await api(path, options);
 if (response.status === 204) return null;
 const data = await response.json().catch(() => ({}));
 if (!response.ok) throw Error(data.error || 'Comparison failed.');
 return data;
}
async function upload(form, file) {
 const body = new FormData();
 for (const [name, value] of Object.entries(form.fields)) body.append(name, value);
 body.append('file', file);  // S3 requires the file to be the last field
 const response = await fetch(form.url, { method: 'POST', body });
 if (!response.ok) throw Error('Upload failed. Check your connection and try again.');
}
async function download(url, kind) {
 const response = await fetch(url);
 if (!response.ok) throw Error('Could not load the result. It may have expired or been deleted when you signed out.');
 return kind === 'json' ? response.json() : response.blob();
}
function setBusy(busy, message) {
 if (busy) { $('compare').disabled = true; $('compare').dataset.busy = '1'; }
 else { delete $('compare').dataset.busy; updateButton(); }
 $('beforeFile').disabled = $('afterFile').disabled = busy;
 $('status').className = busy ? 'busy' : '';
 $('status').textContent = message || '';
}
// Polls the job until it finishes. Polling is not user activity, so it never extends the session.
async function waitForJob(jobId) {
 const run = ++polling;
 for (let delay = 1500; ; delay = Math.min(delay * 1.3, 5000)) {
   const job = await apiJson('/api/jobs/' + jobId);
   if (run !== polling) return null;
   if (job.status === 'done') return job;
   if (job.status === 'failed' || job.status === 'cancelled') throw Error(job.error || 'Comparison failed.');
   $('status').textContent = job.status === 'pending'
     ? 'Queued. Waiting for the comparison to start…'
     : 'Parsing text, vectors and annotations, then comparing objects… Large drawings can take a few minutes.';
   await sleep(delay);
 }
}
async function showResult(job, localFiles, view) {
 const data = await download(job.result_url, 'json');
 const blobs = localFiles || Object.fromEntries(await Promise.all(sides.map(async side => [side, await download(job[side + '_url'])])));
 viewer ??= await import('/viewer.mjs');
 const next = {before: viewer.openPdf(blobs.before), after: viewer.openPdf(blobs.after)};
 try {
   await Promise.all(sides.map(side => next[side].document));
 } catch (error) {
   await Promise.allSettled(sides.map(side => next[side].destroy()));
   throw error;
 }
 clearPanes();
 if (pdfs) await Promise.allSettled(sides.map(side => pdfs[side].destroy()));
 pdfs = next;
 result = data; result.jobId = job.job_id; result.filenames = job.filenames;
 pageIndex = 0; zoom = 1; selectedRegion = null; resetScroll();
 if (view?.jobId === job.job_id) {
   pageIndex = Math.min(Math.max(0, Number(view.page) || 0), result.pages.length - 1);
   zoom = Math.min(8, Math.max(.5, Number(view.zoom) || 1));
   if (['original', 'faded', 'diff'].includes(view.mode)) $('mode').value = view.mode;
   if (typeof view.annotations === 'boolean') $('annotations').checked = view.annotations;
 }
 $('pageSelect').innerHTML = result.pages.map((_, i) => `<option value="${i}">Page ${i + 1}</option>`).join('');
 $('pageSelect').value = String(pageIndex);
 $('results').hidden = false; $('empty').hidden = true; $('status').textContent = '';
 await render();
}
function saveView() {
 if (!result?.jobId) return;
 localStorage.setItem(VIEW_KEY, JSON.stringify({ jobId: result.jobId, page: pageIndex, zoom,
   mode: $('mode').value, annotations: $('annotations').checked }));
}
function readView() { try { return JSON.parse(localStorage.getItem(VIEW_KEY)); } catch { return null; } }
for (const type of ['click', 'change']) document.addEventListener(type, () => setTimeout(saveView), true);
$('compare').onclick=async()=>{
 const before=files.before,after=files.after;if(!before||!after)return;
 if(before.size+after.size>80*1024*1024){$('status').textContent='The two files together must be 80 MB or less.';return;}
 setMaximized(false); setBusy(true, 'Uploading files…'); $('results').hidden = true; $('empty').hidden = true;
 try {
   const { job_id, uploads } = await apiJson('/api/uploads', { method: 'POST' });
   await Promise.all(sides.map(side => upload(uploads[side], files[side])));
   await apiJson('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ job_id, filenames: { before: before.name, after: after.name } }) });
   const job = await waitForJob(job_id);
   if (job) await showResult(job, { before, after });
 } catch (e) {
   $('status').className=''; $('status').textContent=e.message||'Could not reach the service. Please try again.'; $('empty').hidden=false;
 } finally { delete $('compare').dataset.busy; $('beforeFile').disabled=$('afterFile').disabled=false; updateButton(); if ($('status').className === 'busy') $('status').className = ''; }
};
// After a reload, bring back the last comparison (or keep waiting for one still running).
async function restore() {
 const last = await apiJson('/api/me/last-result').catch(() => null);
 if (!last || last.status === 'failed' || last.status === 'cancelled') return;
 setBusy(true, 'Restoring your last comparison…'); $('empty').hidden = true;
 try {
   const job = last.status === 'done' ? last : await waitForJob(last.job_id);
   if (job) await showResult(job, null, readView());
 } catch (e) { $('status').className = ''; $('status').textContent = e.message; $('empty').hidden = false; }
 finally { const message = $('status').className === 'busy' ? '' : $('status').textContent; setBusy(false, message); }
}
(async () => {
 try {
   appConfig = await (await fetch('/api/config')).json();
   auth = await import('/auth.js');
   const session = await auth.init(appConfig);
   if (!session.signedIn) return;
   if (appConfig.auth) {
     $('modeBadge').style.display = 'none';
     $('userEmail').textContent = session.email;
     $('logout').hidden = false;
   }
   await restore();
 } catch (e) { $('status').textContent = 'Could not reach the service. Make sure the server is running.'; }
})();
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
        aria-label="${esc(`Show annotation · region ${(target?.regionIndex ?? 0) + 1}: ${o.text || 'Annotation'}`)}"`
     : '';
   (annotation ? annotations : marks).push(`<rect ${action} x="${x - pad}" y="${y - pad}" width="${w + 2 * pad}" height="${h + 2 * pad}"
       fill="${annotation ? 'none' : color}" fill-opacity=".17" stroke="${color}"
       stroke-width="1" vector-effect="non-scaling-stroke" ${annotation ? 'stroke-dasharray="3 3"' : ''}>
       <title>${esc(annotation ? o.text || 'Annotation' : o.kind === 'char' ? o.text : 'Image')}</title></rect>`);
 }
 return `<div class="pdf-layer" aria-hidden="true"
   style="${diffOnly ? `clip-path:url(#${side}-clips)` : $('mode').value === 'faded' ? 'opacity:.23' : ''}"></div>
   <svg class="diff-overlay" viewBox="${box.join(' ')}" preserveAspectRatio="none"
       role="group" aria-label="${side} drawing changes">
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
 let removed=0,added=0;result.pages.forEach(p=>{removed+=changes(p.before).length;added+=changes(p.after).length;});$('removedTotal').textContent=removed.toLocaleString();$('addedTotal').textContent=added.toLocaleString();$('summaryTitle').textContent=`${result.pages.length} ${result.pages.length===1?'page':'pages'} parsed · ${result.pages.filter(p=>changes(p.before).length+changes(p.after).length>0).length} with changes`;
 const page = result.pages[pageIndex], number = pageIndex + 1;
 buildRegions(page);
 for (const side of sides) {
   $(side+'Canvas').innerHTML = `<div class="missing">${page[side] ? 'Loading original drawing…' : 'No matching page in this version'}</div>`;
   $(side+'Canvas').style.height = '';
   $(side+'Caption').textContent = result.filenames[side];
 }
 await Promise.all(sides.map(async side => {
   if (!page[side]) return;
   const report = error => {
     if (version !== renderVersion) return;
     console.error(error);
     $('status').textContent = 'Some original PDF pages could not be displayed.';
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
     if (version === renderVersion) $(side+'Canvas').textContent = 'The original PDF page could not be displayed.';
   }
 }));
 if (version !== renderVersion) return;
 const warning=[];if(!page.sameSize)warning.push('The two pages are different sizes and are not aligned automatically, so position differences may produce many marks.');if([page.before,page.after].some(p=>p?.counts.image&&!p?.counts.char&&!p?.counts.line&&!p?.counts.curve))warning.push('This page may be a scan. It is compared as a whole image, with no OCR.');$('pageWarning').hidden=!warning.length;$('pageWarning').textContent=warning.join(' ');
 sizeCanvases();
 for (const side of sides) $(side+'Viewport').scrollTo(...positions[side]);
 if (selectedRegion !== null && regions[selectedRegion]) focusRegion(selectedRegion, false);
 $('parseInfo').innerHTML='<table><thead><tr><th>Objects on this page</th><th>Before</th><th>After</th></tr></thead><tbody>'+Object.entries(names).map(([k,n])=>`<tr><td>${n}</td><td>${(page.before?.counts[k]||0).toLocaleString()}</td><td>${(page.after?.counts[k]||0).toLocaleString()}</td></tr>`).join('')+'</tbody></table><p>The original PDF is rendered in your browser. The overview starts as a low-resolution preview, and the visible area is redrawn sharper when you zoom in.</p>';
}
function buildRegions(page){const map=new Map(),w=Math.max(page.before?.width||0,page.after?.width||0),h=Math.max(page.before?.height||0,page.after?.height||0);
 for(const side of ['before','after'])for(const o of changes(page[side])){const b=o.box,x=(b[0]+b[2])/2,y=(b[1]+b[3])/2,key=`${Math.floor(y/h*6)}:${Math.floor(x/w*8)}`;if(!map.has(key))map.set(key,{box:[...b],before:0,after:0,kinds:new Set(),texts:[],objects:{before:[],after:[]}});const r=map.get(key);r.box=[Math.min(r.box[0],b[0]),Math.min(r.box[1],b[1]),Math.max(r.box[2],b[2]),Math.max(r.box[3],b[3])];r[side]++;r.objects[side].push(o);r.kinds.add(names[o.kind]);if(o.kind==='annotation'&&o.text)r.texts.push(o.text);}
 regions=[...map.values()].sort((a,b)=>a.box[1]-b.box[1]||a.box[0]-b.box[0]);$('regionCount').textContent=regions.length;$('regions').innerHTML=regions.length?regions.map((r,i)=>`<button class="region" data-index="${i}" title="${esc(r.texts.join(' / '))}">Region ${String(i+1).padStart(2,'0')}<small>${esc([...r.kinds].join(', '))}</small></button>`).join(''):'<p>No changes on this page.</p>';
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
   ? 'Objects in region' : `Region ${String(index + 1).padStart(2, '0')} · objects`;
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
function setMaximized(on) {
 const was = $('results').classList.contains('maximized');
 $('results').classList.toggle('maximized', on);
 document.body.classList.toggle('no-scroll', on);
 $('maximize').setAttribute('aria-pressed', String(on));
 $('maximize').textContent = on ? '⤡ Exit full view' : '⤢ Maximize';
 if (result && was !== on) sizeCanvases(true);
}
$('maximize').onclick = () => setMaximized(!$('results').classList.contains('maximized'));
document.addEventListener('keydown', event => {
 if (event.key === 'Escape' && $('results').classList.contains('maximized') && !$('idleDialog').open) setMaximized(false);
});
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
 const text=t=>`“${t}”`;
 const objectKeys = new Map();
 for (const side of ['before', 'after']) {
   region.objects[side].forEach((object, index) => {
     objectKeys.set(object, `${side}-${index}`);
   });
 }
 let fields = [];
 const row = (label, a, b) => fields.push([label, a, b]);
 const describe = object => {
   if (object.kind === 'char' || object.kind === 'annotation') return text(object.text || 'Annotation');
   if (object.kind === 'image') return 'Image';
   return '';
 };
 const addObject = (before, after) => {
   const object = before || after;
   const keys = [before, after].map(item => objectKeys.get(item?.source ?? item)).filter(Boolean);
   const status = before && after ? 'changed' : before ? 'removed' : 'added';
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
     html: `<tr${attributes}${selected}><th scope="row"><button type="button" class="locate-object">${esc(names[object.kind])} ${status}</button></th>
       ${cell(before, 1, 'old-value')}${cell(after, 2, 'new-value')}</tr>`,
   });
   fields = [];
 };
 for(const a of before){let best=-1,bestScore=Infinity;after.forEach((b,i)=>{if(used.has(i)||a.kind!==b.kind)return;const ac=center(a),bc=center(b),dist=Math.hypot(ac[0]-bc[0],ac[1]-bc[1]);const edge=Math.max(...a.box.map((v,j)=>Math.abs(v-b.box[j])));const exactText=a.text&&a.text===b.text;const threshold=a.kind==='char'?45:12;if(dist>threshold||edge>(a.kind==='char'?100:25))return;const score=(a.kind==='char'?Math.hypot(a.box[0]-b.box[0],a.box[1]-b.box[1]):dist)+(exactText?-5:0);if(score<bestScore){best=i;bestScore=score;}});
 if(best<0){addObject(a,null);continue;}
 used.add(best);const b=after[best];let changed=false;
 if(a.text!==b.text){row(a.kind==='image'?'Image content':a.kind==='annotation'?'Annotation text':'Text',a.kind==='image'?'Old image':text(a.text||''),a.kind==='image'?'New image':text(b.text||''));changed=true;}
 if(a.kind==='char'){for(const [index,label]of [[0,'Font'],[1,'Size'],[2,'Text color']])if(!same(a.style?.[index],b.style?.[index])){row(label,styleText(a.style?.[index]),styleText(b.style?.[index]));changed=true;}}
 else if(a.kind!=='annotation'&&a.kind!=='image'){for(const [index,label]of [[0,'Line width (pt)'],[1,'Stroke'],[2,'Fill'],[3,'Stroke color'],[4,'Fill color'],[5,'Dash pattern']])if(!same(a.style?.[index],b.style?.[index])){row(label,styleText(a.style?.[index]),styleText(b.style?.[index]));changed=true;}}
 if(!same(a.box,b.box)&&(!changed||a.text===b.text)){row('Position / bounds (pt)',boxText(a.box),boxText(b.box));changed=true;}
 if(!changed&&!same(a.path,b.path))row('Path points',JSON.stringify(a.path).slice(0,180),JSON.stringify(b.path).slice(0,180));
 else if(!changed&&!same(a.style,b.style))row('Annotation style',styleText(a.style),styleText(b.style));
 else if(!changed&&!same(a.matrix,b.matrix))row('Text transform',JSON.stringify(a.matrix),JSON.stringify(b.matrix));
 addObject(a,b);
 }
 after.forEach((b,i)=>{if(!used.has(i))addObject(null,b);});
 return rows.sort((a,b)=>a.box[1]-b.box[1]||a.box[0]-b.box[0]).map(row=>row.html).join('');
 function boxText(box){return '('+box.map(fmt).join(', ')+')';}
 function styleText(v){if(v==null)return 'none';if(typeof v==='boolean')return v?'yes':'no';if(typeof v==='number')return fmt(v);if(Array.isArray(v))return JSON.stringify(v);return String(v);}
}

function pickAnnotation(hits, previous) {
 const area = element => Number(element.getAttribute('width')) * Number(element.getAttribute('height'));
 const ordered = [...hits].sort((a, b) => area(a) - area(b));
 return ordered[(ordered.indexOf(previous) + 1) % ordered.length];
}
