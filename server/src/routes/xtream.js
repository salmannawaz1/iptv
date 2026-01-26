const express = require('express');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const router = express.Router();
const { getDb } = require('../db/database');

// =============================================================================
// GLOBAL M3U CACHE - Parse once, use everywhere
// =============================================================================
const globalM3UCache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours cache

// Get cached parsed M3U data for a user
async function getCachedM3UData(user) {
  const cacheKey = user.m3u_playlist_id || user.m3u_url || user.id;
  
  // Check cache first
  const cached = globalM3UCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[M3U Cache] HIT for ${user.username} (${cached.data.channels.length} channels)`);
    return cached.data;
  }
  
  console.log(`[M3U Cache] MISS for ${user.username}, fetching...`);
  
  // Fetch and parse
  const content = await getM3UContent(user);
  if (!content) {
    console.log(`[M3U Cache] No content for ${user.username}`);
    return null;
  }
  
  console.log(`[M3U Cache] Parsing ${content.length} chars...`);
  const startTime = Date.now();
  const data = parseM3UContent(content);
  console.log(`[M3U Cache] Parsed in ${Date.now() - startTime}ms: ${data.channels.length} channels, ${data.movies.length} movies, ${data.series.length} series`);
  
  // Cache the parsed data
  globalM3UCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
  
  return data;
}

// Get M3U content from URL or stored playlist
async function getM3UContent(user) {
  const db = getDb();
  
  // First check if user has a stored playlist assigned
  if (user.m3u_playlist_id) {
    console.log(`[getM3UContent] User ${user.username} has playlist ID: ${user.m3u_playlist_id}`);
    const playlist = await db.prepare('SELECT m3u_content, m3u_url FROM m3u_playlists WHERE id = ?').get(user.m3u_playlist_id);
    
    // Try stored content first
    if (playlist && playlist.m3u_content) {
      console.log(`[getM3UContent] Using stored content (${playlist.m3u_content.length} chars)`);
      return playlist.m3u_content;
    }
    
    // Try playlist URL
    if (playlist && playlist.m3u_url) {
      console.log(`[getM3UContent] Fetching from playlist URL: ${playlist.m3u_url}`);
      try {
        const response = await axios.get(playlist.m3u_url, { 
          timeout: 120000,
          maxContentLength: 500 * 1024 * 1024 // 500MB max
        });
        return response.data;
      } catch (err) {
        console.error(`[getM3UContent] Failed to fetch playlist URL:`, err.message);
      }
    }
  }
  
  // Fall back to user's m3u_url
  if (user.m3u_url) {
    console.log(`[getM3UContent] Fetching from user URL: ${user.m3u_url}`);
    try {
      const response = await axios.get(user.m3u_url, { 
        timeout: 120000,
        maxContentLength: 500 * 1024 * 1024
      });
      return response.data;
    } catch (err) {
      console.error(`[getM3UContent] Failed to fetch user URL:`, err.message);
    }
  }
  
  return null;
}

// Parse M3U content
function parseM3UContent(content) {
  console.log(`[parseM3U] Parsing ${content.length} characters`);
  
  const lines = content.split('\n');
  const channels = [];
  const movies = [];
  const series = [];
  const categories = new Set();
  
  let currentChannel = null;
  let currentGroup = 'Uncategorized';
  let streamId = 1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line.startsWith('#EXTINF:')) {
      // Parse channel info
      const nameMatch = line.match(/,(.+)$/);
      const groupMatch = line.match(/group-title="([^"]+)"/i);
      const logoMatch = line.match(/tvg-logo="([^"]+)"/i);
      const idMatch = line.match(/tvg-id="([^"]+)"/i);
      
      const name = nameMatch ? nameMatch[1] : `Channel ${streamId}`;
      currentGroup = groupMatch ? groupMatch[1] : 'Uncategorized';
      const logo = logoMatch ? logoMatch[1] : '';
      const tvgId = idMatch ? idMatch[1] : '';
      
      categories.add(currentGroup);
      
      currentChannel = {
        num: streamId,
        name: name,
        stream_type: 'live',
        stream_id: streamId,
        stream_icon: logo,
        epg_channel_id: tvgId,
        added: '',
        category_id: currentGroup,
        custom_sid: '',
        tv_archive: 0,
        direct_source: '',
        tv_archive_duration: 0
      };
      
      streamId++;
    } else if (line && !line.startsWith('#') && currentChannel) {
      // This is the stream URL
      currentChannel.direct_source = line;
      
      // Categorize based on group name
      const groupLower = currentGroup.toLowerCase();
      if (groupLower.includes('movie') || groupLower.includes('vod')) {
        movies.push({ ...currentChannel, stream_type: 'movie' });
      } else if (groupLower.includes('series')) {
        series.push({ ...currentChannel, stream_type: 'series' });
      } else {
        channels.push(currentChannel);
      }
      
      currentChannel = null;
    }
  }
  
  console.log(`[parseM3U] Parsed: ${categories.size} categories, ${channels.length} channels, ${movies.length} movies, ${series.length} series`);
  
  return {
    categories: Array.from(categories),
    channels,
    movies,
    series
  };
}

// Xtream Codes API - Player API endpoint
// GET /player_api.php?username=XXX&password=XXX&action=XXX
router.get('/player_api.php', async (req, res) => {
  try {
    const { username, password, action, category_id, vod_id, series_id, stream_id } = req.query;
    const db = getDb();

    // Authenticate user
    const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    
    if (!user) {
      return res.status(401).json({ user_info: { auth: 0, message: 'Invalid credentials' } });
    }

    // Check password using bcrypt
    const passwordValid = bcrypt.compareSync(password, user.password);
    if (!passwordValid) {
      return res.status(401).json({ user_info: { auth: 0, message: 'Invalid credentials' } });
    }

    // Check if user is active
    if (!user.is_active) {
      return res.status(403).json({ user_info: { auth: 0, message: 'Account disabled' } });
    }

    // Check expiry
    const now = new Date();
    const expiry = new Date(user.expiry_date);
    if (expiry < now) {
      return res.status(403).json({ user_info: { auth: 0, message: 'Subscription expired' } });
    }

    // Handle different actions
    switch (action) {
      case undefined:
      case 'get_user_info':
        return res.json(getUserInfo(user));

      case 'get_live_categories':
        return res.json(await getLiveCategories(user));

      case 'get_live_streams':
        return res.json(await getLiveStreams(user, category_id));

      case 'get_vod_categories':
        return res.json(await getVodCategories(user));

      case 'get_vod_streams':
        return res.json(await getVodStreams(user, category_id));

      case 'get_vod_info':
        return res.json(getVodInfo(vod_id));

      case 'get_series_categories':
        return res.json(await getSeriesCategories(user));

      case 'get_series':
        return res.json(await getSeries(user, category_id));

      case 'get_series_info':
        return res.json(getSeriesInfo(series_id));

      case 'get_short_epg':
      case 'get_simple_data_table':
        return res.json({ epg_listings: [] });

      default:
        return res.json({ error: 'Unknown action' });
    }
  } catch (err) {
    console.error('Xtream API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

function getUserInfo(user) {
  const now = new Date();
  const expiry = new Date(user.expiry_date);
  
  return {
    user_info: {
      auth: 1,
      status: 'Active',
      exp_date: Math.floor(expiry.getTime() / 1000).toString(),
      is_trial: '0',
      active_cons: '0',
      created_at: Math.floor(new Date(user.created_at).getTime() / 1000).toString(),
      max_connections: user.max_connections.toString(),
      allowed_output_formats: ['m3u8', 'ts', 'rtmp'],
      username: user.username,
      password: user.password
    },
    server_info: {
      url: process.env.STREAM_SERVER || 'http://localhost:5000',
      port: '5000',
      https_port: '443',
      server_protocol: 'http',
      rtmp_port: '1935',
      timezone: 'UTC',
      timestamp_now: Math.floor(now.getTime() / 1000),
      time_now: now.toISOString()
    }
  };
}

// =============================================================================
// OPTIMIZED API FUNCTIONS - Use global cache
// =============================================================================

async function getLiveCategories(user) {
  const m3uData = await getCachedM3UData(user);
  
  if (m3uData && m3uData.categories.length > 0) {
    return m3uData.categories.map(cat => ({
      category_id: cat,
      category_name: cat,
      parent_id: 0
    }));
  }
  
  return getSampleCategories();
}

function getSampleCategories() {
  return [
    { category_id: '1', category_name: 'General', parent_id: 0 },
    { category_id: '2', category_name: 'News', parent_id: 0 },
    { category_id: '3', category_name: 'Sports', parent_id: 0 },
    { category_id: '4', category_name: 'Entertainment', parent_id: 0 },
    { category_id: '5', category_name: 'Movies', parent_id: 0 }
  ];
}

async function getLiveStreams(user, categoryId) {
  const m3uData = await getCachedM3UData(user);
  
  if (m3uData && m3uData.channels.length > 0) {
    let streams = m3uData.channels;
    if (categoryId) {
      streams = streams.filter(s => s.category_id === categoryId);
    }
    return streams;
  }
  
  return getSampleStreams(categoryId);
}

function getSampleStreams(categoryId) {
  const streams = [
    { num: 1, name: 'Channel 1', stream_type: 'live', stream_id: 1, stream_icon: '', epg_channel_id: '', added: '', category_id: '1', custom_sid: '', tv_archive: 0, direct_source: 'http://sample-stream.com/live/1.m3u8', tv_archive_duration: 0 },
    { num: 2, name: 'Channel 2', stream_type: 'live', stream_id: 2, stream_icon: '', epg_channel_id: '', added: '', category_id: '1', custom_sid: '', tv_archive: 0, direct_source: 'http://sample-stream.com/live/2.m3u8', tv_archive_duration: 0 },
    { num: 3, name: 'News Live', stream_type: 'live', stream_id: 3, stream_icon: '', epg_channel_id: '', added: '', category_id: '2', custom_sid: '', tv_archive: 0, direct_source: 'http://sample-stream.com/live/news.m3u8', tv_archive_duration: 0 },
    { num: 4, name: 'Sports Channel', stream_type: 'live', stream_id: 4, stream_icon: '', epg_channel_id: '', added: '', category_id: '3', custom_sid: '', tv_archive: 0, direct_source: 'http://sample-stream.com/live/sports.m3u8', tv_archive_duration: 0 }
  ];

  if (categoryId) {
    return streams.filter(s => s.category_id === categoryId);
  }
  return streams;
}

async function getVodCategories(user) {
  const m3uData = await getCachedM3UData(user);
  
  if (m3uData && m3uData.movies.length > 0) {
    const movieCategories = new Set();
    m3uData.movies.forEach(m => movieCategories.add(m.category_id));
    return Array.from(movieCategories).map(cat => ({
      category_id: cat,
      category_name: cat,
      parent_id: 0
    }));
  }
  
  return [
    { category_id: '10', category_name: 'Action', parent_id: 0 },
    { category_id: '11', category_name: 'Comedy', parent_id: 0 },
    { category_id: '12', category_name: 'Drama', parent_id: 0 },
    { category_id: '13', category_name: 'Horror', parent_id: 0 }
  ];
}

async function getVodStreams(user, categoryId) {
  const m3uData = await getCachedM3UData(user);
  
  if (m3uData && m3uData.movies.length > 0) {
    let movies = m3uData.movies.map(m => ({
      ...m,
      rating: '0',
      rating_5based: 0,
      container_extension: 'mp4',
      stream_type: 'movie'
    }));
    
    if (categoryId) {
      movies = movies.filter(m => m.category_id === categoryId);
    }
    return movies;
  }
  
  const defaultMovies = [
    { num: 1, name: 'Sample Movie 1', stream_type: 'movie', stream_id: 101, stream_icon: '', rating: '7.5', rating_5based: 3.75, added: '', category_id: '10', container_extension: 'mp4', custom_sid: '', direct_source: 'http://sample-stream.com/movie/1.mp4' },
    { num: 2, name: 'Sample Movie 2', stream_type: 'movie', stream_id: 102, stream_icon: '', rating: '8.0', rating_5based: 4.0, added: '', category_id: '11', container_extension: 'mp4', custom_sid: '', direct_source: 'http://sample-stream.com/movie/2.mp4' }
  ];

  if (categoryId) {
    return defaultMovies.filter(m => m.category_id === categoryId);
  }
  return defaultMovies;
}

function getVodInfo(vodId) {
  return {
    info: {
      movie_image: '',
      tmdb_id: '',
      name: 'Sample Movie',
      o_name: 'Sample Movie',
      plot: 'This is a sample movie description.',
      cast: 'Actor 1, Actor 2',
      director: 'Director Name',
      genre: 'Action',
      release_date: '2024-01-01',
      duration: '120 min',
      rating: '7.5'
    },
    movie_data: {
      stream_id: vodId,
      container_extension: 'mp4',
      direct_source: 'http://sample-stream.com/movie/' + vodId + '.mp4'
    }
  };
}

async function getSeriesCategories(user) {
  const m3uData = await getCachedM3UData(user);
  
  if (m3uData && m3uData.series.length > 0) {
    const seriesCategories = new Set();
    m3uData.series.forEach(s => seriesCategories.add(s.category_id));
    return Array.from(seriesCategories).map(cat => ({
      category_id: cat,
      category_name: cat,
      parent_id: 0
    }));
  }
  
  return [
    { category_id: '20', category_name: 'Drama Series', parent_id: 0 },
    { category_id: '21', category_name: 'Comedy Series', parent_id: 0 },
    { category_id: '22', category_name: 'Action Series', parent_id: 0 }
  ];
}

async function getSeries(user, categoryId) {
  const m3uData = await getCachedM3UData(user);
  
  if (m3uData && m3uData.series.length > 0) {
    let series = m3uData.series.map((s, idx) => ({
      num: idx + 1,
      name: s.name,
      series_id: s.stream_id,
      cover: s.stream_icon,
      plot: '',
      cast: '',
      director: '',
      genre: s.category_id,
      release_date: '',
      rating: '0',
      rating_5based: 0,
      youtube_trailer: '',
      category_id: s.category_id,
      backdrop_path: []
    }));
    
    if (categoryId) {
      series = series.filter(s => s.category_id === categoryId);
    }
    return series;
  }
  
  const defaultSeries = [
    { num: 1, name: 'Sample Series 1', series_id: 201, cover: '', plot: 'A great series', cast: 'Actor 1', director: 'Director', genre: 'Drama', release_date: '2024-01-01', rating: '8.5', rating_5based: 4.25, youtube_trailer: '', category_id: '20', backdrop_path: [] },
    { num: 2, name: 'Sample Series 2', series_id: 202, cover: '', plot: 'Another great series', cast: 'Actor 2', director: 'Director 2', genre: 'Comedy', release_date: '2024-01-01', rating: '7.8', rating_5based: 3.9, youtube_trailer: '', category_id: '21', backdrop_path: [] }
  ];

  if (categoryId) {
    return defaultSeries.filter(s => s.category_id === categoryId);
  }
  return defaultSeries;
}

function getSeriesInfo(seriesId) {
  return {
    seasons: [{ season_number: 1, name: 'Season 1' }],
    info: {
      name: 'Sample Series',
      cover: '',
      plot: 'Series description',
      cast: 'Actor 1, Actor 2',
      director: 'Director',
      genre: 'Drama',
      release_date: '2024-01-01',
      rating: '8.0'
    },
    episodes: {
      '1': [
        { id: '1', episode_num: 1, title: 'Episode 1', container_extension: 'mp4', info: { plot: 'Episode 1 plot' }, custom_sid: '', added: '', season: 1, direct_source: 'http://sample-stream.com/series/201/s1e1.mp4' },
        { id: '2', episode_num: 2, title: 'Episode 2', container_extension: 'mp4', info: { plot: 'Episode 2 plot' }, custom_sid: '', added: '', season: 1, direct_source: 'http://sample-stream.com/series/201/s1e2.mp4' }
      ]
    }
  };
}

// Helper function to validate user for stream access
async function validateStreamUser(username, password) {
  const db = getDb();
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  
  if (!user) return null;
  
  const passwordValid = bcrypt.compareSync(password, user.password);
  if (!passwordValid) return null;
  
  if (!user.is_active) return null;
  
  const expiry = new Date(user.expiry_date);
  if (expiry < new Date()) return null;
  
  return user;
}

// Live stream endpoint - uses global cache for fast lookups
router.get('/live/:username/:password/:streamId.ts', async (req, res) => {
  const { username, password, streamId } = req.params;
  
  const user = await validateStreamUser(username, password);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const m3uData = await getCachedM3UData(user);
    if (m3uData) {
      const stream = m3uData.channels.find(c => c.stream_id === parseInt(streamId));
      if (stream && stream.direct_source) {
        return res.redirect(stream.direct_source);
      }
    }
  } catch (err) {
    console.error('[Live Stream] Error:', err.message);
  }
  
  res.status(404).json({ error: 'Stream not found' });
});

// VOD stream endpoint - uses global cache for fast lookups
router.get('/movie/:username/:password/:streamId.:ext', async (req, res) => {
  const { username, password, streamId, ext } = req.params;
  
  const user = await validateStreamUser(username, password);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const m3uData = await getCachedM3UData(user);
    if (m3uData) {
      const movie = m3uData.movies.find(m => m.stream_id === parseInt(streamId));
      if (movie && movie.direct_source) {
        return res.redirect(movie.direct_source);
      }
    }
  } catch (err) {
    console.error('[Movie Stream] Error:', err.message);
  }
  
  res.status(404).json({ error: 'Movie not found' });
});

// Series stream endpoint - uses global cache for fast lookups
router.get('/series/:username/:password/:streamId.:ext', async (req, res) => {
  const { username, password, streamId, ext } = req.params;
  
  const user = await validateStreamUser(username, password);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const m3uData = await getCachedM3UData(user);
    if (m3uData) {
      const episode = m3uData.series.find(s => s.stream_id === parseInt(streamId));
      if (episode && episode.direct_source) {
        return res.redirect(episode.direct_source);
      }
    }
  } catch (err) {
    console.error('[Series Stream] Error:', err.message);
  }
  
  res.status(404).json({ error: 'Episode not found' });
});

module.exports = router;
