import io
import unittest
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import FreeText
from compare import compare, unmatched, annot_box

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
        self.assertTrue(any(o.get('text')=='a' for o in p['after']['changes']))
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
    def test_rotation(self):
        p=PdfReader(io.BytesIO(pdf())).pages[0];p.rotate(270)
        self.assertEqual(annot_box([20,30,60,70],p),[130,240,170,280])
    def test_invalid(self):
        with self.assertRaises(Exception):compare(b'not a PDF',pdf())
if __name__=='__main__':unittest.main()
