// ═══════════════════════════════════════════════════════════════
// ATOM MERGE — Molecule Engine + VFX + KPIs
// Phases 3–6: spatial index, recipe scanner, bond-lock, effects
// ═══════════════════════════════════════════════════════════════

/* ── Molecule State ─────────────────────────────────────────── */
var MOLECULES_DATA = [];
var moleculeCooldowns = {};     // recipeId → timestamp when available again
var reservedAtoms = {};         // atomId → expiry timestamp
var lastMoleculeScan = 0;
var comboIndex = 0;
var comboResetTimer = null;
var globalMolCooldownEnd = 0;   // global 1.2s cooldown between any molecule
var moleculeLog = [];           // KPI: last 50 molecule events
var sessionStats = { merges: 0, molecules: 0, highestTier: 0, totalEnergy: 0, dropsCount: 0 };

/* ── Spatial Hash ───────────────────────────────────────────── */
var MOL_CELL_SIZE = 4;

function buildSpatialHash() {
  var hash = {};
  for (var i = 0; i < atoms.length; i++) {
    var a = atoms[i];
    if (a.merging || a.fresh) continue;
    var p = a.mesh.getAbsolutePosition();
    var cx = Math.floor(p.x / MOL_CELL_SIZE);
    var cy = Math.floor(p.y / MOL_CELL_SIZE);
    var key = cx + ',' + cy;
    if (!hash[key]) hash[key] = [];
    hash[key].push(a);
  }
  return hash;
}

function getNeighbors(hash, x, y) {
  var result = [];
  var cx = Math.floor(x / MOL_CELL_SIZE);
  var cy = Math.floor(y / MOL_CELL_SIZE);
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      var k = (cx + dx) + ',' + (cy + dy);
      if (hash[k]) {
        for (var n = 0; n < hash[k].length; n++) result.push(hash[k][n]);
      }
    }
  }
  return result;
}

/* ── Recipe Scanner (10Hz) ──────────────────────────────────── */
function scanMolecules() {
  var now = performance.now();
  if (now - lastMoleculeScan < 100) return;
  lastMoleculeScan = now;

  if (merging || gameIsOver) return;
  if (now < globalMolCooldownEnd) return;

  var w = WORLDS_DATA[worldIdx];
  if (!w || !w.molecules || !w.molecules.length) return;

  // Get recipes for current world — only active ones (unlocked by level)
  var activeIds = typeof getActiveRecipeIds === 'function' ? getActiveRecipeIds() : (w.molecules || []);
  var recipes = [];
  for (var i = 0; i < MOLECULES_DATA.length; i++) {
    var r = MOLECULES_DATA[i];
    if (activeIds.indexOf(r.id) >= 0) recipes.push(r);
  }
  recipes.sort(function(a, b) {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.inputs.length - a.inputs.length;
  });

  var hash = buildSpatialHash();

  // Clean expired reservations
  for (var aid in reservedAtoms) {
    if (now > reservedAtoms[aid]) delete reservedAtoms[aid];
  }

  for (var ri = 0; ri < recipes.length; ri++) {
    var recipe = recipes[ri];
    // Check cooldown
    if (moleculeCooldowns[recipe.id] && now < moleculeCooldowns[recipe.id]) continue;
    // Check energy
    if (energy < recipe.cost) continue;

    var match = findRecipeMatch(recipe, hash);
    if (match) {
      triggerMolecule(recipe, match);
      return; // one molecule per scan tick
    }
  }
}

function findRecipeMatch(recipe, hash) {
  // Build required multiset
  var required = {};
  for (var i = 0; i < recipe.inputs.length; i++) {
    var z = recipe.inputs[i].Z;
    required[z] = (required[z] || 0) + 1;
  }
  // Touch tolerance: atoms must be nearly touching (sum of radii + small gap)
  var TOUCH_TOLERANCE = 0.35;

  for (var ai = 0; ai < atoms.length; ai++) {
    var seed = atoms[ai];
    if (seed.merging || seed.fresh) continue;
    if (reservedAtoms[seed.id]) continue;

    var seedZ = ELEMENT_DB[seed.tier].Z;
    if (!required[seedZ]) continue;

    var pos = seed.mesh.getAbsolutePosition();
    var seedR = seed.r || ELEMENT_DB[seed.tier].r || 0.5;
    var neighbors = getNeighbors(hash, pos.x, pos.y);

    var found = {};
    var candidates = [];

    for (var ni = 0; ni < neighbors.length; ni++) {
      var n = neighbors[ni];
      if (n.merging || n.fresh) continue;
      if (reservedAtoms[n.id]) continue;

      var nZ = ELEMENT_DB[n.tier].Z;
      if (!required[nZ]) continue;

      var nR = n.r || ELEMENT_DB[n.tier].r || 0.5;
      var touchDist = seedR + nR + TOUCH_TOLERANCE;
      var dist = BABYLON.Vector3.Distance(pos, n.mesh.getAbsolutePosition());
      if (dist > touchDist) continue;

      // Low velocity check
      var vel = n.mesh.physicsImpostor ? n.mesh.physicsImpostor.getLinearVelocity() : null;
      if (vel && vel.length() > 3.5) continue;

      if (!found[nZ]) found[nZ] = 0;
      if (found[nZ] < required[nZ]) {
        found[nZ]++;
        candidates.push(n);
      }
    }

    // Verify completeness
    var complete = true;
    for (var z in required) {
      if ((found[z] || 0) < required[z]) { complete = false; break; }
    }

    if (complete && candidates.length === recipe.inputs.length) {
      return candidates;
    }
  }
  return null;
}

/* ── Trigger Molecule ───────────────────────────────────────── */
function triggerMolecule(recipe, matchedAtoms) {
  var now = performance.now();

  // Reserve atoms (bond-lock 450ms)
  for (var i = 0; i < matchedAtoms.length; i++) {
    reservedAtoms[matchedAtoms[i].id] = now + 450;
  }

  // Deduct energy
  energy = Math.max(0, energy - recipe.cost);

  // Set cooldowns
  moleculeCooldowns[recipe.id] = now + recipe.cooldownSec * 1000;
  globalMolCooldownEnd = now + 1200; // 1.2s global cooldown

  // Calculate center of matched atoms
  var cx = 0, cy = 0;
  for (var i = 0; i < matchedAtoms.length; i++) {
    var p = matchedAtoms[i].mesh.getAbsolutePosition();
    cx += p.x; cy += p.y;
  }
  cx /= matchedAtoms.length;
  cy /= matchedAtoms.length;
  var center = new BABYLON.Vector3(cx, cy, 0);

  // Flash + VFX
  moleculeVFX(recipe, center, matchedAtoms);

  // Mark consumed atoms — remove physics, animate pull-to-center + grow + vanish
  for (var pi = 0; pi < matchedAtoms.length; pi++) {
    matchedAtoms[pi].merging = true;
    try { matchedAtoms[pi].mesh.physicsImpostor.dispose(); } catch(e) {}
  }

  // Animate consumed atoms: pull toward center + grow slightly, then pop away
  for (var ai = 0; ai < matchedAtoms.length; ai++) {
    (function(atom, idx) {
      var m = atom.mesh;
      if (!m) return;
      var startPos = m.position.clone();
      var startScale = m.scaling.clone();
      var bigScale = startScale.scale(1.35); // grow 35%
      // Pull-to-center + grow (150ms)
      var posAnim = new BABYLON.Animation('molPull', 'position', 60,
        BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
        BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
      posAnim.setKeys([
        { frame: 0, value: startPos },
        { frame: 9, value: center.clone() }
      ]);
      var scaleUp = new BABYLON.Animation('molGrow', 'scaling', 60,
        BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
        BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
      scaleUp.setKeys([
        { frame: 0, value: startScale },
        { frame: 6, value: bigScale },
        { frame: 9, value: new BABYLON.Vector3(0.01, 0.01, 0.01) }
      ]);
      m.animations = [posAnim, scaleUp];
      scene.beginAnimation(m, 0, 9, false, 1, function() {
        try { removeAtom(atom); } catch(e) {}
      });
    })(matchedAtoms[ai], ai);
  }

  // Spawn byproducts FROM center after consume animation finishes (~200ms)
  setTimeout(function() {
    var numByproducts = Math.max(1, matchedAtoms.length - 1);
    for (var bp = 0; bp < numByproducts; bp++) {
      (function(bpIdx) {
        try {
          var deck = currentWorld.spawnDeck || [];
          var bpTier = deck.length > 0 ? deck[Math.floor(Math.random() * deck.length)] : 1;
          var ox = (Math.random() - 0.5) * 0.8;
          var oy = Math.random() * 0.3;
          var atom = spawnAtom(bpTier, center.x, center.y, 0, true);
          // Pop-out animation: start tiny at center, grow to full size
          if (atom && atom.mesh) {
            var fullScale = atom.mesh.scaling.clone();
            atom.mesh.scaling = new BABYLON.Vector3(0.01, 0.01, 0.01);
            var popAnim = new BABYLON.Animation('molPop', 'scaling', 60,
              BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
              BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
            popAnim.setKeys([
              { frame: 0, value: new BABYLON.Vector3(0.01, 0.01, 0.01) },
              { frame: 5, value: fullScale.scale(1.15) },
              { frame: 8, value: fullScale }
            ]);
            atom.mesh.animations = [popAnim];
            scene.beginAnimation(atom.mesh, 0, 8, false);
          }
        } catch(e) {}
      })(bp);
    }

    // Apply gameplay effect
    applyMoleculeGameplay(recipe, center);

    // Refund
    if (recipe.refund) {
      var maxRefund = Math.floor(recipe.cost * 0.4);
      var refund = Math.min(recipe.refund, maxRefund);
      energy = Math.min(ENERGY_RULESET.maxEnergy || 100, energy + refund);
    }

    // Score bonus
    var bonus = recipe.cost * 2 + comboIndex * 10;
    score += bonus;
    if (score > bestScore) {
      bestScore = score;
      try { localStorage.setItem('atomMerge_best', bestScore); } catch(e) {}
    }

    // Combo
    comboIndex++;
    if (comboResetTimer) clearTimeout(comboResetTimer);
    comboResetTimer = setTimeout(function() { comboIndex = 0; }, 3000);

    // KPIs
    sessionStats.molecules++;
    moleculeLog.push({ id: recipe.id, t: Date.now(), combo: comboIndex });
    if (moleculeLog.length > 50) moleculeLog.shift();

    saveGame();
    updateHUD();
    showMoleculeToast(recipe, bonus);

    // Level-up check: notify game.js
    if (typeof onMoleculeFormed === 'function') onMoleculeFormed(recipe);
  }, 100);
}

/* ── Molecule Toast (brief notification) ────────────────────── */
function showMoleculeToast(recipe, bonus) {
  var el = document.getElementById('mol-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mol-toast';
    el.style.cssText = 'position:fixed;top:56px;left:50%;transform:translateX(-50%);' +
      'background:rgba(80,40,200,0.85);color:#fff;padding:6px 16px;border-radius:8px;' +
      'font-size:13px;font-weight:600;z-index:60;pointer-events:none;transition:opacity .4s;' +
      'text-shadow:0 1px 4px rgba(0,0,0,0.5)';
    document.body.appendChild(el);
  }
  var inputs = recipe.inputs.map(function(inp) { return inp.sym; }).join('+');
  el.textContent = '🧬 ' + inputs + ' → ' + recipe.effect + ' +' + bonus + 'pts';
  el.style.opacity = '1';
  setTimeout(function() { el.style.opacity = '0'; }, 2200);
}

/* ── Molecule VFX ───────────────────────────────────────────── */
function moleculeVFX(recipe, center, matchedAtoms) {
  var eff = recipe.effect || 'chain_spark';
  var rad = recipe.effectRadius || 2.5;
  var color = ELEMENT_DB[matchedAtoms[0].tier].col;

  // No full-screen flash — only local particle VFX

  // Category-based VFX
  if (eff.indexOf('spark') >= 0 || eff.indexOf('chain') >= 0 || eff.indexOf('burst') >= 0 ||
      eff.indexOf('radiation') >= 0 || eff.indexOf('conduct') >= 0) {
    vfxSparkBurst(center, color, rad);
  } else if (eff.indexOf('clear') >= 0 || eff.indexOf('flash') >= 0 || eff.indexOf('fog') >= 0 ||
             eff.indexOf('fission') >= 0 || eff.indexOf('meltdown') >= 0 || eff.indexOf('reset') >= 0 ||
             eff.indexOf('corrosive') >= 0) {
    vfxWaveClear(center, color, rad);
  } else if (eff.indexOf('compress') >= 0 || eff.indexOf('pull') >= 0 || eff.indexOf('gravity') >= 0 ||
             eff.indexOf('magnet') >= 0 || eff.indexOf('drag') >= 0 || eff.indexOf('anchor') >= 0 ||
             eff.indexOf('anvil') >= 0) {
    vfxImplode(center, color, rad);
  } else if (eff.indexOf('shield') >= 0 || eff.indexOf('stabilize') >= 0 || eff.indexOf('harden') >= 0 ||
             eff.indexOf('aura') >= 0) {
    vfxShieldBubble(center, color, rad);
  } else if (eff.indexOf('repulse') >= 0 || eff.indexOf('shock') >= 0 || eff.indexOf('lift') >= 0 ||
             eff.indexOf('shear') >= 0 || eff.indexOf('wave') >= 0) {
    vfxShockwave(center, color, rad);
  } else {
    // Special: refill, slow, warp, phase, gold — use generic sparkle
    vfxSparkle(center, color, rad);
  }
}

/* ── VFX Implementations ────────────────────────────────────── */

// 1. Spark Burst — energetic particles shooting outward
function vfxSparkBurst(center, color, radius) {
  var ps = new BABYLON.ParticleSystem('molSpark', 100, scene);
  ps.particleTexture = getMergeParticleTexture();
  ps.emitter = center.clone();
  ps.createSphereEmitter(radius * 0.3);
  var c = hex3(color);
  ps.color1 = new BABYLON.Color4(Math.min(1, c.r+0.3), Math.min(1, c.g+0.3), c.b, 1);
  ps.color2 = new BABYLON.Color4(1, 0.9, 0.3, 0.9);
  ps.colorDead = new BABYLON.Color4(c.r*0.3, c.g*0.3, c.b*0.3, 0);
  ps.minSize = 0.08; ps.maxSize = 0.25;
  ps.minLifeTime = 0.2; ps.maxLifeTime = 0.6;
  ps.minEmitPower = 5; ps.maxEmitPower = 12;
  ps.gravity = vec3(0, -2, 0);
  ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
  ps.emitRate = 300; ps.manualEmitCount = 80;
  ps.targetStopDuration = 0.05; ps.disposeOnStop = true;
  ps.start();

  // Secondary orange trails
  var ps2 = new BABYLON.ParticleSystem('molTrail', 40, scene);
  ps2.particleTexture = getMergeParticleTexture();
  ps2.emitter = center.clone();
  ps2.createSphereEmitter(radius * 0.6);
  ps2.color1 = new BABYLON.Color4(1, 0.6, 0.1, 0.8);
  ps2.color2 = new BABYLON.Color4(1, 0.3, 0.0, 0.6);
  ps2.colorDead = new BABYLON.Color4(0.3, 0.1, 0, 0);
  ps2.minSize = 0.15; ps2.maxSize = 0.4;
  ps2.minLifeTime = 0.3; ps2.maxLifeTime = 0.8;
  ps2.minEmitPower = 2; ps2.maxEmitPower = 6;
  ps2.gravity = vec3(0, -1, 0);
  ps2.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
  ps2.emitRate = 200; ps2.manualEmitCount = 30;
  ps2.targetStopDuration = 0.05; ps2.disposeOnStop = true;
  ps2.start();
}

// 2. Wave/Clear — expanding ring that clears area
function vfxWaveClear(center, color, radius) {
  // Expanding torus ring
  var ring = BABYLON.MeshBuilder.CreateTorus('molRing', {
    diameter: radius * 0.2, thickness: 0.12, tessellation: 32
  }, scene);
  ring.position = center.clone();
  ring.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
  var mat = new BABYLON.StandardMaterial('molRingM', scene);
  var c = hex3(color);
  mat.emissiveColor = c; mat.diffuseColor = c;
  mat.alpha = 1.0; mat.disableLighting = true;
  ring.material = mat;

  var scAnim = new BABYLON.Animation('mrS', 'scaling', 60,
    BABYLON.Animation.ANIMATIONTYPE_VECTOR3, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
  scAnim.setKeys([
    { frame: 0, value: vec3(1,1,1) },
    { frame: 20, value: vec3(8,8,8) }
  ]);
  var alAnim = new BABYLON.Animation('mrA', 'material.alpha', 60,
    BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
  alAnim.setKeys([
    { frame: 0, value: 1.0 },
    { frame: 20, value: 0.0 }
  ]);
  ring.animations = [scAnim, alAnim];
  scene.beginAnimation(ring, 0, 20, false, 1.0, function() { ring.dispose(); });

  // Particle splash
  var ps = new BABYLON.ParticleSystem('molClear', 60, scene);
  ps.particleTexture = getMergeParticleTexture();
  ps.emitter = center.clone();
  ps.createSphereEmitter(radius * 0.8);
  ps.color1 = new BABYLON.Color4(c.r, c.g, c.b, 0.9);
  ps.color2 = new BABYLON.Color4(1, 1, 1, 0.7);
  ps.colorDead = new BABYLON.Color4(c.r*0.2, c.g*0.2, c.b*0.2, 0);
  ps.minSize = 0.1; ps.maxSize = 0.35;
  ps.minLifeTime = 0.3; ps.maxLifeTime = 0.7;
  ps.minEmitPower = 4; ps.maxEmitPower = 9;
  ps.gravity = vec3(0, -3, 0);
  ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
  ps.emitRate = 200; ps.manualEmitCount = 50;
  ps.targetStopDuration = 0.05; ps.disposeOnStop = true;
  ps.start();
}

// 3. Implode — particles rush inward then pop
function vfxImplode(center, color, radius) {
  var c = hex3(color);
  // Ring that shrinks
  var ring = BABYLON.MeshBuilder.CreateTorus('molImp', {
    diameter: radius * 2, thickness: 0.08, tessellation: 28
  }, scene);
  ring.position = center.clone();
  ring.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
  var mat = new BABYLON.StandardMaterial('molImpM', scene);
  mat.emissiveColor = new BABYLON.Color3(c.r, c.g, Math.min(1, c.b+0.3));
  mat.alpha = 0.9; mat.disableLighting = true;
  ring.material = mat;

  var scAnim = new BABYLON.Animation('miS', 'scaling', 60,
    BABYLON.Animation.ANIMATIONTYPE_VECTOR3, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
  scAnim.setKeys([
    { frame: 0, value: vec3(3,3,3) },
    { frame: 12, value: vec3(0.1,0.1,0.1) }
  ]);
  var alAnim = new BABYLON.Animation('miA', 'material.alpha', 60,
    BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
  alAnim.setKeys([
    { frame: 0, value: 0.9 },
    { frame: 12, value: 0 }
  ]);
  ring.animations = [scAnim, alAnim];
  scene.beginAnimation(ring, 0, 12, false, 1.0, function() { ring.dispose(); });
}

// 4. Shield Bubble — glowing sphere that fades
function vfxShieldBubble(center, color, radius) {
  var c = hex3(color);
  var sphere = BABYLON.MeshBuilder.CreateSphere('molShield', {
    diameter: radius * 1.5, segments: 20
  }, scene);
  sphere.position = center.clone();
  var mat = new BABYLON.StandardMaterial('molShM', scene);
  mat.emissiveColor = new BABYLON.Color3(c.r*0.8, c.g*0.8, Math.min(1, c.b+0.4));
  mat.alpha = 0.35; mat.disableLighting = true;
  mat.wireframe = true;
  sphere.material = mat;

  var alAnim = new BABYLON.Animation('msA', 'material.alpha', 60,
    BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
  alAnim.setKeys([
    { frame: 0, value: 0.45 },
    { frame: 40, value: 0 }
  ]);
  var scAnim = new BABYLON.Animation('msS', 'scaling', 60,
    BABYLON.Animation.ANIMATIONTYPE_VECTOR3, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
  scAnim.setKeys([
    { frame: 0, value: vec3(0.5,0.5,0.5) },
    { frame: 10, value: vec3(1.2,1.2,1.2) },
    { frame: 40, value: vec3(1.4,1.4,1.4) }
  ]);
  sphere.animations = [alAnim, scAnim];
  scene.beginAnimation(sphere, 0, 40, false, 1.0, function() { sphere.dispose(); });
}

// 5. Shockwave — ring push outward + ground ripple
function vfxShockwave(center, color, radius) {
  // Use merge ring but bigger
  emitMergeRing(center, color, radius * 1.5);
  emitMergeBurst(center, color, radius * 1.2);
}

// 6. Sparkle — generic pretty effect for special molecules
function vfxSparkle(center, color, radius) {
  var c = hex3(color);
  var ps = new BABYLON.ParticleSystem('molSparkle', 50, scene);
  ps.particleTexture = getMergeParticleTexture();
  ps.emitter = center.clone();
  ps.minEmitBox = vec3(-radius*0.5, -radius*0.5, -0.2);
  ps.maxEmitBox = vec3(radius*0.5, radius*0.5, 0.2);
  ps.color1 = new BABYLON.Color4(1, 0.95, 0.7, 1);
  ps.color2 = new BABYLON.Color4(c.r, c.g, c.b, 0.8);
  ps.colorDead = new BABYLON.Color4(0.5, 0.3, 0.1, 0);
  ps.minSize = 0.05; ps.maxSize = 0.2;
  ps.minLifeTime = 0.4; ps.maxLifeTime = 1.0;
  ps.minEmitPower = 1; ps.maxEmitPower = 4;
  ps.gravity = vec3(0, 2, 0); // floats up
  ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
  ps.emitRate = 150; ps.manualEmitCount = 40;
  ps.targetStopDuration = 0.05; ps.disposeOnStop = true;
  ps.start();
}

/* ── Gameplay Effects (post-VFX) ────────────────────────────── */
function applyMoleculeGameplay(recipe, center) {
  var eff = recipe.effect || '';
  var rad = recipe.effectRadius || 2.5;

  // Clear effects: only give score bonus, do NOT remove other atoms
  // (removing nearby atoms was causing non-recipe atoms to vanish)
  if (eff.indexOf('clear') >= 0 || eff.indexOf('flash') >= 0 ||
      eff.indexOf('fission') >= 0 || eff.indexOf('meltdown') >= 0 ||
      eff.indexOf('reset') >= 0 || eff.indexOf('corrosive') >= 0) {
    score += recipe.points * 2; // bonus points instead of removing atoms
  }

  // Compress/pull: apply inward impulse
  if (eff.indexOf('compress') >= 0 || eff.indexOf('pull') >= 0 || eff.indexOf('gravity') >= 0 ||
      eff.indexOf('magnet') >= 0 || eff.indexOf('drag') >= 0 || eff.indexOf('anchor') >= 0) {
    for (var i = 0; i < atoms.length; i++) {
      var p = atoms[i].mesh.getAbsolutePosition();
      var d = BABYLON.Vector3.Distance(center, p);
      if (d < rad * 1.5 && d > 0.1 && !atoms[i].merging) {
        var dir = center.subtract(p).normalize();
        var force = dir.scale(0.3 * (1 - d / (rad * 1.5)));
        try {
          atoms[i].mesh.physicsImpostor.applyImpulse(force, p);
        } catch(e) {}
      }
    }
  }

  // Repulse/shockwave/lift: outward impulse
  if (eff.indexOf('repulse') >= 0 || eff.indexOf('shock') >= 0 || eff.indexOf('lift') >= 0 ||
      eff.indexOf('shear') >= 0 || eff.indexOf('wave') >= 0) {
    for (var i = 0; i < atoms.length; i++) {
      var p = atoms[i].mesh.getAbsolutePosition();
      var d = BABYLON.Vector3.Distance(center, p);
      if (d < rad * 1.5 && d > 0.1 && !atoms[i].merging) {
        var dir = p.subtract(center).normalize();
        if (eff.indexOf('lift') >= 0) dir.y += 0.5;
        var force = dir.scale(0.4 * (1 - d / (rad * 1.5)));
        try {
          atoms[i].mesh.physicsImpostor.applyImpulse(force, p);
        } catch(e) {}
      }
    }
  }

  // Refill effects: bonus energy
  if (eff.indexOf('refill') >= 0 || eff.indexOf('glow_refill') >= 0 || eff.indexOf('catalyst') >= 0) {
    energy = Math.min(ENERGY_RULESET.maxEnergy || 100, energy + 15);
  }

  // Slow effects: reduce velocity of nearby atoms
  if (eff.indexOf('slow') >= 0 || eff.indexOf('fog') >= 0 || eff.indexOf('time') >= 0) {
    for (var i = 0; i < atoms.length; i++) {
      var p = atoms[i].mesh.getAbsolutePosition();
      var d = BABYLON.Vector3.Distance(center, p);
      if (d < rad * 1.5 && !atoms[i].merging) {
        try {
          var v = atoms[i].mesh.physicsImpostor.getLinearVelocity();
          atoms[i].mesh.physicsImpostor.setLinearVelocity(v.scale(0.3));
        } catch(e) {}
      }
    }
  }
}

/* ── Integration: Check reserved atoms before merge ─────────── */
function isAtomReserved(atom) {
  if (!reservedAtoms[atom.id]) return false;
  if (performance.now() > reservedAtoms[atom.id]) {
    delete reservedAtoms[atom.id];
    return false;
  }
  return true;
}

/* ── Energy Gain Formula (Phase 5) ──────────────────────────── */
function calcEnergyGain(newTier) {
  return Math.ceil(1 + 0.35 * newTier + 0.75 * comboIndex);
}
