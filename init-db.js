const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'server/nexo_db.sqlite');

// Delete the database file if it exists
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
  console.log('Existing database deleted.');
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS \`groups\` (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_by INTEGER,
        FOREIGN KEY (created_by) REFERENCES users (id)
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS group_members (
        group_id INTEGER,
        user_id INTEGER,
        PRIMARY KEY (group_id, user_id),
        FOREIGN KEY (group_id) REFERENCES \`groups\` (id),
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT NOT NULL,
        amount REAL NOT NULL,
        user_id INTEGER,
        group_id INTEGER,
        date TEXT NOT NULL,
        paid_by INTEGER,
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (group_id) REFERENCES \`groups\` (id),
        FOREIGN KEY (paid_by) REFERENCES users (id)
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS expense_splits (
        expense_id INTEGER,
        user_id INTEGER,
        amount_owed REAL NOT NULL,
        PRIMARY KEY (expense_id, user_id),
        FOREIGN KEY (expense_id) REFERENCES expenses (id),
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`);
       db.run(`CREATE TABLE IF NOT EXISTS friends (
        user_id1 INTEGER NOT NULL,
        user_id2 INTEGER NOT NULL,
        PRIMARY KEY (user_id1, user_id2),
        FOREIGN KEY (user_id1) REFERENCES users(id),
        FOREIGN KEY (user_id2) REFERENCES users(id)
    );`);
      db.run(`CREATE TABLE IF NOT EXISTS payment_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER NOT NULL,
        to_user_id INTEGER NOT NULL,
        expense_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        due_date TEXT NOT NULL,
        is_paid BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (from_user_id) REFERENCES users(id),
        FOREIGN KEY (to_user_id) REFERENCES users(id),
        FOREIGN KEY (expense_id) REFERENCES expenses(id)
    );`);
    db.run(`CREATE TABLE IF NOT EXISTS badges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT
    );`);
     db.run(`CREATE TABLE IF NOT EXISTS user_badges (
        user_id INTEGER NOT NULL,
        badge_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, badge_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (badge_id) REFERENCES badges(id)
    );`);
    console.log('Tables created successfully.');
    });
  }
});