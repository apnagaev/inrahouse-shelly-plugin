'use strict';

const fs = require('fs');
const { createHash } = require('crypto');
const path = require('path');

function main() {
  const [project, device, ...rest] = process.argv.slice(2);
  if (!project || rest.length || (device && !/^d[0-9]+$/.test(device))) {
    throw new Error('Использование: node extras/install.js <каталог проекта> [ID устройства dNNNN]');
  }

  const root = fs.realpathSync(project);
  const jbase = path.join(root, 'jbase');
  const pending = [];
  const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
  const dialog = read('dialog.json');

  function db(name) {
    const file = path.join(jbase, name);
    const content = fs.readFileSync(file, 'utf8');
    return {file, content, rows: content.split(/\r?\n/).filter(line => line.trim()).map(JSON.parse)};
  }

  function append(database, rows) {
    if (!rows.length) return;
    const separator = !database.content || database.content.endsWith('\n') ? '' : '\n';
    pending.push([database.file, database.content + separator + rows.map(row => JSON.stringify(row)).join('\n') + '\n']);
  }

  function allocate(rows, prefix) {
    const used = new Set(rows.flatMap(row => [row._id, row.id]));
    for (let n = 1; n < 100000; n++) {
      const id = prefix + String(n).padStart(3, '0');
      if (!used.has(id)) return id;
    }
    throw new Error('Свободный ID не найден: ' + prefix);
  }

  function installDialog(file, content) {
    if (fs.existsSync(file)) {
      const current = fs.readFileSync(file, 'utf8');
      if (current === content) return;
      const template = current.replace("const did = '" + device + "';", "const did = '__DEVICE_ID__';");
      const hash = createHash('sha256').update(template).digest('hex');
      // Upgrade the stock 5.3.3 dialog without overwriting customized dialogs.
      if (hash !== '5fc1a6e09e3f2fc7c1974fb2466dde82a072d3f7ee681f99008f3b0b5ab9e0db') {
        throw new Error('Диалог уже существует и отличается от штатного: ' + file);
      }
    }
    pending.push([file, content]);
  }

  const type = read('type.json');
  const types = db('types.db');
  const liveTypes = [...new Map(types.rows.map(row => [row._id, row])).values()]
    .filter(row => !row.$$deleted);
  if (!liveTypes.some(row => row._id === type.parent)) {
    throw new Error('Не найден корень типов устройств');
  }
  const existingType = liveTypes.find(row => row.name === type.name && row.parent === type.parent && !row.folder);
  const typeId = existingType ? existingType._id : allocate(types.rows, 't');
  if (!existingType) {
    append(types, [{ ...type, _id: typeId }]);
  } else {
    const props = existingType.props || {};
    const missing = Object.entries(type.props).filter(([key]) => !Object.prototype.hasOwnProperty.call(props, key));
    if (missing.length) {
      append(types, [{ ...existingType, props: { ...props, ...Object.fromEntries(missing) } }]);
    }
  }

  let dialogId;
  if (device) {
    const target = db('devices.db').rows.find(row => row._id === device && !row.folder);
    if (!target) throw new Error('Устройство не найдено: ' + device);
    const dialogs = db('dialogs.db');
    if (!dialogs.rows.some(row => row._id === 'dialoggroup')) throw new Error('Не найден корень диалогов');
    const name = 'Shelly 1 · ' + device;
    const existing = dialogs.rows.find(row => row.name === name && row.parent === 'dialoggroup' && !row.folder);
    dialogId = existing ? existing._id : allocate(dialogs.rows, 'di');
    const content = JSON.stringify(dialog).replace(/__DEVICE_ID__/g, device) + '\n';
    installDialog(path.join(jbase, 'dialog', dialogId + '.json'), content);
    if (!existing) append(dialogs, [{_id: dialogId, parent: 'dialoggroup', name, order: 90000, status: 0, miss: 1}]);
  }

  const staged = [];
  try {
    for (const [file, content] of pending) {
      const tmp = file + '.plugin-install-' + process.pid;
      const stat = fs.existsSync(file) ? fs.statSync(file) : null;
      fs.writeFileSync(tmp, content, {flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o644});
      staged.push([file, tmp]);
      if (stat && typeof process.getuid === 'function' && process.getuid() === 0) {
        fs.chownSync(tmp, stat.uid, stat.gid);
      }
    }
    for (const [file, tmp] of staged) fs.renameSync(tmp, file);
  } finally {
    for (const [, tmp] of staged) if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }

  console.log('Тип устройства:', typeId);
  if (dialogId) console.log('Диалог:', dialogId);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
