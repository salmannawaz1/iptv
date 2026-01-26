const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authenticateToken, isReseller, isActiveReseller } = require('../middleware/auth');

const router = express.Router();

// Get all users (for reseller - only their users, for admin - all users)
router.get('/', authenticateToken, isReseller, isActiveReseller, async (req, res) => {
  try {
    const db = getDb();
    let users;
    if (req.user.role === 'admin') {
      users = await db.prepare(`
        SELECT u.*, r.username as reseller_name 
        FROM users u 
        LEFT JOIN resellers r ON u.reseller_id = r.id
        ORDER BY u.created_at DESC
      `).all();
    } else {
      users = await db.prepare(`
        SELECT * FROM users WHERE reseller_id = ? ORDER BY created_at DESC
      `).all(req.user.id);
    }

    // Remove passwords from response
    users = users.map(u => {
      const { password, ...userWithoutPassword } = u;
      return {
        ...userWithoutPassword,
        is_expired: new Date(u.expiry_date) < new Date()
      };
    });

    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get single user
router.get('/:id', authenticateToken, isReseller, isActiveReseller, async (req, res) => {
  try {
    const db = getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check ownership for resellers
    if (req.user.role === 'reseller' && user.reseller_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { password, ...userWithoutPassword } = user;
    res.json(userWithoutPassword);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Create new user
router.post('/', authenticateToken, isReseller, isActiveReseller, async (req, res) => {
  try {
    const db = getDb();
    const { username, password, max_connections, expiry_days, notes, bouquet_ids, m3u_url, m3u_playlist_id } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Check if username exists
    const existing = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    // For resellers, check credits
    if (req.user.role === 'reseller') {
      const reseller = await db.prepare('SELECT credits, max_users FROM resellers WHERE id = ?').get(req.user.id);
      const userCount = await db.prepare('SELECT COUNT(*) as count FROM users WHERE reseller_id = ?').get(req.user.id);

      if (userCount.count >= reseller.max_users) {
        return res.status(400).json({ error: 'Maximum user limit reached' });
      }

      if (reseller.credits < 1) {
        return res.status(400).json({ error: 'Insufficient credits' });
      }

      // Deduct credit
      await db.prepare('UPDATE resellers SET credits = credits - 1 WHERE id = ?').run(req.user.id);

      // Log transaction
      await db.prepare(`
        INSERT INTO credit_transactions (id, reseller_id, amount, type, description)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuidv4(), req.user.id, -1, 'user_creation', `Created user: ${username}`);
    }

    const userId = uuidv4();
    const hashedPassword = bcrypt.hashSync(password, 10);
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + (parseInt(expiry_days) || 30));

    // Get reseller ID - for resellers use their ID, for admin use provided reseller_id or their own ID
    let resellerId = req.user.id;
    if (req.user.role === 'reseller') {
      resellerId = req.user.id;
    } else if (req.body.reseller_id) {
      resellerId = req.body.reseller_id;
    }

    const userNotes = notes || '';
    const maxConn = parseInt(max_connections) || 1;
    const userM3uUrl = m3u_url || '';
    const userPlaylistId = m3u_playlist_id || null;

    await db.prepare(`
      INSERT INTO users (id, username, password, max_connections, expiry_date, reseller_id, notes, m3u_url, m3u_playlist_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, username, hashedPassword, maxConn, expiryDate.toISOString(), resellerId, userNotes, userM3uUrl, userPlaylistId);

    // Assign bouquets
    if (bouquet_ids && bouquet_ids.length > 0) {
      for (const bouquetId of bouquet_ids) {
        await db.prepare('INSERT INTO user_bouquets (user_id, bouquet_id) VALUES (?, ?)').run(userId, bouquetId);
      }
    }

    // Log activity
    await db.prepare(`
      INSERT INTO activity_logs (id, actor_type, actor_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), req.user.role, req.user.id, 'create_user', JSON.stringify({ username, userId }));

    res.status(201).json({
      message: 'User created successfully',
      user: { id: userId, username, max_connections: max_connections || 1, expiry_date: expiryDate.toISOString() }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update user
router.put('/:id', authenticateToken, isReseller, isActiveReseller, async (req, res) => {
  try {
    const db = getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (req.user.role === 'reseller' && user.reseller_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { password, max_connections, is_active, expiry_date, notes, bouquet_ids, m3u_url, m3u_playlist_id } = req.body;

    let updates = [];
    let params = [];

    if (password) {
      updates.push('password = ?');
      params.push(bcrypt.hashSync(password, 10));
    }
    if (max_connections !== undefined) {
      updates.push('max_connections = ?');
      params.push(max_connections);
    }
    if (is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(is_active ? 1 : 0);
    }
    if (expiry_date) {
      updates.push('expiry_date = ?');
      params.push(expiry_date);
    }
    if (notes !== undefined) {
      updates.push('notes = ?');
      params.push(notes);
    }
    if (m3u_url !== undefined) {
      updates.push('m3u_url = ?');
      params.push(m3u_url);
    }
    if (m3u_playlist_id !== undefined) {
      updates.push('m3u_playlist_id = ?');
      params.push(m3u_playlist_id || null);
    }

    if (updates.length > 0) {
      params.push(req.params.id);
      await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    // Update bouquets
    if (bouquet_ids !== undefined) {
      await db.prepare('DELETE FROM user_bouquets WHERE user_id = ?').run(req.params.id);
      if (bouquet_ids.length > 0) {
        for (const bouquetId of bouquet_ids) {
          await db.prepare('INSERT INTO user_bouquets (user_id, bouquet_id) VALUES (?, ?)').run(req.params.id, bouquetId);
        }
      }
    }

    res.json({ message: 'User updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete user
router.delete('/:id', authenticateToken, isReseller, isActiveReseller, async (req, res) => {
  try {
    const db = getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (req.user.role === 'reseller' && user.reseller_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);

    // Log activity
    await db.prepare(`
      INSERT INTO activity_logs (id, actor_type, actor_id, action, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), req.user.role, req.user.id, 'delete_user', JSON.stringify({ username: user.username }));

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Extend user subscription
router.post('/:id/extend', authenticateToken, isReseller, isActiveReseller, async (req, res) => {
  try {
    const db = getDb();
    const { days } = req.body;
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (req.user.role === 'reseller' && user.reseller_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check credits for resellers
    if (req.user.role === 'reseller') {
      const reseller = await db.prepare('SELECT credits FROM resellers WHERE id = ?').get(req.user.id);
      if (reseller.credits < 1) {
        return res.status(400).json({ error: 'Insufficient credits' });
      }

      await db.prepare('UPDATE resellers SET credits = credits - 1 WHERE id = ?').run(req.user.id);
      await db.prepare(`
        INSERT INTO credit_transactions (id, reseller_id, amount, type, description)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuidv4(), req.user.id, -1, 'subscription_extend', `Extended user: ${user.username}`);
    }

    const currentExpiry = new Date(user.expiry_date);
    const now = new Date();
    const baseDate = currentExpiry > now ? currentExpiry : now;
    baseDate.setDate(baseDate.getDate() + (days || 30));

    await db.prepare('UPDATE users SET expiry_date = ? WHERE id = ?').run(baseDate.toISOString(), req.params.id);

    res.json({ message: 'Subscription extended', new_expiry: baseDate.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to extend subscription' });
  }
});

module.exports = router;
