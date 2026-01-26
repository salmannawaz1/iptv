const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authenticateToken, isAdmin } = require('../middleware/auth');

const router = express.Router();

// Get all resellers (admin only)
router.get('/', authenticateToken, isAdmin, async (req, res) => {
  try {
    const db = getDb();
    const resellers = await db.prepare(`
      SELECT r.id, r.username, r.email, r.credits, r.max_users, r.is_active, r.created_at,
             (SELECT COUNT(*) FROM users WHERE reseller_id = r.id) as user_count
      FROM resellers r
      ORDER BY r.created_at DESC
    `).all();

    res.json(resellers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch resellers' });
  }
});

// Get single reseller
router.get('/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const db = getDb();
    const reseller = await db.prepare(`
      SELECT r.id, r.username, r.email, r.credits, r.max_users, r.is_active, r.created_at,
             (SELECT COUNT(*) FROM users WHERE reseller_id = r.id) as user_count
      FROM resellers r
      WHERE r.id = ?
    `).get(req.params.id);

    if (!reseller) {
      return res.status(404).json({ error: 'Reseller not found' });
    }

    res.json(reseller);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch reseller' });
  }
});

// Create reseller (admin only)
router.post('/', authenticateToken, isAdmin, async (req, res) => {
  try {
    const db = getDb();
    const { username, password, email, credits, max_users } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Check if username exists
    const existingAdmin = await db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
    const existingReseller = await db.prepare('SELECT id FROM resellers WHERE username = ?').get(username);
    
    if (existingAdmin || existingReseller) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const resellerId = uuidv4();
    const hashedPassword = bcrypt.hashSync(password, 10);

    await db.prepare(`
      INSERT INTO resellers (id, username, password, email, credits, max_users, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(resellerId, username, hashedPassword, email || null, credits || 0, max_users || 100, req.user.id);

    // Log activity
    await db.prepare(`
      INSERT INTO activity_logs (id, actor_type, actor_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), 'admin', req.user.id, 'create_reseller', JSON.stringify({ username, resellerId }));

    res.status(201).json({
      message: 'Reseller created successfully',
      reseller: { id: resellerId, username, credits: credits || 0, max_users: max_users || 100 }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create reseller' });
  }
});

// Update reseller (admin only)
router.put('/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const db = getDb();
    const reseller = await db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.params.id);

    if (!reseller) {
      return res.status(404).json({ error: 'Reseller not found' });
    }

    const { password, email, credits, max_users, is_active } = req.body;

    let updates = [];
    let params = [];

    if (password) {
      updates.push('password = ?');
      params.push(bcrypt.hashSync(password, 10));
    }
    if (email !== undefined) {
      updates.push('email = ?');
      params.push(email);
    }
    if (credits !== undefined) {
      updates.push('credits = ?');
      params.push(credits);
    }
    if (max_users !== undefined) {
      updates.push('max_users = ?');
      params.push(max_users);
    }
    if (is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(is_active ? 1 : 0);
    }

    if (updates.length > 0) {
      params.push(req.params.id);
      await db.prepare(`UPDATE resellers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    res.json({ message: 'Reseller updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update reseller' });
  }
});

// Add credits to reseller (admin only)
router.post('/:id/credits', authenticateToken, isAdmin, async (req, res) => {
  try {
    const db = getDb();
    const { amount, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }

    const reseller = await db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.params.id);
    if (!reseller) {
      return res.status(404).json({ error: 'Reseller not found' });
    }

    await db.prepare('UPDATE resellers SET credits = credits + ? WHERE id = ?').run(amount, req.params.id);

    // Log transaction
    await db.prepare(`
      INSERT INTO credit_transactions (id, reseller_id, amount, type, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), req.params.id, amount, 'credit_add', description || 'Credits added by admin');

    const updated = await db.prepare('SELECT credits FROM resellers WHERE id = ?').get(req.params.id);

    res.json({ message: 'Credits added', new_balance: updated.credits });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add credits' });
  }
});

// Delete reseller (admin only)
router.delete('/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const db = getDb();
    const reseller = await db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.params.id);

    if (!reseller) {
      return res.status(404).json({ error: 'Reseller not found' });
    }

    // Delete all users under this reseller
    await db.prepare('DELETE FROM users WHERE reseller_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM resellers WHERE id = ?').run(req.params.id);

    // Log activity
    await db.prepare(`
      INSERT INTO activity_logs (id, actor_type, actor_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), 'admin', req.user.id, 'delete_reseller', JSON.stringify({ username: reseller.username }));

    res.json({ message: 'Reseller and all associated users deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete reseller' });
  }
});

// Get reseller's credit history
router.get('/:id/credits/history', authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    // Resellers can only see their own history
    if (req.user.role === 'reseller' && req.user.id !== req.params.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const transactions = await db.prepare(`
      SELECT * FROM credit_transactions 
      WHERE reseller_id = ? 
      ORDER BY created_at DESC 
      LIMIT 100
    `).all(req.params.id);

    res.json(transactions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch credit history' });
  }
});

module.exports = router;
