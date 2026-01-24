const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default-secret-key-change-in-production');
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const isReseller = (req, res, next) => {
  if (req.user.role !== 'reseller' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Reseller access required' });
  }
  next();
};

const isActiveReseller = (req, res, next) => {
  if (req.user.role === 'reseller') {
    const db = getDb();
    const reseller = db.prepare('SELECT is_active FROM resellers WHERE id = ?').get(req.user.id);
    if (!reseller || !reseller.is_active) {
      return res.status(403).json({ error: 'Reseller account is disabled' });
    }
  }
  next();
};

module.exports = {
  authenticateToken,
  isAdmin,
  isReseller,
  isActiveReseller
};
