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
  var baseDeck = w.spawnDeck.slice();
  // Every 2 molecule-levels, trim 1 bottom tier (6 levels → max 3 trimmed)
  var tiersToRemove = Math.floor(currentLevel / 2);
  tiersToRemove = Math.min(tiersToRemove, baseDeck.length - 1); // always keep at least 1
  return baseDeck.slice(tiersToRemove);
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
  engine = new BABYLON.Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false });

  await loadGameData();
  buildScene();
  setupInput(canvas);
  populateWorldSelector();
  buildLegend();

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
    // Enforce Z=0 + wake stuck atoms + recover missing physics
    var floorY = -(CONTAINER.h / 2);
    for (var zi = 0; zi < atoms.length; zi++) {
      var at = atoms[zi];
      if (at.merging) continue; // skip atoms mid-merge (physics disposed intentionally)
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
        body.position.z = 0;
        body.velocity.z = 0;
        at.mesh.position.z = 0;
        // Clamp velocity — prevent atoms flying out of box on merge
        var maxV = 3;
        var vx = body.velocity.x, vy = body.velocity.y;
        if (vx > maxV) body.velocity.x = maxV;
        if (vx < -maxV) body.velocity.x = -maxV;
        if (vy > maxV) body.velocity.y = maxV;  // cap upward
        if (vy < -maxV * 4) body.velocity.y = -maxV * 4; // allow faster falling
        // Ensure no atom ever sleeps (prevents stuck-in-air bugs)
        if (body.sleepState !== 0) body.wakeUp();
        // Stuck detection: if atom is above resting zone but velocity is ~0, nudge it
        var meshY = at.mesh.position.y;
        var restY = floorY + at.elem.r + 0.1;
        if (meshY > restY + 1.0 && Math.abs(vy) < 0.05 && Math.abs(vx) < 0.05) {
          // Atom is floating motionless — forcefully re-sync and nudge
          body.position.x = at.mesh.position.x;
          body.position.y = at.mesh.position.y;
          body.velocity.y = -2; // gentle downward nudge
          at._stuckFrames = (at._stuckFrames || 0) + 1;
          if (at._stuckFrames > 30) {
            // Truly stuck for 30+ frames — nuke and re-create physics
            console.warn('Nuking stuck atom physics', at.id);
            try { imp.dispose(); } catch(e2){}
            addPhysicsToAtom(at.mesh, at.elem);
            at._stuckFrames = 0;
          }
        } else {
          at._stuckFrames = 0;
        }
      } catch(e) { console.warn('Per-frame atom error:', e); }
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

  // Physics
  scene.enablePhysics(vec3(0, -PHYSICS_PRESET.gravity, 0),
    new BABYLON.CannonJSPlugin(true, 10, CANNON));

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
  wm.alpha = 0.25;

  var ph = { mass:0, restitution:PHYSICS_PRESET.restitution, friction:PHYSICS_PRESET.friction };

  function wall(name, w, h, d, x, y, z, vis) {
    var m = BABYLON.MeshBuilder.CreateBox(name, {width:w,height:h,depth:d}, scene);
    m.position.set(x, y, z);
    m.material = wm;
    if (vis === false) m.isVisible = false;
    m.physicsImpostor = new BABYLON.PhysicsImpostor(m,
      BABYLON.PhysicsImpostor.BoxImpostor, ph, scene);
    return m;
  }

  wall('floor', W+2*T, T, D+2*T,  0,            -T/2,        0);
  wall('left',  T,     H, D,      -(W/2+T/2),    H/2,         0);
  wall('right', T,     H, D,       (W/2+T/2),    H/2,         0);
  wall('back',  W,     H, T,       0,             H/2,        -(D/2+T/2));
  wall('front', W,     H, T,       0,             H/2,         (D/2+T/2), false);
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
  var mass = Math.pow(elem.r, 3) * 5;
  sp.physicsImpostor = new BABYLON.PhysicsImpostor(sp,
    BABYLON.PhysicsImpostor.SphereImpostor,
    { mass: mass, restitution: PHYSICS_PRESET.restitution, friction: PHYSICS_PRESET.friction },
    scene);
  try {
    sp.physicsImpostor.physicsBody.angularFactor.set(0, 0, 1);
    sp.physicsImpostor.physicsBody.linearFactor.set(1, 1, 0);
    sp.physicsImpostor.physicsBody.angularDamping = 0.5;
    sp.physicsImpostor.physicsBody.linearDamping = 0.08;
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
function onMoleculeFormed(recipe) {
  var w = WORLDS_DATA[worldIdx];
  if (!w || !w.molecules) return;
  if (currentLevel >= w.molecules.length) return; // already complete
  var targetId = w.molecules[currentLevel];
  if (recipe.id !== targetId) return; // not the target molecule

  currentLevel++;
  var rName = recipe.name || recipe.id;
  showLevelUpToast(rName);

  // Spawn special atom: +3 tiers above current highest on board
  var highest = 0;
  for (var i = 0; i < atoms.length; i++) {
    if (atoms[i].tier > highest) highest = atoms[i].tier;
  }
  var specialTier = Math.min(highest + 3, ELEMENT_DB.length - 1);
  var spX = (Math.random() - 0.5) * (CONTAINER.w - 2);
  var spY = CONTAINER.h * 0.6;
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

/* ── Merge Detection ────────────────────────────────────────── */
function checkMerges() {
  if (merging || gameIsOver) return;

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
      if (d <= (a.r + b.r) * 1.08) {
        doMerge(a, b);
        return;
      }
    }
  }
}

var mergeTimeout = null;
function doMerge(a, b) {
  merging  = true;
  a.merging = true;
  b.merging = true;
  // Safety: force-reset merging flag if stuck for too long
  if (mergeTimeout) clearTimeout(mergeTimeout);
  mergeTimeout = setTimeout(function() { merging = false; }, 600);

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
    if (mergeTimeout) { clearTimeout(mergeTimeout); mergeTimeout = null; }
    merging = false;
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

function triggerGameOver() {
  gameIsOver = true;
  try { localStorage.removeItem('atomMerge_save'); } catch(e){}
  disposeAllStormLines();
  document.getElementById('final-score').textContent = 'Score: ' + score;
  document.getElementById('game-over').style.display = 'flex';
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

function mapX(clientX, clientY) {
  if (!pickPlane || !inputCanvas) return 0;
  var r  = inputCanvas.getBoundingClientRect();
  var sx = ((clientX - r.left) / r.width);
  var sy = ((clientY - r.top)  / r.height);
  var pick = scene.pick(
    sx * engine.getRenderWidth(),
    sy * engine.getRenderHeight(),
    function (mesh) { return mesh === pickPlane; }
  );
  if (pick && pick.hit && pick.pickedPoint) {
    var maxX = CONTAINER.w / 2 - 0.5;
    return Math.max(-maxX, Math.min(maxX, pick.pickedPoint.x));
  }
  return ghostX; // fallback to last known position
}

function setupInput(cvs) {
  inputCanvas = cvs;
  createPickPlane();

  inputCanvas.addEventListener('mousemove', function (e) {
    if (gameIsOver) return;
    ghostX = mapX(e.clientX, e.clientY);
    if (ghostMesh) ghostMesh.position.x = ghostX;
  });
  inputCanvas.addEventListener('click', function (e) {
    if (gameIsOver) return;
    dropAtom(mapX(e.clientX, e.clientY));
  });
  inputCanvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    if (gameIsOver) return;
    ghostX = mapX(e.touches[0].clientX, e.touches[0].clientY);
    if (ghostMesh) ghostMesh.position.x = ghostX;
  }, { passive: false });
  inputCanvas.addEventListener('touchend', function (e) {
    e.preventDefault();
    if (gameIsOver) return;
    dropAtom(mapX(e.changedTouches[0].clientX, e.changedTouches[0].clientY));
  }, { passive: false });
}

/* ── HUD ────────────────────────────────────────────────────── */
function updateHUD() {
  document.getElementById('score-val').textContent = score;
  document.getElementById('best-val').textContent  = bestScore;
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
    if (targetId) {
      for (var mi = 0; mi < MOLECULES_DATA.length; mi++) {
        if (MOLECULES_DATA[mi].id === targetId) {
          var tr = MOLECULES_DATA[mi];
          targetLabel = tr.name || tr.inputs.map(function(x){return x.sym;}).join('+');
          break;
        }
      }
    }
    wl.textContent = '\u{1F30D} ' + WORLDS_DATA[worldIdx].label + '  Lv.' + (currentLevel + 1) +
      (targetLabel ? ' \u{1F3AF}' + targetLabel : ' \u2713');
  }
  var dc = document.getElementById('drop-cost');
  if (dc) dc.textContent = '-' + getDropCost() + '⚡';
}

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

function setWorldFromUI(idx) {
  applyWorld(parseInt(idx));
  texCache = {};
  matCache = {};
  buildLegend();
  populateWorldSelector();
  syncPhysicsUI();
  restartGame();
}

/* ── Start ──────────────────────────────────────────────────── */
boot();
