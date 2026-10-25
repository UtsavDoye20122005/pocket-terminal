# Pairing security: a QR code works once, needs approval on the computer, and phones can be removed.
# Run: python3 test/e2e_pairing.py
import subprocess, time, os, json, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import pairing_helper as ph
from playwright.sync_api import sync_playwright
S=__import__('tempfile').mkdtemp(); os.makedirs(S+'/home'); R=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
svc=subprocess.Popen(['node','test/run-services.js','8840','8841',S+'/board.json'],cwd=R,stdout=subprocess.PIPE,text=True)
ports=json.loads(svc.stdout.readline()); BOARD=f"http://127.0.0.1:{ports['board']}"; APP=f"http://localhost:{ports['app']}/"
env=dict(os.environ,POCKET_HOME=S+'/home',POCKET_APP_URL=APP)
ph.setup(R, env, 'TestMac', BOARD)
agent=subprocess.Popen(['node','agent.js'],cwd=R+'/agent',env=dict(env,POWER_BRAIN='0'),stdout=open(S+'/agent.log','w'),stderr=subprocess.STDOUT)
devices=lambda: json.load(open(S+'/home/direct.json'))['devices']
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
try:
  with sync_playwright() as p:
    b=p.chromium.launch(args=['--disable-features=WebRtcHideLocalIpsWithMdns'])
    phone=lambda: b.new_context(**p.devices['iPhone 13']).new_page()
    me=phone(); match, out, link = ph.pair(me, R, env)
    check(1, 'my phone: same code on both screens, approved, connected', match and 'Paired "iPhone (Safari)"' in out and wait(lambda: awake(me), 40))
    check(2, 'the invite code is gone from the address bar', 'join=' not in me.url)
    bro=phone(); bro.goto(link); time.sleep(8)
    check(3, "brother's phone, same QR again: no PIN screen, nothing paired", bro.is_hidden('#pairPad') and len(devices())==1 and 'awake' not in (bro.get_attribute('#presence','class') or ''))
    # two phones race for one fresh QR code
    pp, link2 = ph.start_invite(R, env)
    a=phone(); c=phone(); a.goto(link2); time.sleep(0.5); c.goto(link2)
    _, txt = ph.read_until(pp, 'second phone')
    check(4, 'two phones on one QR: computer refuses both', 'second phone' in txt and pp.wait(10)==1 and len(devices())==1)
    check(5, 'both racing phones are told nothing was paired', wait(lambda: 'Nothing was paired' in a.inner_text('#pairErr') and 'Nothing was paired' in c.inner_text('#pairErr'), 15))
    # you say no
    pp, link3 = ph.start_invite(R, env)
    d=phone(); d.goto(link3); ph.read_until(pp, 'Its code:'); pp.stdin.write('n\n'); pp.stdin.flush()
    check(6, 'you type n: phone is refused', wait(lambda: 'said no' in d.inner_text('#pairErr'), 15) and len(devices())==1)
    # old reusable links are refused
    old=phone(); old.goto(APP+'#pair=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&name=x')
    check(7, 'old-style reusable link does nothing', wait(lambda: not old.is_hidden('#gate-none'), 5))
    # remove my phone
    r=subprocess.run(['node','pair.js','--remove','iPhone (Safari)'],cwd=R+'/agent',env=env,capture_output=True,text=True).stdout
    check(8, 'pair.js --remove', 'Removed' in r and len(devices())==0)
    check(9, 'agent drops it within seconds', wait(lambda: 'phone removed' in open(S+'/agent.log').read(), 10))
    me.reload(); time.sleep(12)
    check(10, 'removed phone can no longer connect', not awake(me))
    b.close()
finally:
  agent.terminate(); svc.terminate()
  text=open(S+'/board.json').read()
  check(11, 'board never saw a secret in plain text', not re.search(r'"(secret|pair)"', text) and 'TestMac' not in text)
  print('ALL OK' if ok else 'SOME FAILED')
