const Database = require('better-sqlite3');
const path = require('path');
const bcryptLite = require('crypto');

const db = new Database(path.join(__dirname, 'fruityvapes.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  subtitle TEXT,
  price INTEGER NOT NULL,
  image TEXT,
  stock INTEGER NOT NULL DEFAULT 5,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS machine (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  machine_id TEXT NOT NULL,
  last_heartbeat TEXT,
  online INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS restock_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_code TEXT NOT NULL,
  contact TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  notified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS uptime_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  online INTEGER NOT NULL,
  changed_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// migrate: add a longer description field for the product detail view
try {
  db.exec('ALTER TABLE slots ADD COLUMN description TEXT');
} catch (e) {
  // column already exists, ignore
}

// migrate: add compare_at_price for showing a strikethrough "was Rs X" sale price on the storefront
try {
  db.exec('ALTER TABLE slots ADD COLUMN compare_at_price INTEGER');
} catch (e) {
  // column already exists, ignore
}

// migrate: add badge column for filter tags (New / Bestseller / etc) if upgrading from an older db
try {
  db.exec('ALTER TABLE slots ADD COLUMN badge TEXT');
} catch (e) {
  // column already exists, ignore
}

// migrate: add category column (flavour / pod) so the storefront can filter by product type
try {
  db.exec("ALTER TABLE slots ADD COLUMN category TEXT NOT NULL DEFAULT 'flavour'");
} catch (e) {
  // column already exists, ignore
}

// seed admin (fruityvapes / fv09876) if not present
const hash = (pw) => bcryptLite.createHash('sha256').update(pw).digest('hex');
const adminExists = db.prepare('SELECT * FROM admins WHERE username = ?').get('fruityvapes');
if (!adminExists) {
  db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run('fruityvapes', hash('fv09876'));
}

// seed the two test slots if empty
const slotCount = db.prepare('SELECT COUNT(*) as c FROM slots').get().c;
if (slotCount === 0) {
  const insert = db.prepare('INSERT INTO slots (slot_code, name, subtitle, price, image, stock, badge, category, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('A1', 'Tokyo Super Cool - Pineapple Mango', 'Nicotine Salt E-Liquid, 30ml', 4000, '/assets/bottle.png', 5, 'Bestseller', 'flavour',
    'A crisp pineapple-mango blend with a cooling menthol finish. 30ml bottle, nicotine salt formula, 50mg strength.');
  insert.run('A2', 'CaliBar CH Pod Kit', '35W Rechargeable Pod Device', 7999, '/assets/pod.png', 5, 'New', 'pod',
    'Compact 35W pod system with adjustable airflow and a USB-C fast-charging battery. Compatible with standard 0.8ohm and 1.2ohm pods.');
}

// one-time correction: earlier versions of this migration assumed ALTER TABLE ... DEFAULT 'flavour'
// would leave existing rows NULL so it could detect and fix them — but SQLite actually backfills
// the default value immediately, so slot A2 (the pod kit) got silently set to 'flavour' and stayed
// that way. This runs exactly once (tracked via the meta table) so it never re-overrides an admin's
// own category edits on later restarts.
const categoryFixDone = db.prepare("SELECT value FROM meta WHERE key = 'category_backfill_v1'").get();
if (!categoryFixDone) {
  db.prepare("UPDATE slots SET category = 'pod' WHERE slot_code = 'A2'").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('category_backfill_v1', 'done')").run();
}

const machineRow = db.prepare('SELECT * FROM machine WHERE id = 1').get();
if (!machineRow) {
  db.prepare('INSERT INTO machine (id, machine_id, online) VALUES (1, ?, 0)').run(process.env.MACHINE_ID || 'VM01');
}

module.exports = { db, hash };
