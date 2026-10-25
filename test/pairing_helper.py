# Shared by the end-to-end tests: pair a (headless) phone the real way.
#   pair.js shows a one-time link → phone opens it → both show a code → "y" on the computer → PIN.
import subprocess, time, re, json

def setup(R, env, name, board):
    """Create direct.json for a test computer (no phones yet)."""
    subprocess.run(['node', 'pair.js', '--list', '--name', name, '--board', board], cwd=R + '/agent', env=env, capture_output=True)
    f = env['POCKET_HOME'] + '/direct.json'
    cfg = json.load(open(f)); cfg['boards'] = [board]; cfg['iceServers'] = []; json.dump(cfg, open(f, 'w'))

def start_invite(R, env):
    pp = subprocess.Popen(['node', 'pair.js', '--print-link'], cwd=R + '/agent', env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    for line in pp.stdout:
        if line.startswith('LINK '): return pp, line[5:].strip()
    raise RuntimeError('pair.js gave no link')

def read_until(pp, needle):
    out = ''
    for line in pp.stdout:
        out += line
        if needle in line: return line, out
    return None, out

def phone_code(pg, t=20):
    t0 = time.time()
    while time.time() - t0 < t:
        c = re.sub(r'\D', '', pg.inner_text('#joinCode') or '')
        if len(c) == 6: return c
        time.sleep(0.2)

def open_link(pg, link):
    """Open a pairing link like the phone's camera does. On an iPhone in Safari the app first suggests
    the Home Screen app; tests continue in the browser."""
    pg.goto(link)
    try:
        pg.wait_for_selector('#iosNote:not([hidden]), #joinBox:not([hidden]), #gate-none:not([hidden])', timeout=8000)
        if pg.is_visible('#iosNote'): pg.click('#iosAnyway')
    except Exception: pass

def pair(pg, R, env, pin='123456', shot=None):
    """Returns (codes_matched, pair_output)."""
    pp, link = start_invite(R, env)
    open_link(pg, link); pg.wait_for_selector('#joinBox:not([hidden])')
    line, _ = read_until(pp, 'Its code:')
    mac_code = re.sub(r'\D', '', line.split(':', 1)[1])
    ph = phone_code(pg)
    if shot: shot(pg)
    pp.stdin.write('y\n'); pp.stdin.flush()
    pg.wait_for_selector('#pairPad:not([hidden])', timeout=20000)
    for _ in range(2): pg.keyboard.type(pin); pg.keyboard.press('Enter')
    out = pp.stdout.read(); pp.wait(5)
    return mac_code == ph, out, link
