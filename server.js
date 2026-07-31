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
db.exec(schema, (err) => {
  if (err) console.error('Failed to initialize DB:', err);
});

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

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

// Record sale
app.post('/api/sales', (req, res) => {
  const { bird_type, qty, total_kg = null, price_per_kg = null, total_amount } = req.body;
  if (!bird_type || total_amount == null) return res.status(400).json({ error: 'bird_type and total_amount required' });
  const date = new Date().toISOString();
  db.run(`INSERT INTO sales (date,bird_type,qty,total_kg,price_per_kg,total_amount) VALUES (?,?,?,?,?,?)`,
    [date, bird_type, qty, total_kg, price_per_kg, total_amount],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, saleId: this.lastID });
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

// Summary for today
app.get('/api/summary/today', (req, res) => {
  const results = {};
  const tasks = [
    {
      key: 'hens_sold_today',
      sql: `SELECT COUNT(*) as v FROM birds WHERE type='hen' AND status='sold' AND DATE(sold_at)=DATE('now','localtime')`
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
    },
    {
      key: 'todays_earnings',
      sql: `SELECT IFNULL(SUM(total_amount),0) as v FROM sales WHERE DATE(date)=DATE('now','localtime')`
    }
  ];

  let done = 0;
  tasks.forEach(t => {
    db.get(t.sql, [], (err, row) => {
      results[t.key] = err ? null : row.v;
      done++;
      if (done === tasks.length) res.json(results);
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Server listening on ${PORT}`));
