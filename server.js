const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3001;
const FILE = path.join(__dirname, 'scores.json');

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

app.listen(PORT, () => console.log('Scores API on port ' + PORT));
