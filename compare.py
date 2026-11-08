"""Local PDF object extraction and multiset comparison; no remote services."""
import base64
import io
import math
from collections import Counter
import pdfplumber
import pypdfium2 as pdfium
from pypdf import PdfReader

MAX_PAGES = 30
MAX_OBJECTS = 400000

def normalize(value):
    if isinstance(value, (int, float)):
        return round(float(value), 1)
    if isinstance(value, (tuple, list)):
        return tuple(normalize(v) for v in value)
    return value

def object_key(o):
    return (o['kind'], normalize(o['box']), normalize(o.get('path')), o.get('text'),
            normalize(o.get('style')), normalize(o.get('matrix')))

def unmatched(before, after):
    """Multiset subtraction preserves duplicate object multiplicities."""
    a, b = Counter(map(object_key, before)), Counter(map(object_key, after))
    def remaining(items, other):
        result = []
        for item in items:
            key = object_key(item)
            if other[key]:
                other[key] -= 1
            else:
                result.append(item)
        return result
    return remaining(before, b), remaining(after, a)

def annot_box(rect, page):
    x0,y0,x1,y1 = map(float,rect)
    left,bottom,right,top = map(float,page.mediabox)
    w,h = right-left,top-bottom
    rotation = int(page.get('/Rotate',0)) % 360
    def point(x,y):
        x,y=x-left,y-bottom
        return {0:(x,h-y),90:(y,x),180:(w-x,y),270:(h-y,w-x)}[rotation]
    points=[point(x,y) for x,y in [(x0,y0),(x1,y1)]]
    return [min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)]

def extract(data):
    reader=PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise ValueError('這份 PDF 有密碼保護，請先解鎖再上傳。')
    if not 1 <= len(reader.pages) <= MAX_PAGES:
        raise ValueError(f'每份 PDF 須為 1–{MAX_PAGES} 頁。')
    pages=[]
    total=0
    renderer=pdfium.PdfDocument(data)
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for index,page in enumerate(pdf.pages):
                objects=[]
                word_map={}
                for word in page.extract_words(return_chars=True):
                    for char in word['chars']:
                        word_map[id(char)] = {'text':word['text'],'box':[word['x0'],word['top'],word['x1'],word['bottom']]}
                for kind in ('line','curve','rect','char','image'):
                    for item in page.objects.get(kind,[]):
                        o={'kind':kind,'box':[item['x0'],item['top'],item['x1'],item['bottom']]}
                        if kind=='char':
                            o.update(word=word_map.get(id(item)),text=item['text'],matrix=item.get('matrix'),style=[item.get('fontname'),item.get('size'),item.get('non_stroking_color')])
                        elif kind=='image':
                            import hashlib
                            o.update(text=hashlib.sha256(item['stream'].get_data()).hexdigest())
                        else:
                            o.update(path=item.get('path') or [('m',p) if i==0 else ('l',p) for i,p in enumerate(item.get('pts',[]))],style=[item.get('linewidth'),item.get('stroke'),item.get('fill'),item.get('stroking_color'),item.get('non_stroking_color'),item.get('dash'),item.get('evenodd')])
                        objects.append(o)
                for ref in reader.pages[index].get('/Annots',[]):
                    a=ref.get_object()
                    if a.get('/Subtype') in ('/Link','/Popup','/Widget') or not a.get('/Rect'): continue
                    objects.append({'kind':'annotation','box':annot_box(a['/Rect'],reader.pages[index]),'text':str(a.get('/Contents','')),'style':str([a.get(k) for k in ('/Subtype','/C','/Vertices','/L','/InkList','/DA','/BS')])})
                total += len(objects)
                if total > MAX_OBJECTS: raise ValueError('圖面物件過多，請拆成較小的 PDF 再比對。')
                rp=renderer[index]
                bitmap=rp.render(scale=min(1.1,2200/max(page.width,page.height)),draw_annots=False)
                out=io.BytesIO();bitmap.to_pil().save(out,format='PNG')
                bitmap.close();rp.close()
                pages.append({'width':page.width,'height':page.height,'objects':objects,'counts':dict(Counter(o['kind'] for o in objects)),'image':'data:image/png;base64,'+base64.b64encode(out.getvalue()).decode()})
                page.close()
    finally:
        renderer.close()
    return pages

def compare(before,after):
    a,b=extract(before),extract(after)
    pages=[]
    for index in range(max(len(a),len(b))):
        left=a[index] if index<len(a) else None
        right=b[index] if index<len(b) else None
        removed,added=unmatched(left['objects'] if left else [],right['objects'] if right else [])
        for page,changes in [(left,removed),(right,added)]:
            if page is not None:
                page.pop('objects')
                page['changes']=changes
        pages.append({'before':left,'after':right,'sameSize':not left or not right or (left['width']==right['width'] and left['height']==right['height'])})
    return {'pages':pages,'precision':0.1}
