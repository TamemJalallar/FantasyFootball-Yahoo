class AudioQueue {
  constructor({ logger, getSettings, metrics = null }) {
    this.logger = logger;
    this.getSettings = getSettings;
    this.metrics = metrics;

    this.queue = [];
    this.timer = null;
    this.dispatching = false;
    this.lastDispatchAt = 0;
    this.lastDispatchByType = new Map();
  }

  priorityForType(type) {
    if (type === 'touchdown') return 100;
    if (type === 'upset') return 80;
    if (type === 'lead_change') return 60;
    if (type === 'final') return 40;
    return 20;
  }

  enqueue(type, payload = {}, priority = null) {
    this.queue.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      priority: Number.isFinite(priority) ? priority : this.priorityForType(type),
      payload,
      ts: new Date().toISOString()
    });

    this.metrics?.inc('audio_events_enqueued_total');

    this.queue.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.ts.localeCompare(b.ts);
    });

    this.ensureWorker().catch((error) => {
      this.logger.warn('Audio queue worker error', { error: error.message });
    });
  }

  async ensureWorker() {
    if (this.dispatching) {
      return;
    }

    this.dispatching = true;

    while (this.queue.length > 0) {
      const settings = await this.getSettings();
      const audio = settings.audio || {};

      if (!audio.enabled || !audio.endpointUrl) {
        this.queue = [];
        this.metrics?.set('audio_queue_size', 0);
        break;
      }

      const maxQueue = Math.max(1, Number(audio.maxQueueSize || 50));
      if (this.queue.length > maxQueue) {
        this.queue = this.queue.slice(0, maxQueue);
      }

      const minInterval = Math.max(250, Number(audio.minDispatchIntervalMs || 1200));
      const wait = this.lastDispatchAt + minInterval - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      const event = this.queue.shift();
      this.metrics?.set('audio_queue_size', this.queue.length);
      const cooldowns = audio.cooldownsMs || {};
      const eventCooldown = Math.max(0, Number(cooldowns[event.type] || 0));
      const lastTypeAt = Number(this.lastDispatchByType.get(event.type) || 0);
      const remainingTypeCooldown = (lastTypeAt + eventCooldown) - Date.now();
      if (remainingTypeCooldown > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingTypeCooldown));
      }

      const templates = audio.templates || {};
      const templateId = String(templates[event.type] || templates.default || '').trim();

      try {
        const response = await fetch(audio.endpointUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type: 'audio_event',
            eventType: event.type,
            templateId,
            priority: event.priority,
            payload: event.payload,
            ts: event.ts
          })
        });

        if (!response.ok) {
          throw new Error(`Audio endpoint failed (${response.status})`);
        }

        this.lastDispatchAt = Date.now();
        this.lastDispatchByType.set(event.type, this.lastDispatchAt);
        this.metrics?.inc('audio_events_dispatched_total');
      } catch (error) {
        this.logger.warn('Audio event dispatch failed', { error: error.message, eventType: event.type });
        this.metrics?.inc('audio_events_failed_total');
      }
    }

    this.dispatching = false;
  }
}

module.exports = {
  AudioQueue
};
