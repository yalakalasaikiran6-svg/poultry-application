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

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT DEFAULT (datetime('now','localtime')),
  bird_type TEXT CHECK(bird_type IN ('hen','broiler')),
  qty INTEGER,
  total_kg REAL,
  price_per_kg REAL,
  total_amount REAL
);
