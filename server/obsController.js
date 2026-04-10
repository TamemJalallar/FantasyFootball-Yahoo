const OBSWebSocket = require('obs-websocket-js').default;

class ObsController {
  constructor({ logger, getSettings, metrics = null }) {
    this.logger = logger;
    this.getSettings = getSettings;
    this.metrics = metrics;
    this.obs = new OBSWebSocket();
    this.connected = false;
    this.connecting = false;
    this.lastSceneSwitchAt = 0;

    this.obs.on('ConnectionClosed', () => {
      this.connected = false;
      this.metrics?.set('obs_connected', 0);
    });
  }

  async ensureConnection(settings) {
    if (this.connected) {
      return true;
    }

    if (this.connecting) {
      return false;
    }

    if (!settings.obs?.enabled || !settings.obs?.wsUrl) {
      return false;
    }

    this.connecting = true;

    try {
      await this.obs.connect(settings.obs.wsUrl, settings.obs.password || undefined);
      this.connected = true;
      this.metrics?.set('obs_connected', 1);
      this.logger.info('Connected to OBS WebSocket', { wsUrl: settings.obs.wsUrl });
      return true;
    } catch (error) {
      this.connected = false;
      this.metrics?.set('obs_connected', 0);
      this.logger.warn('OBS WebSocket connection failed', { error: error.message });
      return false;
    } finally {
      this.connecting = false;
    }
  }

  sceneForEvent(settings, eventType) {
    const scenes = settings.obs?.scenes || {};

    if (eventType === 'touchdown') return scenes.touchdown || scenes.default || '';
    if (eventType === 'upset') return scenes.upset || scenes.default || '';
    if (eventType === 'game_of_week') return scenes.gameOfWeek || scenes.default || '';

    return scenes.default || '';
  }

  async trigger(eventType, context = {}) {
    const settings = await this.getSettings();
    if (!settings.obs?.enabled) {
      return;
    }

    const sceneName = this.sceneForEvent(settings, eventType);
    if (!sceneName) {
      return;
    }

    const cooldownMs = Math.max(0, Number(settings.obs?.sceneCooldownMs || 7000));
    if (Date.now() - this.lastSceneSwitchAt < cooldownMs) {
      return;
    }

    const ready = await this.ensureConnection(settings);
    if (!ready) {
      return;
    }

    try {
      await this.obs.call('SetCurrentProgramScene', { sceneName });
      this.lastSceneSwitchAt = Date.now();
      this.metrics?.inc('obs_scene_switch_total');
      this.logger.info('OBS scene switched', { eventType, sceneName, context });
    } catch (error) {
      this.connected = false;
      this.metrics?.set('obs_connected', 0);
      this.logger.warn('OBS scene switch failed', { error: error.message, sceneName });
    }
  }
}

module.exports = {
  ObsController
};
