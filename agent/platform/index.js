// Picks the power controls for this computer's operating system.
// Other systems (Linux servers etc.) run without the power brain: always awake, nothing to manage.
module.exports.supported = () => process.platform === 'darwin' || process.platform === 'win32';
module.exports.sys = () => {
  if (process.platform === 'darwin') return require('./mac').sys;
  if (process.platform === 'win32') return require('./windows').sys;
  return {};
};
