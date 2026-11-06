"""Verifica o modo offline com Edge/Playwright e um Supabase inteiramente simulado.

Não lê nem grava dados do Supabase real. Requer o pacote Python playwright e Edge.
Execute: python tools/verify_offline.py
"""
from __future__ import annotations

import hashlib
import http.server
import json
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
UID = '11111111-1111-4111-8111-111111111111'
OTHER_UID = '22222222-2222-4222-8222-222222222222'
EMAIL = 'gustavo@offline.test'
ROWS = [
    dict(id='33333333-3333-4333-8333-333333333333', user_id=UID, author='gustavo', kind='income', amount_cents=10000, currency='USD', brl_cents=None, category='salario', note='Salário de teste', occurred_on='2026-11-06', created_at='2026-11-06T10:00:00Z'),
    dict(id='44444444-4444-4444-8444-444444444444', user_id=OTHER_UID, author='manuela', kind='expense', amount_cents=500, currency='USD', brl_cents=None, category='alimentacao', note='Café da Manuela', occurred_on='2026-11-06', created_at='2026-11-06T11:00:00Z'),
]


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.webmanifest': 'application/manifest+json'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *_):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def reply(self, data, status=200, content_type='application/json'):
        payload = (json.dumps(data) if content_type == 'application/json' else data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type + '; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == '/index.html':
            self.send_response(308)
            self.send_header('Location', '/')
            self.end_headers()
            return
        if parsed.path == '/js/config.js':
            config = dict(
                supabaseUrl=f'http://127.0.0.1:{self.server.server_port}/mock',
                supabaseAnonKey='offline-test-publishable-key', emailDomain='offline.test',
                users=[dict(username='gustavo', name='Gustavo', color='#0A84FF', email=EMAIL), dict(username='manuela', name='Manuela', color='#FF375F', email='manuela@offline.test')],
                loveNoteEchoToSender=False,
            )
            return self.reply('export const CONFIG = ' + json.dumps(config) + ';', content_type='text/javascript')
        if parsed.path.startswith('/mock/'):
            if self.headers.get('Authorization') != 'Bearer offline-test-access':
                return self.reply(dict(message='Unauthorized'), 401)
            if parsed.path == '/mock/rest/v1/transactions':
                rows = list(ROWS)
                query = parse_qs(parsed.query)
                if 'id' in query:
                    record_id = query['id'][0].removeprefix('eq.')
                    rows = [row for row in rows if row['id'] == record_id]
                return self.reply(rows)
            return self.reply([])
        if getattr(self.server, 'rollback', False) and parsed.path != '/desativar-offline.html':
            self.directory = str(ROOT.parent / 'DolarMap-publicar')
        return super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        if path == '/mock/auth/v1/token':
            return self.reply(dict(access_token='offline-test-access', refresh_token='offline-test-refresh', expires_in=3600, user=dict(id=UID, email=EMAIL)))
        if path == '/mock/auth/v1/logout':
            return self.reply({})
        if path == '/mock/rest/v1/transactions':
            if self.headers.get('Authorization') != 'Bearer offline-test-access':
                return self.reply(dict(message='Unauthorized'), 401)
            if any(row['id'] == body.get('id') for row in ROWS):
                return self.reply(dict(code='23505', message='duplicate key'), 409)
            row = {**body, 'user_id': UID, 'author': 'gustavo', 'created_at': '2026-11-06T12:00:00Z'}
            ROWS.append(row)
            return self.reply([row], 201)
        return self.reply(dict(message='Unsupported test route'), 404)


def main():
    report = {'checks': [], 'unit_tests': '', 'real_supabase_accessed': False}

    def check(condition, label):
        report['checks'].append(dict(ok=bool(condition), label=label))
        if not condition:
            raise AssertionError(label)
        print('PASS ' + label, flush=True)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', headless=True)
            context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, reduced_motion='reduce')
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + '/tests/run.html')
            page.wait_for_function("document.title === 'TESTS PASSED' || document.title === 'TESTS FAILED'", timeout=45000)
            report['unit_tests'] = page.locator('#summary').inner_text()
            if page.title() != 'TESTS PASSED':
                print(page.locator('#results').inner_text(), flush=True)
            check(page.title() == 'TESTS PASSED', report['unit_tests'])

            page.goto(base + '/')
            page.locator('[data-user="gustavo"]').click()
            page.locator('#password').fill('teste-offline')
            page.locator('#login-form button[type="submit"]').click()
            page.wait_for_selector('#main')
            for tab in ['home', 'list', 'analytics']:
                page.locator(f'nav [data-action="tab"][data-tab="{tab}"]').click()
                check(page.locator('#offline-status').count() == 0, f'painel de sincronização ausente na aba {tab}')
            page.locator('nav [data-action="tab"][data-tab="settings"]').click()
            page.wait_for_selector('[data-offline-assets="ready"]', timeout=35000)
            check(page.evaluate("() => { const panel = document.querySelector('#offline-status'); const title = panel.previousElementSibling; return title.textContent === 'Sincronização' && title.previousElementSibling.previousElementSibling.textContent === 'Conquistas'; }"), 'sincronização aparece em Ajustes imediatamente abaixo de Conquistas')
            page.wait_for_function("document.querySelector('#offline-status').innerText.includes('Última atualização')")
            page.wait_for_function('!!navigator.serviceWorker.controller')
            check('Gustavo' in page.locator('#main').inner_text(), 'login online, cópia dos dados e preparação do service worker')
            check(page.evaluate("async () => { const registrations = await navigator.serviceWorker.getRegistrations(); return registrations.some(r => !!r.active); }"), 'service worker ativo')

            # Força token vencido: o acesso offline deve lembrar a conta sem renovar na rede.
            page.evaluate("() => { const k='dolarmap.offline.session.v1'; const s=JSON.parse(localStorage.getItem(k)); s.expires_at=0; localStorage.setItem(k, JSON.stringify(s)); }")
            context.set_offline(True)
            page.reload(wait_until='domcontentloaded')
            page.wait_for_selector('#main')
            check('Olá, Gustavo' in page.locator('#main').inner_text(), 'reabre a interface em modo avião com sessão expirada')
            check('US$' in page.locator('.hero').inner_text(), 'saldo e extrato usam a cópia local sem conexão')

            page.locator('.tab-add').click()
            page.locator('#amount').fill('12,00')
            page.locator('#note').fill('Almoço no modo avião')
            page.locator('[data-cat="alimentacao"]').click()
            page.locator('.sheet form').evaluate('(form) => form.requestSubmit()')
            page.wait_for_function("!document.querySelector('dialog.sheet').open")
            page.locator('nav [data-action="tab"][data-tab="settings"]').click()
            page.wait_for_function("document.querySelector('#offline-status').innerText.includes('1 registro(s) pendente(s)')")
            check(len(ROWS) == 2, 'gasto offline não chama o servidor')
            page.reload(wait_until='domcontentloaded')
            page.wait_for_selector('#main')
            page.locator('nav [data-action="tab"][data-tab="list"]').click()
            row = page.locator('[data-action="edit"]').filter(has_text='Almoço no modo avião')
            check(row.count() == 1 and 'Pendente de sincronização' in row.inner_text(), 'gasto persiste depois de fechar/reabrir e aparece como pendente')
            page.screenshot(path=str(ROOT / 'tests/offline-screenshot.png'), full_page=True, animations='disabled')

            # Nova aba e navegador sem rede: garante abertura pelo endereço, não só uma tela em memória.
            second = context.new_page()
            second.goto(base + '/', wait_until='domcontentloaded')
            second.wait_for_selector('#main')
            second.locator('nav [data-action="tab"][data-tab="settings"]').click()
            check('1 registro(s) pendente(s)' in second.locator('#offline-status').inner_text(), 'uma nova janela abre totalmente offline com os dados preservados')
            second.close()

            context.set_offline(False)
            page.locator('nav [data-action="tab"][data-tab="settings"]').click()
            page.wait_for_function("document.querySelector('#offline-status').innerText.includes('Dados atualizados')", timeout=20000)
            check(len(ROWS) == 3 and sum(row.get('note') == 'Almoço no modo avião' for row in ROWS) == 1, 'reconectar envia uma única vez ao Supabase simulado')
            page.locator('[data-action="sync"]').click()
            page.wait_for_function("document.querySelector('#offline-status').innerText.includes('Dados atualizados')")
            check(len(ROWS) == 3, 'nova sincronização mantém o gasto sem duplicar')

            cached_urls = page.evaluate("async () => { const urls=[]; for (const name of await caches.keys()) { const cache=await caches.open(name); urls.push(...(await cache.keys()).map(r=>r.url)); } return urls; }")
            check(len(cached_urls) >= 10 and not any('/mock/' in url for url in cached_urls), 'cache do service worker contém a interface e nenhuma resposta autenticada')
            check(not errors, 'interface sem erros JavaScript: ' + '; '.join(errors))

            # O servidor passa a servir os arquivos originais no mesmo endereço, como um rollback.
            server.rollback = True
            page.goto(base + '/')
            page.wait_for_selector('#login-form')
            check(page.title() == 'DolarMap' and page.locator('#offline-status').count() == 0, 'publicar a versão anterior no mesmo endereço carrega a interface original')

            page.goto(base + '/desativar-offline.html')
            page.locator('#disable').click()
            page.wait_for_url('**/?offline-desativado=1')
            check(page.url.endswith('/?offline-desativado=1'), 'página de desativação redireciona sem apagar lançamentos')
            check(page.evaluate('async () => (await navigator.serviceWorker.getRegistrations()).length === 0'), 'desativação remove o service worker e impede novo registro nessa abertura')
            check(page.evaluate('async () => (await caches.keys()).every(key => !key.startsWith("dolarmap-offline-shell:"))'), 'desativação remove somente o cache da interface offline')
            context.close()
            browser.close()

        baseline = json.loads((ROOT / 'tests/original-folders.sha256.json').read_text(encoding='utf-8'))
        for folder_name, expected in baseline.items():
            folder = ROOT.parent / folder_name
            actual = {str(path.relative_to(folder)): hashlib.sha256(path.read_bytes()).hexdigest() for path in folder.rglob('*') if path.is_file()}
            check(actual == expected, f'pasta original preservada: {folder_name}')
        report['ok'] = True
    finally:
        server.shutdown()
        (ROOT / 'tests/offline-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
