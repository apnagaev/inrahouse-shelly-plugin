'use strict';

function integer(value, min, max, label) {
  const validType = typeof value === 'number' ||
    (typeof value === 'string' && /^\d+$/.test(value.trim()));
  const number = validType ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(label + ': допустимый диапазон ' + min + '–' + max);
  }
  return number;
}

function binary(value, label) {
  return integer(typeof value === 'boolean' ? Number(value) : value, 0, 1, label) === 1;
}

module.exports = { integer, binary, maxSeconds: 2147483647 };
