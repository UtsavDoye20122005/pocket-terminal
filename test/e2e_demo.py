# Demo mode (#demo): opens without pairing, pretend shell works, sleep/wake cycle, themes,
# and it never writes the real pairing, history or keys to this phone's storage.
import subprocess, json, os, sys, time, tempfile
from playwright.sync_api import sync_playwright
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = tempfile.mkdtemp()
svc = subprocess.Popen(['node', 'test/run-services.js', '8890', '8891', S + '/board.json'], stdout=subprocess.PIPE, text=True, cwd=R)
ports = json.loads(svc.stdout.readline()); APP = f"http://localhost:{ports['app']}/"
ok = True
def wait(pg, js, timeout=8000):  # the app's CSP blocks eval, so poll with evaluate instead of wait_for_function
    end = time.time() + timeout / 1000
    while time.time() < end:
        try:
            if pg.evaluate('() => ' + js): return True
        except Exception: pass  # page still loading
        pg.wait_for_timeout(150)
    raise TimeoutError(js)
def check(n, label, v):
    global ok; ok = ok and bool(v); print(n, label + ':', v)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True); pg = ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(APP); pg.wait_for_selector('#demoBtn', state='visible')
        check(1, 'light theme by default', pg.evaluate("document.documentElement.dataset.theme") == 'light')
        pg.click('#demoBtn'); wait(pg, "document.querySelector('#status').textContent.includes('Live')", 8000)
        check(2, 'demo opens live without pairing', True)
        pg.click('#term'); pg.keyboard.type('git status\n'); pg.wait_for_timeout(400)
        txt = pg.evaluate("document.querySelector('#term .xterm-rows').innerText")
        check(3, 'pretend shell answers', 'On branch main' in txt)
        pg.click('#menuBtn'); pg.click('[data-tab=queue]'); pg.fill('#qcmd', 'uptime'); pg.click('#qform button')
        wait(pg, "document.querySelector('#jobs .job .tag').textContent === 'done'", 5000)
        check(4, 'Send a command gets a result', True)
        pg.click('#sheetBack'); pg.click('[data-tab=settings]'); pg.click('#themeSeg [data-v=dark]')
        check(5, 'Appearance → Dark', pg.evaluate("document.documentElement.dataset.theme") == 'dark')
        pg.click('#sheetClose'); pg.wait_for_timeout(300)
        pg.click('#term'); pg.keyboard.type('pmset sleepnow\n')
        wait(pg, "document.querySelector('#status').textContent.startsWith('Asleep')", 4000)
        check(6, 'sleep shows the asleep card', pg.is_visible('#banner'))
        wait(pg, "document.querySelector('#status').textContent.includes('Live')", 30000)
        check(7, 'wakes and reconnects by itself', True)
        keys = pg.evaluate("Object.keys(localStorage)")
        check(8, 'demo stored nothing but the theme', keys == ['pt_theme'])
        check(9, 'no page errors', errs == [])
        b.close()
finally:
    svc.kill()
print('ALL OK' if ok else 'FAILED'); sys.exit(0 if ok else 1)
