// Stand-in for native/hugin-fpu (AriHuginFpu.exe): same line protocol, no device.
// Commands: `hang` never answers, `crash` exits, `slow` answers after 100 ms,
// anything else echoes back as `0|1|<cmd>`.
import readline from 'node:readline';

const reply = (request, body) => process.stdout.write(`${JSON.stringify({ id: request.id, ...body })}\n`);

process.stdout.write(`${JSON.stringify({ ready: true, version: 'test' })}\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.cmd === 'hang') return;
  if (request.cmd === 'crash') process.exit(3);
  if (request.cmd === 'slow') {
    setTimeout(() => reply(request, { ok: true, raw: '0|1|slow' }), 100);
    return;
  }
  reply(request, { ok: true, raw: `0|1|${request.cmd}` });
});
