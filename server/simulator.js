// simulator.js
// A "virtual ESP32" you can run locally to test the full order -> dispense flow
// BEFORE your real hardware is wired up. It speaks the exact same MQTT protocol
// the real firmware (esp32/vending_machine.ino) uses, so you can swap this out
// for the real board later with zero changes to the web app.
//
// Run with:  node simulator.js

require('dotenv').config();
const mqtt = require('mqtt');

const MACHINE_ID = process.env.MACHINE_ID || 'VM01';
const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com:1883';

const TOPIC_CMD = `fruityvapes/${MACHINE_ID}/cmd`;
const TOPIC_STATUS = `fruityvapes/${MACHINE_ID}/status`;
const TOPIC_HEARTBEAT = `fruityvapes/${MACHINE_ID}/heartbeat`;

// pretend stock, same starting values as the seeded DB
const stock = { A1: 10, A2: 10 };

const client = mqtt.connect(BROKER_URL, { clientId: `fruityvapes-sim-${Math.random().toString(16).slice(2, 8)}` });

client.on('connect', () => {
  console.log(`[simulator] connected to ${BROKER_URL} pretending to be machine ${MACHINE_ID}`);
  client.subscribe(TOPIC_CMD);

  // send a heartbeat every 8 seconds so the storefront shows "machine online"
  setInterval(() => {
    client.publish(TOPIC_HEARTBEAT, JSON.stringify({ slots: stock }));
  }, 8000);
  client.publish(TOPIC_HEARTBEAT, JSON.stringify({ slots: stock }));
});

client.on('message', (topic, payload) => {
  if (topic !== TOPIC_CMD) return;
  const msg = JSON.parse(payload.toString());
  console.log(`[simulator] received dispense command for slot ${msg.slot} (order ${msg.orderId})`);

  if (stock[msg.slot] <= 0) {
    console.log(`[simulator] slot ${msg.slot} is empty, reporting failure`);
    client.publish(TOPIC_STATUS, JSON.stringify({ orderId: msg.orderId, slot: msg.slot, status: 'failed' }));
    return;
  }

  // simulate the motor/servo spinning to push the item out (~2.5s)
  console.log(`[simulator] motor spinning for slot ${msg.slot}...`);
  setTimeout(() => {
    stock[msg.slot] -= 1;
    console.log(`[simulator] item dropped from slot ${msg.slot}. remaining stock: ${stock[msg.slot]}`);
    client.publish(TOPIC_STATUS, JSON.stringify({ orderId: msg.orderId, slot: msg.slot, status: 'dispensed' }));
    client.publish(TOPIC_HEARTBEAT, JSON.stringify({ slots: stock }));
  }, 2500);
});
