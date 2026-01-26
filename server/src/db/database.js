const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Parse DATABASE_URL and use connection pooler (IPv4 compatible)
let dbConfig;
if (process.env.DATABASE_URL) {
  try {
    const dbUrl = new URL(process.env.DATABASE_URL);
    const usePooler = dbUrl.hostname.includes('supabase.co');
    
    if (usePooler) {
      // Use Supabase Session Mode pooler (port 6543) for better compatibility
      console.log(`🔄 Using Supabase Session Mode pooler on port 6543`);
      
      dbConfig = {
        user: dbUrl.username,
        password: dbUrl.password,
        host: dbUrl.hostname, // Keep original hostname
        port: 6543, // Use Session Mode pooler port
        database: dbUrl.pathname.slice(1),
        ssl: {
          rejectUnauthorized: false
        }
      };
    } else {
      dbConfig = {
        user: dbUrl.username,
        password: dbUrl.password,
        host: dbUrl.hostname,
        port: parseInt(dbUrl.port || '5432'),
        database: dbUrl.pathname.slice(1),
        ssl: {
          rejectUnauthorized: false
        }
      };
    }
  } catch (err) {
    console.error('❌ Failed to parse DATABASE_URL:', err.message);
    dbConfig = {
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    };
  }
} else {
  console.error('❌ DATABASE_URL not set!');
  throw new Error('DATABASE_URL environment variable is required');
}

// PostgreSQL connection pool
const pool = new Pool(dbConfig);

let db = null;

console.log('🐘 Connecting to PostgreSQL database...');

// Wrapper to make PostgreSQL API similar to SQLite for compatibility
function createDbWrapper(pgPool) {
  return {
    prepare: (sql) => ({
      run: async (...params) => {
        // Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
        let pgSql = sql;
        let paramIndex = 1;
        while (pgSql.includes('?')) {
          pgSql = pgSql.replace('?', `$${paramIndex}`);
          paramIndex++;
        }
        await pgPool.query(pgSql, params);
      },
      get: async (...params) => {
        let pgSql = sql;
        let paramIndex = 1;
        while (pgSql.includes('?')) {
          pgSql = pgSql.replace('?', `$${paramIndex}`);
          paramIndex++;
        }
        const result = await pgPool.query(pgSql, params);
        return result.rows[0] || undefined;
      },
      all: async (...params) => {
        let pgSql = sql;
        let paramIndex = 1;
        while (pgSql.includes('?')) {
          pgSql = pgSql.replace('?', `$${paramIndex}`);
          paramIndex++;
        }
        const result = await pgPool.query(pgSql, params);
        return result.rows;
      }
    }),
    exec: async (sql) => {
      await pgPool.query(sql);
    },
    query: async (sql, params = []) => {
      const result = await pgPool.query(sql, params);
      return result.rows;
    }
  };
}

async function initializeDatabase() {
  try {
    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✅ PostgreSQL connected successfully');
    
    db = createDbWrapper(pool);

    // Create tables with PostgreSQL syntax
    await db.exec(`
      -- Admins table (main admin who manages resellers)
      CREATE TABLE IF NOT EXISTS admins (
        id VARCHAR(255) PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Resellers table
      CREATE TABLE IF NOT EXISTS resellers (
        id VARCHAR(255) PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        credits INT DEFAULT 0,
        max_users INT DEFAULT 100,
        is_active INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(255),
        FOREIGN KEY (created_by) REFERENCES admins(id)
      );

      -- M3U Playlists table (stores uploaded M3U content) - must be before users
      CREATE TABLE IF NOT EXISTS m3u_playlists (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        filename VARCHAR(255),
        m3u_content TEXT,
        m3u_url TEXT,
        channel_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(255)
      );

      -- Users table (IPTV end users created by resellers)
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        max_connections INT DEFAULT 1,
        is_active INT DEFAULT 1,
        expiry_date TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reseller_id VARCHAR(255) NOT NULL,
        notes TEXT,
        m3u_url TEXT,
        m3u_playlist_id VARCHAR(255),
        FOREIGN KEY (reseller_id) REFERENCES resellers(id),
        FOREIGN KEY (m3u_playlist_id) REFERENCES m3u_playlists(id)
      );

      -- Playlists/Bouquets table
      CREATE TABLE IF NOT EXISTS bouquets (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        channels TEXT,
        m3u_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- User-Bouquet assignments
      CREATE TABLE IF NOT EXISTS user_bouquets (
        user_id VARCHAR(255) NOT NULL,
        bouquet_id VARCHAR(255) NOT NULL,
        PRIMARY KEY (user_id, bouquet_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (bouquet_id) REFERENCES bouquets(id) ON DELETE CASCADE
      );

      -- Activity logs
      CREATE TABLE IF NOT EXISTS activity_logs (
        id VARCHAR(255) PRIMARY KEY,
        actor_type VARCHAR(255) NOT NULL,
        actor_id VARCHAR(255) NOT NULL,
        action VARCHAR(255) NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Credit transactions
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id VARCHAR(255) PRIMARY KEY,
        reseller_id VARCHAR(255) NOT NULL,
        amount INT NOT NULL,
        type VARCHAR(255) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (reseller_id) REFERENCES resellers(id)
      );
    `);
    
    console.log('✅ Tables created/verified');

    // Run migrations for existing databases
    try {
      // Check if m3u_playlist_id column exists in users table
      const columnCheck = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name='users' AND column_name='m3u_playlist_id'
      `);
      
      if (columnCheck.rows.length === 0) {
        await pool.query('ALTER TABLE users ADD COLUMN m3u_playlist_id VARCHAR(255)');
        console.log('✅ Migration: Added m3u_playlist_id column to users table');
      }
    } catch (migrationErr) {
      console.log('Migration check:', migrationErr.message);
    }

    // Create default admin if not exists
    const adminExists = await db.prepare('SELECT id FROM admins WHERE username = ?').get('admin');
    let adminId;
    if (!adminExists) {
      adminId = uuidv4();
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      await db.prepare(`
        INSERT INTO admins (id, username, password, email)
        VALUES (?, ?, ?, ?)
      `).run(adminId, 'admin', hashedPassword, 'admin@iptv.local');
      console.log('✅ Default admin created (username: admin, password: admin123)');
    } else {
      adminId = adminExists.id;
    }

    // Create admin reseller if not exists (admin acts as a reseller too)
    const adminReseller = await db.prepare('SELECT id FROM resellers WHERE username = ?').get('admin');
    let resellerId;
    if (!adminReseller) {
      resellerId = uuidv4();
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      await db.prepare(`
        INSERT INTO resellers (id, username, password, email, credits, max_users, is_active, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(resellerId, 'admin', hashedPassword, 'admin@iptv.local', 1000, 1000, 1, adminId);
      console.log('✅ Admin reseller created');
    } else {
      resellerId = adminReseller.id;
    }

    // Create test user if not exists
    const testUserExists = await db.prepare('SELECT id FROM users WHERE username = ?').get('testuser');
    if (!testUserExists) {
      const testUserId = uuidv4();
      const hashedPassword = bcrypt.hashSync('test123', 10);
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 365);
      await db.prepare(`
        INSERT INTO users (id, username, password, max_connections, is_active, expiry_date, reseller_id, notes, m3u_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(testUserId, 'testuser', hashedPassword, 1, 1, expiryDate.toISOString(), resellerId, 'Test user for app', '');
      console.log('✅ Test user created (username: testuser, password: test123)');
    }

    // Create sample bouquets
    const bouquetExists = await db.prepare('SELECT id FROM bouquets LIMIT 1').get();
    if (!bouquetExists) {
      const bouquets = [
        { name: 'Sports Package', description: 'All sports channels', channels: JSON.stringify(['ESPN', 'Sky Sports', 'beIN Sports']) },
        { name: 'Movies Package', description: 'Premium movie channels', channels: JSON.stringify(['HBO', 'Showtime', 'Starz']) },
        { name: 'Kids Package', description: 'Children channels', channels: JSON.stringify(['Cartoon Network', 'Nickelodeon', 'Disney']) },
        { name: 'News Package', description: 'News channels', channels: JSON.stringify(['CNN', 'BBC News', 'Al Jazeera']) },
        { name: 'Full Package', description: 'All channels included', channels: JSON.stringify(['All Channels']) }
      ];

      for (const b of bouquets) {
        await db.prepare(`
          INSERT INTO bouquets (id, name, description, channels)
          VALUES (?, ?, ?, ?)
        `).run(uuidv4(), b.name, b.description, b.channels);
      }
      console.log('✅ Sample bouquets created');
    }

    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
    throw err;
  }
}

function getDb() {
  return db;
}

module.exports = { getDb, initializeDatabase };
