# Captures the README screenshots with the real app, a fake board and a simulated computer.
# Needs: pip install playwright && playwright install chromium.   Run: python3 test/make_screenshots.py
import subprocess, time, os, json, signal, tempfile, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import pairing_helper as ph
from playwright.sync_api import sync_playwright
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(R, 'docs', 'screenshots'); os.makedirs(OUT, exist_ok=True)
S = tempfile.mkdtemp(); os.makedirs(S + '/home'); demo = S + '/projects'; os.makedirs(demo + '/pocket-terminal'); os.makedirs(demo + '/estatedesk')
for f in ['README.md', 'notes.txt', 'deploy.sh']: open(f'{demo}/{f}', 'w').write('x\n')
svc = subprocess.Popen(['node', 'test/run-services.js', '8820', '8821', S + '/board.json'], cwd=R, stdout=subprocess.PIPE, text=True)
ports = json.loads(svc.stdout.readline()); BOARD = f"http://127.0.0.1:{ports['board']}"; APP = f"http://localhost:{ports['app']}/"
json.dump({'percent': 82, 'onCharger': True, 'lid': True}, open(S + '/sim.json', 'w'))
json.dump({'checkInMinutes': 2, 'idleMinutes': 0.05}, open(S + '/home/power.json', 'w'))
env = dict(os.environ, POCKET_HOME=S + '/home', POCKET_APP_URL=APP, SHELL='/bin/bash', HOME=S)
ph.setup(R, env, 'MacBook Pro', BOARD)
agent = subprocess.Popen(['node', 'agent.js'], cwd=R + '/agent', env=dict(env, POWER_SIM=R + '/agent/test/sim-mac.js', SIM_STATE=S + '/sim.json'), stdout=open(S + '/agent.log', 'w'), stderr=subprocess.STDOUT)
time.sleep(1.5)
def shot(pg, name): pg.wait_for_timeout(700); pg.screenshot(path=f'{OUT}/{name}.png')
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--disable-features=WebRtcHideLocalIpsWithMdns'])
        ctx = b.new_context(**p.devices['iPhone 13']); pg = ctx.new_page()
        pg.goto(APP); pg.evaluate("localStorage.setItem('pt_font', '11')"); shot(pg, 'welcome')
        pg.close(); pg = ctx.new_page()  # new page: a hash-only change would not reload
        ph.pair(pg, R, env, shot=lambda pg: (pg.evaluate("document.getElementById('pairHint').textContent='Check that your computer shows the same code, then type y there to allow this phone.'"), shot(pg, 'pair')))
        t0 = time.time()
        while 'awake' not in (pg.get_attribute('#presence', 'class') or '') and time.time() - t0 < 40: time.sleep(0.3)
        pg.click('#term'); time.sleep(1)
        pg.keyboard.type(f"export PS1='\\[\\e[38;5;215m\\]utsav@MacBook-Pro\\[\\e[0m\\]:\\[\\e[38;5;147m\\]\\w\\[\\e[0m\\] $ '; cd ~/projects; alias ls='ls --color=always'; clear\n"); time.sleep(0.8)
        for c in ['ls', 'uptime -p', 'df -h / | tail -1', 'echo "deploy finished ✓"']:
            pg.keyboard.type(c + '\n'); time.sleep(0.6)
        time.sleep(1.2); pg.evaluate("document.activeElement.blur()"); shot(pg, 'terminal')
        pg.click('#menuBtn'); pg.click('[data-tab=queue]')
        for c in ['ls ~/projects', 'df -h / | tail -1']:
            pg.fill('#qcmd', c); pg.click('#qform button'); time.sleep(1.2)
        pg.evaluate("document.activeElement.blur()"); shot(pg, 'commands')
        pg.click('[data-tab=power]'); shot(pg, 'power')
        pg.click('#sheet', position={'x': 5, 'y': 5})
        # unplug, leave, computer sleeps; come back to the asleep card
        json.dump({'percent': 64, 'onCharger': False, 'lid': True}, open(S + '/sim.json', 'w'))
        pg.close()
        st = lambda: open(f'/proc/{agent.pid}/stat').read().split()[2]
        t0 = time.time()
        while st() != 'T' and time.time() - t0 < 60: time.sleep(0.5)
        pg = ctx.new_page(); pg.goto(APP); time.sleep(3)
        pg.fill('#bannerCmd', 'npm run build'); pg.click('#bannerForm button'); time.sleep(3.2)
        shot(pg, 'asleep')
        ctx2 = b.new_context(**p.devices['iPhone 13']); pg2 = ctx2.new_page()
        pg2.goto(APP); pg2.evaluate(f"localStorage.setItem('pt_vault', {json.dumps(pg.evaluate('localStorage.getItem(\"pt_vault\")'))})"); pg2.reload(); pg2.keyboard.type('12'); shot(pg2, 'lock')
        b.close()
finally:
    agent.send_signal(signal.SIGCONT); agent.terminate(); svc.terminate()
print('screenshots in', OUT)
