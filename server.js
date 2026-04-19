const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const SCORES_FILE = path.join(__dirname, 'scores.json');
const MAX_SCORES = 10;

function loadScores() {
  try {
    if (fs.existsSync(SCORES_FILE)) return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
  } catch (e) { console.error('Error loading scores:', e); }
  return [];
}

function saveScores(scores) {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
}

// GET top 10 scores
app.get('/api/scores', (req, res) => {
  res.json(loadScores());
});

// POST a new score
app.post('/api/scores', (req, res) => {
  const { name, score, world } = req.body;

  // Validate
  if (!name || typeof name !== 'string' || name.length < 1 || name.length > 3) {
    return res.status(400).json({ error: 'Name must be 1-3 characters' });
  }
  if (typeof score !== 'number' || score < 0 || score > 999999) {
    return res.status(400).json({ error: 'Invalid score' });
  }

  const entry = {
    name: name.toUpperCase().slice(0, 3),
    score: Math.floor(score),
    world: (world || 'w1').slice(0, 20),
    date: new Date().toISOString()
  };

  const scores = loadScores();
  scores.push(entry);
  scores.sort((a, b) => b.score - a.score);
  const top = scores.slice(0, MAX_SCORES);
  saveScores(top);

  const rank = top.findIndex(s => s.date === entry.date) + 1;
  res.json({ rank, scores: top });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Atom Merge server running on port ${PORT}`));
