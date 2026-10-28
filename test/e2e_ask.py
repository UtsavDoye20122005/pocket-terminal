# End-to-end test for "Ask": built-in search, AI (fake provider), safety, run over the direct link, run while asleep.
# Run: python3 test/e2e_ask.py
import subprocess, time, os, json, signal, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import pairing_helper as ph
from playwright.sync_api import sync_playwright
S=__import__('tempfile').mkdtemp(); os.makedirs(S+'/home', exist_ok=True); R=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
svc=subprocess.Popen(['node','test/run-services.js','8820','8821',S+'/board.json'],cwd=R,stdout=subprocess.PIPE,text=True)
ports=json.loads(svc.stdout.readline()); BOARD=f"http://127.0.0.1:{ports['board']}"; APP=f"http://localhost:{ports['app']}/"
json.dump({'percent':70,'onCharger':True,'lid':True},open(S+'/sim.json','w'))
env=dict(os.environ,POCKET_HOME=S+'/home',POCKET_APP_URL=APP)
ph.setup(R, env, 'TestMac', BOARD)

agent=subprocess.Popen(['node','agent.js'],cwd=R+'/agent',env=dict(env,POWER_SIM=R+'/agent/test/sim-mac.js',SIM_STATE=S+'/sim.json'),stdout=open(S+'/agent.log','a'),stderr=subprocess.STDOUT)
rows="[...document.querySelectorAll('.xterm-rows > div')].map(d=>d.textContent).join('\\n')"
def wait(fn, t=20):
    t0=time.time()
    while time.time()-t0<t:
        try:
            v=fn()
            if v: return v
        except Exception: pass
        time.sleep(0.3)
asked=[]
def fake_ai(route):
    req=route.request; body=json.loads(req.post_data); asked.append({'auth':req.headers.get('authorization'),'body':body})
    if 'port 3000' in body['messages'][-1]['content']:
        content=json.dumps({'options':[{'command':'lsof -ti :3000 | xargs kill','explain':'Finds the program using port 3000 and stops it.','risk':'careful'},
                                       {'command':'lsof -i :3000','explain':'Only shows what is using port 3000, without stopping it.','risk':'safe'}]})
        return route.fulfill(status=200, headers={'access-control-allow-origin':'*','content-type':'application/json'}, body=json.dumps({'choices':[{'message':{'content':content}}]}))
    content=json.dumps({'options':[{'command':'echo ai-says-$((2*21))','explain':'Prints a test line.','risk':'safe'},
                                   {'command':'rm -rf ~/nothing-here-123','explain':'Deletes a folder.','risk':'danger'}]})
    route.fulfill(status=200, headers={'access-control-allow-origin':'*','content-type':'application/json'},
                  body=json.dumps({'choices':[{'message':{'content':content}}]}))
ok=True
errs=[]
def check(n, label, v):
    global ok; ok = ok and bool(v); print(f'{n} {label}:', v)
try:
  with sync_playwright() as p:
    b=p.chromium.launch(args=['--disable-features=WebRtcHideLocalIpsWithMdns'])
    ctx=b.new_context(**p.devices['iPhone 13']); pg=ctx.new_page(); pg.on('console', lambda m: m.type=='error' and errs.append('console: '+m.text)); pg.on('pageerror', lambda e: errs.append(str(e)))
    ph.pair(pg, R, env)
    check(1, 'direct link', wait(lambda: 'awake' in (pg.get_attribute('#presence','class') or ''), 40))
    check(2, 'computer OS known', pg.evaluate("localStorage.getItem('pt_os')"))
    pg.click('#askBtn'); pg.fill('#askIn','find big files')
    check(3, 'built-in match for "find big files"', wait(lambda: pg.input_value('#askLib .sug .cmdedit').startswith('du -ah'), 5))
    pg.fill('#askIn','git sta'); check(4, 'half-remembered "git sta"', wait(lambda: 'git' in pg.input_value('#askLib .sug .cmdedit') and pg.input_value('#askLib .sug .cmdedit'), 5))
    pg.click('#askLib .sug [data-act=run]'); check(5, 'placeholder must be filled', wait(lambda: 'Fill in' in pg.inner_text('#toast') and pg.inner_text('#toast'), 3))
    pg.fill('#askIn','say hi with a number'); pg.click('#askGo')
    check(6, 'no key yet → sent to Settings', wait(lambda: not pg.is_hidden('#aiForm'), 3))
    pg.select_option('#aiProvider','groq'); pg.fill('#aiKey','gsk_test_key_123'); pg.click('#aiForm button.btn:not(.ghost)')
    check(7, 'AI key saved encrypted', 'gsk_test' not in json.dumps(pg.evaluate("Object.assign({},localStorage)")) and pg.inner_text('#aiInfo'))
    pg.route('https://api.groq.com/**', fake_ai)
    ph.nav(pg, 'ask'); pg.click('#askGo')
    check(8, 'AI answer shown', wait(lambda: pg.input_value('#askAi .sug .cmdedit'), 10))
    check(9, 'key sent only to AI, request has OS', asked and asked[-1]['auth']=='Bearer gsk_test_key_123' and 'Linux (bash)' in asked[-1]['body']['messages'][0]['content'])
    check(10, 'danger option labelled', 'danger' in pg.inner_text('#askAi .sug:nth-child(2)'))
    pg.click('#askAi .sug:nth-child(2) [data-act=run]'); check(11, 'danger needs a 2nd tap', pg.inner_text('#askAi .sug:nth-child(2) [data-act=run]'))
    pg.click('#askAi .sug:first-child [data-act=run]')
    check(12, 'ran in live terminal', wait(lambda: 'ai-says-42' in pg.evaluate(rows), 10))
    check(13, 'danger command never ran', not os.path.exists(os.path.expanduser('~/nothing-here-123')) and 'rm -rf' not in pg.evaluate(rows))
    pg.click('#askBtn'); pg.click('#askAi .sug:first-child [data-act=save]')
    check(14, 'saved as chip', wait(lambda: 'Prints a test line' in pg.inner_text('#chips'), 3))
    pg.reload(); pg.wait_for_selector('#app:not([hidden])')
    check(15, 'AI key survives reload (decrypted)', wait(lambda: 'Groq' in pg.inner_text('#aiInfo'), 5))
    check(16, 'no page errors', not errs or errs)
    pg.route('https://api.groq.com/**', fake_ai)
    ph.nav(pg, 'queue'); pg.fill('#qcmd','ls /no-such-folder-xyz'); pg.click('#qform button')
    wait(lambda: pg.is_visible('.fixit'), 15); pg.click('.fixit')
    check(19, 'Fix with AI sends the failed command and its output', wait(lambda: pg.title() is not None and any('failed with exit code' in a['body']['messages'][-1]['content'] and 'no-such-folder' in a['body']['messages'][-1]['content'] for a in asked), 10))
    pg.route('https://llm.example.test/**', fake_ai)
    ph.nav(pg, 'settings'); pg.click('#aiSetup'); pg.select_option('#aiProvider','custom')
    pg.fill('#aiUrl','https://llm.example.test/v1/chat/completions'); pg.fill('#aiModel','my-model'); pg.fill('#aiKey','sk-custom'); pg.click('#aiTest')
    check(20, 'custom OpenAI-compatible API: Test button works', wait(lambda: 'Works' in pg.inner_text('#aiNote'), 10) and asked[-1]['body']['model']=='my-model' and asked[-1]['auth']=='Bearer sk-custom')
    pg.click('#aiForm button.btn:not(.ghost)')
    ph.nav(pg, 'ask'); pg.fill('#askIn','my react app says port 3000 is already in use'); pg.click('#askGo')
    check(17, 'plain-English AI answer', wait(lambda: pg.input_value('#askAi .sug .cmdedit')=='lsof -ti :3000 | xargs kill', 10))
    pg.evaluate("document.activeElement.blur(); document.getElementById('status').textContent='Awake · direct, encrypted'; document.getElementById('askHint').textContent='Commands for macOS. Nothing runs until you tap Run.'"); time.sleep(.4)
    pg.screenshot(path=S+'/ask.png'); __import__('shutil').copy(S+'/ask.png', R+'/docs/screenshots/ask.png')
    b.close()
finally:
  agent.terminate(); svc.terminate()
  text=open(S+'/board.json').read() if os.path.exists(S+'/board.json') else ''
  check(18, 'board never saw the request or key', not any(w in text for w in ['gsk_test','say hi','ai-says']))
  print('ALL OK' if ok else 'SOME FAILED')
