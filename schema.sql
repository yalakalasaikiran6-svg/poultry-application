-- schema.sql: defines birds and sales with extended fields for skinless and per-sale prices

-- birds table: one row per bird (or set qty if you change schema)
CREATE TABLE IF NOT EXISTS birds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('hen','broiler')),
  batch TEXT,
  status TEXT NOT NULL CHECK(status IN ('alive','sold','deceased')) DEFAULT 'alive',
  weight_kg REAL,
  cost_per_hen REAL,
  cost_per_kg REAL,
  added_at TEXT DEFAULT (datetime('now','localtime')),
  sold_at TEXT,
  sold_price REAL,
  deceased_at TEXT
);

-- sales table: records each sale. Supports qty (birds), total_kg (whole/broiler), skinless_kg, per-sale prices and sale_mode
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT DEFAULT (datetime('now','localtime')),
  bird_type TEXT CHECK(bird_type IN ('hen','broiler')),
  qty INTEGER DEFAULT 0,
  total_kg REAL DEFAULT 0,
  skinless_kg REAL DEFAULT 0,
  sale_mode TEXT,              -- 'per_bird' | 'per_kg' | 'skinless' | 'mixed'
  price_per_hen REAL,         -- per-bird price recorded for this sale
  price_per_kg REAL,          -- per-kg price (whole)
  price_per_kg_skinless REAL, -- per-kg price for skinless
  price_per_kg_recorded REAL, -- legacy field (kept for compatibility)
  total_amount REAL
);

-- prices table: site-wide daily prices (optional). The summary prefers sale.total_amount but will use these if present to compute earnings.
CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  price_per_hen REAL DEFAULT 0,
  price_per_kg REAL DEFAULT 0,
  price_per_kg_skinless REAL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
