// mqttBridge.js
// Handles all communication with the physical (or simulated) ESP32 vending machine
// over MQTT, so it can be controlled remotely from anywhere in the world.
//
// Topics (namespaced by MACHINE_ID so multiple machines / test setups don't collide):
//   fruityvapes/<MACHINE_ID>/cmd        -> server publishes dispense commands here
//   fruityvapes/<MACHINE_ID>/status     -> ESP32 publishes dispense results here
//   fruityvapes/<MACHINE_ID>/heartbeat  -> ESP32 publishes "I'm alive + slot stock" here

const mqtt = require('mqtt');
const { db } = require('./db');

const MACHINE_ID = process.env.MACHINE_ID || 'VM01';
const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com:1883';

const TOPIC_CMD = `fruityvapes/${MACHINE_ID}/cmd`;
const TOPIC_STATUS = `fruityvapes/${MACHINE_ID}/status`;
const TOPIC_HEARTBEAT = `fruityvapes/${MACHINE_ID}/heartbeat`;

let client = null;
let onlineTimer = null;

function markOnline(isOnline) {
  const current = db.prepare('SELECT online FROM machine WHERE id = 1').get();
  const changed = !current || current.online !== (isOnline ? 1 : 0);
  db.prepare('UPDATE machine SET online = ?, last_heartbeat = CURRENT_TIMESTAMP WHERE id = 1')
    .run(isOnline ? 1 : 0);
  if (changed) {
    db.prepare('INSERT INTO uptime_log (online) VALUES (?)').run(isOnline ? 1 : 0);
  }
}

function connect(io) {
  client = mqtt.connect(BROKER_URL, {
    clientId: `fruityvapes-server-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 2000,
  });

  client.on('connect', () => {
    console.log(`[mqtt] connected to ${BROKER_URL} as bridge for machine ${MACHINE_ID}`);
    client.subscribe([TOPIC_STATUS, TOPIC_HEARTBEAT], (err) => {
      if (err) console.error('[mqtt] subscribe error', err);
    });
  });

  // A stock value only gets written to the DB if it's a real, non-negative integer.
  // This is what stops a bad/missing reading (null, undefined, "n/a", a negative number,
  // stray traffic from another client on the shared public broker, etc.) from ever being
  // written to the `slots.stock` column, which is NOT NULL and previously had no guard here.
  function isValidStock(v) {
    return Number.isInteger(v) && v >= 0;
  }

  client.on('message', (topic, payload) => {
    let msg;
    try {
      msg = JSON.parse(payload.toString());
    } catch (e) {
      return;
    }

    // Everything below used to run unguarded, so any unexpected/malformed message on this
    // topic (including from someone else's device on the shared public broker) could throw
    // and crash the whole Node process. Now nothing in here can take the server down.
    try {
      if (topic === TOPIC_HEARTBEAT) {
        markOnline(true);

        // Accept two heartbeat shapes so the server doesn't care which style the firmware uses:
        //   1) { slots: { A1: 4, A2: 5 } }      <- keyed by slot_code directly
        //   2) { online: true, slot1: 4, slot2: 5 }  <- flat numbered keys, mapped in slot order below
        if (msg.slots && typeof msg.slots === 'object') {
          for (const [slotCode, stock] of Object.entries(msg.slots)) {
            if (!isValidStock(stock)) {
              console.warn(`[mqtt] ignoring bad heartbeat stock value for slot ${slotCode}:`, stock);
              continue;
            }
            db.prepare('UPDATE slots SET stock = ? WHERE slot_code = ?').run(stock, slotCode);
          }
        } else {
          const flatSlotKeys = Object.keys(msg).filter(k => /^slot\d+$/.test(k)).sort();
          if (flatSlotKeys.length > 0) {
            const slotCodesInOrder = db.prepare('SELECT slot_code FROM slots ORDER BY slot_code ASC').all().map(r => r.slot_code);
            flatSlotKeys.forEach((key, i) => {
              const slotCode = slotCodesInOrder[i];
              const stock = msg[key];
              if (slotCode && isValidStock(stock)) {
                db.prepare('UPDATE slots SET stock = ? WHERE slot_code = ?').run(stock, slotCode);
              } else if (slotCode) {
                console.warn(`[mqtt] ignoring bad heartbeat stock value for slot ${slotCode}:`, stock);
              }
            });
          }
        }
        resetOnlineTimeout();
      }

      if (topic === TOPIC_STATUS && msg.orderId) {
        const status = msg.status === 'dispensed' ? 'dispensed' : 'failed';
        db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(status, msg.orderId);

        if (status === 'dispensed' && msg.slot) {
          db.prepare('UPDATE slots SET stock = MAX(stock - 1, 0) WHERE slot_code = ?').run(msg.slot);
        }
      }
    } catch (err) {
      console.error('[mqtt] failed to process message on', topic, err.message);
    }
  });

  client.on('error', (err) => console.error('[mqtt] error', err.message));

  return client;
}

// If we don't hear a heartbeat for 20s, consider the machine offline.
function resetOnlineTimeout() {
  if (onlineTimer) clearTimeout(onlineTimer);
  onlineTimer = setTimeout(() => markOnline(false), 20000);
}

function sendDispenseCommand(orderId, slotCode) {
  if (!client || !client.connected) {
    throw new Error('Machine bridge not connected to broker');
  }
  client.publish(TOPIC_CMD, JSON.stringify({ orderId, slot: slotCode, action: 'dispense' }));
}

function getTopics() {
  return { TOPIC_CMD, TOPIC_STATUS, TOPIC_HEARTBEAT, MACHINE_ID, BROKER_URL };
}

module.exports = { connect, sendDispenseCommand, getTopics };
