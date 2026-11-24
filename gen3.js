'use strict';

const { randomBytes } = require('crypto');
const connect = require('./mqtt-client');
const { binary, integer, maxSeconds } = require('./values');

const inputModes = new Set(['momentary', 'follow', 'flip', 'detached', 'activate']);
const bootModes = new Set(['off', 'on', 'restore_last', 'match_input']);
const writable = new Set(['state', 'auto', 'timeOff', 'buttontype', 'initialState', 'pulseSeconds']);

module.exports = function startGen3(plugin, params) {
  const topic = String(params.mqttTopic || '').trim();
  if (!/^[^/+#\s\x00-\x1f]+(?:\/[^/+#\s\x00-\x1f]+)*$/.test(topic)) {
    throw new Error('Укажите точный базовый топик MQTT Shelly 1 Gen3');
  }
  const interval = integer(params.pollSeconds ?? 5, 1, 300, 'Опрос') * 1000;
  const timeout = integer(params.timeout ?? 2500, 250, 15000, 'Тайм-аут');
  const src = 'ih-shelly-' + randomBytes(8).toString('hex');
  const replyTopic = src + '/rpc';
  const eventsTopic = topic + '/events/rpc';
  const onlineTopic = topic + '/online';
  const subscriptions = [replyTopic, eventsTopic, onlineTopic];
  const client = connect(plugin, params);
  const values = { online: 0 };
  const commands = [];
  let channels = [];
  let requestId = 0;
  let pending;
  let subscribed = false;
  let connection = 0;
  let busy = false;
  let stopped = false;

  function publish(update, cache = true) {
    if (stopped) return;
    if (cache) Object.assign(values, update);
    const ts = Date.now();
    const data = channels
      .filter(channel => channel.id && Object.prototype.hasOwnProperty.call(update, channel.chan))
      .map(channel => ({ id: channel.id, value: update[channel.chan], ts }));
    if (data.length) plugin.sendData(data);
  }

  async function loadChannels() {
    try {
      const list = await plugin.channels.get();
      if (Array.isArray(list)) channels = list;
      publish(values);
    } catch (error) {
      plugin.log('Каналы Shelly: ' + error.message);
    }
  }

  function rpc(method, params, session) {
    if (!subscribed || !client.connected || session !== connection || stopped) {
      throw new Error('Нет связи с Shelly по MQTT RPC');
    }
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => finish(new Error('Истёк тайм-аут ' + method)), timeout);
      function finish(error, result) {
        if (pending?.id !== id) return;
        pending = undefined;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      }
      pending = { id, finish };
      client.publish(topic + '/rpc', JSON.stringify({ id, src, method, params }),
        { qos: 0, retain: false }, error => {
          if (error) finish(error);
        });
    });
  }

  function publishStatus(status, full = false) {
    const update = {};
    const relay = status['switch:0'];
    const input = status['input:0'];
    if (typeof relay?.output === 'boolean') update.state = Number(relay.output);
    if (typeof relay?.source === 'string') update.source = relay.source;
    if (typeof input?.state === 'boolean') update.input = Number(input.state);
    else if (input?.state === null) update.input = -1;
    if (full) {
      const now = status.sys?.unixtime;
      update.timerRemaining = 0;
      if (Number.isFinite(relay?.timer_duration) && relay.timer_duration > 0) {
        update.timerRemaining = Number.isFinite(now) && Number.isFinite(relay.timer_started_at)
          ? Math.max(0, Math.ceil(relay.timer_started_at + relay.timer_duration - now)) : -1;
      }
      if (Number.isFinite(status.wifi?.rssi)) update.rssi = status.wifi.rssi;
    }
    publish(update);
  }

  async function refresh(session) {
    const status = await rpc('Shelly.GetStatus', {}, session);
    if (typeof status?.['switch:0']?.output !== 'boolean') {
      throw new Error('Shelly не вернул состояние switch:0');
    }
    await readConfig(session);
    publishStatus(status, true);
    publish({ online: 1 });
  }

  async function readConfig(session) {
    const config = await rpc('Switch.GetConfig', { id: 0 }, session);
    if (typeof config?.auto_off !== 'boolean' || !Number.isFinite(config.auto_off_delay)) {
      throw new Error('Shelly не вернул настройки автоотключения');
    }
    publish({
      auto: Number(config.auto_off),
      timeOff: config.auto_off ? config.auto_off_delay : 0,
      tmptimeOff: config.auto_off_delay,
      buttontype: config.in_mode,
      initialState: config.initial_state
    });
    return config;
  }

  async function write(channel, value, session) {
    if (channel === 'state' || channel === 'pulseSeconds') {
      const control = { id: 0, on: channel === 'pulseSeconds' || value };
      if (channel === 'pulseSeconds') control.toggle_after = value;
      await rpc('Switch.Set', control, session);
      return;
    }

    let config;
    if (channel === 'auto') {
      if (value) {
        const current = await readConfig(session);
        if (current.auto_off_delay <= 0) throw new Error('Сначала задайте ненулевой таймер');
      }
      config = { auto_off: value };
    } else if (channel === 'timeOff') {
      config = { auto_off: value > 0 };
      if (value > 0) config.auto_off_delay = value;
    } else if (channel === 'buttontype') {
      config = { in_mode: value };
    } else {
      config = { initial_state: value };
    }
    await rpc('Switch.SetConfig', { id: 0, config }, session);
  }

  async function tick() {
    if (busy || stopped || !subscribed) return;
    busy = true;
    const session = connection;
    try {
      if (!commands.length || !values.online) await refresh(session);
      while (commands.length && session === connection && subscribed && !stopped) {
        const { channel, value } = commands.shift();
        try {
          await write(channel, value, session);
        } catch (error) {
          plugin.log('Команда ' + channel + ': ' + error.message);
        }
        await refresh(session);
      }
    } catch (error) {
      commands.length = 0;
      if (values.online) plugin.log('Связь с Shelly Gen3: ' + error.message);
      publish({ online: 0 });
    } finally {
      busy = false;
      if (session !== connection && subscribed && client.connected) void tick();
    }
  }

  plugin.onAct(message => {
    for (const action of message.data || []) {
      const channel = action.chan || channels.find(item => item.id === action.id)?.chan || action.id;
      if (!writable.has(channel)) continue;
      if (!values.online || !subscribed || !client.connected || stopped) {
        plugin.log('Команда ' + channel + ': нет связи с Shelly Gen3');
        continue;
      }
      if (commands.length >= 32) {
        plugin.log('Очередь команд Shelly заполнена');
        break;
      }
      try {
        let value = action.value;
        if (channel === 'auto' || channel === 'state') value = binary(value, channel);
        if (channel === 'timeOff' || channel === 'pulseSeconds') {
          value = integer(value, channel === 'pulseSeconds' ? 1 : 0, maxSeconds, 'Таймер');
        }
        if (channel === 'buttontype' && !inputModes.has(value)) throw new Error('Недопустимый режим SW');
        if (channel === 'initialState' && !bootModes.has(value)) throw new Error('Недопустимый режим питания');
        commands.push({ channel, value });
      } catch (error) {
        plugin.log('Команда ' + channel + ' отклонена: ' + error.message);
      }
    }
    if (commands.length) void tick();
  });

  function invalidate() {
    connection++;
    commands.length = 0;
    pending?.finish(new Error('Связь с Shelly Gen3 прервана'));
    publish({ online: 0 });
  }

  client.on('connect', () => {
    subscribed = false;
    invalidate();
    const session = connection;
    client.subscribe(subscriptions, { qos: 0 }, (error, granted) => {
      if (session !== connection || !client.connected || stopped) return;
      if (error || granted?.length !== subscriptions.length || granted.some(item => item.qos !== 0)) {
        plugin.log('Подписка Shelly Gen3: ' + (error?.message || 'брокер отклонил топики'));
        return;
      }
      subscribed = true;
      void tick();
    });
  });

  client.on('message', (topic, payload, packet) => {
    if (stopped || packet.retain) return;
    if (topic === onlineTopic) {
      if (payload.toString() === 'false' && subscribed) invalidate();
      else if (payload.toString() === 'true') void tick();
      return;
    }
    let frame;
    try {
      frame = JSON.parse(payload.toString());
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    if (topic === replyTopic && pending && frame.id === pending.id && (frame.dst === undefined || frame.dst === src)) {
      const error = frame.error && new Error(frame.error.message || 'Ошибка RPC Shelly');
      pending.finish(error, Object.prototype.hasOwnProperty.call(frame, 'result') ? frame.result : frame.params);
    } else if (topic === eventsTopic && values.online) {
      if (frame.method === 'NotifyStatus' && frame.params) publishStatus(frame.params);
      if (frame.method === 'NotifyEvent' && Array.isArray(frame.params?.events)) {
        for (const event of frame.params.events) {
          if (event?.component === 'input:0' && typeof event.event === 'string' && Number.isFinite(event.ts)) {
            publish({ inputEvent: event.event, inputEventTs: event.ts }, false);
          }
        }
      }
    }
  });
  client.on('close', () => {
    subscribed = false;
    invalidate();
  });
  client.on('error', error => plugin.log('Shelly Gen3 MQTT: ' + error.message));

  plugin.onChange('channels', loadChannels);
  void loadChannels();
  const timer = setInterval(tick, interval);
  return () => {
    stopped = true;
    subscribed = false;
    invalidate();
    clearInterval(timer);
    client.end(true);
  };
};
