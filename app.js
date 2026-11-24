'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const relayPath = '/relay/0';
const settingsPath = '/settings/relay/0';
const buttonModes = new Set([
  'momentary', 'toggle', 'edge', 'detached', 'action', 'momentary_on_release'
]);

function integer(value, min, max, label) {
  const validType = typeof value === 'number' ||
    (typeof value === 'string' && /^\d+$/.test(value.trim()));
  const number = validType ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(label + ': допустимый диапазон ' + min + '–' + max);
  }
  return number;
}

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
    url.searchParams.set('auto_off', integer(value, 0, 2147483647, 'Таймер'));
  } else {
    if (!buttonModes.has(value)) throw new Error('Неизвестный режим входа SW');
    url.searchParams.set('btn_type', value);
  }
  return url;
}

module.exports = function start(plugin, params) {
  const origin = readOrigin(params.host);
  const interval = integer(params.pollSeconds ?? 5, 1, 300, 'Опрос') * 1000;
  const timeout = integer(params.timeout ?? 2500, 250, 15000, 'Тайм-аут');
  const auth = params.username ? String(params.username) + ':' + String(params.password || '') : undefined;
  const pollUrl = new URL(settingsPath, origin);
  const commands = [];
  let channels = [];
  let online;
  let busy = false;
  let ready = false;
  let stopped = false;

  async function loadChannels() {
    try {
      const list = await plugin.channels.get();
      if (Array.isArray(list)) channels = list;
    } catch (error) {
      plugin.log('Каналы Shelly: ' + error.message);
    }
  }

  function publish(values) {
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
      const values = { online: 1, state: Number(response.ison) };
      if (url.pathname === settingsPath) {
        if (!Number.isFinite(response.auto_off) || response.auto_off < 0 ||
            typeof response.btn_type !== 'string') {
          throw new Error('Ответ Shelly не содержит настроек реле');
        }
        values.timeOff = response.auto_off;
        values.buttontype = response.btn_type;
      }
      if (online !== true) plugin.log('Связь с Shelly установлена');
      online = true;
      publish(values);
      if (command) {
        const expected = command === 'state'
          ? Number(url.searchParams.get('turn') === 'on')
          : command === 'timeOff'
            ? Number(url.searchParams.get('auto_off'))
            : url.searchParams.get('btn_type');
        if (values[command] !== expected) {
          plugin.log('Устройство сообщило другое значение для ' + command);
        }
      }
    } catch (error) {
      if (online !== false || command) plugin.log((command || 'Связь с Shelly') + ': ' + error.message);
      online = false;
      publish({ online: 0 });
    }
  }

  async function tick() {
    if (busy || !ready || stopped) return;
    busy = true;
    try {
      if (!commands.length) await exchange(pollUrl);
      while (commands.length && !stopped) {
        const { url, channel } = commands.shift();
        await exchange(url, channel);
      }
    } finally {
      busy = false;
    }
  }

  plugin.onAct(message => {
    for (const action of message.data || []) {
      const channel = action.chan || channels.find(item => item.id === action.id)?.chan || action.id;
      if (!['state', 'timeOff', 'buttontype'].includes(channel)) continue;
      if (commands.length >= 32) {
        plugin.log('Очередь команд Shelly заполнена');
        break;
      }
      try {
        commands.push({ url: commandUrl(origin, channel, action.value), channel });
      } catch (error) {
        plugin.log('Команда ' + channel + ' отклонена: ' + error.message);
      }
    }
    if (commands.length) void tick();
  });

  plugin.onChange('channels', async () => {
    await loadChannels();
    await tick();
  });
  void loadChannels().then(() => {
    ready = true;
    return tick();
  });

  const timer = setInterval(tick, interval);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};
