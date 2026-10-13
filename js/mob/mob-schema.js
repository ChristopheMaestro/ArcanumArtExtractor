// .MOB / .PRO object-field schema tables.

export const MOB_OD_NAMES = {"0":"Invalid","1":"Begin","2":"End","3":"Int32","4":"Int64","5":"String","6":"Handle","7":"Int32Array","8":"Int64Array","9":"UInt32Array","10":"UInt64Array","11":"ScriptArray","12":"QuestArray","13":"HandleArray","14":"Ptr","15":"PtrArray"};
export const MOB_OD_TYPES = [1,3,4,3,3,3,9,9,9,3,3,3,3,3,3,3,9,9,9,3,3,3,3,3,3,3,3,3,3,3,3,7,11,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,3,3,3,3,9,10,2,1,3,3,3,3,13,3,3,3,3,9,10,2,1,3,6,3,3,9,10,2,1,3,3,3,6,3,3,9,10,2,1,3,6,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,9,10,2,1,3,3,3,3,7,7,7,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,9,10,2,1,3,3,3,3,3,9,10,2,1,3,3,3,3,7,7,3,3,3,3,9,10,2,1,3,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,9,3,3,9,10,2,1,3,3,3,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,7,7,7,9,3,3,3,3,9,9,6,3,6,6,6,6,6,3,13,3,3,13,4,3,3,3,3,3,3,9,10,2,1,3,3,9,10,3,3,12,9,10,9,10,3,10,9,9,9,3,5,3,9,9,3,3,9,10,2,1,3,6,3,6,6,3,3,10,3,4,4,3,3,3,6,3,3,13,9,9,3,3,3,9,13,2,1,3,3,3,9,10,2];
export const MOB_GROUP_BEGIN = [0,38,45,55,68,76,86,111,140,149,163,171,178,185,192,200,210,217,252,279,306];
export const MOB_GROUP_PARENT_LAST = [-1,36,36,36,36,36,36,109,109,109,109,109,109,109,109,109,109,36,250,250,36];
export const MOB_TYPE_RANGE_BEGIN = [38,45,55,68,76,86,111,86,140,86,149,86,163,86,171,86,178,86,185,86,192,86,200,86,210,217,252,217,279,306];
export const MOB_TYPE_RANGE_END = [44,54,67,75,85,110,139,110,148,110,162,110,170,110,177,110,184,110,191,110,199,110,209,110,216,251,278,251,305,312];
export const MOB_TYPE_RANGE_OFFSET = [0,1,2,3,4,5,7,9,11,13,15,17,19,21,23,25,27,29,30];
export const MOB_TYPE_LAST_FIELD = [43,53,66,74,84,138,147,161,169,176,183,190,198,208,215,277,304,311];
// Generated from game/obj.h (OBJ_F_* enum order) and game/obj_flags.h (the
// obj_flags_fields_lookup_tbl mapping of flag sets to fields). Names are the
// game's own field names; regenerate rather than editing by hand.
export const MOB_FIELD_NAMES = {"1":"F_CURRENT_AID","2":"F_LOCATION","3":"F_OFFSET_X","4":"F_OFFSET_Y","5":"F_SHADOW","6":"F_OVERLAY_FORE","7":"F_OVERLAY_BACK","8":"F_UNDERLAY","9":"F_BLIT_FLAGS","10":"F_BLIT_COLOR","11":"F_BLIT_ALPHA","12":"F_BLIT_SCALE","13":"F_LIGHT_FLAGS","14":"F_LIGHT_AID","15":"F_LIGHT_COLOR","16":"F_OVERLAY_LIGHT_FLAGS","17":"F_OVERLAY_LIGHT_AID","18":"F_OVERLAY_LIGHT_COLOR","19":"F_FLAGS","20":"F_SPELL_FLAGS","21":"F_BLOCKING_MASK","22":"F_NAME","23":"F_DESCRIPTION","24":"F_AID","25":"F_DESTROYED_AID","26":"F_AC","27":"F_HP_PTS","28":"F_HP_ADJ","29":"F_HP_DAMAGE","30":"F_MATERIAL","31":"F_RESISTANCE_IDX","32":"F_SCRIPTS_IDX","33":"F_SOUND_EFFECT","34":"F_CATEGORY","35":"F_PAD_IAS_1","36":"F_PAD_I64AS_1","39":"F_WALL_FLAGS","40":"F_WALL_PAD_I_1","41":"F_WALL_PAD_I_2","42":"F_WALL_PAD_IAS_1","43":"F_WALL_PAD_I64AS_1","46":"F_PORTAL_FLAGS","47":"F_PORTAL_LOCK_DIFFICULTY","48":"F_PORTAL_KEY_ID","49":"F_PORTAL_NOTIFY_NPC","50":"F_PORTAL_PAD_I_1","51":"F_PORTAL_PAD_I_2","52":"F_PORTAL_PAD_IAS_1","53":"F_PORTAL_PAD_I64AS_1","56":"F_CONTAINER_FLAGS","57":"F_CONTAINER_LOCK_DIFFICULTY","58":"F_CONTAINER_KEY_ID","59":"F_CONTAINER_INVENTORY_NUM","60":"F_CONTAINER_INVENTORY_LIST_IDX","61":"F_CONTAINER_INVENTORY_SOURCE","62":"F_CONTAINER_NOTIFY_NPC","63":"F_CONTAINER_PAD_I_1","64":"F_CONTAINER_PAD_I_2","65":"F_CONTAINER_PAD_IAS_1","66":"F_CONTAINER_PAD_I64AS_1","69":"F_SCENERY_FLAGS","70":"F_SCENERY_WHOS_IN_ME","71":"F_SCENERY_RESPAWN_DELAY","72":"F_SCENERY_PAD_I_2","73":"F_SCENERY_PAD_IAS_1","74":"F_SCENERY_PAD_I64AS_1","77":"F_PROJECTILE_FLAGS_COMBAT","78":"F_PROJECTILE_FLAGS_COMBAT_DAMAGE","79":"F_PROJECTILE_HIT_LOC","80":"F_PROJECTILE_PARENT_WEAPON","81":"F_PROJECTILE_PAD_I_1","82":"F_PROJECTILE_PAD_I_2","83":"F_PROJECTILE_PAD_IAS_1","84":"F_PROJECTILE_PAD_I64AS_1","87":"F_ITEM_FLAGS","88":"F_ITEM_PARENT","89":"F_ITEM_WEIGHT","90":"F_ITEM_MAGIC_WEIGHT_ADJ","91":"F_ITEM_WORTH","92":"F_ITEM_MANA_STORE","93":"F_ITEM_INV_AID","94":"F_ITEM_INV_LOCATION","95":"F_ITEM_USE_AID_FRAGMENT","96":"F_ITEM_MAGIC_TECH_COMPLEXITY","97":"F_ITEM_DISCIPLINE","98":"F_ITEM_DESCRIPTION_UNKNOWN","99":"F_ITEM_DESCRIPTION_EFFECTS","100":"F_ITEM_SPELL_1","101":"F_ITEM_SPELL_2","102":"F_ITEM_SPELL_3","103":"F_ITEM_SPELL_4","104":"F_ITEM_SPELL_5","105":"F_ITEM_SPELL_MANA_STORE","106":"F_ITEM_AI_ACTION","107":"F_ITEM_PAD_I_1","108":"F_ITEM_PAD_IAS_1","109":"F_ITEM_PAD_I64AS_1","112":"F_WEAPON_FLAGS","113":"F_WEAPON_PAPER_DOLL_AID","114":"F_WEAPON_BONUS_TO_HIT","115":"F_WEAPON_MAGIC_HIT_ADJ","116":"F_WEAPON_DAMAGE_LOWER_IDX","117":"F_WEAPON_DAMAGE_UPPER_IDX","118":"F_WEAPON_MAGIC_DAMAGE_ADJ_IDX","119":"F_WEAPON_SPEED_FACTOR","120":"F_WEAPON_MAGIC_SPEED_ADJ","121":"F_WEAPON_RANGE","122":"F_WEAPON_MAGIC_RANGE_ADJ","123":"F_WEAPON_MIN_STRENGTH","124":"F_WEAPON_MAGIC_MIN_STRENGTH_ADJ","125":"F_WEAPON_AMMO_TYPE","126":"F_WEAPON_AMMO_CONSUMPTION","127":"F_WEAPON_MISSILE_AID","128":"F_WEAPON_VISUAL_EFFECT_AID","129":"F_WEAPON_CRIT_HIT_CHART","130":"F_WEAPON_MAGIC_CRIT_HIT_CHANCE","131":"F_WEAPON_MAGIC_CRIT_HIT_EFFECT","132":"F_WEAPON_CRIT_MISS_CHART","133":"F_WEAPON_MAGIC_CRIT_MISS_CHANCE","134":"F_WEAPON_MAGIC_CRIT_MISS_EFFECT","135":"F_WEAPON_PAD_I_1","136":"F_WEAPON_PAD_I_2","137":"F_WEAPON_PAD_IAS_1","138":"F_WEAPON_PAD_I64AS_1","141":"F_AMMO_FLAGS","142":"F_AMMO_QUANTITY","143":"F_AMMO_TYPE","144":"F_AMMO_PAD_I_1","145":"F_AMMO_PAD_I_2","146":"F_AMMO_PAD_IAS_1","147":"F_AMMO_PAD_I64AS_1","150":"F_ARMOR_FLAGS","151":"F_ARMOR_PAPER_DOLL_AID","152":"F_ARMOR_AC_ADJ","153":"F_ARMOR_MAGIC_AC_ADJ","154":"F_ARMOR_RESISTANCE_ADJ_IDX","155":"F_ARMOR_MAGIC_RESISTANCE_ADJ_IDX","156":"F_ARMOR_SILENT_MOVE_ADJ","157":"F_ARMOR_MAGIC_SILENT_MOVE_ADJ","158":"F_ARMOR_UNARMED_BONUS_DAMAGE","159":"F_ARMOR_PAD_I_2","160":"F_ARMOR_PAD_IAS_1","161":"F_ARMOR_PAD_I64AS_1","164":"F_GOLD_FLAGS","165":"F_GOLD_QUANTITY","166":"F_GOLD_PAD_I_1","167":"F_GOLD_PAD_I_2","168":"F_GOLD_PAD_IAS_1","169":"F_GOLD_PAD_I64AS_1","172":"F_FOOD_FLAGS","173":"F_FOOD_PAD_I_1","174":"F_FOOD_PAD_I_2","175":"F_FOOD_PAD_IAS_1","176":"F_FOOD_PAD_I64AS_1","179":"F_SCROLL_FLAGS","180":"F_SCROLL_PAD_I_1","181":"F_SCROLL_PAD_I_2","182":"F_SCROLL_PAD_IAS_1","183":"F_SCROLL_PAD_I64AS_1","186":"F_KEY_KEY_ID","187":"F_KEY_PAD_I_1","188":"F_KEY_PAD_I_2","189":"F_KEY_PAD_IAS_1","190":"F_KEY_PAD_I64AS_1","193":"F_KEY_RING_FLAGS","194":"F_KEY_RING_LIST_IDX","195":"F_KEY_RING_PAD_I_1","196":"F_KEY_RING_PAD_I_2","197":"F_KEY_RING_PAD_IAS_1","198":"F_KEY_RING_PAD_I64AS_1","201":"F_WRITTEN_FLAGS","202":"F_WRITTEN_SUBTYPE","203":"F_WRITTEN_TEXT_START_LINE","204":"F_WRITTEN_TEXT_END_LINE","205":"F_WRITTEN_PAD_I_1","206":"F_WRITTEN_PAD_I_2","207":"F_WRITTEN_PAD_IAS_1","208":"F_WRITTEN_PAD_I64AS_1","211":"F_GENERIC_FLAGS","212":"F_GENERIC_USAGE_BONUS","213":"F_GENERIC_USAGE_COUNT_REMAINING","214":"F_GENERIC_PAD_IAS_1","215":"F_GENERIC_PAD_I64AS_1","218":"F_CRITTER_FLAGS","219":"F_CRITTER_FLAGS2","220":"F_CRITTER_STAT_BASE_IDX","221":"F_CRITTER_BASIC_SKILL_IDX","222":"F_CRITTER_TECH_SKILL_IDX","223":"F_CRITTER_SPELL_TECH_IDX","224":"F_CRITTER_FATIGUE_PTS","225":"F_CRITTER_FATIGUE_ADJ","226":"F_CRITTER_FATIGUE_DAMAGE","227":"F_CRITTER_CRIT_HIT_CHART","228":"F_CRITTER_EFFECTS_IDX","229":"F_CRITTER_EFFECT_CAUSE_IDX","230":"F_CRITTER_FLEEING_FROM","231":"F_CRITTER_PORTRAIT","232":"F_CRITTER_GOLD","233":"F_CRITTER_ARROWS","234":"F_CRITTER_BULLETS","235":"F_CRITTER_POWER_CELLS","236":"F_CRITTER_FUEL","237":"F_CRITTER_INVENTORY_NUM","238":"F_CRITTER_INVENTORY_LIST_IDX","239":"F_CRITTER_INVENTORY_SOURCE","240":"F_CRITTER_DESCRIPTION_UNKNOWN","241":"F_CRITTER_FOLLOWER_IDX","242":"F_CRITTER_TELEPORT_DEST","243":"F_CRITTER_TELEPORT_MAP","244":"F_CRITTER_DEATH_TIME","245":"F_CRITTER_AUTO_LEVEL_SCHEME","246":"F_CRITTER_PAD_I_1","247":"F_CRITTER_PAD_I_2","248":"F_CRITTER_PAD_I_3","249":"F_CRITTER_PAD_IAS_1","250":"F_CRITTER_PAD_I64AS_1","253":"F_PC_FLAGS","254":"F_PC_FLAGS_FATE","255":"F_PC_REPUTATION_IDX","256":"F_PC_REPUTATION_TS_IDX","257":"F_PC_BACKGROUND","258":"F_PC_BACKGROUND_TEXT","259":"F_PC_QUEST_IDX","260":"F_PC_BLESSING_IDX","261":"F_PC_BLESSING_TS_IDX","262":"F_PC_CURSE_IDX","263":"F_PC_CURSE_TS_IDX","264":"F_PC_PARTY_ID","265":"F_PC_RUMOR_IDX","266":"F_PC_PAD_IAS_2","267":"F_PC_SCHEMATICS_FOUND_IDX","268":"F_PC_LOGBOOK_EGO_IDX","269":"F_PC_FOG_MASK","270":"F_PC_PLAYER_NAME","271":"F_PC_BANK_MONEY","272":"F_PC_GLOBAL_FLAGS","273":"F_PC_GLOBAL_VARIABLES","274":"F_PC_PAD_I_1","275":"F_PC_PAD_I_2","276":"F_PC_PAD_IAS_1","277":"F_PC_PAD_I64AS_1","280":"F_NPC_FLAGS","281":"F_NPC_LEADER","282":"F_NPC_AI_DATA","283":"F_NPC_COMBAT_FOCUS","284":"F_NPC_WHO_HIT_ME_LAST","285":"F_NPC_EXPERIENCE_WORTH","286":"F_NPC_EXPERIENCE_POOL","287":"F_NPC_WAYPOINTS_IDX","288":"F_NPC_WAYPOINT_CURRENT","289":"F_NPC_STANDPOINT_DAY","290":"F_NPC_STANDPOINT_NIGHT","291":"F_NPC_ORIGIN","292":"F_NPC_FACTION","293":"F_NPC_RETAIL_PRICE_MULTIPLIER","294":"F_NPC_SUBSTITUTE_INVENTORY","295":"F_NPC_REACTION_BASE","296":"F_NPC_SOCIAL_CLASS","297":"F_NPC_REACTION_PC_IDX","298":"F_NPC_REACTION_LEVEL_IDX","299":"F_NPC_REACTION_TIME_IDX","300":"F_NPC_WAIT","301":"F_NPC_GENERATOR_DATA","302":"F_NPC_PAD_I_1","303":"F_NPC_DAMAGE_IDX","304":"F_NPC_SHIT_LIST_IDX","307":"F_TRAP_FLAGS","308":"F_TRAP_DIFFICULTY","309":"F_TRAP_PAD_I_2","310":"F_TRAP_PAD_IAS_1","311":"F_TRAP_PAD_I64AS_1"};

// Bit-flag breakdowns, one entry per flag-bearing field, with the masks taken
// straight from the game's #defines (names are the C names in CamelCase).
export const MOB_FLAG_BITS = {
  19: [ // F_FLAGS (OF_*)
    [0x00000001, 'Destroyed'],
    [0x00000002, 'Off'],
    [0x00000004, 'Flat'],
    [0x00000008, 'Text'],
    [0x00000010, 'SeeThrough'],
    [0x00000020, 'ShootThrough'],
    [0x00000040, 'Translucent'],
    [0x00000080, 'Shrunk'],
    [0x00000100, 'Dontdraw'],
    [0x00000200, 'Invisible'],
    [0x00000400, 'NoBlock'],
    [0x00000800, 'ClickThrough'],
    [0x00001000, 'Inventory'],
    [0x00002000, 'Dynamic'],
    [0x00004000, 'ProvidesCover'],
    [0x00008000, 'HasOverlays'],
    [0x00010000, 'HasUnderlays'],
    [0x00020000, 'Wading'],
    [0x00040000, 'WaterWalking'],
    [0x00080000, 'Stoned'],
    [0x00100000, 'Dontlight'],
    [0x00200000, 'TextFloater'],
    [0x00400000, 'Invulnerable'],
    [0x00800000, 'Extinct'],
    [0x01000000, 'TrapPc'],
    [0x02000000, 'TrapSpotted'],
    [0x04000000, 'DisallowWading'],
    [0x08000000, 'MultiplayerLock'],
    [0x10000000, 'Frozen'],
    [0x20000000, 'AnimatedDead'],
    [0x40000000, 'Teleported']
  ],
  20: [ // F_SPELL_FLAGS (OSF_*)
    [0x00000001, 'Invisible'],
    [0x00000002, 'Floating'],
    [0x00000004, 'BodyOfAir'],
    [0x00000008, 'BodyOfEarth'],
    [0x00000010, 'BodyOfFire'],
    [0x00000020, 'BodyOfWater'],
    [0x00000040, 'DetectingMagic'],
    [0x00000080, 'DetectingAlignment'],
    [0x00000100, 'DetectingTraps'],
    [0x00000200, 'DetectingInvisible'],
    [0x00000400, 'Shielded'],
    [0x00000800, 'AntiMagicShell'],
    [0x00001000, 'BondsOfMagic'],
    [0x00002000, 'FullReflection'],
    [0x00004000, 'Summoned'],
    [0x00008000, 'Illusion'],
    [0x00010000, 'Stoned'],
    [0x00020000, 'Polymorphed'],
    [0x00040000, 'Mirrored'],
    [0x00080000, 'Shrunk'],
    [0x00100000, 'Passwalled'],
    [0x00200000, 'WaterWalking'],
    [0x00400000, 'MagneticInversion'],
    [0x00800000, 'Charmed'],
    [0x01000000, 'Entangled'],
    [0x02000000, 'SpokenWithDead'],
    [0x04000000, 'TempusFugit'],
    [0x08000000, 'MindControlled'],
    [0x10000000, 'Drunk'],
    [0x20000000, 'Enshrouded'],
    [0x40000000, 'Familiar'],
    [0x80000000, 'HardenedHands']
  ],
  39: [ // F_WALL_FLAGS (OWAF_*)
    [0x00000001, 'TransDisallow'],
    [0x00000002, 'TransLeft'],
    [0x00000004, 'TransRight'],
    [0x00000008, 'TransAll']
  ],
  46: [ // F_PORTAL_FLAGS (OPF_*)
    [0x00000001, 'Locked'],
    [0x00000002, 'Jammed'],
    [0x00000004, 'MagicallyHeld'],
    [0x00000008, 'NeverLocked'],
    [0x00000010, 'AlwaysLocked'],
    [0x00000020, 'LockedDay'],
    [0x00000040, 'LockedNight'],
    [0x00000080, 'Busted'],
    [0x00000100, 'Sticky']
  ],
  56: [ // F_CONTAINER_FLAGS (OCOF_*)
    [0x00000001, 'Locked'],
    [0x00000002, 'Jammed'],
    [0x00000004, 'MagicallyHeld'],
    [0x00000008, 'NeverLocked'],
    [0x00000010, 'AlwaysLocked'],
    [0x00000020, 'LockedDay'],
    [0x00000040, 'LockedNight'],
    [0x00000080, 'Busted'],
    [0x00000100, 'Sticky'],
    [0x00000200, 'InvenSpawnOnce'],
    [0x00000400, 'InvenSpawnIndependent']
  ],
  69: [ // F_SCENERY_FLAGS (OSCF_*)
    [0x00000001, 'NoAutoAnimate'],
    [0x00000002, 'Busted'],
    [0x00000004, 'Nocturnal'],
    [0x00000008, 'MarksTownmap'],
    [0x00000010, 'IsFire'],
    [0x00000020, 'Respawnable'],
    [0x00000040, 'SoundSmall'],
    [0x00000080, 'SoundMedium'],
    [0x00000100, 'SoundExtraLarge'],
    [0x00000200, 'UnderAll'],
    [0x00000400, 'Respawning']
  ],
  87: [ // F_ITEM_FLAGS (OIF_*)
    [0x00000001, 'Identified'],
    [0x00000002, 'WontSell'],
    [0x00000004, 'IsMagical'],
    [0x00000008, 'TransferLight'],
    [0x00000010, 'NoDisplay'],
    [0x00000020, 'NoDrop'],
    [0x00000040, 'Hexed'],
    [0x00000080, 'CanUseBox'],
    [0x00000100, 'NeedsTarget'],
    [0x00000200, 'LightSmall'],
    [0x00000400, 'LightMedium'],
    [0x00000800, 'LightLarge'],
    [0x00001000, 'LightXlarge'],
    [0x00002000, 'Persistent'],
    [0x00004000, 'MtTriggered'],
    [0x00008000, 'Stolen'],
    [0x00010000, 'UseIsThrow'],
    [0x00020000, 'NoDecay'],
    [0x00040000, 'Uber'],
    [0x00080000, 'NoNpcPickup'],
    [0x00100000, 'NoRangedUse'],
    [0x00200000, 'ValidAiAction'],
    [0x00400000, 'MpInserted']
  ],
  112: [ // F_WEAPON_FLAGS (OWF_*)
    [0x00000001, 'Loud'],
    [0x00000002, 'Silent'],
    [0x00000004, 'TwoHanded'],
    [0x00000008, 'HandCountFixed'],
    [0x00000010, 'Throwable'],
    [0x00000020, 'TransProjectile'],
    [0x00000040, 'Boomerangs'],
    [0x00000080, 'IgnoreResistance'],
    [0x00000100, 'DamageArmor'],
    [0x00000200, 'DefaultThrows']
  ],
  141: [ // F_AMMO_FLAGS (OAF_*)
    [0x00000001, 'None']
  ],
  150: [ // F_ARMOR_FLAGS (OARF_*)
    [0x00000001, 'SizeSmall'],
    [0x00000002, 'SizeMedium'],
    [0x00000004, 'SizeLarge'],
    [0x00000008, 'MaleOnly'],
    [0x00000010, 'FemaleOnly']
  ],
  164: [ // F_GOLD_FLAGS (OGOF_*)
    [0x00000001, 'None']
  ],
  172: [ // F_FOOD_FLAGS (OFF_*)
    [0x00000001, 'None']
  ],
  179: [ // F_SCROLL_FLAGS (OSRF_*)
    [0x00000001, 'None']
  ],
  193: [ // F_KEY_RING_FLAGS (OKRF_*)
    [0x00000001, 'PrimaryRing']
  ],
  201: [ // F_WRITTEN_FLAGS (OWRF_*)
    [0x00000001, 'None']
  ],
  211: [ // F_GENERIC_FLAGS (OGF_*)
    [0x00000001, 'UsesTorchShieldLocation'],
    [0x00000002, 'IsLockpick'],
    [0x00000004, 'IsTrapDevice'],
    [0x00000008, 'IsHealingItem'],
    [0x00000010, 'IsGrenade']
  ],
  218: [ // F_CRITTER_FLAGS (OCF_*)
    [0x00000001, 'IsConcealed'],
    [0x00000002, 'MovingSilently'],
    [0x00000004, 'Undead'],
    [0x00000008, 'Animal'],
    [0x00000010, 'Fleeing'],
    [0x00000020, 'Stunned'],
    [0x00000040, 'Paralyzed'],
    [0x00000080, 'Blinded'],
    [0x00000100, 'CrippledArmsOne'],
    [0x00000200, 'CrippledArmsBoth'],
    [0x00000400, 'CrippledLegsBoth'],
    [0x00000800, 'Unused'],
    [0x00001000, 'Sleeping'],
    [0x00002000, 'Mute'],
    [0x00004000, 'Surrendered'],
    [0x00008000, 'Monster'],
    [0x00010000, 'SpellFlee'],
    [0x00020000, 'Encounter'],
    [0x00040000, 'CombatModeActive'],
    [0x00080000, 'LightSmall'],
    [0x00100000, 'LightMedium'],
    [0x00200000, 'LightLarge'],
    [0x00400000, 'LightXlarge'],
    [0x00800000, 'Unrevivifiable'],
    [0x01000000, 'Unressurectable'],
    [0x02000000, 'Demon'],
    [0x04000000, 'FatigueImmune'],
    [0x08000000, 'NoFlee'],
    [0x10000000, 'NonLethalCombat'],
    [0x20000000, 'Mechanical'],
    [0x40000000, 'AnimalEnshroud'],
    [0x80000000, 'FatigueLimiting']
  ],
  219: [ // F_CRITTER_FLAGS2 (OCF2_*)
    [0x00000001, 'ItemStolen'],
    [0x00000002, 'AutoAnimates'],
    [0x00000004, 'UsingBoomerang'],
    [0x00000008, 'FatigueDraining'],
    [0x00000010, 'SlowParty'],
    [0x00000020, 'CombatToggleFx'],
    [0x00000040, 'NoDecay'],
    [0x00000080, 'NoPickpocket'],
    [0x00000100, 'NoBloodSplotches'],
    [0x00000200, 'NighInvulnerable'],
    [0x00000400, 'Elemental'],
    [0x00000800, 'DarkSight'],
    [0x00001000, 'NoSlip'],
    [0x00002000, 'NoDisintegrate'],
    [0x00004000, 'Reaction0'],
    [0x00008000, 'Reaction1'],
    [0x00010000, 'Reaction2'],
    [0x00020000, 'Reaction3'],
    [0x00040000, 'Reaction4'],
    [0x00080000, 'Reaction5'],
    [0x00100000, 'Reaction6'],
    [0x00200000, 'TargetLock'],
    [0x00400000, 'PermaPolymorph'],
    [0x00800000, 'SafeOff'],
    [0x01000000, 'CheckReactionBad'],
    [0x02000000, 'CheckAlignGood'],
    [0x04000000, 'CheckAlignBad']
  ],
  253: [ // F_PC_FLAGS (OPCF_*)
    [0x00000004, 'UseAltData'],
    [0x00000020, 'FollowerSkillsOn']
  ],
  280: [ // F_NPC_FLAGS (ONF_*)
    [0x00000001, 'Fighting'],
    [0x00000002, 'WaypointsDay'],
    [0x00000004, 'WaypointsNight'],
    [0x00000008, 'AiWaitHere'],
    [0x00000010, 'AiSpreadOut'],
    [0x00000020, 'Jilted'],
    [0x00000040, 'CheckWield'],
    [0x00000080, 'CheckWeapon'],
    [0x00000100, 'Kos'],
    [0x00000200, 'WaypointsBed'],
    [0x00000400, 'ForcedFollower'],
    [0x00000800, 'KosOverride'],
    [0x00001000, 'Wanders'],
    [0x00002000, 'WandersInDark'],
    [0x00004000, 'Fence'],
    [0x00008000, 'Familiar'],
    [0x00010000, 'CheckLeader'],
    [0x00020000, 'Aloof'],
    [0x00040000, 'CastHighest'],
    [0x00080000, 'Generator'],
    [0x00100000, 'Generated'],
    [0x00200000, 'GeneratorRate1'],
    [0x00400000, 'GeneratorRate2'],
    [0x00800000, 'GeneratorRate3'],
    [0x01000000, 'DemaintainSpells'],
    [0x02000000, 'LookForWeapon'],
    [0x04000000, 'LookForArmor'],
    [0x08000000, 'LookForAmmo'],
    [0x10000000, 'BackingOff'],
    [0x20000000, 'NoAttack'],
    [0x40000000, 'CheckGrenade']
  ],
  307: [ // F_TRAP_FLAGS (OTF_*)
    [0x00000001, 'Busted']
  ]
};

export const MOB_RESISTANCE_LABELS = ['Damage', 'Fire', 'Electrical', 'Poison', 'Magic'];

export const MOB_OBJECT_TYPE_NAMES = [
  'WALL', 'PORTAL', 'CONTAINER', 'SCENERY', 'PROJECTILE', 'WEAPON', 'AMMO',
  'ARMOR', 'GOLD (money)', 'FOOD', 'SCROLL', 'KEY', 'KEY_RING', 'WRITTEN',
  'GENERIC (item)', 'PC', 'NPC', 'TRAP'
];

export function mobObjectTypeName(type){
  return MOB_OBJECT_TYPE_NAMES[type] || `Unknown object type`;
}
