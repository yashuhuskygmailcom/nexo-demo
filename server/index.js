
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const { createWorker } = require('tesseract.js');
const cors = require('cors');

const app = express();
const port = 3003;

const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(express.json());
app.use(cors());

const dbPath = path.resolve(__dirname, 'nexo_db.sqlite');

// Trust the proxy to ensure secure cookies work
app.set('trust proxy', 1);

// Session configuration
const isProduction = process.env.NODE_ENV === 'production';
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true, // Reverted to true
  cookie: {
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  }
}));

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

// Initialize Tesseract worker
let worker;
(async () => {
  worker = await createWorker('eng');
})();

const parseOcrText = (text) => {
  const lines = text.split('\\n').filter(line => line.trim() !== '');
  let merchantName = lines[0] || 'Unknown Merchant';
  let date = new Date().toISOString().split('T')[0];
  let total = 0;
  const items = [];

  const dateRegex = /\\d{2}[-\\/]\\d{2}[-\\/]\\d{2,4}/;
  const dateMatch = text.match(dateRegex);
  if (dateMatch) {
    date = new Date(dateMatch[0]).toISOString().split('T')[0];
  }

  const itemRegex = /(.+?)\\s+\\$?(\\d+\\.\\d{2})/;
  lines.forEach(line => {
    const match = line.match(itemRegex);
    if (match) {
      const name = match[1].trim();
      const price = parseFloat(match[2]);
      if (!/total|subtotal|tax|tip/i.test(name)) {
        items.push({ name, price });
      }
    }
  });

  const totalRegex = /(?:total|amount|balance due)\\s+\\$?(\\d+\\.\\d{2})/i;
  const totalMatch = text.match(totalRegex);
  if (totalMatch) {
    total = parseFloat(totalMatch[1]);
  } else if (items.length > 0) {
    total = items.reduce((sum, item) => sum + item.price, 0);
  }

  if (items.length > 0 && lines.length > 0) {
    const potentialMerchantLine = lines.find(line =>
      !line.match(itemRegex) &&
      !line.match(dateRegex) &&
      !line.match(totalRegex) &&
      isNaN(parseFloat(line.replace(/\\$/g, '')))
    );
    if (potentialMerchantLine) {
      merchantName = potentialMerchantLine.trim();
    } else {
      merchantName = 'Unknown Merchant';
    }
  }

  return { merchantName, date, total, items };
};

const isAuthenticated = (req, res, next) => {
  if (req.session.userId) {
    next();
  } else {
    res.status(401).json({ message: 'Unauthorized' });
  }
};

app.get('/api/check-session', (req, res) => {
  if (req.session.userId) {
    const query = 'SELECT id, username, email FROM users WHERE id = ?';
    db.get(query, [req.session.userId], (err, user) => {
      if (err) {
        res.status(500).json({ message: 'Internal server error' });
      } else if (user) {
        res.status(200).json({ user });
      } else {
        res.status(401).json({ message: 'Unauthorized' });
      }
    });
  } else {
    res.status(401).json({ message: 'Unauthorized' });
  }
});

app.post('/api/scan-receipt', upload.single('receipt'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No receipt image provided' });
  }

  try {
    const { data: { text } } = await worker.recognize(req.file.path);
    const extractedData = parseOcrText(text);
    res.status(200).json(extractedData);
  } catch (error) {
    console.error('OCR Error:', error);
    res.status(500).json({ message: 'Error processing receipt' });
  }
});

app.post('/api/signup', async (req, res) => {
  console.log('Signup request received:', req.body);
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    console.log('Signup failed: Missing fields');
    return res.status(400).json({ message: 'Username, email, and password are required' });
  }

  try {
    console.log('Hashing password...');
    const hashedPassword = await bcrypt.hash(password, 10);
    console.log('Password hashed.');

    const query = 'INSERT INTO users (username, email, password) VALUES (?, ?, ?)';
    console.log('Executing INSERT query...');

    db.run(query, [username, email, hashedPassword], function (err) {
      if (err) {
        console.error('DB insert error:', err.message);
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(409).json({ message: 'Email already in use' });
        }
        return res.status(500).json({ message: 'Internal server error during user creation' });
      }
      
      console.log('User inserted, ID:', this.lastID);
      const userId = this.lastID;
      req.session.userId = userId;
      console.log('Session user ID set:', req.session.userId);

      req.session.save((err) => {
        if (err) {
          console.error('Session save error after signup:', err);
          return res.status(500).json({ message: 'Internal server error after signup' });
        }
        console.log('Session saved successfully.');
        const newUserQuery = 'SELECT id, username, email FROM users WHERE id = ?';
        db.get(newUserQuery, [userId], (err, user) => {
          if (err) {
            console.error('Error fetching new user:', err);
            return res.status(500).json({ message: 'Internal server error fetching user data' });
          }
          console.log('Returning new user:', user);
          res.status(200).json({ user });
        });
      });
    });
  } catch (error) {
    console.error('Signup process error:', error);
    res.status(500).json({ message: 'An unexpected error occurred during signup' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const query = 'SELECT * FROM users WHERE email = ?';

  db.get(query, [email], async (err, user) => {
    if (err) {
      console.error('Error logging in:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }

    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ message: 'Internal server error during session save' });
      }
      const { password: _, ...userWithoutPassword } = user;
      res.status(200).json({ user: userWithoutPassword });
    });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ message: 'Could not log out, please try again' });
    }
    res.clearCookie('connect.sid'); 
    res.status(200).json({ message: 'Logout successful' });
  });
});

app.get('/api/user/:email', isAuthenticated, (req, res) => {
  const { email } = req.params;
  const query = 'SELECT id, username, email FROM users WHERE email = ?';

  db.get(query, [email], (err, user) => {
    if (err) {
      console.error('Error fetching user:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({ user });
  });
});

app.post('/api/expenses', isAuthenticated, async (req, res) => {
  const { description, amount, date, paid_by, splits } = req.body;
  const userId = req.session.userId;

  if (!description || !amount || !date || !paid_by || !splits || !Array.isArray(splits)) {
    return res.status(400).json({ message: 'Missing or invalid required fields' });
  }

  try {
    await new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', (err) => (err ? reject(err) : resolve()));
    });

    const expenseId = await new Promise((resolve, reject) => {
      const expenseQuery = 'INSERT INTO expenses (user_id, description, amount, date, paid_by) VALUES (?, ?, ?, ?, ?)';
      db.run(expenseQuery, [userId, description, amount, date, paid_by], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });

    const splitPromises = splits.map(split => {
      return new Promise((resolve, reject) => {
        const splitQuery = 'INSERT INTO expense_splits (expense_id, user_id, amount_owed) VALUES (?, ?, ?)';
        db.run(splitQuery, [expenseId, split.user_id, split.amount_owed], (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });

    await Promise.all(splitPromises);

    await new Promise((resolve, reject) => {
      db.run('COMMIT', (err) => (err ? reject(err) : resolve()));
    });

    const newExpense = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM expenses WHERE id = ?', [expenseId], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });

    const newSplits = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM expense_splits WHERE expense_id = ?', [expenseId], (err, rows) => {
        if (err) reject(err);
        resolve(rows);
      });
    });

    const result = {
      ...newExpense,
      paidBy: newExpense.paid_by,
      splits: newSplits.map(split => ({ user_id: split.user_id, amount_owed: split.amount_owed }))
    };

    res.status(200).json(result);

  } catch (error) {
    console.error('Error creating expense:', error);
    await new Promise((resolve) => {
        db.run('ROLLBACK', () => resolve());
    });
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/api/expenses', isAuthenticated, (req, res) => {
  const userId = req.session.userId;
  const query = 'SELECT id, description, amount, date, paid_by as paidBy FROM expenses WHERE user_id = ? ORDER BY date DESC';

  db.all(query, [userId], (err, expenses) => {
    if (err) {
      console.error('Error fetching expenses:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }

    const expensePromises = expenses.map(expense => {
      return new Promise((resolve, reject) => {
        const splitQuery = 'SELECT * FROM expense_splits WHERE expense_id = ?';
        db.all(splitQuery, [expense.id], (err, splits) => {
          if (err) {
            return reject(err);
          }
          expense.splits = splits.map(split => ({
            user_id: split.user_id,
            amount_owed: split.amount_owed
          }));
          resolve(expense);
        });
      });
    });

    Promise.all(expensePromises)
      .then(completedExpenses => {
        res.status(200).json(completedExpenses);
      })
      .catch(error => {
        console.error('Error fetching expense splits:', error);
        res.status(500).json({ message: 'Internal server error' });
      });
  });
});

app.delete('/api/expenses/:id', isAuthenticated, async (req, res) => {
  const { id } = req.params;
  const userId = req.session.userId;

  try {
    const expense = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM expenses WHERE id = ? AND user_id = ?', [id, userId], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });

    if (!expense) {
      return res.status(404).json({ message: 'Expense not found or you do not have permission to delete it.' });
    }

    await new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', (err) => (err ? reject(err) : resolve()));
    });

    await new Promise((resolve, reject) => {
      db.run('DELETE FROM expense_splits WHERE expense_id = ?', [id], (err) => {
        if (err) reject(err);
        resolve();
      });
    });

    await new Promise((resolve, reject) => {
      db.run('DELETE FROM expenses WHERE id = ?', [id], (err) => {
        if (err) reject(err);
        resolve();
      });
    });

    await new Promise((resolve, reject) => {
      db.run('COMMIT', (err) => (err ? reject(err) : resolve()));
    });

    res.status(200).json({ message: 'Expense deleted successfully' });

  } catch (error) {
    console.error('Error deleting expense:', error);
    await new Promise((resolve) => {
        db.run('ROLLBACK', () => resolve());
    });
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.put('/api/expenses/:id', isAuthenticated, async (req, res) => {
  const { id } = req.params;
  const { description, amount, date, paid_by, splits } = req.body;
  const userId = req.session.userId;

  if (!description || !amount || !date || !paid_by || !splits || !Array.isArray(splits)) {
    return res.status(400).json({ message: 'Missing or invalid required fields' });
  }

  try {
    const expense = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM expenses WHERE id = ? AND user_id = ?', [id, userId], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });

    if (!expense) {
      return res.status(404).json({ message: 'Expense not found or you do not have permission to update it.' });
    }

    await new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', (err) => (err ? reject(err) : resolve()));
    });

    await new Promise((resolve, reject) => {
      const query = 'UPDATE expenses SET description = ?, amount = ?, date = ?, paid_by = ? WHERE id = ?';
      db.run(query, [description, amount, date, paid_by, id], (err) => {
        if (err) reject(err);
        resolve();
      });
    });

    await new Promise((resolve, reject) => {
      db.run('DELETE FROM expense_splits WHERE expense_id = ?', [id], (err) => {
        if (err) reject(err);
        resolve();
      });
    });

    const splitPromises = splits.map(split => {
      return new Promise((resolve, reject) => {
        const splitQuery = 'INSERT INTO expense_splits (expense_id, user_id, amount_owed) VALUES (?, ?, ?)';
        db.run(splitQuery, [id, split.user_id, split.amount_owed], (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });

    await Promise.all(splitPromises);

    await new Promise((resolve, reject) => {
      db.run('COMMIT', (err) => (err ? reject(err) : resolve()));
    });

    const updatedExpense = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM expenses WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });

    const updatedSplits = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM expense_splits WHERE expense_id = ?', [id], (err, rows) => {
        if (err) reject(err);
        resolve(rows);
      });
    });

    const result = {
      ...updatedExpense,
      paidBy: updatedExpense.paid_by,
      splits: updatedSplits.map(split => ({ user_id: split.user_id, amount_owed: split.amount_owed }))
    };

    res.status(200).json(result);

  } catch (error) {
    console.error('Error updating expense:', error);
    await new Promise((resolve) => {
        db.run('ROLLBACK', () => resolve());
    });
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/api/expenses/summary', isAuthenticated, (req, res) => {
  const userId = req.session.userId;
  const query = `
    SELECT
      strftime('%Y-%W', date) as week,
      SUM(amount) as total
    FROM
      expenses
    WHERE
      user_id = ?
    GROUP BY
      week
    ORDER BY
      week;
  `;

  db.all(query, [userId], (err, rows) => {
    if (err) {
      console.error('Error fetching expense summary:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }

    const summaryData = rows.map((row, index) => ({
      name: `Week ${index + 1}`,
      amount: row.total,
    }));

    res.status(200).json(summaryData);
  });
});

app.get('/api/friends', isAuthenticated, (req, res) => {
    const userId = req.session.userId;
    console.log(`Fetching friends for user ${userId}`);
    const query = `
        SELECT u.id, u.username, u.email 
        FROM users u
        INNER JOIN friends f ON u.id = f.user_id2
        WHERE f.user_id1 = ?
        UNION
        SELECT u.id, u.username, u.email 
        FROM users u
        INNER JOIN friends f ON u.id = f.user_id1
        WHERE f.user_id2 = ?
    `;

    db.all(query, [userId, userId], (err, friends) => {
        if (err) {
            console.error('Error fetching friends:', err);
            return res.status(500).json({ message: 'Internal server error' });
        }
        console.log(`Found ${friends.length} friends for user ${userId}`);
        res.status(200).json(friends);
    });
});

app.post('/api/friends', isAuthenticated, (req, res) => {
    const { friendId } = req.body;
    const userId = req.session.userId;
    console.log(`User ${userId} is adding friend ${friendId}`);

    // Check if they are already friends
    const checkQuery = 'SELECT * FROM friends WHERE (user_id1 = ? AND user_id2 = ?) OR (user_id1 = ? AND user_id2 = ?)';
    db.get(checkQuery, [userId, friendId, friendId, userId], (err, row) => {
        if (err) {
            console.error('Error checking friendship:', err);
            return res.status(500).json({ message: 'Internal server error' });
        }
        if (row) {
            console.log(`Users ${userId} and ${friendId} are already friends`);
            return res.status(409).json({ message: 'Already friends' });
        }

        const insertQuery = 'INSERT INTO friends (user_id1, user_id2) VALUES (?, ?)';
        db.run(insertQuery, [userId, friendId], function(err) {
            if (err) {
                console.error('Error adding friend:', err);
                return res.status(500).json({ message: 'Internal server error' });
            }
            console.log(`Friend added with ID ${this.lastID}`);
            res.status(201).json({ message: 'Friend added successfully' });
        });
    });
});

app.get('/api/groups', isAuthenticated, (req, res) => {
    const userId = req.session.userId;
    console.log(`Fetching groups for user ${userId}`);
    const query = `
        SELECT g.id, g.name
        FROM \`groups\` g
        LEFT JOIN group_members gm ON g.id = gm.group_id
        WHERE gm.user_id = ?
    `;

    db.all(query, [userId], async (err, groups) => {
        if (err) {
            console.error('Error fetching groups:', err);
            return res.status(500).json({ message: 'Internal server error' });
        }
        
        try {
            const groupDetails = await Promise.all(groups.map(async (group) => {
                const members = await new Promise((resolve, reject) => {
                    const membersQuery = 'SELECT u.username FROM users u JOIN group_members gm ON u.id = gm.user_id WHERE gm.group_id = ?';
                    db.all(membersQuery, [group.id], (err, members) => {
                        if (err) return reject(err);
                        resolve(members.map(m => m.username));
                    });
                });

                const totalExpenses = await new Promise((resolve, reject) => {
                    const expensesQuery = 'SELECT SUM(amount) as total FROM expenses WHERE group_id = ?';
                    db.get(expensesQuery, [group.id], (err, result) => {
                        if (err) return reject(err);
                        resolve(result.total || 0);
                    });
                });

                return { ...group, members, totalExpenses };
            }));
            console.log(`Found ${groupDetails.length} groups for user ${userId}`);
            res.status(200).json(groupDetails);
        } catch (error) {
            console.error('Error compiling group details:', error);
            res.status(500).json({ message: 'Internal server error' });
        }
    });
});

app.post('/api/groups', isAuthenticated, (req, res) => {
    const { name, members } = req.body;
    const userId = req.session.userId;
    console.log(`User ${userId} is creating group '${name}' with members ${members}`);
    const insertGroupQuery = 'INSERT INTO \`groups\` (name, created_by) VALUES (?, ?)';

    db.run(insertGroupQuery, [name, userId], function(err) {
        if (err) {
            console.error('Error creating group:', err);
            return res.status(500).json({ message: 'Internal server error' });
        }

        const groupId = this.lastID;
        console.log(`Group created with ID ${groupId}`);
        const allMembers = [...new Set([userId, ...members.map(m => parseInt(m))])]; 
        console.log(`Adding members to group ${groupId}: ${allMembers}`);
        const insertMembersQuery = 'INSERT INTO group_members (group_id, user_id) VALUES (?, ?)';

        allMembers.forEach(memberId => {
            db.run(insertMembersQuery, [groupId, memberId], (err) => {
                if (err) {
                    console.error(`Error adding member ${memberId} to group ${groupId}:`, err);

                  }
            });
        });

        res.status(201).json({ message: 'Group created successfully', groupId });
    });
});

app.get('/api/dashboard', isAuthenticated, async (req, res) => {
  const userId = req.session.userId;
  try {
    const totalOwed = await new Promise((resolve, reject) => {
      // Complex query to calculate total amount others owe the user
      resolve(0); // Placeholder
    });

    const totalOwe = await new Promise((resolve, reject) => {
      // Complex query to calculate total amount the user owes others
      resolve(0); // Placeholder
    });

    const recentActivities = await new Promise((resolve, reject) => {
      const query = `
        SELECT 'expense' as type, e.description, e.amount, e.date
        FROM expenses e
        WHERE e.user_id = ?
        ORDER BY e.date DESC
        LIMIT 5
      `;
      db.all(query, [userId], (err, rows) => {
        if (err) reject(err);
        resolve(rows);
      });
    });

    res.status(200).json({ 
      totalOwed, 
      totalOwe, 
      recentActivities 
    });

  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port} and connected to SQLite`);
});
