# Partitionner ~118 paliers atomiques en 6–8 mondes jouables pour un atom‑merge type Suika

## Executive summary

7 mondes, 42 molécules, config-driven, Molecule > Merge priority, bond-lock reservation system.

## Key Design Decisions

- 7 worlds mapped to Z-blocks (contiguous atomic number ranges)
- Spawn decks: max 10 visible types, sub-decks 6/8/10
- Radius renormalized per world: rMin=1.0, rMax=5.5 (ratio ≤ 5.5×)
- Energy gain formula: E_gain = ceil(1 + 0.35 * tierTo + 0.75 * comboIndex)
- Refund cap: floor(cost * 0.4)
- Global molecule cooldown: 1.2s
- Molecule > Merge resolution priority
- Bond-lock: 450ms reservation window
- Scan interval: 100ms (10Hz)

## Worlds

| World | Range Z | Tiers | Physics | Theme |
|---|---|---:|---|---|
| w1_origines | 1–18 | 18 | phys_light | Cyan-lab, bubbles |
| w2_alliages_p4 | 19–36 | 18 | phys_metal | Steel, sparks |
| w3_catalyse_p5 | 37–54 | 18 | phys_catalyst | Indigo, noble glow |
| w4_terres_rares | 55–72 | 18 | phys_magnetic | Green neon, magnetic |
| w5_lourds_p6 | 73–86 | 14 | phys_heavy | Gold/black, smoke |
| w6_actinides | 87–103 | 17 | phys_unstable | Blue electric |
| w7_superheavy | 104–118 | 15 | phys_exotic | UV/glitch |

## Physics Presets

| Preset | gravity | restitution | friction | linearDamping | angularDamping |
|---|---:|---:|---:|---:|---:|
| phys_light | 20 | 0.22 | 0.18 | 0.02 | 0.02 |
| phys_metal | 23 | 0.14 | 0.24 | 0.03 | 0.03 |
| phys_catalyst | 24 | 0.13 | 0.26 | 0.035 | 0.035 |
| phys_magnetic | 22 | 0.15 | 0.28 | 0.04 | 0.04 |
| phys_heavy | 26 | 0.10 | 0.32 | 0.05 | 0.05 |
| phys_unstable | 25 | 0.18 | 0.20 | 0.03 | 0.03 |
| phys_exotic | 24 | 0.20 | 0.22 | 0.02 | 0.02 |

## Energy Rules

- maxEnergy per world: 90, 100, 110, 120, 130, 140, 160
- Gain: ceil(1 + 0.35 * tierTo + 0.75 * comboIndex)
- Refund cap: floor(cost * 0.4)
- Global molecule cooldown: 1.2s

## All 42 Molecule Recipes

### World 1 — Origines (1–18) — maxEnergy 90
| id | diff | inputs | cost | effect | effectRadius | refund | cooldown | priority |
|---|---|---|---:|---|---:|---:|---:|---:|
| w1_oh | easy | O(8)+H(1) | 14 | chain_spark | 2.2 | 2 | 2.5s | 70 |
| w1_no | easy | N(7)+O(8) | 14 | stabilize_soft | 2.2 | 1 | 2.5s | 70 |
| w1_co | easy | C(6)+O(8) | 16 | compress | 2.4 | 2 | 3.0s | 70 |
| w1_h2o | medium | H(1)+H(1)+O(8) | 28 | splash_clear | 2.6 | 4 | 4.0s | 82 |
| w1_co2 | medium | C(6)+O(8)+O(8) | 26 | smoke_slow | 2.8 | 2 | 4.0s | 82 |
| w1_nh3 | hard | N(7)+H(1)+H(1)+H(1) | 34 | fog_repulse | 2.8 | 0 | 6.0s | 92 |

### World 2 — Alliages P4 (19–36) — maxEnergy 100
| id | diff | inputs | cost | effect | effectRadius | refund | cooldown | priority |
|---|---|---|---:|---|---:|---:|---:|---:|
| w2_fe_co | easy | Fe(26)+Co(27) | 16 | harden | 2.3 | 1 | 2.5s | 70 |
| w2_ti_v | easy | Ti(22)+V(23) | 16 | lift | 2.4 | 1 | 3.0s | 70 |
| w2_cr_mn | easy | Cr(24)+Mn(25) | 18 | burst | 2.4 | 2 | 3.0s | 70 |
| w2_stainless | medium | Fe(26)+Cr(24)+Ni(28) | 28 | shield | 2.7 | 3 | 4.5s | 82 |
| w2_tri_alloy | medium | Ti(22)+Cr(24)+V(23) | 30 | shear_wave | 2.9 | 2 | 5.0s | 82 |
| w2_superalloy | hard | Ni(28)+Cr(24)+Co(27)+Fe(26) | 40 | conduct_chain | 3.0 | 6 | 7.0s | 92 |

### World 3 — Catalyse P5 (37–54) — maxEnergy 110
| id | diff | inputs | cost | effect | effectRadius | refund | cooldown | priority |
|---|---|---|---:|---|---:|---:|---:|---:|
| w3_zr_nb | easy | Zr(40)+Nb(41) | 18 | shield_bubble | 2.4 | 2 | 3.0s | 70 |
| w3_mo_tc | easy | Mo(42)+Tc(43) | 18 | catalyst_refill | 2.0 | 6 | 4.0s | 70 |
| w3_ru_rh | easy | Ru(44)+Rh(45) | 18 | stabilize | 2.5 | 1 | 3.0s | 70 |
| w3_tricat | medium | Ru(44)+Rh(45)+Pd(46) | 30 | chain_spark_2 | 2.9 | 4 | 5.0s | 82 |
| w3_silver | medium | Ag(47)+Ag(47)+Sn(50) | 32 | mirror_clear | 2.7 | 4 | 5.5s | 82 |
| w3_xe_nova | hard | Xe(54)+I(53)+Ag(47)+Pd(46) | 44 | xenon_flash | 3.2 | 6 | 7.5s | 92 |

### World 4 — Terres rares (55–72) — maxEnergy 120
| id | diff | inputs | cost | effect | effectRadius | refund | cooldown | priority |
|---|---|---|---:|---|---:|---:|---:|---:|
| w4_cs_ba | easy | Cs(55)+Ba(56) | 20 | shockwave | 2.6 | 2 | 3.5s | 70 |
| w4_nd_sm | easy | Nd(60)+Sm(62) | 20 | magnetic_pull | 3.2 | 0 | 4.0s | 70 |
| w4_eu_gd | easy | Eu(63)+Gd(64) | 20 | glow_refill | 2.2 | 8 | 5.0s | 70 |
| w4_glow_tri | medium | Sm(62)+Eu(63)+Gd(64) | 34 | aura_shield | 3.0 | 4 | 6.0s | 82 |
| w4_magnet_tri | medium | Nd(60)+Tb(65)+Dy(66) | 36 | magnet_sweep | 3.4 | 2 | 6.5s | 82 |
| w4_matrix | hard | Nd(60)+Tb(65)+Dy(66)+Ho(67) | 48 | field_compress | 3.6 | 6 | 8.0s | 92 |

### World 5 — Lourds P6 (73–86) — maxEnergy 130
| id | diff | inputs | cost | effect | effectRadius | refund | cooldown | priority |
|---|---|---|---:|---|---:|---:|---:|---:|
| w5_au_pt | easy | Au(79)+Pt(78) | 22 | shield_heavy | 2.8 | 2 | 4.0s | 70 |
| w5_hg_au | easy | Hg(80)+Au(79) | 22 | liquid_drag | 2.8 | 0 | 4.0s | 70 |
| w5_pb_tl | easy | Pb(82)+Tl(81) | 22 | anchor | 2.6 | 0 | 4.0s | 70 |
| w5_os_ir_pt | medium | Os(76)+Ir(77)+Pt(78) | 38 | anvil_pulse | 3.2 | 4 | 6.5s | 82 |
| w5_au2_hg | medium | Au(79)+Au(79)+Hg(80) | 40 | gold_flash | 3.0 | 6 | 7.0s | 82 |
| w5_rn_fog | hard | Rn(86)+At(85)+Po(84)+Pb(82) | 54 | radon_fog | 3.8 | 6 | 9.0s | 92 |

### World 6 — Actinides (87–103) — maxEnergy 140
| id | diff | inputs | cost | effect | effectRadius | refund | cooldown | priority |
|---|---|---|---:|---|---:|---:|---:|---:|
| w6_u_np | easy | U(92)+Np(93) | 24 | radiation_pulse | 3.0 | 2 | 4.0s | 70 |
| w6_pu_am | easy | Pu(94)+Am(95) | 24 | burst_hot | 3.0 | 2 | 4.0s | 70 |
| w6_th_pa | easy | Th(90)+Pa(91) | 24 | stabilize_strong | 2.8 | 2 | 4.0s | 70 |
| w6_fission | medium | U(92)+U(92)+Pu(94) | 44 | fission_clear | 3.6 | 6 | 7.0s | 82 |
| w6_chain | medium | Np(93)+Pu(94)+Am(95) | 46 | chain_react | 3.5 | 6 | 7.5s | 82 |
| w6_core | hard | U(92)+Pu(94)+Am(95)+Cf(98) | 60 | core_meltdown | 4.2 | 10 | 10.0s | 92 |

### World 7 — Superlourds (104–118) — maxEnergy 160
| id | diff | inputs | cost | effect | effectRadius | refund | cooldown | priority |
|---|---|---|---:|---|---:|---:|---:|---:|
| w7_rf_db | easy | Rf(104)+Db(105) | 28 | gravity_well | 3.4 | 2 | 4.5s | 70 |
| w7_ds_rg | easy | Ds(110)+Rg(111) | 28 | spark_storm | 3.2 | 2 | 4.5s | 70 |
| w7_cn_nh | easy | Cn(112)+Nh(113) | 28 | phase_shift | 3.0 | 2 | 4.5s | 70 |
| w7_timewarp | medium | Hs(108)+Mt(109)+Ds(110) | 52 | time_warp | 3.8 | 6 | 8.0s | 82 |
| w7_corrosion | medium | Fl(114)+Lv(116)+Ts(117) | 56 | corrosive_clear | 3.9 | 6 | 8.5s | 82 |
| w7_og_end | hard | Og(118)+Og(118)+Ts(117)+Lv(116) | 74 | exotic_reset | 4.6 | 12 | 12.0s | 92 |

## Molecule Detection Algorithm

1. Build spatial index (grid/hash) of active atoms
2. For each allowed recipe in world, ordered by: priority desc, ingredientCount desc, avgTier desc
3. Search candidates (neighbors in detectRadius), assemble multiset
4. Validate: max distance + avg velocity < threshold + no ingredient already reserved
5. Reserve ingredients (reservedUntil = now + candidateLockMs)
6. Check energy: insufficient → warning + release reservation; sufficient → trigger
7. After molecule pass, run standard merge pass (blocked if reserved)

## Bond-Lock Parameters
- scanIntervalMs: 100
- candidateLockMs: 450
- requireLowVelocity: true
- globalMoleculeCooldownSec: 1.2
- warnEnergyCooldownSec: 2.5
