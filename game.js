// ═══════════════════════════════════════════════════════════════
// ATOM MERGE — Game Engine
// Babylon.js 5 + Cannon.js  •  config-driven  •  VFX primitives
// ═══════════════════════════════════════════════════════════════

/* ── State ──────────────────────────────────────────────────── */
var engine, scene, glowLayer, camera;
var atoms       = [];
var score       = 0;
var bestScore   = 0;
var energy      = 0;
var dropQueue   = [];
var gameIsOver  = false;
var canDrop     = true;
var worldIdx    = 0;
var ghostMesh   = null;
var ghostX      = 0;
var dangerStart = 0;
var merging     = false;
var currentLevel = 0;   // molecule-based: 0-5 (6 recipes per world)
var texCache    = {};
var matCache    = {};
var atomIdSeq   = 0;
var queueMeshes = [null, null, null]; // 3D preview spheres

/* ── Helpers ────────────────────────────────────────────────── */
function hex3(hex) {
  return new BABYLON.Color3(
    parseInt(hex.slice(1,3),16)/255,
    parseInt(hex.slice(3,5),16)/255,
    parseInt(hex.slice(5,7),16)/255
  );
}
function world()       { return WORLDS[worldIdx]; }
function getActiveSpawnDeck() {
  var w = WORLDS_DATA[worldIdx];
  if (!w || !w.spawnDeck || w.spawnDeck.length === 0) return [0];
  return w.spawnDeck.slice(); // strict 5 atoms only — no injection
}

function getDropCost() {
  return Math.floor(currentLevel / 2) + 1;
}

/* Returns recipe IDs active at current level — ONLY the current target recipe.
   One recipe at a time prevents earlier recipes from stealing atoms needed for later ones. */
function getActiveRecipeIds() {
  var w = WORLDS_DATA[worldIdx];
  if (!w || !w.molecules || currentLevel >= w.molecules.length) return [];
  return [w.molecules[currentLevel]];
}

/* Returns the target recipe ID for the current level */
function getTargetRecipeId() {
  var w = WORLDS_DATA[worldIdx];
  if (!w || !w.molecules || currentLevel >= w.molecules.length) return null;
  return w.molecules[currentLevel];
}

function randDrop() {
  var deck = getActiveSpawnDeck();
  var z = deck[Math.floor(Math.random() * deck.length)];
  for (var i = 0; i < ELEMENT_DB.length; i++) {
    if (ELEMENT_DB[i].Z === z) return i;
  }
  return Math.floor(Math.random() * Math.min(6, ELEMENT_DB.length));
}
function initQueue()   { dropQueue = []; for (var i = 0; i < 4; i++) dropQueue.push(randDrop()); }
function advanceQueue(){ dropQueue.shift(); dropQueue.push(randDrop()); }
function currentTierFromQueue() { return dropQueue[0]; }
function vec3(x,y,z)   { return new BABYLON.Vector3(x, y, z); }

/* ── Persistence ───────────────────────────────────────────── */
function saveGame() {
  if (gameIsOver) return;
  var state = {
    worldIdx: worldIdx,
    currentLevel: currentLevel,
    score: score,
    bestScore: bestScore,
    energy: energy,
    atoms: atoms.map(function(a) {
      return { tier: a.tier, x: a.mesh.position.x, y: a.mesh.position.y };
    }),
    queue: dropQueue.map(function(t) { return t; })
  };
  try { localStorage.setItem('atomMerge_save', JSON.stringify(state)); } catch(e){}
}

function loadGame() {
  try {
    var raw = localStorage.getItem('atomMerge_save');
    if (!raw) return false;
    var s = JSON.parse(raw);

    if (s.worldIdx !== undefined) {
      worldIdx = s.worldIdx;
      applyWorld(worldIdx);
      applyWorldTheme();
    }
    if (s.currentLevel !== undefined) {
      var maxLvl = WORLDS_DATA[worldIdx].molecules ? WORLDS_DATA[worldIdx].molecules.length : 6;
      currentLevel = Math.min(s.currentLevel, maxLvl - 1);
    }

    score = s.score || 0;
    bestScore = s.bestScore || 0;
    energy = s.energy || 0;

    if (s.atoms && s.atoms.length > 0) {
      for (var i = 0; i < s.atoms.length; i++) {
        spawnAtom(s.atoms[i].tier, s.atoms[i].x, s.atoms[i].y, 0, true);
      }
    }

    if (s.queue && s.queue.length >= 4) {
      dropQueue = s.queue;
    }

    updateGhost();
    updateQueuePreview();
    updateHUD();
    return true;
  } catch(e) { return false; }
}

/* ── Engine bootstrap ───────────────────────────────────────── */
async function boot() {
  var canvas = document.getElementById('renderCanvas');
  engine = new BABYLON.Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false }, true /* adaptToDeviceRatio */);
  // Cap at 2x on 3x+ screens: scalingLevel = 1/targetDPR
  var dpr = window.devicePixelRatio || 1;
  if (dpr > 2) engine.setHardwareScalingLevel(1 / 2);

  await loadGameData();
  buildScene();
  applyWorldTheme();
  initStarfield();
  setupInput(canvas);
  populateWorldSelector();
  buildLegend();
  loadHighScores(); // pre-fetch server scores into cache
  checkServerStatus(); // ping scores server

  var lastTick = 0;

  engine.runRenderLoop(function () {
    if (!scene || !scene.activeCamera) return;
    var now = performance.now();
    if (now - lastTick > 80) {
      scanMolecules();
      checkMerges();
      checkGameOver();
      lastTick = now;
    }
    updateStormLines();
    /* energy only changes on merge — no passive drain */
    updateHUD();
    // Enforce Z=0 + micro-velocity damping + recover missing physics
    var floorY = -(CONTAINER.h / 2);
    for (var zi = 0; zi < atoms.length; zi++) {
      var at = atoms[zi];
      // Safety: clear stuck merging flag after 1s
      if (at.merging) {
        if (!at._mergeStart) at._mergeStart = Date.now();
        if (Date.now() - at._mergeStart > 1000) {
          at.merging = false;
          at._mergeStart = 0;
          console.warn('Cleared stuck merging flag on atom', at.id);
        } else { continue; }
      }
      try {
        // Safety net: re-add physics if somehow lost
        var imp = at.mesh.physicsImpostor;
        if (!imp || !imp.physicsBody) {
          console.warn('Re-adding physics to stuck atom', at.id);
          addPhysicsToAtom(at.mesh, at.elem);
          imp = at.mesh.physicsImpostor;
        }
        var body = imp.physicsBody;
        if (!body) continue;
        // Lock Z axis only
        body.position.z = 0;
        body.velocity.z = 0;
        at.mesh.position.z = 0;
        // Safety clamp — only extreme velocities (explosion prevention)
        var vx = body.velocity.x, vy = body.velocity.y;
        if (vx > 8) body.velocity.x = 8;
        if (vx < -8) body.velocity.x = -8;
        if (vy > 10) body.velocity.y = 10;
        if (vy < -20) body.velocity.y = -20;
      } catch(e) {}
    }
    scene.render();
  });

  window.addEventListener('resize', function () { engine.resize(); fitCamera(); });
}

/* ── Responsive Camera ─────────────────────────────────────── */
function fitCamera() {
  if (!camera || !engine) return;
  var aspect = engine.getAspectRatio(camera);
  var isPortrait = aspect < 0.85;
  var pad = isPortrait ? 1.5 : 4;
  var needW = CONTAINER.w + pad;
  var needH = CONTAINER.h + pad;
  var camZ = 38;
  var fovForH = 2 * Math.atan(needH / 2 / camZ);
  var fovForW = 2 * Math.atan((needW / 2 / camZ) / aspect);
  camera.fov = Math.max(fovForH, fovForW);
  var halfH = camZ * Math.tan(camera.fov / 2);
  var camY = halfH * 0.98;
  camera.position.y = camY;
  camera.position.z = camZ;
  camera.setTarget(new BABYLON.Vector3(0, camY - 1, 0));

  /* Align HUD width to projected container width */
  var visW = 2 * camZ * Math.tan(camera.fov / 2) * aspect;
  var boxFrac = CONTAINER.w / visW;
  var pixW = Math.round(boxFrac * engine.getRenderWidth());
  var hud = document.getElementById('hud');
  if (hud) {
    hud.style.width = pixW + 'px';
    hud.style.left = '50%';
    hud.style.right = 'auto';
    hud.style.transform = 'translateX(-50%)';
  }
}

/* ── Scene ──────────────────────────────────────────────────── */
function buildScene() {
  texCache = {};
  matCache = {};
  atoms    = [];
  merging  = false;
  dangerStart = 0;

  if (scene) scene.dispose();
  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);

  // Physics — 12 solver iterations (fewer = less over-correction with many atoms)
  var cannonPlugin = new BABYLON.CannonJSPlugin(true, 12, CANNON);
  scene.enablePhysics(vec3(0, -PHYSICS_PRESET.gravity, 0), cannonPlugin);
  // Tune Cannon.js world for stable piles
  var cWorld = cannonPlugin.world;
  if (cWorld) {
    cWorld.solver.tolerance = 0.001;
    // Default contact material — low bounce, high friction
    if (cWorld.defaultContactMaterial) {
      cWorld.defaultContactMaterial.restitution = 0.02;
      cWorld.defaultContactMaterial.friction = 0.8;
      cWorld.defaultContactMaterial.contactEquationStiffness = 1e8;
      cWorld.defaultContactMaterial.contactEquationRelaxation = 4;
    }
  }

  // Camera — fixed front view, responsive fit
  camera = new BABYLON.FreeCamera('cam', vec3(0, 10, 38), scene);
  camera.setTarget(vec3(0, 7, 0));
  camera.inputs.clear();
  fitCamera();

  // Lighting
  var hemi = new BABYLON.HemisphericLight('h', vec3(0, 1, 0.3), scene);
  hemi.intensity   = 0.55;
  hemi.groundColor = new BABYLON.Color3(0.08, 0.08, 0.18);

  var p1 = new BABYLON.PointLight('p1', vec3(-5, 14, 10), scene);
  p1.intensity = 1.0;
  p1.diffuse   = new BABYLON.Color3(0.85, 0.90, 1.0);

  var p2 = new BABYLON.PointLight('p2', vec3(5, 1, 8), scene);
  p2.intensity = 0.5;
  p2.diffuse   = new BABYLON.Color3(1.0, 0.85, 0.7);

  // Glow layer (VFX primitive)
  glowLayer = new BABYLON.GlowLayer('glow', scene, { mainTextureSamples: 2 });
  glowLayer.intensity = 0.25;

  buildContainer();
  buildDangerLine();

  initQueue();
  score       = 0;
  energy      = 0;
  gameIsOver  = false;
  canDrop     = true;

  // Load bestScore from persistent storage
  try { bestScore = parseInt(localStorage.getItem('atomMerge_best')) || 0; } catch(e){}

  // Try to restore saved game state
  if (!loadGame()) {
    updateGhost();
    updateQueuePreview();
    updateHUD();
  }
}

/* ── Container ──────────────────────────────────────────────── */
function buildContainer() {
  var W = CONTAINER.w, H = CONTAINER.h, D = CONTAINER.d, T = CONTAINER.wall;

  var wm = new BABYLON.StandardMaterial('wm', scene);
  wm.diffuseColor  = new BABYLON.Color3(0.12, 0.16, 0.32);
  wm.specularColor = new BABYLON.Color3(0.15, 0.20, 0.35);
  wm.emissiveColor = new BABYLON.Color3(0.04, 0.06, 0.12);
  wm.alpha = 0.08;

  var ph = { mass:0, restitution:PHYSICS_PRESET.restitution, friction:PHYSICS_PRESET.friction };

  function wall(name, w, h, d, x, y, z, vis, hasPhysics) {
    var m = BABYLON.MeshBuilder.CreateBox(name, {width:w,height:h,depth:d}, scene);
    m.position.set(x, y, z);
    m.material = wm;
    if (vis === false) m.isVisible = false;
    if (hasPhysics !== false) {
      m.physicsImpostor = new BABYLON.PhysicsImpostor(m,
        BABYLON.PhysicsImpostor.BoxImpostor, ph, scene);
    }
    return m;
  }

  wall('floor', W+2*T, T, D+2*T,  0,            -T/2,        0);
  wall('left',  T,     H, D,      -(W/2+T/2),    H/2,         0);
  wall('right', T,     H, D,       (W/2+T/2),    H/2,         0);
  // Front/back walls: visual only, NO physics — Z is locked by linearFactor
  // Having physics here causes big atoms (r>1.5) to collide with both walls → freeze
  wall('back',  W,     H, T,       0,             H/2,        -(D/2+T/2), true, false);
  wall('front', W,     H, T,       0,             H/2,         (D/2+T/2), false, false);
}

function buildDangerLine() {
  var dm = new BABYLON.StandardMaterial('dm', scene);
  dm.emissiveColor   = new BABYLON.Color3(0.9, 0.12, 0.08);
  dm.alpha           = 0.12;
  dm.disableLighting = true;
  var ln = BABYLON.MeshBuilder.CreateBox('dline',
    {width:CONTAINER.w-0.05, height:0.02, depth:CONTAINER.d-0.05}, scene);
  ln.position.y = GAME_RULES.dangerY;
  ln.material   = dm;
}

/* ── Element Textures (color + text baked onto sphere) ── */
function elemTexture(elem) {
  if (texCache[elem.Z]) return texCache[elem.Z];

  var S = 512;
  var tex = new BABYLON.DynamicTexture('dt'+elem.Z, S, scene, true);
  var ctx = tex.getContext();

  // Solid color fill
  ctx.fillStyle = elem.col;
  ctx.fillRect(0, 0, S, S);

  // Subtle radial highlight for 3D feel
  var g = ctx.createRadialGradient(S*0.4, S*0.35, 0, S/2, S/2, S*0.55);
  g.addColorStop(0, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(0,0,0,0.15)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  // Mirror horizontally so text reads correctly on sphere front face
  ctx.save();
  ctx.translate(S, 0);
  ctx.scale(-1, 1);

  // Draw element symbol — shifted up from center, crisp border
  var symSize = elem.sym.length > 2 ? 64 : 80;
  ctx.font         = 'bold ' + symSize + 'px Arial, Helvetica, sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle  = 'rgba(0,0,0,0.85)';
  ctx.lineWidth    = 7;
  ctx.lineJoin     = 'round';
  ctx.strokeText(elem.sym, S/2, S*0.40);
  ctx.fillStyle    = '#FFFFFF';
  ctx.fillText(elem.sym, S/2, S*0.40);

  // Z number just below symbol, bigger + border
  ctx.font         = 'bold 48px Arial, Helvetica, sans-serif';
  ctx.strokeStyle  = 'rgba(0,0,0,0.75)';
  ctx.lineWidth    = 5;
  ctx.strokeText(String(elem.Z), S/2, S*0.50);
  ctx.fillStyle    = 'rgba(255,255,255,0.85)';
  ctx.fillText(String(elem.Z), S/2, S*0.50);

  ctx.restore();

  tex.update(false);
  tex.uOffset = -0.25; // Rotate UV to face camera
  texCache[elem.Z] = tex;
  return tex;
}

/* ── Atom Materials ─────────────────────────────────────────── */
function atomMat(elem) {
  var m = new BABYLON.StandardMaterial('am'+elem.Z+'_'+(atomIdSeq++), scene);
  m.diffuseTexture = elemTexture(elem);
  m.specularColor  = new BABYLON.Color3(0.45, 0.45, 0.45);
  m.specularPower  = 28;
  m.emissiveColor  = hex3(elem.col).scale(0.10);
  return m;
}

/* ── Atom Spawn ─────────────────────────────────────────────── */
function spawnAtom(tier, x, y, z, skipAnim) {
  if (tier < 0 || tier >= ELEMENT_DB.length) return null;
  var elem = ELEMENT_DB[tier];

  var id = 'a' + (atomIdSeq++);
  var sp = BABYLON.MeshBuilder.CreateSphere(id,
    { diameter: elem.r * 2, segments: 16 }, scene);
  sp.position.set(x, y, z || 0);
  sp.material = atomMat(elem);
  sp.isPickable = false;

  var atom = { id: id, mesh: sp, tier: tier, r: elem.r, elem: elem, merging: false, fresh: true };
  setTimeout(function () { atom.fresh = false; }, GAME_RULES.settleDelay);
  atoms.push(atom);

  if (!skipAnim) {
    // Spawn animation for dropped atoms (VFX: scale pop)
    // Physics impostor created AFTER animation to avoid ghost collisions
    sp.scaling.setAll(0.01);
    var anim = new BABYLON.Animation('sp', 'scaling', 60,
      BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
      BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    anim.setKeys([
      { frame:0,  value: vec3(0.01,0.01,0.01) },
      { frame:5,  value: vec3(1.3,1.3,1.3)    },
      { frame:9,  value: vec3(1,1,1)           },
    ]);
    sp.animations = [anim];
    scene.beginAnimation(sp, 0, 9, false, 1.0, function() {
      // Create impostor only after animation finishes — no ghost overlaps
      addPhysicsToAtom(sp, elem);
    });
  } else {
    // Merged atoms: full size immediately, physics body right away
    addPhysicsToAtom(sp, elem);
  }

  return atom;
}

function addPhysicsToAtom(sp, elem) {
  // Linear mass — avoids huge mass ratios that make big atoms immovable
  var mass = 0.5 + elem.r * 2;
  sp.physicsImpostor = new BABYLON.PhysicsImpostor(sp,
    BABYLON.PhysicsImpostor.SphereImpostor,
    { mass: mass, restitution: PHYSICS_PRESET.restitution, friction: PHYSICS_PRESET.friction },
    scene);
  try {
    sp.physicsImpostor.physicsBody.angularFactor.set(0, 0, 1);
    sp.physicsImpostor.physicsBody.linearFactor.set(1, 1, 0);
    sp.physicsImpostor.physicsBody.angularDamping = 0.85;
    sp.physicsImpostor.physicsBody.linearDamping = 0.12;
    sp.physicsImpostor.physicsBody.allowSleep = false;
    sp.physicsImpostor.physicsBody.position.z = 0;
  } catch(e) {}
}

function removeAtom(atom) {
  var i = atoms.indexOf(atom);
  if (i >= 0) atoms.splice(i, 1);
  try { atom.mesh.physicsImpostor.dispose(); } catch(e){}
  try { atom.mesh.dispose(); } catch(e){}
}

/* ── 3D Queue Preview ──────────────────────────────────────── */
// Queue sits on the RIGHT side of the screen. qi=0 (next drop) is the LEFTMOST ball.
function queuePos(qi, diam) {
  var edge = (CONTAINER.w / 2) - 0.8;  // positive X = screen RIGHT (camera at +Z)
  var spacing = 1.1;
  var yCenter = CONTAINER.h + 0.6;  // centered between box top and header
  // Center-aligned: all ball centers at same Y
  return new BABYLON.Vector3(edge - (2 - qi) * spacing, yCenter, 2.0);
}

// qi = display index (0=leftmost/next, 1=middle, 2=rightmost)
// maps to dropQueue[qi+1] since dropQueue[0] is the active drop ball
function makeQueueBall(qi) {
  var elem = ELEMENT_DB[dropQueue[qi + 1]];
  var scale = qi === 0 ? 1.0 : (qi === 1 ? 0.75 : 0.5);  // next=full, 2nd=3/4, 3rd=half
  var diam = elem.r * 2 * scale;
  if (qi > 0 && diam > 1.4) diam = 1.4;  // cap only preview balls, not next-drop

  var sp = BABYLON.MeshBuilder.CreateSphere('q3d_' + qi,
    { diameter: diam, segments: 16 }, scene);
  sp._queueDiam = diam;  // store for sweep scaling
  sp.position = queuePos(qi);

  var mat = new BABYLON.StandardMaterial('qm_' + qi, scene);
  mat.diffuseTexture = elemTexture(elem);
  mat.emissiveColor  = hex3(elem.col).scale(0.10);
  mat.alpha = 1.0;
  sp.material = mat;
  sp.isPickable = false;
  return sp;
}

function updateQueuePreview() {
  for (var i = 0; i < 3; i++) {
    if (queueMeshes[i]) { queueMeshes[i].dispose(); queueMeshes[i] = null; }
  }
  for (var qi = 0; qi < 3; qi++) {
    queueMeshes[qi] = makeQueueBall(qi);
  }
}

/* Animated queue transition: sweep first ball to drop zone, shift others, new fades in */
function animateQueueDrop(targetX, callback) {
  var sweepMs = 180;  // quick but visible
  var frames = Math.round(sweepMs / 16);

  // Snapshot current queue mesh positions before disposing
  var oldMeshes = queueMeshes.slice();
  queueMeshes = [null, null, null];

  // Ball 0 (next drop) sweeps down to drop zone
  var sweeper = oldMeshes[0];
  var dropTarget = new BABYLON.Vector3(targetX, GAME_RULES.dropY, 2.0);

  // Balls 1,2 slide inward to their new positions (they become 0,1)
  var sliders = [];
  for (var s = 1; s < 3; s++) {
    if (oldMeshes[s]) {
      sliders.push({ mesh: oldMeshes[s], target: queuePos(s - 1) });
    }
  }

  var frame = 0;
  var obs = scene.onBeforeRenderObservable.add(function () {
    frame++;
    var t = Math.min(frame / frames, 1);
    var ease = t * (2 - t); // ease-out quad

    // Sweep ball 0 down to drop zone — scale UP to real size
    if (sweeper) {
      if (!sweeper._sweepStart) sweeper._sweepStart = sweeper.position.clone();
      BABYLON.Vector3.LerpToRef(sweeper._sweepStart, dropTarget, ease, sweeper.position);
      // Already real size (qi=0 is 1.0 scale, no cap) — just keep it

    }

    // Slide remaining balls inward
    for (var j = 0; j < sliders.length; j++) {
      var sl = sliders[j];
      if (!sl.start) sl.start = sl.mesh.position.clone();
      BABYLON.Vector3.LerpToRef(sl.start, sl.target, ease, sl.mesh.position);
    }

    if (t >= 1) {
      scene.onBeforeRenderObservable.remove(obs);
      // Clean up old meshes
      if (sweeper) sweeper.dispose();
      for (var k = 0; k < sliders.length; k++) sliders[k].mesh.dispose();
      // Rebuild fresh queue
      updateQueuePreview();
      if (callback) callback();
    }
  });
}

/* ── Drop ───────────────────────────────────────────────────── */
function dropAtom(wx) {
  if (!canDrop || gameIsOver || atoms.length >= GAME_RULES.maxAtoms) return;
  var maxX = CONTAINER.w / 2 - ELEMENT_DB[dropQueue[0]].r - 0.15;
  wx = Math.max(-maxX, Math.min(maxX, wx));

  canDrop = false;

  // Energy cost per drop — scales with level
  var dropCost = getDropCost();
  energy = Math.max(0, energy - dropCost);

  spawnAtom(dropQueue[0], wx, GAME_RULES.dropY, 0, true); // skipAnim — just drop
  playDropSound();
  sessionStats.dropsCount++;

  // Hide ghost — the sweep animation replaces it
  if (ghostMesh) { ghostMesh.dispose(); ghostMesh = null; }

  // Advance queue and start sweep simultaneously with ball drop
  advanceQueue();
  saveGame();
  animateQueueDrop(ghostX, function() {
    // Sweep done → show new ghost + allow next drop
    updateGhost();
    updateHUD();
    setTimeout(function () { canDrop = true; }, GAME_RULES.dropCooldown);
  });
  updateHUD();
}

/* ── Ghost (drop preview) ──────────────────────────────────── */
function updateGhost() {
  if (ghostMesh) ghostMesh.dispose();
  var elem = ELEMENT_DB[dropQueue[0]];
  ghostMesh = BABYLON.MeshBuilder.CreateSphere('ghost',
    { diameter: elem.r * 2, segments: 16 }, scene);
  ghostMesh.position.set(ghostX, GAME_RULES.dropY, 0);
  var gm = new BABYLON.StandardMaterial('gm', scene);
  gm.diffuseTexture = elemTexture(elem);
  gm.emissiveColor  = hex3(elem.col).scale(0.10);
  gm.alpha = 1.0;
  ghostMesh.material = gm;
  ghostMesh.isPickable = false;

}

/* ── Level / World Progression ──────────────────────────────── */
function showLevelUpToast(recipeName) {
  var el = document.getElementById('level-toast');
  if (!el) return;
  var dropCost = getDropCost();
  el.innerHTML = '⬆ Level ' + (currentLevel + 1) + ' — ' + (recipeName || '?') +
    ' <span style="opacity:0.6;font-size:12px">Drop: -' + dropCost + '⚡</span>';
  el.style.opacity = '1';
  el.style.transform = 'translateX(-50%) translateY(0)';
  setTimeout(function() {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(-20px)';
  }, 2200);
}

/* Called by molecules.js after any molecule is formed */
function onMoleculeFormed(recipe, molCenter) {
  var w = WORLDS_DATA[worldIdx];
  if (!w || !w.molecules) return;
  if (currentLevel >= w.molecules.length) return; // already complete
  var targetId = w.molecules[currentLevel];
  if (recipe.id !== targetId) return; // not the target molecule

  currentLevel++;
  var rName = recipe.name || recipe.id;
  playMoleculeSound();
  showLevelUpToast(rName);
  setTimeout(playLevelUpSound, 400); // arpeggio after molecule sweep

  // Spawn special atom: recipe's highest ingredient tier + 1 (not random high tier)
  var recipeMaxTier = 0;
  if (recipe && recipe.inputs) {
    for (var ri = 0; ri < recipe.inputs.length; ri++) {
      for (var ti = 0; ti < ELEMENT_DB.length; ti++) {
        if (ELEMENT_DB[ti].Z === recipe.inputs[ri].Z && ti > recipeMaxTier) recipeMaxTier = ti;
      }
    }
  }
  var specialTier = Math.min(recipeMaxTier + 1, ELEMENT_DB.length - 1);
  var spX = molCenter ? molCenter.x : (Math.random() - 0.5) * (CONTAINER.w - 2);
  var spY = molCenter ? molCenter.y : CONTAINER.h * 0.6;
  var sa = spawnAtom(specialTier, spX, spY, 0, true);
  if (sa) {
    // Give the special atom a glowing aura
    try {
      sa.mesh.material.emissiveColor = sa.mesh.material.emissiveColor.scale(3);
      setTimeout(function() {
        try { sa.mesh.material.emissiveColor = sa.mesh.material.emissiveColor.scale(0.33); } catch(e){}
      }, 1500);
    } catch(e){}
  }

  // World complete: crafted all 6 recipes
  if (currentLevel >= w.molecules.length) {
    setTimeout(function() { showWorldComplete(); }, 800);
  }

  saveGame();
  updateHUD();
}

function showWorldComplete() {
  canDrop = false;
  var popup = document.getElementById('world-complete');
  if (!popup) return;
  var wName = WORLDS_DATA[worldIdx] ? WORLDS_DATA[worldIdx].label : 'World ' + (worldIdx + 1);
  document.getElementById('wc-title').textContent = wName + ' Complete!';
  document.getElementById('wc-score').textContent = 'Score: ' + score;
  var nextIdx = worldIdx + 1;
  var btn = document.getElementById('wc-continue');
  if (nextIdx >= WORLDS_DATA.length) {
    btn.textContent = '🏆 All Worlds Complete!';
    btn.onclick = function() { popup.style.display = 'none'; canDrop = true; };
  } else {
    var nextName = WORLDS_DATA[nextIdx] ? WORLDS_DATA[nextIdx].label : 'World ' + (nextIdx + 1);
    btn.textContent = 'Continue → ' + nextName;
    btn.onclick = function() { continueToNextWorld(); };
  }
  popup.style.display = 'flex';
}

function continueToNextWorld() {
  var popup = document.getElementById('world-complete');
  if (popup) popup.style.display = 'none';
  var nextIdx = worldIdx + 1;
  if (nextIdx >= WORLDS_DATA.length) return;

  // Keep score and best, reset everything else
  applyWorld(nextIdx);
  applyWorldTheme();
  texCache = {};
  matCache = {};

  // Clear board
  disposeAllStormLines();
  for (var i = atoms.length - 1; i >= 0; i--) removeAtom(atoms[i]);
  atoms = [];
  if (ghostMesh) { ghostMesh.dispose(); ghostMesh = null; }

  currentLevel = 0;
  energy      = 0;
  gameIsOver  = false;
  canDrop     = true;
  dangerStart = 0;
  merging     = false;
  moleculeCooldowns = {};
  reservedAtoms = {};
  comboIndex = 0;
  globalMolCooldownEnd = 0;

  try { scene.getPhysicsEngine().setGravity(vec3(0, -PHYSICS_PRESET.gravity, 0)); } catch(e){}

  initQueue();
  if (typeof createPickPlane === 'function') createPickPlane();
  updateGhost();
  updateQueuePreview();
  buildLegend();
  populateWorldSelector();
  syncPhysicsUI();
  saveGame();
  updateHUD();
}

/* ── Wake Nearby ─────────────────────────────────────────────── */
function wakeNearby(x, y, radius) {
  for (var i = 0; i < atoms.length; i++) {
    var at = atoms[i];
    if (at.merging) continue;
    try {
      var dx = at.mesh.position.x - x;
      var dy = at.mesh.position.y - y;
      if (dx * dx + dy * dy < radius * radius) {
        var body = at.mesh.physicsImpostor && at.mesh.physicsImpostor.physicsBody;
        if (body && body.sleepState !== 0) body.wakeUp();
      }
    } catch(e) {}
  }
}

/* ── Merge Detection ────────────────────────────────────────── */
function checkMerges() {
  if (gameIsOver) return;
  var pairs = [];

  for (var i = 0; i < atoms.length; i++) {
    var a = atoms[i];
    if (a.merging || a.fresh || isAtomReserved(a)) continue;
    for (var j = i + 1; j < atoms.length; j++) {
      var b = atoms[j];
      if (b.merging || b.fresh || isAtomReserved(b)) continue;
      if (a.tier !== b.tier) continue;
      if (a.tier >= ELEMENT_DB.length - 1) continue;

      var d = BABYLON.Vector3.Distance(
        a.mesh.getAbsolutePosition(),
        b.mesh.getAbsolutePosition());
      if (d <= (a.r + b.r) * 1.15) {
        pairs.push([a, b]);
      }
    }
  }
  // Process all merge pairs — mark both atoms immediately
  for (var k = 0; k < pairs.length; k++) {
    var p = pairs[k];
    if (p[0].merging || p[1].merging) continue; // already claimed
    doMerge(p[0], p[1]);
  }
}

/* ── Sound System ─────────────────────────────────────────── */
var audioCtx = null;
var sfxMuted = localStorage.getItem('sfxMuted') === '1';

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function toggleSfx() {
  sfxMuted = !sfxMuted;
  localStorage.setItem('sfxMuted', sfxMuted ? '1' : '0');
  var btn = document.getElementById('sfx-toggle');
  if (btn) btn.textContent = sfxMuted ? '🔇' : '🔊';
}

/* Merge pop — musical note based on tier, satisfying bubble pop */
function playMergeSound(tier) {
  if (sfxMuted) return;
  try {
    var ctx = ensureAudio(), now = ctx.currentTime;
    // Pentatonic scale notes — each tier plays a pleasant note
    var notes = [523,587,659,784,880,988,1047,1175,1319,1397,1568,1760,1976,2093,2349,2637,2794,3136];
    var freq = notes[Math.min(tier, notes.length - 1)] || 523;

    // Main bubble pop — sine with quick pitch drop
    var o1 = ctx.createOscillator(); o1.type = 'sine';
    o1.frequency.setValueAtTime(freq * 1.3, now);
    o1.frequency.exponentialRampToValueAtTime(freq * 0.7, now + 0.08);
    var g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.12, now);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    o1.connect(g1).connect(ctx.destination);
    o1.start(now); o1.stop(now + 0.15);

    // Shimmery harmonic
    var o2 = ctx.createOscillator(); o2.type = 'sine';
    o2.frequency.setValueAtTime(freq * 2, now + 0.02);
    o2.frequency.exponentialRampToValueAtTime(freq * 1.5, now + 0.1);
    var g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.04, now + 0.02);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    o2.connect(g2).connect(ctx.destination);
    o2.start(now + 0.02); o2.stop(now + 0.1);
  } catch(e){}
}

/* Drop — soft thud */
function playDropSound() {
  if (sfxMuted) return;
  try {
    var ctx = ensureAudio(), now = ctx.currentTime;
    var o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(180, now);
    o.frequency.exponentialRampToValueAtTime(60, now + 0.08);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.10, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    o.connect(g).connect(ctx.destination);
    o.start(now); o.stop(now + 0.1);
  } catch(e){}
}

/* Combo — ascending chime */
function playComboSound(comboN) {
  if (sfxMuted) return;
  try {
    var ctx = ensureAudio(), now = ctx.currentTime;
    var base = 660 + comboN * 110; // higher pitch for bigger combos
    var o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(base, now);
    o.frequency.exponentialRampToValueAtTime(base * 1.5, now + 0.15);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    o.connect(g).connect(ctx.destination);
    o.start(now); o.stop(now + 0.2);
  } catch(e){}
}

/* Level up — triumphant 3-note arpeggio */
function playLevelUpSound() {
  if (sfxMuted) return;
  try {
    var ctx = ensureAudio(), now = ctx.currentTime;
    var chord = [523, 659, 784]; // C E G major
    for (var i = 0; i < 3; i++) {
      var o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(chord[i], now + i * 0.1);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, now + i * 0.1);
      g.gain.linearRampToValueAtTime(0.10, now + i * 0.1 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(now + i * 0.1); o.stop(now + i * 0.1 + 0.35);
    }
  } catch(e){}
}

/* Molecule formed — sparkly sweep */
function playMoleculeSound() {
  if (sfxMuted) return;
  try {
    var ctx = ensureAudio(), now = ctx.currentTime;
    var o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(400, now);
    o.frequency.exponentialRampToValueAtTime(1600, now + 0.3);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.08, now);
    g.gain.linearRampToValueAtTime(0.12, now + 0.15);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    o.connect(g).connect(ctx.destination);
    o.start(now); o.stop(now + 0.4);
    // Shimmer
    var o2 = ctx.createOscillator(); o2.type = 'triangle';
    o2.frequency.setValueAtTime(800, now + 0.05);
    o2.frequency.exponentialRampToValueAtTime(2400, now + 0.3);
    var g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.04, now + 0.05);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    o2.connect(g2).connect(ctx.destination);
    o2.start(now + 0.05); o2.stop(now + 0.35);
  } catch(e){}
}

/* Game over — descending sad tone */
function playGameOverSound() {
  if (sfxMuted) return;
  try {
    var ctx = ensureAudio(), now = ctx.currentTime;
    var notes = [440, 392, 330]; // A G E descending
    for (var i = 0; i < 3; i++) {
      var o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(notes[i], now + i * 0.2);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, now + i * 0.2);
      g.gain.linearRampToValueAtTime(0.10, now + i * 0.2 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.2 + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(now + i * 0.2); o.stop(now + i * 0.2 + 0.5);
    }
  } catch(e){}
}

/* ── Arcade Floating Text VFX ──────────────────────────────── */
function floatText(worldPos, elemName, points, color, tier) {
  var el = document.createElement('div');
  var c = color || '#FFD700';
  el.style.cssText = 'position:fixed;pointer-events:none;z-index:999;font-family:"Orbitron",sans-serif;text-align:center;white-space:nowrap;';
  var screenPos = BABYLON.Vector3.Project(worldPos,
    BABYLON.Matrix.Identity(),
    scene.getTransformMatrix(),
    camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()));
  el.style.left = screenPos.x + 'px';
  el.style.top = screenPos.y + 'px';
  el.style.transform = 'translate(-50%,-50%)';
  // Element name — big, glowing, atom-colored
  el.innerHTML = '<div style="font-size:22px;font-weight:900;color:' + c +
    ';text-shadow:0 0 12px ' + c + ',0 0 24px ' + c + ',0 2px 4px rgba(0,0,0,0.9);' +
    'letter-spacing:2px;text-transform:uppercase">' + elemName + '</div>' +
    '<div style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.7);' +
    'text-shadow:0 0 6px ' + c + ',0 1px 2px rgba(0,0,0,0.8);margin-top:1px">+' + points + '</div>';
  document.body.appendChild(el);
  var startY = screenPos.y;
  var startT = performance.now();
  var dur = 1000;
  function tick() {
    var p = (performance.now() - startT) / dur;
    if (p >= 1) { el.remove(); return; }
    // Float up with slight deceleration
    el.style.top = (startY - p * 80) + 'px';
    // Scale: pop in then settle
    var s = p < 0.1 ? (1 + p * 5) : (1.5 - p * 0.5);
    el.style.opacity = (1 - p * p * p).toString();
    el.style.transform = 'translate(-50%,-50%) scale(' + s + ')';
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function doMerge(a, b) {
  a.merging = true;
  b.merging = true;

  var mid = BABYLON.Vector3.Lerp(
    a.mesh.getAbsolutePosition(),
    b.mesh.getAbsolutePosition(), 0.5);
  var newTier = a.tier + 1;
  var pts     = calcMergeScore(a.tier);

  // Remove physics from merging atoms IMMEDIATELY — prevents kicking neighbors
  try { a.mesh.physicsImpostor.dispose(); } catch(e){}
  try { b.mesh.physicsImpostor.dispose(); } catch(e){}

  // VFX: shrink both (visual only, no physics bodies left)
  shrink(a.mesh);
  shrink(b.mesh);

  // No full-screen glow flash — only local particle/ring VFX

  // VFX: particle burst + ring shockwave
  var newElem = ELEMENT_DB[newTier] || ELEMENT_DB[a.tier];
  emitMergeBurst(mid, newElem.col, newElem.r);
  emitMergeRing(mid, newElem.col, newElem.r);

  setTimeout(function () {
    try {
      removeAtom(a);
      removeAtom(b);

      // Clamp spawn position so large atoms don't overlap walls
      var nr = (ELEMENT_DB[newTier] || {}).r || 1;
      var halfW = CONTAINER.w / 2;
      var wallThick = 0.25;
      var xMin = -(halfW - wallThick - nr);
      var xMax = (halfW - wallThick - nr);
      var yMin = -(CONTAINER.h / 2) + wallThick + nr;  // above floor
      var cx = Math.max(xMin, Math.min(xMax, mid.x));
      var cy = Math.max(yMin, mid.y);
      var na = spawnAtom(newTier, cx, cy, 0, true);
      if (na) {
        try {
          var body = na.mesh.physicsImpostor.physicsBody;
          body.wakeUp();
          body.velocity.set(0, 0, 0); // spawn still, let gravity do the work
          body.position.z = 0;
          na.mesh.position.z = 0;
        } catch(e){}
      }

      score  += pts;
      /* Arcade floating text + merge sound */
      var mergedElem = ELEMENT_DB[newTier] || newElem;
      var comboTxt = comboIndex > 0 ? ' x' + (comboIndex + 1) : '';
      floatText(mid, mergedElem.name, pts + comboTxt, newElem.col, newTier);
      playMergeSound(newTier);
      if (comboIndex > 0) playComboSound(comboIndex);
      /* Energy gain: design formula with combo bonus */
      var tierGain = calcEnergyGain(newTier);
      energy = Math.min(ENERGY_RULESET.maxEnergy || 100, energy + tierGain);
      comboIndex++;
      if (comboResetTimer) clearTimeout(comboResetTimer);
      comboResetTimer = setTimeout(function() { comboIndex = 0; }, 3000);
      sessionStats.merges++;
      if (newTier > sessionStats.highestTier) sessionStats.highestTier = newTier;
      sessionStats.totalEnergy += tierGain;

      if (score > bestScore) {
        bestScore = score;
        try { localStorage.setItem('atomMerge_best', bestScore); } catch(e){}
      }
      saveGame();
      updateHUD();
    } catch(e) { console.error('Merge error:', e); }
  }, GAME_RULES.mergeAnimMs);
}

function shrink(mesh) {
  var s = mesh.scaling.clone();
  var anim = new BABYLON.Animation('sh', 'scaling', 60,
    BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
    BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
  anim.setKeys([
    { frame:0,  value: s.clone() },
    { frame:3,  value: vec3(s.x*1.4, s.y*1.4, s.z*1.4) },
    { frame:8,  value: vec3(0.01, 0.01, 0.01) },
  ]);
  mesh.animations = [anim];
  scene.beginAnimation(mesh, 0, 8, false);
}

/* ── Merge Particle Burst VFX ─────────────────────────────────── */
var mergeParticleTex = null;

function getMergeParticleTexture() {
  if (mergeParticleTex) return mergeParticleTex;
  // Procedural circle-glow texture
  var sz = 64;
  var dt = new BABYLON.DynamicTexture('mergePTex', sz, scene, false);
  var ctx = dt.getContext();
  var grad = ctx.createRadialGradient(sz/2, sz/2, 0, sz/2, sz/2, sz/2);
  grad.addColorStop(0,   'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.7)');
  grad.addColorStop(0.7, 'rgba(255,200,100,0.3)');
  grad.addColorStop(1,   'rgba(255,100,50,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, sz, sz);
  dt.update();
  mergeParticleTex = dt;
  return dt;
}

function emitMergeBurst(position, color, radius) {
  var ps = new BABYLON.ParticleSystem('mergeBurst', 60, scene);
  ps.particleTexture = getMergeParticleTexture();

  // Emit from merge point
  ps.emitter = position.clone();
  ps.minEmitBox = vec3(-0.1, -0.1, -0.1);
  ps.maxEmitBox = vec3( 0.1,  0.1,  0.1);

  // Burst outward in all directions
  ps.createSphereEmitter(radius * 0.5);

  // Element color → particle colors with glow
  var c = hex3(color);
  ps.color1 = new BABYLON.Color4(c.r, c.g, c.b, 1.0);
  ps.color2 = new BABYLON.Color4(
    Math.min(1, c.r + 0.3),
    Math.min(1, c.g + 0.3),
    Math.min(1, c.b + 0.3), 0.9);
  ps.colorDead = new BABYLON.Color4(c.r * 0.5, c.g * 0.5, c.b * 0.5, 0);

  // Sizes — start big, shrink to nothing
  ps.minSize = radius * 0.15;
  ps.maxSize = radius * 0.45;

  // Lifetime & speed
  ps.minLifeTime = 0.15;
  ps.maxLifeTime = 0.45;
  ps.minEmitPower = 3;
  ps.maxEmitPower = 7;
  ps.updateSpeed = 0.015;

  // Gravity pulls particles down slightly
  ps.gravity = vec3(0, -4, 0);

  // Additive blending for glow effect
  ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;

  // Emit 50 particles in one burst then stop
  ps.emitRate = 200;
  ps.manualEmitCount = 50;
  ps.targetStopDuration = 0.08;
  ps.disposeOnStop = true;

  ps.start();
  return ps;
}

/* ── Ring shockwave VFX ─────────────────────────────────────── */
function emitMergeRing(position, color, radius) {
  var ring = BABYLON.MeshBuilder.CreateTorus('ring', {
    diameter: radius * 0.3,
    thickness: 0.06,
    tessellation: 24
  }, scene);
  ring.position = position.clone();
  ring.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;

  var mat = new BABYLON.StandardMaterial('ringM', scene);
  var c = hex3(color);
  mat.emissiveColor = c;
  mat.diffuseColor  = c;
  mat.alpha = 0.9;
  mat.disableLighting = true;
  ring.material = mat;

  // Animate: expand + fade out
  var frames = 15;
  var scaleAnim = new BABYLON.Animation('ringScale', 'scaling', 60,
    BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
    BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
  scaleAnim.setKeys([
    { frame: 0,      value: vec3(1, 1, 1) },
    { frame: frames, value: vec3(5, 5, 5) },
  ]);

  var alphaAnim = new BABYLON.Animation('ringAlpha', 'material.alpha', 60,
    BABYLON.Animation.ANIMATIONTYPE_FLOAT,
    BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
  alphaAnim.setKeys([
    { frame: 0,      value: 0.9 },
    { frame: frames, value: 0.0 },
  ]);

  ring.animations = [scaleAnim, alphaAnim];
  scene.beginAnimation(ring, 0, frames, false, 1.0, function () {
    ring.dispose();
  });
}

/* ── Lorenz Spark Storm — Oriented Particle Dots with Oscillation ── */
var stormPairs = {};          // key: "idA_idB" → { dots[], birthTime }
var STORM_PROXIMITY = 1.6;   // trigger when dist < sumR * this
var STORM_DOT_COUNT = 35;    // particle dots per pair
var STORM_DT = 0.007;        // Lorenz integrator timestep
var STORM_DOT_SIZE = 0.032;  // base dot radius (tiny)
var stormMatCache = {};
var stormTime = 0;            // global timer for oscillation

function lorenzStep(p, dt) {
  var sigma = 10, rho = 28, beta = 8/3;
  var dx = sigma * (p.y - p.x) * dt;
  var dy = (p.x * (rho - p.z) - p.y) * dt;
  var dz = (p.x * p.y - beta * p.z) * dt;
  return { x: p.x + dx, y: p.y + dy, z: p.z + dz };
}

// Map raw Lorenz → world space, ORIENTED along the axis between two ball centers.
// The butterfly x-axis aligns with the ball-to-ball direction,
// y-axis goes perpendicular (up-ish), z-axis is depth toward camera.
function lorenzToWorldOriented(lp, center, radius, axisDir, perpDir, depthDir) {
  var s = radius / 22;
  // Lorenz x → along axis between balls (butterfly wings span this)
  // Lorenz z-25 → perpendicular (up/down wing spread)
  // Lorenz y → depth (toward camera, flattened)
  var lx = lp.x * s;
  var ly = (lp.z - 25) * s;
  var lz = lp.y * s * 0.35;
  return new BABYLON.Vector3(
    center.x + axisDir.x * lx + perpDir.x * ly + depthDir.x * lz,
    center.y + axisDir.y * lx + perpDir.y * ly + depthDir.y * lz,
    center.z + axisDir.z * lx + perpDir.z * ly + depthDir.z * lz
  );
}

function createStormDot() {
  var lp = { x: 1 + Math.random()*6 - 3, y: 1 + Math.random()*6 - 3, z: 20 + Math.random()*10 };
  for (var w = 0; w < 200 + Math.floor(Math.random()*300); w++) lp = lorenzStep(lp, STORM_DT);
  // Each dot gets a random phase offset for oscillation
  return { lp: lp, mesh: null, phase: Math.random() * Math.PI * 2 };
}

function getStormDotMat(color) {
  var c = hex3(color);
  var m = new BABYLON.StandardMaterial('stormDot_' + color, scene);
  m.diffuseColor  = new BABYLON.Color3(Math.min(1, c.r+0.5), Math.min(1, c.g+0.5), Math.min(1, c.b+0.5));
  m.emissiveColor = new BABYLON.Color3(Math.min(1, c.r+0.3), Math.min(1, c.g+0.3), Math.min(1, c.b+0.3));
  m.specularColor = BABYLON.Color3.Black();
  m.disableLighting = true;
  return m;
}

function updateStormLines() {
  stormTime += 0.016; // ~60fps tick

  // Build active pairs of same-tier atoms in proximity
  var activePairs = {};
  for (var i = 0; i < atoms.length; i++) {
    var a = atoms[i];
    if (a.merging || a.fresh) continue;
    for (var j = i + 1; j < atoms.length; j++) {
      var b = atoms[j];
      if (b.merging || b.fresh) continue;
      if (a.tier !== b.tier) continue;

      var posA = a.mesh.getAbsolutePosition();
      var posB = b.mesh.getAbsolutePosition();
      var dist = BABYLON.Vector3.Distance(posA, posB);
      var sumR = a.r + b.r;
      var threshold = sumR * STORM_PROXIMITY;

      if (dist < threshold && dist > sumR * 1.02) {
        var key = a.id < b.id ? a.id + '_' + b.id : b.id + '_' + a.id;
        var mid = BABYLON.Vector3.Lerp(posA, posB, 0.5);
        var effR = Math.max(dist * 1.0, sumR * 1.4);
        var closeness = 1 - (dist - sumR * 1.02) / (threshold - sumR * 1.02);
        closeness = Math.max(0, Math.min(1, closeness));

        // Calculate orientation basis: axis between balls, perpendicular, depth
        var axis = posB.subtract(posA);
        if (axis.length() < 0.001) axis = new BABYLON.Vector3(1, 0, 0);
        axis.normalize();
        // Perpendicular: cross with camera forward (0,0,-1) or up (0,1,0)
        var camFwd = new BABYLON.Vector3(0, 0, -1);
        var perp = BABYLON.Vector3.Cross(axis, camFwd);
        if (perp.length() < 0.001) perp = BABYLON.Vector3.Cross(axis, new BABYLON.Vector3(0, 1, 0));
        perp.normalize();
        var depth = BABYLON.Vector3.Cross(axis, perp);
        depth.normalize();

        activePairs[key] = {
          mid: mid, radius: effR, color: ELEMENT_DB[a.tier].col,
          closeness: closeness, sumR: sumR,
          axisDir: axis, perpDir: perp, depthDir: depth
        };
      }
    }
  }

  // Spawn dots for new pairs
  for (var key in activePairs) {
    if (!stormPairs[key]) {
      var dots = [];
      for (var k = 0; k < STORM_DOT_COUNT; k++) {
        dots.push(createStormDot());
      }
      stormPairs[key] = { dots: dots, birthTime: stormTime };
    }
  }

  // Update existing, remove stale
  for (var key in stormPairs) {
    if (!activePairs[key]) {
      var ds = stormPairs[key].dots;
      for (var k = 0; k < ds.length; k++) { if (ds[k].mesh) try { ds[k].mesh.dispose(); } catch(e){} }
      delete stormPairs[key];
      continue;
    }

    var info = activePairs[key];
    var ds   = stormPairs[key].dots;
    var baseAlpha = 0.4 + info.closeness * 0.6;
    var dotScale = (STORM_DOT_SIZE + info.sumR * 0.015) * (0.6 + info.closeness * 0.4);

    if (!stormMatCache[info.color]) stormMatCache[info.color] = getStormDotMat(info.color);
    var mat = stormMatCache[info.color];

    // Global oscillation: a slow wave that makes most dots fade out then back
    // Period ~3.5s, duty cycle ~60% visible
    var globalWave = stormTime * 1.8; // speed of oscillation

    for (var k = 0; k < ds.length; k++) {
      var dot = ds[k];
      for (var st = 0; st < 4; st++) dot.lp = lorenzStep(dot.lp, STORM_DT);
      var wp = lorenzToWorldOriented(dot.lp, info.mid, info.radius,
        info.axisDir, info.perpDir, info.depthDir);

      // Per-dot oscillation: sine wave with unique phase offset
      // Creates a "breathing" effect where clusters of dots fade in/out at different times
      var wave = Math.sin(globalWave + dot.phase * 3.0 + k * 0.5);
      // Map sine [-1,1] to alpha multiplier [0,1] with bias toward visible
      var oscAlpha = Math.max(0, wave * 0.7 + 0.3); // ~0 to 1, mostly visible
      var finalAlpha = baseAlpha * oscAlpha;

      if (!dot.mesh) {
        dot.mesh = BABYLON.MeshBuilder.CreateSphere('sd', { diameter: 1, segments: 4 }, scene);
        dot.mesh.material = mat;
        dot.mesh.isPickable = false;
      }
      dot.mesh.position.copyFrom(wp);
      dot.mesh.scaling.setAll(dotScale * (0.5 + oscAlpha * 0.5)); // shrink as they fade
      dot.mesh.visibility = finalAlpha;
      dot.mesh.material = mat;
    }
  }
}

function disposeAllStormLines() {
  for (var key in stormPairs) {
    var ds = stormPairs[key].dots;
    for (var k = 0; k < ds.length; k++) { if (ds[k].mesh) try { ds[k].mesh.dispose(); } catch(e){} }
  }
  stormPairs = {};
  stormMatCache = {};
}

/* ── Game Over ──────────────────────────────────────────────── */
function checkGameOver() {
  if (gameIsOver) return;
  var danger = false;
  for (var i = 0; i < atoms.length; i++) {
    var at = atoms[i];
    if (at.merging || at.fresh) continue;
    var vel = at.mesh.physicsImpostor ? at.mesh.physicsImpostor.getLinearVelocity() : null;
    if (!vel) continue;
    if (at.mesh.position.y > GAME_RULES.dangerY && vel.length() < 0.9) {
      danger = true;
      break;
    }
  }
  if (danger) {
    if (!dangerStart) dangerStart = performance.now();
    if (performance.now() - dangerStart > GAME_RULES.dangerGrace) triggerGameOver();
  } else {
    dangerStart = 0;
  }
}

/* ── Arcade High Score System ─────────────────────────────────── */
// ── Supabase Global Leaderboard ──
var SUPA_URL = 'https://xuphharjjxepynnlhbcw.supabase.co';
var SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1cGhoYXJqanhlcHlubmxoYmN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMzEyOTYsImV4cCI6MjA5MjYwNzI5Nn0.KrDiMGMkqyqHlruy3iQUs4wQCcGkPT8Ej7tRIP_lkAw';
var MAX_SCORES = 10;
var _nameLetters = [0, 0, 0];
var _pendingScore = 0;
var _highlightIdx = -1;
var _cachedScores = [];

function _supaHeaders() {
  return { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
}

// Server status indicator
function checkServerStatus() {
  var el = document.getElementById('server-status');
  if (!el) return;
  if (!SUPA_URL) { el.textContent = '⬤'; el.style.color = '#666'; el.title = 'Score server disabled'; return; }
  fetch(SUPA_URL + '/rest/v1/scores?select=id&limit=1', { headers: _supaHeaders() }).then(function(r) {
    if (r.ok) { el.textContent = '⬤'; el.style.color = '#44ff88'; el.title = 'Leaderboard online (Supabase)'; }
    else { el.textContent = '⬤'; el.style.color = '#ff4444'; el.title = 'Leaderboard error (' + r.status + ')'; }
  }).catch(function() {
    el.textContent = '⬤'; el.style.color = '#ff4444'; el.title = 'Leaderboard offline';
  });
}

// Fetch top 10 scores from Supabase
function loadHighScores(cb) {
  if (!SUPA_URL) { _loadLocal(cb); return; }
  fetch(SUPA_URL + '/rest/v1/scores?select=name,score,world,created_at&order=score.desc&limit=' + MAX_SCORES, {
    headers: _supaHeaders()
  }).then(function(r) { return r.json(); }).then(function(rows) {
    _cachedScores = (rows || []).map(function(r) { return { name: r.name, score: r.score, world: r.world || '', date: r.created_at }; });
    try { localStorage.setItem('atomMerge_highScores', JSON.stringify(_cachedScores)); } catch(e) {}
    if (cb) cb(_cachedScores);
  }).catch(function() {
    _loadLocal(cb);
  });
}
function _loadLocal(cb) {
  try { var raw = localStorage.getItem('atomMerge_highScores'); if (raw) _cachedScores = JSON.parse(raw); } catch(e) {}
  if (cb) cb(_cachedScores);
}
function isHighScore(pts) {
  if (_cachedScores.length < MAX_SCORES) return true;
  return pts > _cachedScores[_cachedScores.length - 1].score;
}

function insertHighScore(name, pts, cb) {
  var w = WORLDS_DATA[worldIdx];
  var worldName = w ? w.name : '???';
  var body = { name: name, score: pts, world: worldName };

  if (!SUPA_URL) { _localInsert(body, cb); return; }

  // Insert into Supabase then re-fetch top 10
  fetch(SUPA_URL + '/rest/v1/scores', {
    method: 'POST',
    headers: _supaHeaders(),
    body: JSON.stringify(body)
  }).then(function(r) {
    if (!r.ok) throw new Error('insert failed');
    // Re-fetch leaderboard to get accurate ranking
    return fetch(SUPA_URL + '/rest/v1/scores?select=name,score,world,created_at&order=score.desc&limit=' + MAX_SCORES, {
      headers: _supaHeaders()
    });
  }).then(function(r) { return r.json(); }).then(function(rows) {
    _cachedScores = (rows || []).map(function(r) { return { name: r.name, score: r.score, world: r.world || '', date: r.created_at }; });
    try { localStorage.setItem('atomMerge_highScores', JSON.stringify(_cachedScores)); } catch(e) {}
    // Find rank of this score
    var rank = -1;
    for (var i = 0; i < _cachedScores.length; i++) {
      if (_cachedScores[i].name === name && _cachedScores[i].score === pts) { rank = i; break; }
    }
    if (cb) cb(rank);
  }).catch(function() {
    // Offline fallback
    _localInsert(body, cb);
  });
}

function _localInsert(body, cb) {
  var entry = { name: body.name, score: body.score, world: body.world, date: new Date().toISOString() };
  _cachedScores.push(entry);
  _cachedScores.sort(function(a, b) { return b.score - a.score; });
  _cachedScores = _cachedScores.slice(0, MAX_SCORES);
  try { localStorage.setItem('atomMerge_highScores', JSON.stringify(_cachedScores)); } catch(e) {}
  var rank = -1;
  for (var i = 0; i < _cachedScores.length; i++) { if (_cachedScores[i] === entry) { rank = i; break; } }
  if (cb) cb(rank);
}

function cycleNameLetter(idx) {
  _nameLetters[idx] = (_nameLetters[idx] + 1) % 26;
  document.getElementById('ne-l' + idx).textContent = String.fromCharCode(65 + _nameLetters[idx]);
  // Little click sound
  if (typeof playDropSound === 'function') playDropSound();
}

// Scroll wheel on letters
(function() {
  for (var i = 0; i < 3; i++) {
    (function(idx) {
      var el = document.getElementById('ne-l' + idx);
      if (!el) return;
      el.addEventListener('wheel', function(e) {
        e.preventDefault();
        var dir = e.deltaY > 0 ? 1 : -1;
        _nameLetters[idx] = (_nameLetters[idx] + dir + 26) % 26;
        el.textContent = String.fromCharCode(65 + _nameLetters[idx]);
      }, { passive: false });
    })(i);
  }
})();

function submitHighScore() {
  var name = '';
  for (var i = 0; i < 3; i++) name += String.fromCharCode(65 + _nameLetters[i]);
  // Hide name entry immediately — don't block on server
  document.getElementById('name-entry').style.display = 'none';
  document.getElementById('final-score').textContent = 'Score: ' + _pendingScore;
  document.getElementById('game-over').style.display = 'flex';
  if (typeof playLevelUpSound === 'function') playLevelUpSound();
  // Submit in background — show scoreboard when ready
  insertHighScore(name, _pendingScore, function(idx) {
    _highlightIdx = idx;
    openScoreboard();
  });
}

function openScoreboard() {
  var body = document.getElementById('sb-body');
  body.innerHTML = '<div class="sb-empty">LOADING...</div>';
  document.getElementById('scoreboard-overlay').style.display = 'flex';
  loadHighScores(function(scores) {
    if (!scores.length) {
      body.innerHTML = '<div class="sb-empty">NO SCORES YET — PLAY TO CLAIM #1!</div>';
    } else {
      var html = '<table class="sb-table">';
      for (var i = 0; i < scores.length; i++) {
        var s = scores[i];
        var hl = (i === _highlightIdx) ? ' class="sb-highlight"' : '';
        html += '<tr' + hl + '>';
        html += '<td class="sb-rank">' + (i + 1) + '.</td>';
        html += '<td class="sb-name">' + (s.name || '???') + '</td>';
        html += '<td class="sb-pts">' + s.score.toLocaleString() + '</td>';
        html += '<td class="sb-world">' + (s.world || '') + '</td>';
        html += '</tr>';
      }
      html += '</table>';
      body.innerHTML = html;
    }
    _highlightIdx = -1;
  });
}

function closeScoreboard(e) {
  if (e && e.target !== document.getElementById('scoreboard-overlay')) return;
  document.getElementById('scoreboard-overlay').style.display = 'none';
}

function triggerGameOver() {
  gameIsOver = true;
  playGameOverSound();
  try { localStorage.removeItem('atomMerge_save'); } catch(e){}
  disposeAllStormLines();

  // Check for high score — show name entry or regular game over
  if (score > 0 && isHighScore(score)) {
    _pendingScore = score;
    _nameLetters = [0, 0, 0];
    for (var i = 0; i < 3; i++) document.getElementById('ne-l' + i).textContent = 'A';
    document.getElementById('ne-score-val').textContent = score.toLocaleString();
    document.getElementById('name-entry').style.display = 'flex';
  } else {
    document.getElementById('final-score').textContent = 'Score: ' + score;
    document.getElementById('game-over').style.display = 'flex';
  }
}

function restartGame() {
  document.getElementById('game-over').style.display = 'none';
  try { localStorage.removeItem('atomMerge_save'); } catch(e){}
  disposeAllStormLines();
  for (var i = atoms.length - 1; i >= 0; i--) removeAtom(atoms[i]);
  atoms = [];
  if (ghostMesh) { ghostMesh.dispose(); ghostMesh = null; }

  initQueue();
  score        = 0;
  energy       = 0;
  currentLevel = 0;
  gameIsOver   = false;
  canDrop      = true;
  dangerStart  = 0;
  merging      = false;
  moleculeCooldowns = {};
  reservedAtoms = {};
  comboIndex = 0;
  globalMolCooldownEnd = 0;
  sessionStats = { merges: 0, molecules: 0, highestTier: 0, totalEnergy: 0, dropsCount: 0 };

  try { scene.getPhysicsEngine().setGravity(vec3(0, -PHYSICS_PRESET.gravity, 0)); } catch(e){}
  if (typeof createPickPlane === 'function') createPickPlane();
  updateGhost();
  updateQueuePreview();
  updateHUD();
}

/* ── Input ──────────────────────────────────────────────────── */
var pickPlane = null;
var inputCanvas = null;

function createPickPlane() {
  // Large invisible plane at z=0, covering the full game area
  if (pickPlane) pickPlane.dispose();
  pickPlane = BABYLON.MeshBuilder.CreatePlane('pickPlane', { width: 30, height: 30 }, scene);
  pickPlane.position.set(0, 7, 0);
  pickPlane.isVisible = false;
  pickPlane.isPickable = true;
}

function mapXFromPointer() {
  if (!pickPlane) return ghostX;
  // scene.pointerX/Y are managed by Babylon — always DPR-correct
  var pick = scene.pick(
    scene.pointerX,
    scene.pointerY,
    function (mesh) { return mesh === pickPlane; }
  );
  if (pick && pick.hit && pick.pickedPoint) {
    var maxX = CONTAINER.w / 2 - 0.5;
    return Math.max(-maxX, Math.min(maxX, pick.pickedPoint.x));
  }
  return ghostX;
}

function setupInput(cvs) {
  inputCanvas = cvs;
  createPickPlane();

  inputCanvas.addEventListener('pointermove', function (e) {
    if (gameIsOver) return;
    ghostX = mapXFromPointer();
    if (ghostMesh) ghostMesh.position.x = ghostX;
  });
  inputCanvas.addEventListener('click', function (e) {
    if (gameIsOver) return;
    dropAtom(mapXFromPointer());
  });
  inputCanvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    if (gameIsOver) return;
    ghostX = mapXFromPointer();
    if (ghostMesh) ghostMesh.position.x = ghostX;
  }, { passive: false });
  inputCanvas.addEventListener('touchend', function (e) {
    e.preventDefault();
    if (gameIsOver) return;
    dropAtom(mapXFromPointer());
  }, { passive: false });
}

/* ── HUD ────────────────────────────────────────────────────── */
function updateHUD() {
  document.getElementById('score-val').textContent = score;
  document.getElementById('best-val').textContent  = bestScore;
  var sb = document.getElementById('sfx-toggle');
  if (sb) sb.textContent = sfxMuted ? '🔇' : '🔊';
  var maxE = ENERGY_RULESET.maxEnergy || 100;
  document.getElementById('energy-fill').style.width = Math.round(energy / maxE * 100) + '%';
  var ev = document.getElementById('energy-val');
  if (ev) ev.textContent = Math.round(energy) + '/' + maxE;
  var cd = document.getElementById('combo-display');
  if (cd) {
    if (comboIndex > 0) {
      cd.textContent = 'x' + comboIndex;
      cd.style.opacity = '1';
    } else {
      cd.style.opacity = '0';
    }
  }
  document.getElementById('atom-count').textContent = 'atoms: ' + atoms.length;
  var wl = document.getElementById('hud-world');
  if (wl && WORLDS_DATA[worldIdx]) {
    var targetId = getTargetRecipeId();
    var targetLabel = '';
    var targetRecipe = null;
    if (targetId) {
      for (var mi = 0; mi < MOLECULES_DATA.length; mi++) {
        if (MOLECULES_DATA[mi].id === targetId) {
          targetRecipe = MOLECULES_DATA[mi];
          targetLabel = targetRecipe.name || targetRecipe.inputs.map(function(x){return x.sym;}).join('+');
          break;
        }
      }
    }
    wl.innerHTML = '\u{1F30D} ' + WORLDS_DATA[worldIdx].label + '  Lv.' + (currentLevel + 1) +
      (targetLabel ? ' <span class="target-mol" onclick="showMoleculeInfo(event)">\u{1F3AF}' + targetLabel + '</span>' : ' \u2713');
  }
  var dc = document.getElementById('drop-cost');
  if (dc) dc.textContent = '-' + getDropCost() + '⚡';
}

function showMoleculeInfo(e) {
  if (e) e.stopPropagation();
  var popup = document.getElementById('mol-info-popup');
  if (!popup) return;

  var targetId = getTargetRecipeId();
  if (!targetId) { popup.style.display = 'none'; return; }

  var recipe = null;
  for (var i = 0; i < MOLECULES_DATA.length; i++) {
    if (MOLECULES_DATA[i].id === targetId) { recipe = MOLECULES_DATA[i]; break; }
  }
  if (!recipe) { popup.style.display = 'none'; return; }

  // Build atom balls HTML
  var atomsHtml = '';
  var atomNames = [];
  for (var j = 0; j < recipe.inputs.length; j++) {
    var inp = recipe.inputs[j];
    var col = '#888';
    var eName = inp.sym;
    for (var k = 0; k < ELEMENT_DB.length; k++) {
      if (ELEMENT_DB[k].Z === inp.Z) { col = ELEMENT_DB[k].col; eName = ELEMENT_DB[k].name; break; }
    }
    atomNames.push(eName);
    atomsHtml += '<div class="mol-atom-ball" style="background:' + col + ';box-shadow:0 0 12px ' + col + '66">' +
      '<span class="mol-atom-sym">' + inp.sym + '</span>' +
      '</div>';
    if (j < recipe.inputs.length - 1) {
      atomsHtml += '<span class="mol-plus">+</span>';
    }
  }

  // Difficulty badge
  var diffColors = { easy: '#44dd88', medium: '#ffaa33', hard: '#ff4466' };
  var diffLabels = { easy: 'EASY', medium: 'MEDIUM', hard: 'HARD' };
  var diff = recipe.difficulty || 'easy';

  // Build hint text
  var hint = 'Merge small atoms up to get ' + atomNames.join(' & ') + ', then bring them together!';

  popup.innerHTML =
    '<div class="mol-popup-card" onclick="event.stopPropagation()">' +
      '<div class="mol-popup-header">' +
        '<span class="mol-popup-name">' + (recipe.name || recipe.id) + '</span>' +
        '<span class="mol-popup-diff" style="background:' + (diffColors[diff] || '#888') + '">' + (diffLabels[diff] || diff.toUpperCase()) + '</span>' +
      '</div>' +
      '<div class="mol-popup-atoms">' + atomsHtml + '</div>' +
      '<div class="mol-popup-hint">' + hint + '</div>' +
      '<div class="mol-popup-stats">' +
        '<div class="mol-stat"><span class="mol-stat-icon">⚡</span><span class="mol-stat-val">' + (recipe.cost || 0) + '</span><span class="mol-stat-label">Energy</span></div>' +
        '<div class="mol-stat"><span class="mol-stat-icon">⭐</span><span class="mol-stat-val">' + (recipe.points || 0) + '</span><span class="mol-stat-label">Points</span></div>' +
      '</div>' +
    '</div>';

  popup.style.display = 'flex';
}

function closeMoleculeInfo() {
  var popup = document.getElementById('mol-info-popup');
  if (popup) popup.style.display = 'none';
}

// Delegated click listener for target-mol (backup for inline onclick)
document.addEventListener('click', function(e) {
  var t = e.target.closest('.target-mol');
  if (t) { showMoleculeInfo(e); return; }
}, true);
document.addEventListener('touchend', function(e) {
  var t = e.target.closest('.target-mol');
  if (t) { e.preventDefault(); showMoleculeInfo(e); return; }
}, true);

function populateWorldSelector() {
  var sel = document.getElementById('cfg-world');
  if (!sel || !WORLDS_DATA.length) return;
  sel.innerHTML = '';
  for (var i = 0; i < WORLDS_DATA.length; i++) {
    var opt = document.createElement('option');
    opt.value = i;
    opt.textContent = WORLDS_DATA[i].label;
    if (i === worldIdx) opt.selected = true;
    sel.appendChild(opt);
  }
}

function syncPhysicsUI() {
  var g = document.getElementById('cfg-gravity');
  if (g) { g.value = PHYSICS_PRESET.gravity; document.getElementById('v-gravity').textContent = PHYSICS_PRESET.gravity.toFixed(1); }
  var r = document.getElementById('cfg-restitution');
  if (r) { r.value = PHYSICS_PRESET.restitution; document.getElementById('v-restitution').textContent = PHYSICS_PRESET.restitution.toFixed(2); }
  var f = document.getElementById('cfg-friction');
  if (f) { f.value = PHYSICS_PRESET.friction; document.getElementById('v-friction').textContent = PHYSICS_PRESET.friction.toFixed(2); }
}

function buildLegend() {
  var el = document.getElementById('legend');
  var html = '';
  for (var i = 0; i < ELEMENT_DB.length; i++) {
    var e = ELEMENT_DB[i];
    html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">'
      + '<div style="width:10px;height:10px;border-radius:50%;background:'+e.col+';flex-shrink:0"></div>'
      + '<span style="opacity:0.55;font-size:10px">'+e.Z+' '+e.sym+' (r='+e.r+')</span></div>';
  }
  el.innerHTML = html;
}

/* ── Config Panel Handlers ──────────────────────────────────── */
function updatePhysicsFromUI() {
  PHYSICS_PRESET.gravity     = parseFloat(document.getElementById('cfg-gravity').value);
  PHYSICS_PRESET.restitution = parseFloat(document.getElementById('cfg-restitution').value);
  PHYSICS_PRESET.friction    = parseFloat(document.getElementById('cfg-friction').value);

  document.getElementById('v-gravity').textContent     = PHYSICS_PRESET.gravity.toFixed(1);
  document.getElementById('v-restitution').textContent  = PHYSICS_PRESET.restitution.toFixed(2);
  document.getElementById('v-friction').textContent     = PHYSICS_PRESET.friction.toFixed(2);

  try {
    scene.getPhysicsEngine().setGravity(vec3(0, -PHYSICS_PRESET.gravity, 0));
  } catch(e){}
}

/* ── World theme (dynamic background) ─────────────────────────
   Sets body background gradient + ambient blob colors based on
   the current world's theme (bgColor / accentColor). ── */
/* applyWorld lives in config.js — DO NOT redefine here.
   Call applyWorldTheme() after applyWorld() where needed. */

function hexToHsl(hex) {
  var r = parseInt(hex.slice(1,3),16)/255;
  var g = parseInt(hex.slice(3,5),16)/255;
  var b = parseInt(hex.slice(5,7),16)/255;
  var max = Math.max(r,g,b), min = Math.min(r,g,b);
  var h, s, l = (max+min)/2;
  if (max === min) { h = s = 0; }
  else {
    var d = max - min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch(max) {
      case r: h = (g-b)/d + (g<b?6:0); break;
      case g: h = (b-r)/d + 2; break;
      default: h = (r-g)/d + 4; break;
    }
    h /= 6;
  }
  return [h*360, s*100, l*100];
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100; l /= 100;
  var c = (1 - Math.abs(2*l - 1)) * s;
  var x = c * (1 - Math.abs((h/60) % 2 - 1));
  var m = l - c/2;
  var r,g,b;
  if (h < 60)       { r=c; g=x; b=0; }
  else if (h < 120) { r=x; g=c; b=0; }
  else if (h < 180) { r=0; g=c; b=x; }
  else if (h < 240) { r=0; g=x; b=c; }
  else if (h < 300) { r=x; g=0; b=c; }
  else              { r=c; g=0; b=x; }
  var toHex = function(v) {
    var n = Math.round((v+m)*255);
    n = Math.max(0, Math.min(255, n));
    var s2 = n.toString(16);
    return s2.length === 1 ? '0'+s2 : s2;
  };
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

function rotateHue(hex, degrees) {
  var hsl = hexToHsl(hex);
  return hslToHex(hsl[0] + degrees, hsl[1], hsl[2]);
}

function mixWithWhite(hex, amount) {
  var hsl = hexToHsl(hex);
  var l = hsl[2] + (100 - hsl[2]) * amount;
  return hslToHex(hsl[0], hsl[1], l);
}

function darkenHex(hex, amount) {
  var hsl = hexToHsl(hex);
  var l = Math.max(0, hsl[2] * (1 - amount));
  return hslToHex(hsl[0], hsl[1], l);
}

function applyWorldTheme() {
  var w = WORLDS_DATA[worldIdx];
  if (!w || !w.theme) return;
  var theme = w.theme;
  var bg = theme.bgColor || '#111122';
  var accent = theme.accentColor || '#4488ff';

  var lighter = mixWithWhite(bg, 0.35);
  var darker = darkenHex(bg, 0.5);

  document.body.style.transition = 'background 1s ease';
  document.body.style.background =
    'radial-gradient(circle at 50% 40%, ' + lighter + ' 0%, ' + bg + ' 45%, ' + darker + ' 100%)';

  var blobColors = [
    accent,
    rotateHue(accent, 60),
    rotateHue(accent, 180),
    rotateHue(accent, -60),
    mixWithWhite(accent, 0.5)
  ];

  var blobs = document.querySelectorAll('.bg-blob');
  for (var i = 0; i < blobs.length && i < blobColors.length; i++) {
    blobs[i].style.background = blobColors[i];
    blobs[i].style.opacity = '0.12';
  }
}

/* ── Starfield background ──────────────────────────────────── */
var starfieldStars = [];
function initStarfield() {
  var canvas = document.getElementById('starfield');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function makeStars() {
    starfieldStars = [];
    for (var i = 0; i < 120; i++) {
      starfieldStars.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        r: 0.5 + Math.random() * 1.5,
        o: 0.2 + Math.random() * 0.6
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < starfieldStars.length; i++) {
      var s = starfieldStars[i];
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + s.o.toFixed(2) + ')';
      ctx.fill();
    }
  }

  function twinkle() {
    for (var i = 0; i < starfieldStars.length; i++) {
      starfieldStars[i].o = Math.max(0.15, Math.min(0.85,
        starfieldStars[i].o + (Math.random() * 0.3 - 0.15)));
    }
    draw();
  }

  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  makeStars();
  draw();

  window.addEventListener('resize', function() {
    resize();
    makeStars();
    draw();
  });

  setInterval(twinkle, 3000);
}

function setWorldFromUI(idx) {
  applyWorld(parseInt(idx));
  applyWorldTheme();
  texCache = {};
  matCache = {};
  buildLegend();
  populateWorldSelector();
  syncPhysicsUI();
  restartGame();
}

/* ── Start ──────────────────────────────────────────────────── */
boot();
