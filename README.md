# FruityVapes — Remote Vending Machine Web App

A customer storefront + admin panel for a real ESP32-controlled vending machine,
built for testing with **2 slots** (no payment gateway yet — this is a working
proof-of-concept you can dispense real product with).

```
fruityvapes/
├── server/                  Node/Express backend + web frontend
│   ├── server.js             API routes, auth, static file serving
│   ├── db.js                 SQLite schema + seed data (your 2 products)
│   ├── mqttBridge.js         Talks to the ESP32 over MQTT
│   ├── simulator.js          "Virtual ESP32" for testing without hardware
│   ├── package.json
│   ├── .env.example           Copy to .env and fill in
│   └── public/
│       ├── index.html         Customer storefront
│       ├── admin/index.html   Admin login + dashboard
│       └── assets/            Your logo + product photos
└── esp32/
    └── vending_machine.ino   Real firmware for the ESP32 board
```

## 1. Quick start — test it locally right now (no hardware needed)

You need [Node.js](https://nodejs.org) 18+ installed.

```bash
cd server
npm install
cp .env.example .env
npm start
```

Open **http://localhost:3000** — that's the customer store.
Open **http://localhost:3000/admin** — log in with:

- **Username:** `fruityvapes`
- **Password:** `fv09876`

Right now if you click "Dispense" nothing will happen yet, because there's no
ESP32 (real or simulated) listening. Open a **second terminal** and run:

```bash
cd server
node simulator.js
```

This is a fake ESP32 that speaks the exact same MQTT protocol the real board
uses. Refresh the storefront — the "VM01 ONLINE" badge should light up
green within ~10 seconds. Now click **Dispense** on either product: you'll
see the order go out, the simulated "motor" run for ~2.5s, and the item
animate into the tray. The admin panel's Orders table and stock counts update
in real time too.

When you're happy with the software, replace `node simulator.js` with your
real ESP32 board running `esp32/vending_machine.ino` — **nothing else changes**,
because it's talking over the same MQTT topics.

## 2. Wiring up the real ESP32

Open `esp32/vending_machine.ino` in the Arduino IDE.

1. Install libraries via Library Manager: **PubSubClient** and **ArduinoJson**.
2. Fill in `WIFI_SSID` / `WIFI_PASSWORD` near the top.
3. Set `MACHINE_ID` to match your `.env` (`VM01` by default).
4. Wire your two slot motors/relays to `RELAY_A1_PIN` (26) and
   `RELAY_A2_PIN` (27) — change these if you wire to different GPIOs.
5. Flash it, open the Serial Monitor at 115200 baud to confirm it connects
   to Wi-Fi and then to the MQTT broker.

Because the ESP32 talks over MQTT (not a direct connection to your server),
it can be anywhere with internet — a different room, a different country —
and the web app can dispense from anywhere too. Nothing needs port-forwarding.

## 3. About the MQTT broker (important for going beyond testing)

By default this project points at the free public broker
`broker.hivemq.com`, which is fine for early testing but has **no
authentication** — technically anyone who guesses your `MACHINE_ID` could
publish a dispense command. Before you rely on this for anything real:

1. Create a free private broker at [HiveMQ Cloud](https://www.hivemq.com/mqtt-cloud-broker/)
   (or use Mosquitto on your own VPS).
2. Set a username/password and TLS for the broker.
3. Update `MQTT_BROKER_URL` in `.env` (e.g. `mqtts://<your-cluster>.hivemq.cloud:8883`)
   and add the matching credentials to both `mqttBridge.js` (`mqtt.connect` options)
   and the ESP32 firmware's `mqttClient.connect(...)` call.

## 4. Putting it online ("controlled from anywhere")

The web app itself just needs to run somewhere reachable on the internet —
it does **not** need to be on the same network as the ESP32, since they only
ever talk through the MQTT broker. Easiest options:

- **Railway** or **Render**: point them at the `server/` folder, set the
  environment variables from `.env.example` in their dashboard, done.
- **A small VPS** (DigitalOcean, Hetzner, etc.): `npm install && npm start`,
  put it behind Nginx + a free Let's Encrypt certificate, and optionally run
  it with `pm2` so it restarts on crash/reboot.

Once deployed, any customer with the URL can order, and you can manage stock
from `/admin` from anywhere, on your phone or laptop.

## 5. Adding more slots / going live with payments later

- New slots: add a row in the `slots` table (see the `INSERT` calls near
  the bottom of `db.js`), wire up a new relay pin on the ESP32, and add the
  new slot code (e.g. `A3`) to the `dispenseSlot()` pin lookup in the
  firmware.
- Payments: this build intentionally skips a payment gateway per your
  request. When you're ready, the natural place to add it is right before
  `mqttBridge.sendDispenseCommand(...)` in `server.js`'s `/api/order` route —
  only call it after payment is confirmed (e.g. via JazzCash/Easypaisa/Stripe
  webhook).

## 6. Troubleshooting

- **"VM01 OFFLINE" never turns green** — the ESP32 (or simulator) isn't
  connected to the same `MQTT_BROKER_URL`/`MACHINE_ID` as the server. Check
  the Serial Monitor or simulator console output.
- **Order stuck on "Dispensing..." then times out** — the broker connection
  dropped mid-command, or the slot's real stock is 0 on the ESP32 side and
  it didn't publish a "failed" status. Check the device logs.
- **Admin login fails** — double check you're using `fruityvapes` / `fv09876`
  exactly; you can change these in `db.js` (update the `hash('fv09876')` seed
  line and restart with a fresh `.db` file, or add an endpoint to change it
  later).
