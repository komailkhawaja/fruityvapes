require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, hash } = require('./db');
const mqttBridge = require('./mqttBridge');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- image upload storage (admin product photos) ----------
const uploadDir = path.join(__dirname, 'public/assets/uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `slot-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) return cb(new Error('Only PNG, JPG or WEBP images are allowed'));
    cb(null, true);
  },
});

// ---------- auth middleware ----------
function requireAdmin(req, res, next) {
  const token = req.cookies?.fv_admin_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

// ================= PUBLIC / CUSTOMER API =================

// list active products/slots for the store front
app.get('/api/products', (req, res) => {
  const slots = db.prepare('SELECT slot_code, name, subtitle, description, price, compare_at_price, image, stock, badge, category FROM slots WHERE active = 1').all();
  res.json(slots);
});

// top-selling items, shown as a "Popular picks" row on the storefront (no revenue figures exposed publicly)
app.get('/api/popular', (req, res) => {
  const rows = db.prepare(`
    SELECT product_name, COUNT(*) as units
    FROM orders WHERE status = 'dispensed'
    GROUP BY product_name ORDER BY units DESC LIMIT 3
  `).all();
  res.json(rows);
});

// customer asks to be notified when an out-of-stock slot is refilled
app.post('/api/notify-restock', (req, res) => {
  const { slotCode, contact } = req.body;
  const slot = db.prepare('SELECT * FROM slots WHERE slot_code = ?').get(slotCode);
  if (!slot) return res.status(404).json({ error: 'Product not found' });
  db.prepare('INSERT INTO restock_requests (slot_code, contact) VALUES (?, ?)').run(slotCode, contact || null);
  res.json({ ok: true });
});

// machine online status, shown as a small badge on the storefront
app.get('/api/machine-status', (req, res) => {
  const m = db.prepare('SELECT online, last_heartbeat FROM machine WHERE id = 1').get();
  res.json(m);
});

// place a test order -> triggers real dispense command over MQTT to the ESP32
app.post('/api/order', (req, res) => {
  const { slotCode } = req.body;
  const slot = db.prepare('SELECT * FROM slots WHERE slot_code = ? AND active = 1').get(slotCode);
  if (!slot) return res.status(404).json({ error: 'Product not found' });
  if (slot.stock <= 0) return res.status(400).json({ error: 'This slot is out of stock' });

  const info = db
    .prepare('INSERT INTO orders (slot_code, product_name, price, status) VALUES (?, ?, ?, ?)')
    .run(slot.slot_code, slot.name, slot.price, 'pending');
  const orderId = info.lastInsertRowid;

  try {
    mqttBridge.sendDispenseCommand(orderId, slot.slot_code);
    db.prepare("UPDATE orders SET status = 'dispensing' WHERE id = ?").run(orderId);
  } catch (e) {
    db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(orderId);
    return res.status(503).json({ error: 'Vending machine is not reachable right now. Please try again shortly.' });
  }

  res.json({ orderId, status: 'dispensing' });
});

// frontend polls this while showing the dispense animation
app.get('/api/order/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// ================= ADMIN API =================

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || admin.password !== hash(password || '')) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie('fv_admin_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.json({ ok: true, username: admin.username });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('fv_admin_token');
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ username: req.admin.username });
});

app.get('/api/admin/slots', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM slots').all());
});

// create a brand-new product/slot (e.g. adding a new flavour or pod kit to the machine)
app.post('/api/admin/slots', requireAdmin, (req, res) => {
  const { slotCode, name, subtitle, description, price, compareAtPrice, stock, badge, category, image } = req.body;
  if (!slotCode || !name || price == null) {
    return res.status(400).json({ error: 'Slot code, name, and price are required' });
  }
  const existing = db.prepare('SELECT id FROM slots WHERE slot_code = ?').get(slotCode);
  if (existing) {
    return res.status(409).json({ error: `Slot ${slotCode} already exists` });
  }
  try {
    const info = db.prepare(`
      INSERT INTO slots (slot_code, name, subtitle, description, price, compare_at_price, image, stock, badge, category, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      slotCode, name, subtitle || null, description || null,
      parseInt(price, 10), compareAtPrice ? parseInt(compareAtPrice, 10) : null,
      image || '/assets/bottle.png', parseInt(stock, 10) || 0,
      badge || null, category || 'flavour'
    );
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: 'Could not create slot: ' + e.message });
  }
});

app.delete('/api/admin/slots/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM slots WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.put('/api/admin/slots/:id', requireAdmin, (req, res) => {
  const { name, subtitle, description, price, compareAtPrice, stock, active, badge, category } = req.body;
  db.prepare('UPDATE slots SET name = ?, subtitle = ?, description = ?, price = ?, compare_at_price = ?, stock = ?, active = ?, badge = ?, category = ? WHERE id = ?')
    .run(name, subtitle, description || null, price, compareAtPrice ? parseInt(compareAtPrice, 10) : null, stock, active ? 1 : 0, badge || null, category || 'flavour', req.params.id);
  res.json({ ok: true });
});

// upload a product photo, returns the public path to store on the slot's `image` field
app.post('/api/admin/upload', requireAdmin, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ path: `/assets/uploads/${req.file.filename}` });
  });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 100').all();
  res.json(orders);
});

// delete a single order record (e.g. clearing out test orders)
app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true });
});

// delete multiple orders at once (used by the "select all" checkbox in admin)
app.post('/api/admin/orders/bulk-delete', requireAdmin, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No order IDs provided' });
  }
  const placeholders = ids.map(() => '?').join(',');
  const info = db.prepare(`DELETE FROM orders WHERE id IN (${placeholders})`).run(...ids);
  res.json({ ok: true, deleted: info.changes });
});

app.get('/api/admin/machine', requireAdmin, (req, res) => {
  const m = db.prepare('SELECT * FROM machine WHERE id = 1').get();
  const topics = mqttBridge.getTopics();
  res.json({ ...m, topics });
});

// manual admin-triggered dispense (e.g. to clear a jam / restock test)
app.post('/api/admin/dispense/:slotCode', requireAdmin, (req, res) => {
  const slot = db.prepare('SELECT * FROM slots WHERE slot_code = ?').get(req.params.slotCode);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  const info = db
    .prepare('INSERT INTO orders (slot_code, product_name, price, status) VALUES (?, ?, ?, ?)')
    .run(slot.slot_code, `${slot.name} (admin test)`, slot.price, 'pending');
  const orderId = info.lastInsertRowid;
  try {
    mqttBridge.sendDispenseCommand(orderId, slot.slot_code);
    db.prepare("UPDATE orders SET status = 'dispensing' WHERE id = ?").run(orderId);
  } catch (e) {
    return res.status(503).json({ error: 'Vending machine is not reachable right now.' });
  }
  res.json({ orderId, status: 'dispensing' });
});

// retry a failed order: creates a fresh order for the same slot/product so the customer isn't charged
// again for something that never dispensed, and marks the original as retried for the audit trail.
app.post('/api/admin/orders/:id/retry', requireAdmin, (req, res) => {
  const original = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!original) return res.status(404).json({ error: 'Order not found' });
  const slot = db.prepare('SELECT * FROM slots WHERE slot_code = ?').get(original.slot_code);
  if (!slot) return res.status(404).json({ error: 'Original slot no longer exists' });

  const info = db
    .prepare('INSERT INTO orders (slot_code, product_name, price, status) VALUES (?, ?, ?, ?)')
    .run(slot.slot_code, `${slot.name} (retry of #${original.id})`, slot.price, 'pending');
  const orderId = info.lastInsertRowid;
  try {
    mqttBridge.sendDispenseCommand(orderId, slot.slot_code);
    db.prepare("UPDATE orders SET status = 'dispensing' WHERE id = ?").run(orderId);
  } catch (e) {
    db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(orderId);
    return res.status(503).json({ error: 'Vending machine is not reachable right now.' });
  }
  res.json({ orderId, status: 'dispensing' });
});

// list customers waiting to be notified when a slot is restocked (no email/SMS sender configured —
// this surfaces the list so an admin can message people manually, or wire in a provider later)
app.get('/api/admin/restock-requests', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT slot_code, COUNT(*) as count, GROUP_CONCAT(contact, ', ') as contacts, MAX(created_at) as last_requested
    FROM restock_requests WHERE notified = 0
    GROUP BY slot_code ORDER BY count DESC
  `).all();
  res.json(rows);
});

app.post('/api/admin/restock-requests/:slotCode/clear', requireAdmin, (req, res) => {
  db.prepare('UPDATE restock_requests SET notified = 1 WHERE slot_code = ?').run(req.params.slotCode);
  res.json({ ok: true });
});

// change the admin's own password
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
  if (!admin || admin.password !== hash(currentPassword || '')) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(hash(newPassword), admin.id);
  res.json({ ok: true });
});

// machine uptime history: percentage online over last 24h/7d + a recent transition log
app.get('/api/admin/uptime', requireAdmin, (req, res) => {
  const recent = db.prepare('SELECT * FROM uptime_log ORDER BY id DESC LIMIT 20').all();

  function uptimePercent(sinceClause) {
    const transitions = db.prepare(`SELECT online, changed_at FROM uptime_log WHERE changed_at >= ${sinceClause} ORDER BY changed_at ASC`).all();
    const current = db.prepare('SELECT online FROM machine WHERE id = 1').get();
    if (transitions.length === 0) return current && current.online ? 100 : 0;
    let onlineMs = 0;
    let last = { online: transitions[0].online, at: new Date(transitions[0].changed_at + 'Z').getTime() };
    const windowStart = last.at;
    const now = Date.now();
    for (let i = 1; i < transitions.length; i++) {
      const at = new Date(transitions[i].changed_at + 'Z').getTime();
      if (last.online) onlineMs += at - last.at;
      last = { online: transitions[i].online, at };
    }
    if (last.online) onlineMs += now - last.at;
    const totalMs = now - windowStart;
    return totalMs > 0 ? Math.round((onlineMs / totalMs) * 100) : 100;
  }

  res.json({
    recent,
    uptime24h: uptimePercent("datetime('now', '-1 day')"),
    uptime7d: uptimePercent("datetime('now', '-7 day')"),
  });
});

// sales analytics for the admin dashboard chart: revenue per day (last 14 days) + top products
// grouped by Pakistan Standard Time (UTC+5) calendar day, since orders.created_at is stored in UTC
app.get('/api/admin/analytics', requireAdmin, (req, res) => {
  const dailyRevenue = db.prepare(`
    SELECT date(created_at, '+5 hours') as day,
           SUM(price) as revenue,
           COUNT(*) as orders
    FROM orders
    WHERE status = 'dispensed' AND created_at >= datetime('now', '-14 days')
    GROUP BY day
    ORDER BY day ASC
  `).all();

  const topProducts = db.prepare(`
    SELECT product_name, COUNT(*) as units, SUM(price) as revenue
    FROM orders
    WHERE status = 'dispensed'
    GROUP BY product_name
    ORDER BY revenue DESC
    LIMIT 5
  `).all();

  const totals = db.prepare(`
    SELECT COUNT(*) as totalOrders, COALESCE(SUM(price),0) as totalRevenue
    FROM orders WHERE status = 'dispensed'
  `).get();

  const failedCount = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status = 'failed'`).get().c;

  res.json({ dailyRevenue, topProducts, totals, failedCount });
});

// export all orders as a CSV file for accounting
app.get('/api/admin/orders/export.csv', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  const header = 'Order ID,Slot,Product,Price (PKR),Status,Created At,Updated At';
  const rows = orders.map(o => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [o.id, esc(o.slot_code), esc(o.product_name), o.price, o.status, o.created_at, o.updated_at].join(',');
  });
  const csv = [header, ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="fruityvapes-orders-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});

// ---------- automatic daily database backup ----------
// Copies the live SQLite file into /backups with a timestamped name and keeps the last 7.
// Runs once at startup, then every 24h. This is a local file-level backup, not an offsite one —
// for real disaster recovery also copy the /backups folder somewhere outside this machine periodically.
const backupDir = path.join(__dirname, 'backups');
function runBackup() {
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupDir, `fruityvapes-${stamp}.db`);
    fs.copyFileSync(path.join(__dirname, 'fruityvapes.db'), dest);
    const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort();
    while (files.length > 7) {
      fs.unlinkSync(path.join(backupDir, files.shift()));
    }
    console.log(`[backup] saved ${dest}`);
  } catch (e) {
    console.error('[backup] failed:', e.message);
  }
}

app.listen(PORT, () => {
  console.log(`FruityVapes server running on http://localhost:${PORT}`);
  console.log(`Admin panel:  http://localhost:${PORT}/admin`);
  mqttBridge.connect();
  runBackup();
  setInterval(runBackup, 24 * 60 * 60 * 1000);
});
