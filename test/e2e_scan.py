# iPhone Home Screen pairing: Safari points you to the Home Screen app; the app scans the QR with
# the camera (fake camera feed showing the real QR) or takes a pasted link.   Run: python3 test/e2e_scan.py
import subprocess, time, os, json, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import pairing_helper as ph
from playwright.sync_api import sync_playwright
S=__import__('tempfile').mkdtemp(); os.makedirs(S+'/home'); R=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
svc=subprocess.Popen(['node','test/run-services.js','8850','8851',S+'/board.json'],cwd=R,stdout=subprocess.PIPE,text=True)
ports=json.loads(svc.stdout.readline()); BOARD=f"http://127.0.0.1:{ports['board']}"; APP=f"http://localhost:{ports['app']}/"
env=dict(os.environ,POCKET_HOME=S+'/home',POCKET_APP_URL=APP)
ph.setup(R, env, 'TestMac', BOARD)
agent=subprocess.Popen(['node','agent.js'],cwd=R+'/agent',env=dict(env,POWER_BRAIN='0'),stdout=open(S+'/agent.log','w'),stderr=subprocess.STDOUT)
HOME_APP="Object.defineProperty(navigator,'standalone',{get:()=>true})"  # what an iPhone Home Screen app reports
awake=lambda pg: 'awake' in (pg.get_attribute('#presence','class') or '')
def wait(fn, t=20):
    t0=time.time()
    while time.time()-t0<t:
        try:
            v=fn()
            if v: return v
        except Exception: pass
        time.sleep(0.3)
ok=True
def check(n, label, v):
    global ok; ok = ok and bool(v); print(f'{n} {label}:', bool(v))
def finish_pair(pg, pp):
    line,_=ph.read_until(pp,'Its code:'); pp.stdin.write('y\n'); pp.stdin.flush()
    pg.wait_for_selector('#pairPad:not([hidden])', timeout=20000)
    for _ in range(2): pg.keyboard.type('123456'); pg.keyboard.press('Enter')
    out=pp.stdout.read(); pp.wait(5); return out
try:
  with sync_playwright() as p:
    pp, link = ph.start_invite(R, env)
    # 1. Safari on iPhone: the camera opens the link in Safari → we point to the Home Screen app and post nothing
    b=p.chromium.launch(); safari=b.new_context(**p.devices['iPhone 13']).new_page(); safari.goto(link)
    check(1, 'Safari shows "pair inside the Home Screen app" first', wait(lambda: safari.is_visible('#iosNote'), 8) and safari.is_hidden('#pairPad'))
    time.sleep(3); check(2, 'nothing was sent yet, so the QR code still works', len(json.load(open(S+'/board.json')))==0 if os.path.exists(S+'/board.json') else True)
    b.close()
    # 2. Home Screen app + camera: fake camera shows the same QR
    vid=S+'/qr.y4m'; subprocess.run(['node','test/make_qr_video.js',link,vid],cwd=R,check=True,capture_output=True)
    b=p.chromium.launch(args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',f'--use-file-for-fake-video-capture={vid}','--disable-features=WebRtcHideLocalIpsWithMdns'])
    ctx=b.new_context(**p.devices['iPhone 13'], permissions=['camera']); ctx.add_init_script(HOME_APP)
    app=ctx.new_page(); errs=[]; app.on('pageerror', lambda e: errs.append(str(e)))
    app.goto(APP); app.wait_for_selector('#scanBtn')
    check(3, 'Home Screen app: Scan QR code + Paste pairing link buttons', app.is_visible('#scanBtn') and app.is_visible('#pasteBtn'))
    app.click('#scanBtn')
    check(4, 'camera opens, reads the QR, shows the matching-code screen', wait(lambda: app.is_visible('#joinBox') and len(app.inner_text('#joinCode').replace(' ',''))==6, 15))
    check(5, 'camera is switched off after scanning', app.is_hidden('#scanner') and app.evaluate("!document.getElementById('scanVideo').srcObject"))
    out=finish_pair(app, pp)
    check(6, 'approved on the computer, PIN set, connected', 'Paired' in out and wait(lambda: awake(app), 40))
    app.reload(); check(7, 'still paired after closing and reopening the app', wait(lambda: awake(app), 40))
    # 3. Paste the link instead (e.g. copied on the Mac, pasted on the iPhone)
    pp2, link2 = ph.start_invite(R, env)
    ctx2=b.new_context(**p.devices['iPhone 13']); ctx2.add_init_script(HOME_APP); pst=ctx2.new_page(); pst.goto(APP)
    pst.click('#pasteBtn'); pst.fill('#pasteIn','hello'); pst.click('#pasteForm button')
    check(8, 'junk pasted: clear message', "isn't a Pocket Terminal pairing link" in pst.inner_text('#noneErr'))
    pst.fill('#pasteIn', link2); pst.click('#pasteForm button')
    check(9, 'pasted link → matching-code screen', wait(lambda: pst.is_visible('#joinBox'), 8))
    out=finish_pair(pst, pp2)
    check(10, 'pasted link pairs and connects', 'Paired' in out and wait(lambda: awake(pst), 40))
    check(11, 'no page errors', not errs)
    pst.goto(APP); app.screenshot(path=S+'/app.png')
    b.close()
finally:
  agent.terminate(); svc.terminate()
  print('ALL OK' if ok else 'SOME FAILED')
