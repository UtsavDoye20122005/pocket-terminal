# Phone-feel tests on an emulated iPhone (touch): key bar taps (Tab, ^X), paste, swipe scrolls only the
# terminal, coming back continues the terminal, a fresh launch gets a fresh one, and typing while it
# reconnects is sent once it's back.   Run: python3 test/e2e_mobile.py
import subprocess, time, os, json, signal, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import pairing_helper as ph
from playwright.sync_api import sync_playwright
S=__import__('tempfile').mkdtemp(); os.makedirs(S+'/home'); R=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
svc=subprocess.Popen(['node','test/run-services.js','8880','8881',S+'/board.json'],cwd=R,stdout=subprocess.PIPE,text=True)
ports=json.loads(svc.stdout.readline()); BOARD=f"http://127.0.0.1:{ports['board']}"; APP=f"http://localhost:{ports['app']}/"
env=dict(os.environ,POCKET_HOME=S+'/home',POCKET_APP_URL=APP,SHELL='/bin/bash')
ph.setup(R, env, 'TestMac', BOARD)
agent=subprocess.Popen(['node','agent.js'],cwd=R+'/agent',env=dict(env,POWER_BRAIN='0'),stdout=open(S+'/agent.log','w'),stderr=subprocess.STDOUT)
ROWS="[...document.querySelectorAll('.xterm-rows > div')].map(d=>d.textContent).join('\\n')"
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
def typ(pg, s): pg.click('#term'); pg.keyboard.type(s)
try:
  with sync_playwright() as p:
    b=p.chromium.launch(args=['--disable-features=WebRtcHideLocalIpsWithMdns'])
    ctx=b.new_context(**p.devices['iPhone 13'], permissions=['clipboard-read','clipboard-write'])
    pg=ctx.new_page(); ph.pair(pg, R, env); wait(lambda: awake(pg), 40)
    # 1. key bar taps (touch): Tab and ^X reach the shell
    typ(pg, 'cat -vt\n'); time.sleep(0.5)
    pg.tap('#keys [data-k=tab]'); pg.keyboard.type('a'); pg.tap('#keys [data-k=cx]'); pg.keyboard.type('\n'); time.sleep(0.8)
    check(1, 'Tab and ^X taps reach the shell (cat shows ^Ia^X)', wait(lambda: '^Ia^X' in pg.evaluate(ROWS), 5))
    pg.tap('#keys [data-k=cc]'); time.sleep(0.3)
    # 2. Paste from the clipboard
    pg.evaluate("navigator.clipboard.writeText('echo pasted-$((3*3))')"); pg.tap('#keys [data-k=paste]'); time.sleep(0.4); pg.keyboard.type('\n')
    check(2, 'Paste key pastes the clipboard', wait(lambda: 'pasted-9' in pg.evaluate(ROWS).split('echo pasted')[-1], 6))
    # 3. swipe: only the terminal scrolls, the page never moves
    typ(pg, 'seq 1 300\n'); time.sleep(1.2)
    top_before=pg.evaluate("document.getElementById('app').getBoundingClientRect().top")
    cdp=ctx.new_cdp_session(pg); box=pg.locator('#term').bounding_box(); x=box['x']+box['width']/2; y0=box['y']+60
    cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y0}]})
    for i in range(1,16): cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x,'y':y0+i*25}]})
    cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]}); time.sleep(0.5)
    nums=[int(n) for n in re.findall(r'^(\d+)$', pg.evaluate(ROWS), re.M)]
    check(3, 'swipe down scrolls the terminal back to older lines', nums and max(nums) < 290)
    check(4, 'the page itself did not move', pg.evaluate("window.scrollY")==0 and abs(pg.evaluate("document.getElementById('app').getBoundingClientRect().top")-top_before)<1)
    # 5. come back to the app (same session): the terminal continues where you left off
    typ(pg, 'clear; MARK=continue-$((40+2)); echo $MARK\n'); time.sleep(0.8)
    pg.reload(); pg.wait_for_selector('#app:not([hidden])'); wait(lambda: awake(pg), 40); time.sleep(1)
    typ(pg, 'echo still-$MARK\n')
    check(5, 'back in the app: same terminal (history and variables kept)', wait(lambda: 'still-continue-42' in pg.evaluate(ROWS), 8))
    if not ok: print(pg.evaluate(ROWS)[-600:]); print(pg.evaluate("sessionStorage.getItem('pt_sid')")); print(open(S+'/agent.log').read()[-1500:])
    # 6. a fresh launch (app was closed) gets a fresh terminal
    pg.close(); pg=ctx.new_page(); pg.goto(APP); wait(lambda: awake(pg), 40); time.sleep(1)
    typ(pg, 'echo fresh-[$MARK]\n')
    check(6, 'app closed and opened again: fresh terminal', wait(lambda: 'fresh-[]' in pg.evaluate(ROWS), 8) and 'continue-42' not in pg.evaluate(ROWS))
    # 7. typing while the link is coming back is kept and sent when it's back
    agent.send_signal(signal.SIGSTOP)
    pg.close(); pg=ctx.new_page(); pg.goto(APP); pg.wait_for_selector('#app:not([hidden])'); time.sleep(2)
    typ(pg, 'echo queued-$((2+3))\n')
    check(7, 'typing while not connected: "Reconnecting…" (kept, not lost)', wait(lambda: 'Reconnecting' in pg.inner_text('#toast'), 5))
    time.sleep(3); agent.send_signal(signal.SIGCONT)
    check(8, 'sent once the link is back', wait(lambda: 'queued-5' in pg.evaluate(ROWS), 90))
    # 9. paste box fallback when the clipboard can't be read
    ctx2=b.new_context(**p.devices['iPhone 13']); pg2=ctx2.new_page(); ph.pair(pg2, R, env); wait(lambda: awake(pg2), 40)
    pg2.evaluate("() => { navigator.clipboard.readText = () => Promise.reject(new Error('no')); }")
    pg2.tap('#keys [data-k=paste]')
    check(9, 'clipboard blocked: a paste box opens', wait(lambda: pg2.is_visible('#pasteBox'), 4))
    pg2.fill('#pasteText','echo box-$((5+5))'); pg2.tap('#pasteSend'); pg2.click('#term'); pg2.keyboard.type('\n')
    check(10, 'paste box sends to the terminal', wait(lambda: 'box-10' in pg2.evaluate(ROWS), 6))
    b.close()
finally:
  try: agent.send_signal(signal.SIGCONT); agent.terminate()
  except Exception: pass
  svc.terminate(); print('ALL OK' if ok else 'SOME FAILED')
