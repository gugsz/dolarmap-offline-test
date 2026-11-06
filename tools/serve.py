"""Servidor local de desenvolvimento do DolarMap — igual ao `python -m http.server`,
mas manda o navegador NUNCA guardar cache (evita misturar arquivos novos com antigos).

Uso (dentro da pasta DolarMap):
    python tools/serve.py            -> http://localhost:8765
    python tools/serve.py 8765 0.0.0.0   (para abrir pelo celular na mesma rede)
"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".webmanifest": "application/manifest+json"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    bind = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(NoCacheHandler, directory=root)
    with http.server.ThreadingHTTPServer((bind, port), handler) as httpd:
        print(f"DolarMap em http://localhost:{port}  (sem cache; Ctrl+C para parar)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
