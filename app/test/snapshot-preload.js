'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require; every server test/helpers.js starts without preloads of its
// own, and the smoke's): the runtime half of the fence on a room's snapshot, a hall's Main room's and a side room's
// alike. A start and a stop write only the dirty rooms (lib/store.js `compactDirty`), so a change to a field a snapshot
// writes that the store was never told of (an op, or `markDirty`) would be lost at the stop. Each room's fields are kept
// here as the store last wrote them or loaded them (`savedAt` aside, and before the load's `onMigrate`); at each
// `compactDirty` (a start, a stop, a crash) every room it leaves unwritten is compared with them, and each field that
// differs is appended to the file AGM_TEST_SNAPSHOTS names as the process exits, a line `<key> <field>`. Nothing the
// server does is changed. A process killed writes nothing.
const fs = require('fs');

const file = process.env.AGM_TEST_SNAPSHOTS;
if (file) {
  const { RoomStore, SNAPSHOT_FIELDS } = require('../lib/store');
  const FIELDS = Object.keys(SNAPSHOT_FIELDS).filter((f) => f !== 'savedAt');
  const kept = new WeakMap();
  const fieldsOf = (store, room) => { const snap = store.snapshotOf(room, 0); return Object.fromEntries(FIELDS.map((f) => [f, JSON.stringify(snap[f])])); };
  const found = new Set();

  const compact = RoomStore.prototype.compact;
  RoomStore.prototype.compact = function keptAsWritten(code) {
    const wrote = compact.call(this, code);
    if (wrote) kept.set(this.room(code), fieldsOf(this, this.room(code)));
    return wrote;
  };
  const loadAll = RoomStore.prototype.loadAll;
  RoomStore.prototype.loadAll = function keptAsLoaded(onMigrate, options) {
    return loadAll.call(this, (room) => { kept.set(room, fieldsOf(this, room)); if (onMigrate) onMigrate(room); }, options);
  };
  const compactDirty = RoomStore.prototype.compactDirty;
  RoomStore.prototype.compactDirty = function checked() {
    const n = compactDirty.call(this);
    for (const room of this.allRooms()) {
      const was = kept.get(room);
      if (!was || this.dirty(room)) continue;
      const now = fieldsOf(this, room);
      for (const f of FIELDS) if (now[f] !== was[f]) found.add(room.code + ' ' + f);
    }
    return n;
  };
  process.on('exit', () => { if (found.size) fs.appendFileSync(file, Array.from(found).join('\n') + '\n'); });
}
