'use strict';

const connect = require('./mqtt-client');

module.exports = function connectRelay(plugin, params, publish) {
  const topic = String(params.mqttTopic || '').trim();
  if (!/^shellies\/[^/+#\s\x00-\x1f]+$/.test(topic)) {
    throw new Error('Укажите базовый топик Shelly в формате shellies/имя-устройства');
  }

  const client = connect(plugin, params);
  const relay = topic + '/relay/0';
  const availability = topic + '/online';

  let subscribed = false;
  let online = false;
  let connection = 0;

  function setOnline(value) {
    online = value;
    publish({ online: Number(value) });
  }

  client.on('connect', () => {
    const generation = ++connection;
    subscribed = false;
    setOnline(false);
    client.subscribe([relay, availability], { qos: 0 }, (error, granted) => {
      if (generation !== connection || !client.connected) return;
      if (error || granted?.length !== 2 || granted.some(item => item.qos !== 0)) {
        plugin.log('Подписка Shelly MQTT: ' + (error?.message || 'брокер отклонил топики'));
        return;
      }
      subscribed = true;
      client.publish(topic + '/command', 'update', { qos: 0, retain: false }, error => {
        if (error) plugin.log('Запрос состояния Shelly MQTT: ' + error.message);
      });
    });
  });

  client.on('message', (source, payload, packet) => {
    const value = payload.toString();
    if (source === availability) {
      if (value === 'false') setOnline(false);
      else if (value === 'true' && !packet.retain) setOnline(true);
    } else if (source === relay && (value === 'on' || value === 'off') && !packet.retain) {
      online = true;
      publish({ online: 1, state: Number(value === 'on') });
    }
  });

  client.on('close', () => {
    connection++;
    subscribed = false;
    setOnline(false);
  });
  client.on('error', error => plugin.log('Shelly MQTT: ' + error.message));

  return {
    write(value) {
      if (!client.connected || !subscribed || !online) {
        throw new Error('Нет связи с Shelly по MQTT');
      }
      client.publish(relay + '/command', value, { qos: 0, retain: false }, error => {
        if (error) plugin.log('Команда Shelly MQTT: ' + error.message);
      });
    },
    stop() {
      client.end(true);
    }
  };
};
