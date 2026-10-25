# The Mac falls asleep by itself (no warning to the phone). The app shows "Waiting…", keeps knocking,
# and connects on its own when the Mac wakes, with nobody touching the phone.   Run: python3 test/e2e_autoconnect.py
import subprocess, time, os, json, signal, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import pairing_helper as ph
from playwright.sync_api import sync_playwright
S=__import__('tempfile').mkdtemp(); os.makedirs(S+'/home'); R=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
svc=subprocess.Popen(['node','test/run-services.js','8870','8871',S+'/board.json'],cwd=R,stdout=subprocess.PIPE,text=True)
ports=json.loads(svc.stdout.readline()); BOARD=f"http://127.0.0.1:{ports['board']}"; APP=f"http://localhost:{ports['app']}/"
json.dump({'percent':70,'onCharger':True,'lid':False},open(S+'/sim.json','w'))
env=dict(os.environ,POCKET_HOME=S+'/home',POCKET_APP_URL=APP)
ph.setup(R, env, 'TestMac', BOARD)
agent=subprocess.Popen(['node','agent.js'],cwd=R+'/agent',env=dict(env,POWER_SIM=R+'/agent/test/sim-mac.js',SIM_STATE=S+'/sim.json'),stdout=open(S+'/agent.log','w'),stderr=subprocess.STDOUT)
awake=lambda pg: 'awake' in (pg.get_attribute('#presence','class') or '')
def wait(fn, t=20):
    t0=time.time()
    while time.time()-t0<t:
        try:
            v=fn()
            if v: return v
        except Exception: pass
        time.sleep(0.5)
ok=True
def check(n, label, v):
    global ok; ok = ok and bool(v); print(f'{n} {label}:', v if isinstance(v,str) else bool(v))
try:
  with sync_playwright() as p:
    b=p.chromium.launch(args=['--disable-features=WebRtcHideLocalIpsWithMdns'])
    pg=b.new_context(**p.devices['iPhone 13']).new_page(); ph.pair(pg, R, env)
    check(1, 'connected', wait(lambda: awake(pg), 40))
    agent.send_signal(signal.SIGSTOP)  # macOS put it to sleep on its own: no goodbye note
    pg.reload(); pg.wait_for_selector('#app:not([hidden])')
    check(2, 'app shows Waiting… while the Mac sleeps', wait(lambda: 'Waiting for' in pg.inner_text('#bannerTitle') and pg.inner_text('#bannerTitle'), 40))
    time.sleep(40)
    agent.send_signal(signal.SIGCONT); t0=time.time()  # the wake alarm fires
    check(3, 'reconnects by itself after the Mac wakes (no taps)', wait(lambda: awake(pg), 150) and f'{time.time()-t0:.0f}s after waking')
    pg.click('#term'); pg.keyboard.type('echo auto-$((40+2))\n')
    check(4, 'terminal works after the auto-reconnect', wait(lambda: 'auto-42' in pg.evaluate("[...document.querySelectorAll('.xterm-rows > div')].map(d=>d.textContent).join('\\\\n')").split('echo')[-1], 10))
    b.close()
finally:
  try: agent.send_signal(signal.SIGCONT); agent.terminate()
  except Exception: pass
  svc.terminate(); print('ALL OK' if ok else 'SOME FAILED')
