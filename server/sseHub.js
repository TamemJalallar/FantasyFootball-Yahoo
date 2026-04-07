class SseHub {
  constructor(logger) {
    this.logger = logger;
    this.clients = new Set();
    this.heartbeat = null;
  }

  register(res) {
    this.clients.add(res);

    if (!this.heartbeat) {
      this.startHeartbeat();
    }
  }

  unregister(res) {
    this.clients.delete(res);

    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const client of this.clients) {
      client.write(payload);
    }
  }

  startHeartbeat() {
    this.heartbeat = setInterval(() => {
      this.broadcast('heartbeat', { ts: Date.now() });
    }, 20_000);

    this.logger.debug('SSE heartbeat started');
  }

  stopHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.logger.debug('SSE heartbeat stopped');
    }
  }
}

module.exports = {
  SseHub
};
