// Starts a mock board + the phone app server, prints their ports as JSON.
const { startBoard } = require('./mock-board');
const { startStatic } = require('./static-server');
(async () => {
  const b = await startBoard(Number(process.argv[2] || 0)); const s = await startStatic(Number(process.argv[3] || 0));
  console.log(JSON.stringify({ board: b.port, app: s.port }));
  setInterval(() => require('fs').writeFileSync(process.argv[4] || '/dev/null', JSON.stringify([...b.topics.values()].flat())), 1000);
})();
