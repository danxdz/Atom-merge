const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3001;
const FILE = path.join(__dirname, 'scores.json');

// Optional staging protection. Production stays public when TEST_PASSWORD is unset.
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';
if (TEST_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const expected = 'Basic ' + Buffer.from('tester:' + TEST_PASSWORD).toString('base64');
    if (header === expected) return next();

    res.setHeader('WWW-Authenticate', 'Basic realm="Atom Merge Staging", charset="UTF-8"');
    return res.status(401).send('Atom Merge staging — login required');
  });
}

app.use(express.json());

// CORS — allow any origin (static site calls this)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function readScores() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return []; }
}
function writeScores(s) { fs.writeFileSync(FILE, JSON.stringify(s, null, 2)); }

// GET top 10
app.get('/api/scores', (req, res) => {
  res.json(readScores());
});

// POST new score
app.post('/api/scores', (req, res) => {
  const { name, score, world } = req.body || {};
  if (!name || typeof score !== 'number') return res.status(400).json({ error: 'bad' });
  const sanitized = String(name).replace(/[^A-Z]/gi, '').slice(0, 3).toUpperCase() || 'AAA';
  let scores = readScores();
  scores.push({ name: sanitized, score, world: String(world || '').slice(0, 20), date: new Date().toISOString() });
  scores.sort((a, b) => b.score - a.score);
  scores = scores.slice(0, 10);
  writeScores(scores);
  const idx = scores.findIndex(s => s.name === sanitized && s.score === score);
  res.json({ rank: idx, scores });
});

// Serve the browser game from this repository.
app.use(express.static(__dirname, {
  dotfiles: 'ignore',
  index: 'index.html',
  fallthrough: true,
  setHeaders(res, filePath) {
    // Prevent stale game JS during rapid staging iterations.
    if (/\.(?:js|json|html)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// SPA-style fallback to the game shell for ordinary browser paths.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('Atom Merge on port ' + PORT + (TEST_PASSWORD ? ' (password protected)' : ' (public)'));
});
