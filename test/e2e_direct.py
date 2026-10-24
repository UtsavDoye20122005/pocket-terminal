# End-to-end test: fake board + real phone app (headless Chromium) + Mac agent with a simulated sleeping Mac.
# Needs: pip install playwright && playwright install chromium.   Run: python3 test/e2e_direct.py
import subprocess, time, os, json, signal
from playwright.sync_api import sync_playwright
S=os.environ.get('E2E_DIR') or __import__('tempfile').mkdtemp(); os.makedirs(S+'/home', exist_ok=True); R=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
svc=subprocess.Popen(['node','test/run-services.js','8810','8811',S+'/board.json'],cwd=R,stdout=subprocess.PIPE,text=True)
ports=json.loads(svc.stdout.readline()); BOARD=f"http://127.0.0.1:{ports['board']}"; APP=f"http://localhost:{ports['app']}/"
json.dump({'percent':70,'onCharger':True,'lid':True},open(S+'/sim.json','w'))
json.dump({'checkInMinutes':0.4,'idleMinutes':0.05},open(S+'/home/power.json','w'))
env=dict(os.environ,POCKET_HOME=S+'/home',POCKET_APP_URL=APP)
subprocess.run(['node','pair.js','--name','TestMac','--board',BOARD],cwd=R+'/agent',env=env,capture_output=True)
cfg=json.load(open(S+'/home/direct.json')); cfg['boards']=[BOARD]; cfg['iceServers']=[]; json.dump(cfg,open(S+'/home/direct.json','w'))
link=subprocess.run(['node','pair.js','--link-only'],cwd=R+'/agent',env=env,capture_output=True,text=True).stdout.strip()
print('pair link boards param ok:', 'boards=' in link)
def start_agent(extra={}):
    return subprocess.Popen(['node','agent.js'],cwd=R+'/agent',env=dict(env,POWER_SIM=R+'/agent/test/sim-mac.js',SIM_STATE=S+'/sim.json',**extra),stdout=open(S+'/agent.log','a'),stderr=subprocess.STDOUT)
agent=start_agent(); time.sleep(1.5)
rows="[...document.querySelectorAll('.xterm-rows > div')].map(d=>d.textContent).join('\\n').trim()"
def wait(pg, fn, t=30):
    t0=time.time()
    while time.time()-t0<t:
        try:
            v=fn()
            if v: return v
        except Exception: pass
        time.sleep(0.3)
    return None
try:
  with sync_playwright() as p:
    b=p.chromium.launch(args=['--disable-features=WebRtcHideLocalIpsWithMdns'])
    ctx=b.new_context(**p.devices['iPhone 13']); pg=ctx.new_page()
    errs=[]; logs=[]; ctx.on('console', lambda m: logs.append(m.text)); pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(link); pg.wait_for_selector('#gate-pair:not([hidden])')
    print('1 pair screen for:', pg.inner_text('#pairName'), '| secret removed from URL:', 'pair=' not in pg.url)
    pg.fill('#pin1','123456'); pg.fill('#pin2','123456'); pg.click('#pairForm button')
    t0=time.time(); ok=wait(pg, lambda: pg.inner_text('#status').endswith('direct 🔒'), 40)
    print(f'2 direct link: {bool(ok)} in {time.time()-t0:.1f}s | status:', pg.inner_text('#status'))
    pg.screenshot(path=S+'/d_connected.png')
    pg.click('#term'); pg.keyboard.type('echo p2p-$((6*7))\n')
    print('3 terminal:', bool(wait(pg, lambda: 'p2p-42' in pg.evaluate(rows).split('echo')[-1], 10)))
    vault=pg.evaluate("localStorage.getItem('pt_vault')"); print('4 vault has no plain secret:', cfg['secret'] not in vault)
    # lock + wrong PIN + right PIN
    pg.click('#menuBtn'); pg.click('[data-tab=settings]'); pg.click('#lockNow'); pg.wait_for_selector('#gate-lock:not([hidden])')
    pg.fill('#pin','000000'); pg.click('#lockForm button'); time.sleep(1.5); print('5 wrong PIN:', pg.inner_text('#lockErr'))
    pg.fill('#pin','123456'); pg.click('#lockForm button')
    print('6 unlocked + reconnected:', bool(wait(pg, lambda: pg.inner_text('#status').endswith('direct 🔒'), 40)))
    # command via direct link
    pg.click('#menuBtn'); pg.click('[data-tab=queue]'); pg.fill('#qcmd','echo job-direct'); pg.click('#qform button')
    print('7 command over direct link:', wait(pg, lambda: pg.inner_text('#jobs .card pre').strip(), 10))
    pg.click('#sheet', position={'x':5,'y':5})
    # sleep: unplug, close phone, Mac sleeps
    json.dump({'percent':60,'onCharger':False,'lid':True},open(S+'/sim.json','w'))
    pg.close(); st=lambda: open(f'/proc/{agent.pid}/stat').read().split()[2]
    print('8 Mac asleep after phone left:', bool(wait(None, lambda: st()=='T', 60)))
    pg=ctx.new_page(); pg.goto(APP); 
    print('9 phone reopens:', wait(pg, lambda: 'asleep' in pg.inner_text('#status') and pg.inner_text('#status'), 20))
    pg.screenshot(path=S+'/d_asleep.png')
    pg.click('#menuBtn'); pg.click('[data-tab=queue]'); pg.fill('#qcmd','echo ran-after-wake'); pg.click('#qform button')
    print('10 command while asleep:', wait(pg, lambda: pg.inner_text('#jobs .card .tag'), 5))
    time.sleep(32); agent.send_signal(signal.SIGCONT); t0=time.time()
    out=wait(pg, lambda: 'ran-after-wake' in pg.inner_text('#jobs .card pre') and pg.inner_text('#jobs .card pre').strip(), 40)
    print(f'11 after wake ({time.time()-t0:.1f}s): result:', out)
    print('12 direct link back:', bool(wait(pg, lambda: pg.inner_text('#status').endswith('direct 🔒'), 40)))
    pg.screenshot(path=S+'/d_woke.png')
    # backup route: Mac ignores offers
    agent.terminate(); agent.wait(); json.dump({'percent':60,'onCharger':True,'lid':True},open(S+'/sim.json','w'))
    agent=start_agent({'POCKET_NO_DIRECT':'1'}); pg.reload(); time.sleep(3)
    pg.click('#menuBtn'); pg.click('[data-tab=queue]'); pg.fill('#qcmd','echo via-backup'); pg.click('#qform button')
    print('13 backup route (no direct link):', wait(pg, lambda: 'via-backup' in pg.inner_text('#jobs .card pre') and 'ok', 30))
    print('errors:', errs[:5]); b.close()
finally:
  try: agent.send_signal(signal.SIGCONT); agent.terminate()
  except Exception: pass
  time.sleep(1.2)
  notes=json.load(open(S+'/board.json')); text=json.dumps(notes)
  print('14 board saw', len(notes), 'notes; any plaintext leaked?', any(w in text for w in ['echo','p2p','job-direct','TestMac','sdp','candidate']))
  svc.terminate()
