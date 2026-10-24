const { execFile } = require('child_process');
// Run a program, never throw. Returns {ok, out, err}.
module.exports = function run(cmd, args, timeout = 15e3) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err || '') }));
  });
};
