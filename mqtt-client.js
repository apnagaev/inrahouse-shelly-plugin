'use strict';

const { URL } = require('url');

module.exports = function connect(plugin, params) {
  const broker = String(params.mqttBroker || '').trim();
  if (!broker) throw new Error('Укажите URL MQTT-брокера');
  const url = new URL(broker);
  if (!['mqtt:', 'mqtts:'].includes(url.protocol) || url.username || url.password ||
      (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('Укажите mqtt:// или mqtts:// без пути и учётных данных в URL');
  }
  const mqtt = require('./vendor/mqtt.cjs');

  // intraHouse can store a single password in ppw instead of a named field.
  let password = params.mqttPassword;
  if (params.ppw_mqttPassword) {
    password = plugin.getPassword(params, 'mqttPassword');
  } else if (params.ppw) {
    password = plugin.getPassword(params);
  }
  return mqtt.connect(url.href, {
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 5000,
    resubscribe: false,
    queueQoSZero: false,
    username: params.mqttUsername || undefined,
    password: password || undefined
  });
};
