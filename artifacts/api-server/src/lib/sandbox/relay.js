const net = require("net");

const [port, socketPath] = process.argv.slice(2);
const broker = net.connect(socketPath);
const streams = new Map();
let buffer = Buffer.alloc(0);
const OPEN = 1, DATA = 2, END = 3;

function send(type, id, payload = Buffer.alloc(0)) {
  const header = Buffer.allocUnsafe(9);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(id, 1);
  header.writeUInt32BE(payload.length, 5);
  broker.write(Buffer.concat([header, payload]));
}
function closeStream(id) {
  const upstream = streams.get(id);
  if (!upstream) return;
  streams.delete(id);
  upstream.destroy();
}
broker.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 9) {
    const type = buffer.readUInt8(0);
    const id = buffer.readUInt32BE(1);
    const length = buffer.readUInt32BE(5);
    if (length > 1024 * 1024) return broker.destroy();
    if (buffer.length < 9 + length) return;
    const payload = buffer.subarray(9, 9 + length);
    buffer = buffer.subarray(9 + length);
    if (type === OPEN) {
      const upstream = net.connect(Number(port), "127.0.0.1");
      streams.set(id, upstream);
      upstream.on("data", (data) => send(DATA, id, data));
      upstream.on("close", () => { streams.delete(id); send(END, id); });
      upstream.on("error", () => closeStream(id));
    } else if (type === DATA) {
      streams.get(id)?.write(payload);
    } else if (type === END) {
      streams.get(id)?.end();
    }
  }
});
broker.on("close", () => { for (const id of streams.keys()) closeStream(id); process.exit(0); });
broker.on("error", () => process.exit(1));