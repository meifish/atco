import io
import unittest
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import FreeText
from compare import compare, unmatched, annot_box, readable_changes

def pdf(text='hello',line=True,pages=1,color=None):
    out=io.BytesIO();c=canvas.Canvas(out,pagesize=(300,200))
    for _ in range(pages):
        c.drawString(20,170,text)
        if line:c.line(20,50,180,50)
        if color:c.drawImage(ImageReader(Image.new('RGB',(10,10),color)),200,50,30,30)
        c.showPage()
    c.save();return out.getvalue()

class ComparisonTests(unittest.TestCase):
    def test_identical(self):
        p=pdf();r=compare(p,p)
        self.assertEqual(r['pages'][0]['before']['changes'],[])
        self.assertEqual(r['pages'][0]['after']['changes'],[])
    def test_text_and_line(self):
        p=compare(pdf(),pdf('hallo',False))['pages'][0]
        self.assertTrue(any(o['kind']=='line' for o in p['before']['changes']))
        self.assertTrue(any(o.get('text')=='hallo' for o in p['after']['changes']))
        self.assertFalse(any(o['kind']=='line' for o in p['after']['changes']))
    def test_added_page(self):
        p=compare(pdf(),pdf(pages=2))['pages'][1]
        self.assertIsNone(p['before']);self.assertTrue(p['after']['changes'])
    def test_image(self):
        p=compare(pdf(color='red'),pdf(color='blue'))['pages'][0]
        self.assertEqual([o['kind'] for o in p['before']['changes']],['image'])
    def test_duplicates(self):
        o={'kind':'line','box':[0,0,10,10]}
        a,b=unmatched([o,o],[o]);self.assertEqual(len(a),1);self.assertEqual(b,[])
    def test_annotation(self):
        source=pdf();w=PdfWriter();w.append(io.BytesIO(source));w.add_annotation(0,FreeText(text='review',rect=(20,20,70,40)))
        out=io.BytesIO();w.write(out)
        p=compare(source,out.getvalue())['pages'][0]
        self.assertEqual([o['kind'] for o in p['after']['changes']],['annotation'])
        self.assertIsNone(p['before']['annotationImage'])
        self.assertTrue(p['after']['annotationImage'].startswith('data:image/png;base64,'))
        import base64
        layer=Image.open(io.BytesIO(base64.b64decode(p['after']['annotationImage'].split(',')[1])))
        self.assertIsNotNone(layer.getchannel('A').getbbox())
    def test_rotation(self):
        p=PdfReader(io.BytesIO(pdf())).pages[0];p.rotate(270)
        self.assertEqual(annot_box([20,30,60,70],p),[130,240,170,280])

    def test_glyph_paths_are_grouped_but_independent_lines_remain(self):
        char={'kind':'char','text':'A','box':[0,0,6,10],'word':{'text':'old','box':[0,0,30,10]}}
        glyph={'kind':'rect','box':[2,1,3,9],'style':[0,False,True]}
        line={'kind':'line','box':[0,5,30,5],'style':[1,True,False]}
        large={'kind':'rect','box':[0,0,100,100],'style':[0,False,True]}
        outside={'kind':'rect','box':[70,1,71,9],'style':[0,False,True]}
        a,b=readable_changes([char,glyph,line,large,outside],[])
        self.assertEqual([o['kind'] for o in a],['char','line','rect','rect'])
        self.assertEqual(a[0]['text'],'old')
        self.assertEqual(b,[])
    def test_hidden_text_style_and_whitespace_are_not_diffs(self):
        a={'kind':'char','text':'A','box':[0,0,6,10],'style':['font1',12]}
        b={**a,'style':['font2',14]}
        space={**a,'text':' '}
        self.assertEqual(readable_changes([a,space],[b]),([],[]))

    def test_invalid(self):
        with self.assertRaises(Exception):compare(b'not a PDF',pdf())
if __name__=='__main__':unittest.main()
