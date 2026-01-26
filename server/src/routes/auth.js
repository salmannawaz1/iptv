const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Login for admin or reseller
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Check admin first
    const db = getDb();
    let user = await db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    let role = 'admin';

    // If not admin, check resellers
    if (!user) {
      user = await db.prepare('SELECT * FROM resellers WHERE username = ?').get(username);
      role = 'reseller';
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if reseller is active
    if (role === 'reseller' && !user.is_active) {
      return res.status(403).json({ error: 'Account is disabled' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role },
      process.env.JWT_SECRET || 'default-secret-key-change-in-production',
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role,
        credits: role === 'reseller' ? user.credits : undefined
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user info
router.get('/me', authenticateToken, (req, res) => {
  try {
    const db = getDb();
    let user;
    if (req.user.role === 'admin') {
      user = db.prepare('SELECT id, username, email, created_at FROM admins WHERE id = ?').get(req.user.id);
    } else {
      user = db.prepare('SELECT id, username, email, credits, max_users, is_active, created_at FROM resellers WHERE id = ?').get(req.user.id);
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ ...user, role: req.user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// Change password
router.post('/change-password', authenticateToken, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    const db = getDb();
    const table = req.user.role === 'admin' ? 'admins' : 'resellers';
    const user = db.prepare(`SELECT password FROM ${table} WHERE id = ?`).get(req.user.id);

    if (!bcrypt.compareSync(currentPassword, user.password)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    db.prepare(`UPDATE ${table} SET password = ? WHERE id = ?`).run(hashedPassword, req.user.id);

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
