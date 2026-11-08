from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import argparse
import json
from compare import compare

ROOT=Path(__file__).parent / 'static'
LIMIT=80*1024*1024
class Handler(BaseHTTPRequestHandler):
    def respond(self,status,data,kind='application/json; charset=utf-8'):
        self.send_response(status)
        self.send_header('Content-Type',kind)
        self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        routes={'/':('index.html','text/html; charset=utf-8'),'/app.js':('app.js','text/javascript; charset=utf-8'),'/style.css':('style.css','text/css; charset=utf-8')}
        route=routes.get(self.path.split('?')[0])
        if route: self.respond(200,(ROOT/route[0]).read_bytes(),route[1])
        else: self.respond(404,b'Not found','text/plain')
    def do_POST(self):
        if self.path!='/api/compare': return self.respond(404,b'{}')
        if self.headers.get('Sec-Fetch-Site')=='cross-site': return self.respond(403,b'{}')
        try:
            length=int(self.headers.get('Content-Length','0'))
            split=int(self.headers.get('X-Before-Length','0'))
            if not 0<split<length<=LIMIT: raise ValueError('請選擇兩份 PDF，合計大小不可超過 80 MB。')
            data=self.rfile.read(length)
            first,second=data[:split],data[split:]
            if not all(b'%PDF-' in x[:1024] for x in (first,second)): raise ValueError('檔案格式不是有效的 PDF。')
            result=compare(first,second)
            self.respond(200,json.dumps(result,ensure_ascii=False).encode())
        except ValueError as e:
            self.respond(400,json.dumps({'error':str(e)},ensure_ascii=False).encode())
        except Exception:
            self.respond(422,json.dumps({'error':'無法解析此 PDF。檔案可能損壞或包含不支援的內容，請重新匯出後再試。'},ensure_ascii=False).encode())
        except BaseException: raise

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8765)
    args=parser.parse_args()
    server=HTTPServer(('127.0.0.1',args.port),Handler)
    print(f'ATCO Drawing Diff → http://127.0.0.1:{args.port}',flush=True)
    server.serve_forever()
