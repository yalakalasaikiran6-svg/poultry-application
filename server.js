const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'poultry.db');
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

// Ensure schema exists
if (!fs.existsSync(SCHEMA_FILE)) {
  console.error('schema.sql not found in repo root. Please ensure schema.sql exists on the default branch.');
  process.exit(1);
}

const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
const db = new sqlite3.Database(DB_FILE);
// initialize base schema
db.exec(schema, (err) => {
  if (err) console.error('Failed to initialize DB with schema.sql:', err);
});

// ensure prices table exists
db.exec(`CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  price_per_hen REAL DEFAULT 0,
  price_per_kg REAL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);`, (err) => {
  if (err) console.error('Failed to create prices table:', err);
});

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// Get current price (latest for today if available)
app.get('/api/price', (req, res) => {
  const today = "DATE('now','localtime')"; // used in SQL
  db.get(`SELECT price_per_hen, price_per_kg, date FROM prices WHERE date = DATE('now','localtime') ORDER BY id DESC LIMIT 1`, [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.json({ price_per_hen: 0, price_per_kg: 0 });
    res.json({ price_per_hen: row.price_per_hen || 0, price_per_kg: row.price_per_kg || 0, date: row.date });
  });
});

// Set today's price
app.post('/api/price', (req, res) => {
  const { price_per_hen = 0, price_per_kg = 0 } = req.body;
  const date = new Date().toISOString().slice(0,10); // YYYY-MM-DD
  db.run(`INSERT INTO prices (date, price_per_hen, price_per_kg) VALUES (?,?,?)`, [date, price_per_hen, price_per_kg], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

// Get list of birds (optional filters)
app.get('/api/birds', (req, res) => {
  const { status, type } = req.query;
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (type) { conditions.push('type = ?'); params.push(type); }
  const where = conditions.length ? ('WHERE ' + conditions.join(' AND ')) : '';
  const sql = `SELECT id, type, batch, status, weight_kg, cost_per_hen, cost_per_kg, added_at, sold_at, sold_price, deceased_at FROM birds ${where} ORDER BY added_at DESC`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Add birds (single or multiple)
app.post('/api/birds', (req, res) => {
  const { type, batch, qty = 1, weight_kg = null, cost_per_hen = null, cost_per_kg = null } = req.body;
  if (!type || !['hen','broiler'].includes(type)) return res.status(400).json({ error: 'type required: hen|broiler' });
  const stmt = db.prepare(`INSERT INTO birds (type,batch,weight_kg,cost_per_hen,cost_per_kg) VALUES (?,?,?,?,?)`);
  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    for (let i = 0; i < qty; i++) {
      stmt.run(type, batch || null, weight_kg, cost_per_hen, cost_per_kg);
    }
    db.run("COMMIT");
    stmt.finalize();
    res.json({ success: true, added: qty });
  });
});

// Record sale (optionally mark specific bird ids as sold)
app.post('/api/sales', (req, res) => {
  const { bird_type, qty, total_kg = null, price_per_kg = null, total_amount, bird_ids = [] } = req.body;
  if (!bird_type || total_amount == null) return res.status(400).json({ error: 'bird_type and total_amount required' });
  const date = new Date().toISOString();
  db.run(`INSERT INTO sales (date,bird_type,qty,total_kg,price_per_kg,total_amount) VALUES (?,?,?,?,?,?)`,
    [date, bird_type, qty, total_kg, price_per_kg, total_amount],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const saleId = this.lastID;
      // If bird_ids provided, mark them sold and set sold_at and sold_price (distribute total_amount equally)
      if (Array.isArray(bird_ids) && bird_ids.length > 0) {
        const perBird = total_amount / bird_ids.length;
        const now = new Date().toISOString();
        const stmt = db.prepare(`UPDATE birds SET status='sold', sold_at=?, sold_price=? WHERE id = ?`);
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          bird_ids.forEach(id => {
            stmt.run(now, perBird, id);
          });
          db.run('COMMIT');
          stmt.finalize();
          res.json({ success: true, saleId, updatedBirds: bird_ids.length });
        });
      } else {
        res.json({ success: true, saleId });
      }
    }
  );
});

// Mark deceased
app.post('/api/deceased', (req, res) => {
  const { ids = [], type = null, qty = 0 } = req.body;
  const now = new Date().toISOString();
  if (ids && ids.length) {
    const placeholders = ids.map(()=>'?').join(',');
    db.run(`UPDATE birds SET status='deceased', deceased_at=? WHERE id IN (${placeholders})`,
      [now, ...ids], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, updated: this.changes });
      });
  } else if (qty > 0 && type) {
    db.run(`UPDATE birds SET status='deceased', deceased_at=? WHERE id IN (
            SELECT id FROM birds WHERE status='alive' AND type=? ORDER BY added_at LIMIT ? )`,
      [now, type, qty], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, updated: this.changes });
      });
  } else {
    res.status(400).json({ error: 'Provide ids OR (type and qty)' });
  }
});

// Summary for today (updated earnings calculation using today's price table if set)
app.get('/api/summary/today', (req, res) => {
  const results = {};
  const tasks = [
    {
      key: 'hens_sold_today_qty',
      sql: `SELECT IFNULL(SUM(qty),0) as v FROM sales WHERE bird_type='hen' AND DATE(date)=DATE('now','localtime')`
    },
    {
      key: 'broilers_sold_kg_today',
      sql: `SELECT IFNULL(SUM(total_kg),0) as v FROM sales WHERE bird_type='broiler' AND DATE(date)=DATE('now','localtime')`
    },
    {
      key: 'chickens_left',
      sql: `SELECT COUNT(*) as v FROM birds WHERE status='alive'`
    },
    {
      key: 'deceased_hens_cost_today',
      sql: `SELECT IFNULL(SUM(cost_per_hen),0) as v FROM birds WHERE type='hen' AND status='deceased' AND DATE(deceased_at)=DATE('now','localtime')`
    },
    {
      key: 'avg_cost_per_hen',
      sql: `SELECT IFNULL(ROUND(AVG(cost_per_hen),2),0) as v FROM birds WHERE type='hen' AND cost_per_hen IS NOT NULL`
    },
    {
      key: 'avg_cost_per_kg_broiler',
      sql: `SELECT IFNULL(ROUND(AVG(cost_per_kg),2),0) as v FROM birds WHERE type='broiler' AND cost_per_kg IS NOT NULL`
    }
  ];

  let done = 0;
  tasks.forEach(t => {
    db.get(t.sql, [], (err, row) => {
      results[t.key] = err ? null : row.v;
      done++;
      if (done === tasks.length) {
        // get today's price and compute earnings
        db.get(`SELECT price_per_hen, price_per_kg FROM prices WHERE date = DATE('now','localtime') ORDER BY id DESC LIMIT 1`, [], (err2, prow) => {
          const price_per_hen = (prow && prow.price_per_hen) ? prow.price_per_hen : null;
          const price_per_kg = (prow && prow.price_per_kg) ? prow.price_per_kg : null;

          // if today's prices available, compute earnings as (hens_qty * price_per_hen) + (broilers_kg * price_per_kg)
          if (price_per_hen != null || price_per_kg != null) {
            const hensQty = Number(results['hens_sold_today_qty'] || 0);
            const broilerKg = Number(results['broilers_sold_kg_today'] || 0);
            const henEarnings = (price_per_hen != null) ? hensQty * price_per_hen : 0;
            const broilerEarnings = (price_per_kg != null) ? broilerKg * price_per_kg : 0;
            results['todays_earnings'] = Number((henEarnings + broilerEarnings).toFixed(2));
            results['price_per_hen'] = price_per_hen || 0;
            results['price_per_kg'] = price_per_kg || 0;
            return res.json(results);
          }

          // fallback: sum recorded sales.total_amount for today
          db.get(`SELECT IFNULL(SUM(total_amount),0) as v FROM sales WHERE DATE(date)=DATE('now','localtime')`, [], (err3, srow) => {
            results['todays_earnings'] = err3 ? null : srow.v;
            results['price_per_hen'] = 0;
            results['price_per_kg'] = 0;
            return res.json(results);
          });
        });
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Server listening on ${PORT}`));
