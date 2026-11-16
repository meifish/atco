const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('static/app.js','utf8');
const context={names:{char:'文字字元',line:'直線'},esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))};vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function attributeSummary(')),context);
const text=(value,box=[0,0,20,10])=>({kind:'char',text:value,box,style:['font',12,[0,0,0]]});
const render=(a,b)=>context.attributeSummary({objects:{before:a,after:b}});
assert.match(render([text('text1')],[text('text2')]),/text1[\s\S]*text2/);
assert.match(render([{kind:'line',box:[0,0,20,10],style:[.36,true,false,0,0]}],[{kind:'line',box:[0,0,20,10],style:[.72,true,false,0,0]}]),/0.36[\s\S]*0.72/);
assert.match(render([text('old')],[text('new',[200,0,220,10])]),/移除[\s\S]*新增/);
assert.ok(!render([text('<script>')],[text('new')]).includes('<script>'));
console.log('4 attribute display tests passed');
const annotation=(value,box)=>({kind:'annotation',text:value,box,style:'FreeText'});
const repeated=render([
    annotation('same note',[0,0,20,10]),
    annotation('same note',[100,100,120,110]),
],[]);
assert.match(repeated,/data-object-keys="before-0"/);
assert.match(repeated,/data-object-keys="before-1"/);
const paired=render([annotation('old note',[0,0,20,10])],[annotation('new note',[0,0,20,10])]);
assert.match(paired,/data-object-keys="before-0 after-0"[\s\S]*old note[\s\S]*new note/);
console.log('2 annotation row linking tests passed');
const hit=(width,height)=>({getAttribute:name=>name==='width'?width:height});
const outer=hit(90,120), inner=hit(10,20), sameSize=hit(10,20);
assert.equal(context.pickAnnotation([outer,inner,sameSize],null),inner);
assert.equal(context.pickAnnotation([outer,inner,sameSize],inner),sameSize);
assert.equal(context.pickAnnotation([outer,inner,sameSize],sameSize),outer);
assert.equal(context.pickAnnotation([outer,inner,sameSize],outer),inner);
assert.equal(context.pickAnnotation([outer],inner),outer);
console.log('5 overlapping annotation selection tests passed');

const region={objects:{before:[annotation('lower',[0,100,20,110]),text('upper')],after:[]}};
const table=context.attributeSummary(region,'before-0');
assert.equal((table.match(/<tr\b/g)||[]).length,2);
assert.equal((table.match(/class="selected-object"/g)||[]).length,1);
assert.match(table,/upper[\s\S]*lower/);
console.log('3 region table tests passed');
