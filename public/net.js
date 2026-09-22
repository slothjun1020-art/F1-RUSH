// WebSocket wrapper with a tiny event emitter and server clock synchronisation.

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.offset = 0;          // serverTime - clientTime, in ms
    this.samples = [];
    this.pingTimer = null;
  }

  on(type, fn) {
    this.handlers.set(type, fn);
    return this;
  }

  emit(type, msg) {
    const fn = this.handlers.get(type);
    if (fn) fn(msg);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws = ws;
      ws.onopen = () => {
        this.startClockSync();
        resolve();
      };
      ws.onerror = () => reject(new Error('서버에 연결할 수 없어요'));
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'pong') { this.onPong(msg); return; }
        this.emit(msg.t, msg);
      };
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        this.emit('close', {});
      };
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close() {
    clearInterval(this.pingTimer);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    this.ws = null;
  }

  startClockSync() {
    let burst = 0;
    const ping = () => this.send({ t: 'ping', c: Date.now() });
    ping();
    this.pingTimer = setInterval(() => {
      ping();
      if (++burst === 6) {
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(ping, 10000);
      }
    }, 150);
  }

  onPong({ c, s }) {
    const recv = Date.now();
    const rtt = recv - c;
    this.samples.push({ rtt, offset: s + rtt / 2 - recv });
    if (this.samples.length > 8) this.samples.shift();
    // The lowest-latency sample is the least distorted by queueing delay.
    this.offset = this.samples.reduce((best, x) => (x.rtt < best.rtt ? x : best)).offset;
    this.rtt = rtt;
    // A gently smoothed round trip time for display (the debug HUD's "ping"): steadier than the raw
    // rtt above, which is deliberately noisy because it's also used to pick the best clock-sync sample.
    this.pingEma = this.pingEma == null ? rtt : this.pingEma + (rtt - this.pingEma) * 0.3;
  }

  serverNow() {
    return Date.now() + this.offset;
  }
}
