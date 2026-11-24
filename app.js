'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { binary, integer, maxSeconds } = require('./values');

const relayPath = '/relay/0';
const settingsPath = '/settings/relay/0';
const buttonModes = new Set([
  'momentary', 'toggle', 'edge', 'detached', 'action', 'momentary_on_release'
]);

function readOrigin(host) {
  const address = String(host || '').trim();
  if (!address) throw new Error('Укажите IP или имя Shelly');
  const url = new URL(address.includes('://') ? address : 'http://' + address);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' ||
      url.search || url.hash || url.username || url.password) {
    throw new Error('Укажите HTTP(S)-адрес Shelly без пути и учётных данных в URL');
  }
  return url;
}

function request(url, timeout, auth) {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.get(url, { agent: false, auth }, response => {
      if (response.statusCode !== 200) {
        req.destroy(new Error('HTTP ' + response.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) {
          req.destroy(new Error('Слишком большой ответ Shelly'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('Shelly вернул некорректный JSON'));
        }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Истёк тайм-аут Shelly')), timeout);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
  });
}

function commandUrl(origin, channel, value) {
  const url = new URL(channel === 'state' ? relayPath : settingsPath, origin);
  if (channel === 'state') {
    const state = integer(typeof value === 'boolean' ? Number(value) : value, 0, 1, 'Состояние');
    url.searchParams.set('turn', state ? 'on' : 'off');
  } else if (channel === 'timeOff') {
    url.searchParams.set('auto_off', integer(value, 0, maxSeconds, 'Таймер'));
  } else {
    if (!buttonModes.has(value)) throw new Error('Неизвестный режим входа SW');
    url.searchParams.set('btn_type', value);
  }
  return url;
}

module.exports = function start(plugin, params) {
  const mode = String(params.protocol || 'http').trim().toLowerCase();
  if (!['http', 'mqtt', 'hybrid'].includes(mode)) {
    throw new Error('Режим протокола: http, mqtt или hybrid');
  }
  const generation = String(params.generation || 'gen1').trim().toLowerCase();
  if (generation === 'gen3') {
    if (mode !== 'mqtt') throw new Error('Для Shelly 1 Gen3 выберите режим mqtt');
    return require('./gen3')(plugin, params);
  }
  if (generation !== 'gen1') throw new Error('Поколение Shelly: gen1 или gen3');
  const useHttp = mode !== 'mqtt';
  const origin = useHttp ? readOrigin(params.host) : undefined;
  const interval = integer(params.pollSeconds ?? 5, 1, 300, 'Опрос') * 1000;
  const timeout = integer(params.timeout ?? 2500, 250, 15000, 'Тайм-аут');
  const auth = params.username ? String(params.username) + ':' + String(params.password || '') : undefined;
  const pollUrl = useHttp ? new URL(settingsPath, origin) : undefined;
  const commands = [];
  const lampControl = String(params.gen1LampControl || '0') === '1';
  const initialTimeOff = integer(params.gen1ResumeSeconds || 0, 0, maxSeconds, 'Резервный таймер');
  let lastTimeOff = initialTimeOff;
  let configRead = false;
  let channels = [];
  let online;
  let busy = false;
  let ready = false;
  let stopped = false;
  const mqttValues = {};
  const mqtt = mode === 'http' ? undefined : require('./mqtt-relay')(plugin, params, values => {
    if (stopped) return;
    Object.assign(mqttValues, values);
    publish(values);
  });

  async function loadChannels() {
    try {
      const list = await plugin.channels.get();
      if (Array.isArray(list)) channels = list;
    } catch (error) {
      plugin.log('Каналы Shelly: ' + error.message);
    }
  }

  function publish(values) {
    if (stopped) return;
    const ts = Date.now();
    const data = channels
      .filter(channel => channel.id && Object.prototype.hasOwnProperty.call(values, channel.chan))
      .map(channel => ({ id: channel.id, value: values[channel.chan], ts }));
    if (data.length) plugin.sendData(data);
  }

  async function exchange(url, command) {
    try {
      const response = await request(url, timeout, auth);
      if (!response || typeof response.ison !== 'boolean') {
        throw new Error('Ответ Shelly не содержит состояния реле');
      }
      const values = mqtt ? {} : { online: 1, state: Number(response.ison) };
      if (url.pathname === settingsPath) {
        if (!Number.isFinite(response.auto_off) || response.auto_off < 0 ||
            typeof response.btn_type !== 'string') {
          throw new Error('Ответ Shelly не содержит настроек реле');
        }
        configRead = true;
        values.timeOff = response.auto_off;
        values.buttontype = response.btn_type;
        if (values.timeOff > 0) lastTimeOff = values.timeOff;
        values.auto = Number(values.timeOff > 0);
        values.tmptimeOff = lastTimeOff;
      }
      if (online !== true) plugin.log('Связь с Shelly установлена');
      online = true;
      publish(values);
      if (command) {
        const expected = {};
        if (url.searchParams.has('turn')) expected.state = Number(url.searchParams.get('turn') === 'on');
        if (url.searchParams.has('auto_off')) expected.timeOff = Number(url.searchParams.get('auto_off'));
        if (url.searchParams.has('btn_type')) expected.buttontype = url.searchParams.get('btn_type');
        for (const [key, value] of Object.entries(expected)) {
          if (values[key] !== value) plugin.log('Устройство сообщило другое значение для ' + key);
        }
      }
    } catch (error) {
      if (online !== false || command) plugin.log((command || 'Связь с Shelly') + ': ' + error.message);
      online = false;
      if (!mqtt) publish({ online: 0 });
    }
  }

  async function tick() {
    if (!useHttp || busy || !ready || stopped) return;
    busy = true;
    try {
      if (!commands.length) await exchange(pollUrl);
      while (commands.length && !stopped) {
        const { channel, value } = commands.shift();
        try {
          if (!configRead && ['auto', 'timeOff'].includes(channel) && (channel === 'timeOff' || !value)) {
            await exchange(pollUrl);
            if (!configRead) throw new Error('Не удалось прочитать текущий таймер');
          }
          if (channel === 'auto' && value && !lastTimeOff) {
            await exchange(pollUrl);
            if (!lastTimeOff) throw new Error('Сначала задайте ненулевой таймер автоотключения');
          }
          if (stopped) break;
          const seconds = channel === 'auto' ? (value ? lastTimeOff : 0) : value;
          const url = commandUrl(origin, channel === 'auto' ? 'timeOff' : channel, seconds);
          if (lampControl && ['auto', 'timeOff'].includes(channel)) {
            url.searchParams.set('btn_type', seconds > 0 ? 'action' : 'detached');
          }
          await exchange(url, channel);
        } catch (error) {
          plugin.log('Команда ' + channel + ' отклонена: ' + error.message);
        }
      }
    } finally {
      busy = false;
    }
  }

  plugin.onAct(message => {
    for (const action of message.data || []) {
      const channel = action.chan || channels.find(item => item.id === action.id)?.chan || action.id;
      if (!['state', 'timeOff', 'auto', 'buttontype'].includes(channel)) continue;
      if (mqtt && channel === 'state') {
        try {
          mqtt.write(binary(action.value, 'Состояние') ? 'on' : 'off');
        } catch (error) {
          plugin.log('Команда state отклонена: ' + error.message);
        }
        continue;
      }
      if (!useHttp) {
        plugin.log('Настройка ' + channel + ' доступна в режиме http или hybrid');
        continue;
      }
      if (commands.length >= 32) {
        plugin.log('Очередь команд Shelly заполнена');
        break;
      }
      try {
        const value = channel === 'auto' ? binary(action.value, 'Авто') : action.value;
        commands.push({ channel, value });
      } catch (error) {
        plugin.log('Команда ' + channel + ' отклонена: ' + error.message);
      }
    }
    if (commands.length) void tick();
  });

  plugin.onChange('channels', async () => {
    await loadChannels();
    if (mqtt) publish(mqttValues);
    await tick();
  });
  void loadChannels().then(() => {
    ready = true;
    if (mqtt) publish({ online: 0, ...mqttValues });
    return tick();
  });

  const timer = useHttp ? setInterval(tick, interval) : undefined;
  return () => {
    stopped = true;
    clearInterval(timer);
    if (mqtt) mqtt.stop();
  };
};
