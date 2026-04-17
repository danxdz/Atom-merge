// ═══════════════════════════════════════════════════════════════
// ATOM MERGE — Configuration Layer
// All game-tunable parameters live here.  CRUD-ready data model.
// ═══════════════════════════════════════════════════════════════

/* ── Vibrant Color Generation ───────────────────────────────── */
function generateWorldColors(count) {
  var colors = [];
  var goldenAngle = 137.508;
  for (var i = 0; i < count; i++) {
    var hue = (i * goldenAngle) % 360;
    var sat = 70 + (i % 3) * 10;
    var lit = 45 + (i % 4) * 8;
    colors.push(hslToHex(hue, sat, lit));
  }
  return colors;
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  var c = (1 - Math.abs(2*l - 1)) * s;
  var x = c * (1 - Math.abs((h/60) % 2 - 1));
  var m = l - c/2;
  var r, g, b;
  if (h < 60)       { r=c; g=x; b=0; }
  else if (h < 120) { r=x; g=c; b=0; }
  else if (h < 180) { r=0; g=c; b=x; }
  else if (h < 240) { r=0; g=x; b=c; }
  else if (h < 300) { r=x; g=0; b=c; }
  else              { r=c; g=0; b=x; }
  var toHex = function(v) { var h = Math.round((v+m)*255).toString(16); return h.length < 2 ? '0'+h : h; };
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

/* Full element + world databases (populated by loadGameData) */
var FULL_ELEMENTS = [];   // all 118 elements from JSON
var WORLDS_DATA   = [];   // all 7 worlds from JSON

/* ---------- Element Database (tier = Z-1) ---------- */
/* Radii: geometric r = 0.60 * 1.18^tier  → H=0.60 … Ca=13.93 (~18% bigger each tier) */
var ELEMENT_DB = [
  { Z:1,  sym:'H',  name:'Hydrogen',   tier:0,  r:0.60, col:'#C8C8FF', grp:1  },
  { Z:2,  sym:'He', name:'Helium',     tier:1,  r:0.71, col:'#88CCFF', grp:18 },
  { Z:3,  sym:'Li', name:'Lithium',    tier:2,  r:0.84, col:'#FF4444', grp:1  },
  { Z:4,  sym:'Be', name:'Beryllium',  tier:3,  r:0.99, col:'#FF8C00', grp:2  },
  { Z:5,  sym:'B',  name:'Boron',      tier:4,  r:1.16, col:'#CC7744', grp:13 },
  { Z:6,  sym:'C',  name:'Carbon',     tier:5,  r:1.37, col:'#808080', grp:14 },
  { Z:7,  sym:'N',  name:'Nitrogen',   tier:6,  r:1.62, col:'#3366FF', grp:15 },
  { Z:8,  sym:'O',  name:'Oxygen',     tier:7,  r:1.91, col:'#FF2222', grp:16 },
  { Z:9,  sym:'F',  name:'Fluorine',   tier:8,  r:2.26, col:'#44DD66', grp:17 },
  { Z:10, sym:'Ne', name:'Neon',       tier:9,  r:2.66, col:'#BB44FF', grp:18 },
  { Z:11, sym:'Na', name:'Sodium',     tier:10, r:3.14, col:'#DD2200', grp:1  },
  { Z:12, sym:'Mg', name:'Magnesium',  tier:11, r:3.71, col:'#FFAA00', grp:2  },
  { Z:13, sym:'Al', name:'Aluminium',  tier:12, r:4.37, col:'#00CCBB', grp:13 },
  { Z:14, sym:'Si', name:'Silicon',    tier:13, r:5.16, col:'#998877', grp:14 },
  { Z:15, sym:'P',  name:'Phosphorus', tier:14, r:6.09, col:'#4499FF', grp:15 },
  { Z:16, sym:'S',  name:'Sulfur',     tier:15, r:7.18, col:'#FFDD00', grp:16 },
  { Z:17, sym:'Cl', name:'Chlorine',   tier:16, r:8.48, col:'#00CC44', grp:17 },
  { Z:18, sym:'Ar', name:'Argon',      tier:17, r:10.00, col:'#9944FF', grp:18 },
  { Z:19, sym:'K',  name:'Potassium',  tier:18, r:11.80, col:'#CC1100', grp:1  },
  { Z:20, sym:'Ca', name:'Calcium',    tier:19, r:13.93, col:'#FF7700', grp:2  },
];

/* ---------- Worlds (Z-block mappings) ---------- */
var WORLDS = [
  { id:'w1_origines',    label:'w1 Origines',    dropMaxTier:4,  legendMaxZ:18 },
  { id:'w2_transitions', label:'w2 Transitions', dropMaxTier:6,  legendMaxZ:20 },
  { id:'w3_debug',       label:'All (debug)',     dropMaxTier:5,  legendMaxZ:20 },
];

/* ---------- Physics Preset ---------- */
const PHYSICS_PRESET = {
  gravity:        22,
  restitution:    0.02,
  friction:       0.8,
  linearDamping:  0.3,
  angularDamping: 0.5,
};

/* ---------- Energy RuleSet ---------- */
const ENERGY_RULESET = {
  g0: 1,    // base energy gain
  g1: 0.4,  // per-tier gain multiplier
  g2: 0.8,  // combo multiplier coefficient
};

/* ---------- Container Geometry ---------- */
const CONTAINER = {
  w:    7,    // inner width (tight Suika-like box)
  h:    11,   // inner height
  d:    3,    // inner depth (thin — Z is locked, purely visual)
  wall: 0.3,  // wall thickness
};

/* ---------- Game Rules ---------- */
const GAME_RULES = {
  dropY:        10,
  dangerY:      9,
  dropCooldown: 450,   // ms between drops (debounce rapid clicks)
  settleDelay:  50,    // ms before atom can merge (near-instant)
  mergeAnimMs:  120,   // ms for shrink animation
  dangerGrace:  2500,  // ms above danger before game over
  maxAtoms:     80,
};

/* ---------- Scoring ---------- */
function calcMergeScore(tier) {
  var base = Math.ceil(ENERGY_RULESET.g0 + ENERGY_RULESET.g1 * (tier + 1));
  return base * (tier + 1) * 5;
}

/* ---------- Data Loading ---------- */
async function loadGameData() {
  var base = '';  // relative path
  var [elRes, wRes, mRes] = await Promise.all([
    fetch(base + 'data/elements.json'),
    fetch(base + 'data/worlds.json'),
    fetch(base + 'data/molecules.json')
  ]);
  FULL_ELEMENTS  = await elRes.json();
  WORLDS_DATA    = await wRes.json();
  MOLECULES_DATA = await mRes.json();
  // Initialize with world 0
  applyWorld(0);
}

/* ---------- World Switching ---------- */
function applyWorld(idx) {
  worldIdx = idx;
  var w = WORLDS_DATA[idx];

  // Build ELEMENT_DB for this world: slice from zMin to zMax, renormalize radii
  var slice = [];
  for (var z = w.zMin; z <= w.zMax; z++) {
    var orig = FULL_ELEMENTS.find(function(e) { return e.Z === z; });
    if (orig) slice.push(Object.assign({}, orig));
  }

  // Renormalize radii: sqrt curve from rMin to rMax (compresses high tiers)
  var rMin = 0.30, rMax = 1.50;
  var n = slice.length;
  for (var i = 0; i < n; i++) {
    slice[i].tier = i;  // local tier within this world
    if (n > 1) {
      var t = Math.sqrt(i / (n - 1)); // sqrt curve — early tiers grow fast, high tiers compress
      slice[i].r = parseFloat((rMin + (rMax - rMin) * t).toFixed(2));
    } else {
      slice[i].r = rMin;
    }
  }

  // Replace ELEMENT_DB
  ELEMENT_DB = slice;

  // Override colors with vibrant per-world palette for gameplay distinction
  var worldColors = generateWorldColors(ELEMENT_DB.length);
  for (var ci = 0; ci < ELEMENT_DB.length; ci++) {
    ELEMENT_DB[ci].col = worldColors[ci];
  }

  // Clear texture and material caches so elements get new textures
  texCache = {};
  matCache = {};

  // Apply physics preset from world
  PHYSICS_PRESET.gravity       = w.physics.gravity;
  PHYSICS_PRESET.restitution   = w.physics.restitution;
  PHYSICS_PRESET.friction      = w.physics.friction;
  PHYSICS_PRESET.linearDamping = w.physics.linearDamping;
  PHYSICS_PRESET.angularDamping= w.physics.angularDamping;

  // Apply energy max
  ENERGY_RULESET.maxEnergy = w.energy.maxEnergy;

  // Update WORLDS array for backward compat (world() helper)
  WORLDS = WORLDS_DATA.map(function(wd, i) {
    return {
      id: wd.id,
      label: wd.label,
      dropMaxTier: Math.min(wd.spawnDeck.length - 1, 5),
      legendMaxZ: wd.zMax,
      spawnDeck: wd.spawnDeck
    };
  });
}
