const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'poultry.db');
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

if (!fs.existsSync(SCHEMA_FILE)) {
  console.error('schema.sql not found in repo root. Please ensure schema.sql exists.');
  process.exit(1);
}

const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
const db = new sqlite3.Database(DB_FILE);
// initialize db
db.exec(schema, (err) => {
  if (err) console.error('Failed to initialize DB:', err);
});

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// Prices (site-wide)
app.get('/api/price', (req, res) => {
  db.get(`SELECT price_per_hen, price_per_kg, price_per_kg_skinless FROM prices WHERE date = DATE('now','localtime') ORDER BY id DESC LIMIT 1`, [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ price_per_hen: (row && row.price_per_hen) || 0, price_per_kg: (row && row.price_per_kg) || 0, price_per_kg_skinless: (row && row.price_per_kg_skinless) || 0 });
  });
});

app.post('/api/price', (req, res) => {
  const { price_per_hen = 0, price_per_kg = 0, price_per_kg_skinless = 0 } = req.body;
  const date = new Date().toISOString().slice(0,10);
  db.run(`INSERT INTO prices (date, price_per_hen, price_per_kg, price_per_kg_skinless) VALUES (?,?,?,?)`, [date, price_per_hen, price_per_kg, price_per_kg_skinless], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

// List birds
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

// Add birds
app.post('/api/birds', (req, res) => {
  const { type, batch, qty = 1, weight_kg = null, cost_per_hen = null, cost_per_kg = null } = req.body;
  if (!type || !['hen','broiler'].includes(type)) return res.status(400).json({ error: 'type required: hen|broiler' });
  const stmt = db.prepare(`INSERT INTO birds (type,batch,weight_kg,cost_per_hen,cost_per_kg) VALUES (?,?,?,?,?)`);
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    for (let i = 0; i < qty; i++) stmt.run(type, batch || null, weight_kg, cost_per_hen, cost_per_kg);
    db.run('COMMIT');
    stmt.finalize();
    res.json({ success: true, added: qty });
  });
});

// Record sale with support for per_bird, per_kg, skinless and mixed
app.post('/api/sales', (req, res) => {
  const {
    bird_type, sale_mode,
    qty = 0, weight_kg = 0, skinless_kg = 0,
    price_per_hen = null, price_per_kg = null, price_per_kg_skinless = null,
    total_amount = null, bird_ids = []
  } = req.body;

  if (!bird_type) return res.status(400).json({ error: 'bird_type required' });

  // compute total if not supplied
  let computedTotal = 0;
  if (total_amount != null) {
    computedTotal = Number(total_amount);
  } else {
    if ((sale_mode === 'per_bird' || sale_mode === 'mixed') && qty > 0) {
      if (price_per_hen == null) return res.status(400).json({ error: 'price_per_hen required for per_bird sales' });
      computedTotal += qty * price_per_hen;
    }
    if ((sale_mode === 'per_kg' || sale_mode === 'mixed') && weight_kg > 0) {
      if (price_per_kg == null) return res.status(400).json({ error: 'price_per_kg required for per_kg sales' });
      computedTotal += weight_kg * price_per_kg;
    }
    if ((sale_mode === 'skinless' || sale_mode === 'mixed') && skinless_kg > 0) {
      if (price_per_kg_skinless == null) return res.status(400).json({ error: 'price_per_kg_skinless required for skinless sales' });
      computedTotal += skinless_kg * price_per_kg_skinless;
    }
    computedTotal = Number(computedTotal.toFixed(2));
  }

  const date = new Date().toISOString();
  db.run(`INSERT INTO sales (date,bird_type,qty,total_kg,skinless_kg,sale_mode,price_per_hen,price_per_kg,price_per_kg_skinless,total_amount) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [date, bird_type, qty, weight_kg, skinless_kg, sale_mode, price_per_hen, price_per_kg, price_per_kg_skinless, computedTotal],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const saleId = this.lastID;
      // mark bird_ids sold if provided
      if (Array.isArray(bird_ids) && bird_ids.length > 0) {
        const perBird = computedTotal / bird_ids.length;
        const now = new Date().toISOString();
        const stmt = db.prepare(`UPDATE birds SET status='sold', sold_at=?, sold_price=? WHERE id = ?`);
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          bird_ids.forEach(id => stmt.run(now, perBird, id));
          db.run('COMMIT');
          stmt.finalize();
          res.json({ success: true, saleId, total_amount: computedTotal });
        });
      } else {
        res.json({ success: true, saleId, total_amount: computedTotal });
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

// Summary for today: use recorded sales.total_amount (which already encodes skinless/weight/bird prices) to compute earnings
app.get('/api/summary/today', (req, res) => {
  const results = {};
  const queries = [
    { key: 'hens_sold_today_qty', sql: `SELECT IFNULL(SUM(qty),0) as v FROM sales WHERE bird_type='hen' AND DATE(date)=DATE('now','localtime')` },
    { key: 'broilers_sold_kg_today', sql: `SELECT IFNULL(SUM(total_kg),0) as v FROM sales WHERE bird_type='broiler' AND DATE(date)=DATE('now','localtime')` },
    { key: 'skinless_kg_sold_today', sql: `SELECT IFNULL(SUM(skinless_kg),0) as v FROM sales WHERE DATE(date)=DATE('now','localtime')` },
    { key: 'chickens_left', sql: `SELECT COUNT(*) as v FROM birds WHERE status='alive'` },
    { key: 'deceased_hens_cost_today', sql: `SELECT IFNULL(SUM(cost_per_hen),0) as v FROM birds WHERE type='hen' AND status='deceased' AND DATE(deceased_at)=DATE('now','localtime')` },
    { key: 'avg_cost_per_hen', sql: `SELECT IFNULL(ROUND(AVG(cost_per_hen),2),0) as v FROM birds WHERE type='hen' AND cost_per_hen IS NOT NULL` },
    { key: 'avg_cost_per_kg_broiler', sql: `SELECT IFNULL(ROUND(AVG(cost_per_kg),2),0) as v FROM birds WHERE type='broiler' AND cost_per_kg IS NOT NULL` }
  ];

  let done = 0;
  queries.forEach(q => {
    db.get(q.sql, [], (err, row) => {
      results[q.key] = err ? null : row.v;
      done++;
      if (done === queries.length) {
        // compute today's earnings from sales.total_amount (preferred), but if zero and prices present, compute using price table
        db.get(`SELECT IFNULL(SUM(total_amount),0) as v FROM sales WHERE DATE(date)=DATE('now','localtime')`, [], (err2, srow) => {
          const summed = err2 ? null : srow.v;
          if (summed && summed > 0) {
            results['todays_earnings'] = summed;
            return res.json(results);
          }
          // fallback: use today's price table and qty/kg sums
          db.get(`SELECT price_per_hen, price_per_kg, price_per_kg_skinless FROM prices WHERE date = DATE('now','localtime') ORDER BY id DESC LIMIT 1`, [], (err3, prow) => {
            const price_per_hen = prow ? prow.price_per_hen : 0;
            const price_per_kg = prow ? prow.price_per_kg : 0;
            const price_per_kg_skinless = prow ? prow.price_per_kg_skinless : 0;
            const hensQty = Number(results['hens_sold_today_qty'] || 0);
            const broilerKg = Number(results['broilers_sold_kg_today'] || 0);
            const skinlessKg = Number(results['skinless_kg_sold_today'] || 0);
            const henEarnings = hensQty * (price_per_hen || 0);
            const broilerEarnings = broilerKg * (price_per_kg || 0);
            const skinlessEarnings = skinlessKg * (price_per_kg_skinless || 0);
            results['todays_earnings'] = Number((henEarnings + broilerEarnings + skinlessEarnings).toFixed(2));
            results['price_per_hen'] = price_per_hen || 0;
            results['price_per_kg'] = price_per_kg || 0;
            results['price_per_kg_skinless'] = price_per_kg_skinless || 0;
            return res.json(results);
          });
        });
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Server listening on ${PORT}`));
