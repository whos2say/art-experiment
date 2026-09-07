"""
build_stage.py — Resonant Spectra: a virtual light stage grown from the album.

Run INSIDE the Unreal Editor (5.5+), Python Editor Script Plugin enabled:

    Window ▸ Output Log ▸ switch the prompt to "Python", then
    py "C:/path/to/art-experiment/unreal/build_stage.py"

or  Edit ▸ Execute Python Script… and pick this file.

What it builds (data-driven from unreal/rigs/*.json — run `npm run export:rigs` first):

  • a dark hall with volumetric fog, a truss, a cine camera, bloom-heavy post
  • one RIG per photograph, in its own outliner folder:
      Spot Lights   — one per bright light in the photo, aimed along the light's
                      streak direction, tight or wide by how directional it is
      Rect Lights   — washes painting the back wall in the photo's region colours
      Point Lights  — a stacked 'plume' column at the photo's warm centre
      (optional)    — the photograph itself on the back wall, faintly emissive,
                      so the beams reveal it exactly as the web app's Reveal look
  • a Level Sequence, RS_Performance, that performs the album: each photo is a
    movement (MOVEMENT_SECONDS long) with the same build → peak → release shape
    the web conductor uses when no music is playing; rigs cross-fade
  • a Level Sequence Actor set to auto-play and loop, so Play-In-Editor performs

Everything runtime-facing is Movable and tagged, so the optional C++ plugin
(Plugins/ResonantSpectra) can take over from the sequence and drive the same
lights from live audio.

Idempotent-ish: re-running removes actors it previously created (by tag) first.
"""
import json
import math
import os
import time
import unreal

# ── configuration ────────────────────────────────────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
RIGS_DIR = os.environ.get('RS_RIGS_DIR', os.path.join(HERE, 'rigs'))
PHOTOS_DIR = os.environ.get('RS_PHOTOS_DIR', os.path.join(os.path.dirname(HERE), 'photos'))

CONTENT_ROOT = '/Game/ResonantSpectra'
LEVEL_PATH = CONTENT_ROOT + '/Maps/RS_Stage'
SEQ_PATH = CONTENT_ROOT + '/RS_Performance'

CREATE_NEW_LEVEL = True         # False: build into the currently open level
BUILD_PHOTO_PLANE = True        # import each photo and put it on the back wall
BUILD_SEQUENCE = True
MAX_RIGS = None                 # e.g. 6 while iterating; None = all
MOVEMENT_SECONDS = 24.0         # per photo, matches the web default
TRANS_SECONDS = 1.6
FPS = 30

TAG_ROOT = 'rs_stage'           # every actor we create carries this tag
FOLDER_ROOT = 'ResonantSpectra'

# ── small helpers ────────────────────────────────────────────────────────────
LOG = unreal.log
WARN = unreal.log_warning

def _set(obj, **props):
    """set_editor_property for each prop; log (don't raise) on API drift."""
    for k, v in props.items():
        try:
            obj.set_editor_property(k, v)
        except Exception as e:  # noqa: BLE001
            WARN(f'[rs] {type(obj).__name__}.{k} = {v!r} failed: {e}')

def vec(x, y, z): return unreal.Vector(float(x), float(y), float(z))
def rot(p=0, y=0, r=0): return unreal.Rotator(float(p), float(y), float(r))
def col(rgb, a=255): return unreal.Color(int(rgb[0]), int(rgb[1]), int(rgb[2]), int(a))
def lin(rgb, a=1.0): return unreal.LinearColor(rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0, a)
def ss(a, b, x):
    x = max(0.0, min(1.0, (x - a) / (b - a))) if b != a else 0.0
    return x * x * (3 - 2 * x)

ACTORS = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
LEVELS = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
ASSETS = unreal.AssetToolsHelpers.get_asset_tools()
EAL = unreal.EditorAssetLibrary

def spawn(cls, location, rotation=None, label=None, folder=None, tags=()):
    a = ACTORS.spawn_actor_from_class(cls, location, rotation or rot())
    if label: a.set_actor_label(label)
    if folder: a.set_folder_path(FOLDER_ROOT + '/' + folder)
    a.set_editor_property('tags', [unreal.Name(TAG_ROOT)] + [unreal.Name(t) for t in tags])
    return a

def light_comp(actor):
    c = actor.get_component_by_class(unreal.LightComponent)
    if c is None:
        raise RuntimeError(f'no LightComponent on {actor.get_actor_label()}')
    return c

def aim(direction):
    return unreal.MathLibrary.make_rot_from_x(vec(*direction))

def basic_mesh(name):
    return EAL.load_asset(f'/Engine/BasicShapes/{name}')

# ── phase 0: clean slate ─────────────────────────────────────────────────────
def remove_previous():
    n = 0
    for a in ACTORS.get_all_level_actors():
        try:
            if unreal.Name(TAG_ROOT) in list(a.get_editor_property('tags')):
                ACTORS.destroy_actor(a); n += 1
        except Exception:  # noqa: BLE001
            pass
    if n: LOG(f'[rs] removed {n} actors from a previous build')

# ── phase 1: the hall ────────────────────────────────────────────────────────
def build_hall(stage):
    hall = stage['hall']; W, D, H = hall['width'], hall['depth'], hall['height']
    cube = basic_mesh('Cube')
    # near-black material so the walls only show what the lights put on them
    mat = None
    try:
        parent = EAL.load_asset('/Engine/BasicShapes/BasicShapeMaterial')
        if not EAL.does_asset_exist(CONTENT_ROOT + '/M_RSBlack'):
            mi = ASSETS.create_asset('M_RSBlack', CONTENT_ROOT, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
            mi.set_editor_property('parent', parent)
            unreal.MaterialEditingLibrary.set_material_instance_vector_parameter_value(mi, 'Color', unreal.LinearColor(0.012, 0.012, 0.016, 1))
            EAL.save_asset(CONTENT_ROOT + '/M_RSBlack')
        mat = EAL.load_asset(CONTENT_ROOT + '/M_RSBlack')
    except Exception as e:  # noqa: BLE001
        WARN(f'[rs] black material skipped: {e}')

    def slab(label, loc, scale):
        a = spawn(unreal.StaticMeshActor, vec(*loc), label=label, folder='Hall')
        smc = a.static_mesh_component
        smc.set_static_mesh(cube)
        a.set_actor_scale3d(vec(*scale))
        if mat: smc.set_material(0, mat)
        smc.set_mobility(unreal.ComponentMobility.STATIC)
        return a
    t = 20  # wall thickness (cm)
    cx = stage['photoPlaneX'] - D / 2
    slab('Floor',    (cx, 0, -t / 2),                 (D / 100, W / 100, t / 100))
    slab('Ceiling',  (cx, 0, H + t / 2),              (D / 100, W / 100, t / 100))
    slab('BackWall', (stage['photoPlaneX'] + t / 2, 0, H / 2), (t / 100, W / 100, H / 100))
    slab('WallL',    (cx, -W / 2 - t / 2, H / 2),     (D / 100, t / 100, H / 100))
    slab('WallR',    (cx,  W / 2 + t / 2, H / 2),     (D / 100, t / 100, H / 100))
    # truss: a bar across the stage at fixture height
    cyl = basic_mesh('Cylinder')
    tr = spawn(unreal.StaticMeshActor, vec(stage['beamX'], 0, stage['trussZ']), rot(90, 0, 0), label='Truss', folder='Hall')
    tr.static_mesh_component.set_static_mesh(cyl)
    tr.set_actor_scale3d(vec(0.12, 0.12, (W - 100) / 100))
    LOG('[rs] hall built')

def build_fog(rig0):
    f = spawn(unreal.ExponentialHeightFog, vec(0, 0, 0), label='Fog', folder='Hall')
    c = f.component
    fog = rig0['fog']
    _set(c, fog_density=fog['density'], fog_height_falloff=0.02, start_distance=0.0,
         volumetric_fog=True, volumetric_fog_scattering_distribution=fog['scatteringDistribution'],
         volumetric_fog_albedo=col(fog['albedo']), volumetric_fog_extinction_scale=fog['extinctionScale'],
         volumetric_fog_distance=6000.0)
    try: c.set_editor_property('fog_inscattering_luminance', unreal.LinearColor(0.002, 0.002, 0.004, 1))
    except Exception: pass  # noqa: BLE001
    c.set_mobility(unreal.ComponentMobility.MOVABLE)
    LOG('[rs] fog built')
    return f

def build_post():
    p = spawn(unreal.PostProcessVolume, vec(0, 0, 0), label='Post', folder='Hall')
    _set(p, unbound=True)
    s = p.settings
    for k, v in dict(override_bloom_intensity=True, bloom_intensity=1.8,
                     override_bloom_threshold=True, bloom_threshold=0.6,
                     override_auto_exposure_method=True, auto_exposure_method=unreal.AutoExposureMethod.AEM_MANUAL,
                     override_auto_exposure_bias=True, auto_exposure_bias=9.5,
                     override_vignette_intensity=True, vignette_intensity=0.55,
                     override_film_grain_intensity=True, film_grain_intensity=0.12).items():
        try: s.set_editor_property(k, v)
        except Exception as e: WARN(f'[rs] post.{k}: {e}')  # noqa: BLE001
    _set(p, settings=s)
    LOG('[rs] post-process built')

def build_camera(stage):
    look_at = vec(stage['photoPlaneX'], 0, (stage['photoZ'][0] + stage['photoZ'][1]) / 2)
    pos = vec(stage['cameraX'], 0, stage['cameraZ'])
    r = unreal.MathLibrary.find_look_at_rotation(pos, look_at)
    cam = spawn(unreal.CineCameraActor, pos, r, label='Camera', folder='Hall')
    cc = cam.cine_camera_component
    _set(cc, current_focal_length=22.0, current_aperture=2.0)
    try:
        fs = cc.get_editor_property('focus_settings'); fs.set_editor_property('manual_focus_distance', 1900.0)
        cc.set_editor_property('focus_settings', fs)
    except Exception: pass  # noqa: BLE001
    LOG('[rs] camera built')
    return cam

# ── phase 2: photo plane (optional) ─────────────────────────────────────────
def ensure_photo_material():
    path = CONTENT_ROOT + '/M_RSPhoto'
    if EAL.does_asset_exist(path):
        return EAL.load_asset(path)
    mel = unreal.MaterialEditingLibrary
    m = ASSETS.create_asset('M_RSPhoto', CONTENT_ROOT, unreal.Material, unreal.MaterialFactoryNew())
    tex = mel.create_material_expression(m, unreal.MaterialExpressionTextureSampleParameter2D, -500, 0)
    tex.set_editor_property('parameter_name', 'Photo')
    glow = mel.create_material_expression(m, unreal.MaterialExpressionScalarParameter, -500, 260)
    glow.set_editor_property('parameter_name', 'Glow'); glow.set_editor_property('default_value', 0.25)
    mul = mel.create_material_expression(m, unreal.MaterialExpressionMultiply, -220, 120)
    mel.connect_material_expressions(tex, 'RGB', mul, 'A')
    mel.connect_material_expressions(glow, '', mul, 'B')
    mel.connect_material_property(tex, 'RGB', unreal.MaterialProperty.MP_BASE_COLOR)   # lit by the beams → Reveal
    mel.connect_material_property(mul, '', unreal.MaterialProperty.MP_EMISSIVE_COLOR)  # faint self-glow → Bloom
    rough = mel.create_material_expression(m, unreal.MaterialExpressionConstant, -220, 320)
    rough.set_editor_property('r', 0.9)
    mel.connect_material_property(rough, '', unreal.MaterialProperty.MP_ROUGHNESS)
    mel.recompile_material(m)
    EAL.save_asset(path)
    return m

def import_photo(rig):
    src = os.path.join(os.path.dirname(HERE), rig['file'])
    if not os.path.exists(src):
        src = os.path.join(PHOTOS_DIR, os.path.basename(rig['file']))
    if not os.path.exists(src):
        WARN(f'[rs] photo not found for {rig["name"]}: {src}'); return None
    dest = CONTENT_ROOT + '/Photos'
    asset_path = f'{dest}/{rig["name"]}'
    if EAL.does_asset_exist(asset_path):
        return EAL.load_asset(asset_path)
    task = unreal.AssetImportTask()
    task.set_editor_property('filename', src)
    task.set_editor_property('destination_path', dest)
    task.set_editor_property('destination_name', rig['name'])
    task.set_editor_property('automated', True)
    task.set_editor_property('save', True)
    task.set_editor_property('replace_existing', True)
    ASSETS.import_asset_tasks([task])
    paths = list(task.get_editor_property('imported_object_paths') or [])
    return EAL.load_asset(paths[0]) if paths else None

def build_photo_plane(rig, stage, base_mat):
    tex = import_photo(rig)
    if tex is None: return None
    mi_path = f'{CONTENT_ROOT}/Photos/MI_{rig["name"]}'
    if not EAL.does_asset_exist(mi_path):
        mi = ASSETS.create_asset(f'MI_{rig["name"]}', CONTENT_ROOT + '/Photos', unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
        mi.set_editor_property('parent', base_mat)
        unreal.MaterialEditingLibrary.set_material_instance_texture_parameter_value(mi, 'Photo', tex)
        unreal.MaterialEditingLibrary.set_material_instance_scalar_parameter_value(mi, 'Glow', 0.25)
        EAL.save_asset(mi_path)
    mi = EAL.load_asset(mi_path)
    # cover-fit the photo onto the wall opening (same rule as the web app)
    y0, y1 = stage['photoY']; z0, z1 = stage['photoZ']
    wall_w, wall_h = abs(y1 - y0), abs(z0 - z1)
    ar = rig['width'] / float(rig['height'])
    pw, ph = wall_w, wall_w / ar
    if ph < wall_h: ph = wall_h; pw = wall_h * ar
    plane = spawn(unreal.StaticMeshActor, vec(stage['photoPlaneX'] - 3, 0, (z0 + z1) / 2), rot(90, 0, 0),
                  label=f'Photo_{rig["name"]}', folder=f'Rigs/{rig["name"]}', tags=['rs_photo', f'rig:{rig["name"]}'])
    smc = plane.static_mesh_component
    smc.set_static_mesh(basic_mesh('Plane'))
    smc.set_material(0, mi)
    smc.set_mobility(unreal.ComponentMobility.MOVABLE)
    plane.set_actor_scale3d(vec(ph / 100.0, pw / 100.0, 1))   # local X → world Z after the 90° pitch
    return plane

# ── phase 3: rigs ────────────────────────────────────────────────────────────
def build_rig(rig, stage, photo_mat):
    folder = f'Rigs/{rig["name"]}'
    out = {'rig': rig, 'beams': [], 'washes': [], 'plume': [], 'photo': None}
    for b in rig['beams']:
        a = spawn(unreal.SpotLight, vec(*b['location']), aim(b['direction']),
                  label=f'{rig["name"]}_Beam{b["id"]}', folder=folder, tags=['rs_beam', f'rig:{rig["name"]}', f'ignite:{b["ignite"]}', f'base:{b["intensityCd"]}'])
        c = light_comp(a); c.set_mobility(unreal.ComponentMobility.MOVABLE)
        _set(c, intensity_units=unreal.LightUnits.CANDELAS, intensity=float(b['intensityCd']), light_color=col(b['color']),
             attenuation_radius=float(b['attenuationRadius']), outer_cone_angle=float(b['outerConeDeg']), inner_cone_angle=float(b['innerConeDeg']),
             volumetric_scattering_intensity=float(b['volumetricScattering']), source_radius=6.0, cast_shadows=False, use_temperature=False)
        out['beams'].append((a, c, b))
    for w in rig['washes']:
        a = spawn(unreal.RectLight, vec(*w['location']), rot(0, 0, 0),   # rect lights emit along +X → toward the back wall
                  label=f'{rig["name"]}_Wash{w["id"]}', folder=folder, tags=['rs_wash', f'rig:{rig["name"]}', f'base:{w["intensity"]}'])
        c = light_comp(a); c.set_mobility(unreal.ComponentMobility.MOVABLE)
        _set(c, intensity_units=unreal.LightUnits.CANDELAS, intensity=float(w['intensity']), light_color=col(w['color']),
             attenuation_radius=float(w['attenuationRadius']), source_width=float(w['size'][0]), source_height=float(w['size'][1]),
             barn_door_angle=70.0, barn_door_length=20.0, volumetric_scattering_intensity=0.35, cast_shadows=False, use_temperature=False)
        out['washes'].append((a, c, w))
    p = rig['plume']; px, py, pz = p['location']
    for i, z in enumerate((pz + 60, pz + 200, pz + 360)):
        a = spawn(unreal.PointLight, vec(px, py, z), label=f'{rig["name"]}_Plume{i}', folder=folder, tags=['rs_plume', f'rig:{rig["name"]}', f'plume:{i}', f'base:{900.0 * (1.0 - 0.25 * i):.0f}'])
        c = light_comp(a); c.set_mobility(unreal.ComponentMobility.MOVABLE)
        _set(c, intensity_units=unreal.LightUnits.CANDELAS, intensity=900.0 * (1.0 - 0.25 * i), light_color=col(p['color']),
             attenuation_radius=700.0, source_radius=60.0, soft_source_radius=120.0, volumetric_scattering_intensity=1.6, cast_shadows=False, use_temperature=False)
        out['plume'].append((a, c, i))
    if BUILD_PHOTO_PLANE and photo_mat is not None:
        try: out['photo'] = build_photo_plane(rig, stage, photo_mat)
        except Exception as e: WARN(f'[rs] photo plane for {rig["name"]} skipped: {e}')  # noqa: BLE001
    return out

# ── phase 4: the performance (Level Sequence) ────────────────────────────────
def movement_curve(p):
    """tension over one movement, p∈[0,1] — same shape as the web conductor without music"""
    return ss(.12, .55, p) * (1 - ss(.8, 1, p))

def build_sequence(rigs_built, cam):
    if EAL.does_asset_exist(SEQ_PATH): EAL.delete_asset(SEQ_PATH)
    seq = ASSETS.create_asset('RS_Performance', CONTENT_ROOT, unreal.LevelSequence, unreal.LevelSequenceFactoryNew())
    seq.set_display_rate(unreal.FrameRate(FPS, 1))
    n = len(rigs_built); total = n * MOVEMENT_SECONDS
    seq.set_playback_start_seconds(0.0); seq.set_playback_end_seconds(total)
    fr = lambda t: unreal.FrameNumber(int(round(t * FPS)))  # noqa: E731

    def float_track(component, prop, keys):
        """possess a component and key one float property; keys = [(t, value)]"""
        b = seq.add_possessable(component)
        tr = b.add_track(unreal.MovieSceneFloatTrack)
        tr.set_property_name_and_path(prop, prop)
        sec = tr.add_section()
        sec.set_start_frame_seconds(0.0); sec.set_end_frame_seconds(total)
        ch = sec.get_all_channels()[0]
        for t, v in keys: ch.add_key(fr(t), float(v))
        return b

    half = TRANS_SECONDS / 2.0
    samples = [0.0, 0.06, 0.12, 0.2, 0.3, 0.42, 0.55, 0.68, 0.8, 0.9, 0.97, 1.0]
    tracks = 0
    for i, built in enumerate(rigs_built):
        t0 = i * MOVEMENT_SECONDS; t1 = t0 + MOVEMENT_SECONDS
        # washes: fade in over the transition, breathe with the build, fade out over the next transition
        for a, c, w in built['washes']:
            base = float(w['intensity']); keys = [(max(0.0, t0 - half), 0.0)]
            for s in samples:
                T = movement_curve(s); keys.append((t0 + s * MOVEMENT_SECONDS, base * (0.85 + 0.45 * T)))
            keys.append((min(total, t1 + half), 0.0))
            float_track(c, 'Intensity', keys); tracks += 1
        # beams: dark until their ignite threshold, then up with the build, flash on release, out
        for a, c, b in built['beams']:
            base = float(b['intensityCd']); keys = [(max(0.0, t0 - half), 0.0)]
            for s in samples:
                T = movement_curve(s); gate = ss(b['ignite'], b['ignite'] + 0.18, T)
                keys.append((t0 + s * MOVEMENT_SECONDS, base * gate * (0.55 + 0.45 * T)))
            keys.append((t1 - 0.25, base * 1.6)); keys.append((t1 + 0.1, 0.0))   # release flash
            float_track(c, 'Intensity', keys); tracks += 1
        # plume column: surges around the peak, top of the column lags the bottom
        for a, c, k in built['plume']:
            base = 900.0 * (1.0 - 0.25 * k); lag = 0.05 * k
            keys = [(max(0.0, t0 - half), 0.0)]
            for s in samples:
                T = movement_curve(max(0.0, s - lag)); keys.append((t0 + s * MOVEMENT_SECONDS, base * (0.15 + 0.85 * T * T)))
            keys.append((min(total, t1 + half), 0.0))
            float_track(c, 'Intensity', keys); tracks += 1
        # photo plane: emissive glow follows presence — up during the movement, down across the transition
        if built.get('photo') is not None:
            try:
                b = seq.add_possessable(built['photo'].static_mesh_component)
                tr = b.add_track(unreal.MovieSceneComponentMaterialTrack); tr.set_material_index(0)
                sec = tr.add_section(); sec.set_start_frame_seconds(0.0); sec.set_end_frame_seconds(total)
                for t, v in [(max(0.0, t0 - half), 0.0), (t0 + half, 0.28), (t1 - half, 0.28), (min(total, t1 + half), 0.0)]:
                    sec.add_scalar_parameter_key('Glow', fr(t), float(v))
                tracks += 1
            except Exception as e: WARN(f'[rs] photo glow track for {built["rig"]["name"]}: {e}')  # noqa: BLE001
    # camera cut + a slow push-in across the whole performance
    try:
        cb = seq.add_possessable(cam)
        cut = seq.add_track(unreal.MovieSceneCameraCutTrack); cs = cut.add_section()
        cs.set_start_frame_seconds(0.0); cs.set_end_frame_seconds(total)
        cs.set_camera_binding_id(seq.get_binding_id(cb))
        tt = cb.add_track(unreal.MovieScene3DTransformTrack); ts = tt.add_section()
        ts.set_start_frame_seconds(0.0); ts.set_end_frame_seconds(total)
        chans = ts.get_all_channels()
        loc = cam.get_actor_location(); r = cam.get_actor_rotation()
        vals = [loc.x, loc.y, loc.z, r.roll, r.pitch, r.yaw, 1, 1, 1]
        for ch, v in zip(chans, vals):
            ch.add_key(fr(0.0), float(v)); ch.add_key(fr(total), float(v))
        chans[0].add_key(fr(total), float(loc.x + 260.0))   # ~2.6 m closer by the end
    except Exception as e: WARN(f'[rs] camera tracks: {e}')  # noqa: BLE001
    EAL.save_asset(SEQ_PATH)
    LOG(f'[rs] sequence RS_Performance: {n} movements, {total:.0f}s, {tracks} tracks')
    # auto-play, looping
    lsa = spawn(unreal.LevelSequenceActor, vec(0, 0, 0), label='Performance', folder='Hall')
    try: lsa.set_sequence(seq)
    except Exception: _set(lsa, level_sequence_asset=seq)  # noqa: BLE001
    try:
        ps = lsa.get_editor_property('playback_settings')
        ps.set_editor_property('auto_play', True)
        lc = ps.get_editor_property('loop_count'); lc.set_editor_property('value', -1); ps.set_editor_property('loop_count', lc)
        lsa.set_editor_property('playback_settings', ps)
    except Exception as e: WARN(f'[rs] playback settings: {e}')  # noqa: BLE001
    return seq

# ── main ─────────────────────────────────────────────────────────────────────
def main():
    t_start = time.time()
    idx_path = os.path.join(RIGS_DIR, 'index.json')
    if not os.path.exists(idx_path):
        raise SystemExit(f'[rs] no rigs at {RIGS_DIR} — run `npm run export:rigs` in the repo first')
    with open(idx_path, encoding='utf-8') as f: index = json.load(f)
    stage = index['stage']
    names = [r['name'] for r in index['rigs']][:MAX_RIGS] if MAX_RIGS else [r['name'] for r in index['rigs']]
    rigs = []
    for nme in names:
        with open(os.path.join(RIGS_DIR, nme + '.json'), encoding='utf-8') as f: rigs.append(json.load(f))
    LOG(f'[rs] {len(rigs)} rigs from {RIGS_DIR}')

    if CREATE_NEW_LEVEL:
        if not EAL.does_directory_exist(CONTENT_ROOT + '/Maps'): EAL.make_directory(CONTENT_ROOT + '/Maps')
        if not LEVELS.new_level(LEVEL_PATH):
            raise SystemExit(f'[rs] could not create level {LEVEL_PATH}')
    remove_previous()

    build_hall(stage)
    build_fog(rigs[0])
    build_post()
    cam = build_camera(stage)
    photo_mat = None
    if BUILD_PHOTO_PLANE:
        try: photo_mat = ensure_photo_material()
        except Exception as e: WARN(f'[rs] photo material skipped (rigs still build): {e}')  # noqa: BLE001

    built = []
    with unreal.ScopedSlowTask(len(rigs), 'Resonant Spectra: building rigs') as task:
        task.make_dialog(True)
        for r in rigs:
            if task.should_cancel(): break
            task.enter_progress_frame(1, r['name'])
            built.append(build_rig(r, stage, photo_mat))
    LOG(f'[rs] {len(built)} rigs built: {sum(len(b["beams"]) for b in built)} beams, {sum(len(b["washes"]) for b in built)} washes')

    if BUILD_SEQUENCE and built:
        try: build_sequence(built, cam)
        except Exception as e: WARN(f'[rs] sequence failed (rigs remain): {e}')  # noqa: BLE001

    # live-music driver (only if Plugins/ResonantSpectra is compiled into the project)
    try:
        drv_cls = unreal.load_class(None, '/Script/ResonantSpectra.ResonantRigDriver')
        if drv_cls:
            spawn(drv_cls, vec(0, 0, 0), label='LiveDriver', folder='Hall')
            LOG('[rs] ResonantRigDriver placed — Play In Editor drives the rigs from live audio')
        else:
            LOG('[rs] ResonantSpectra plugin not present — the Level Sequence performs on a timer')
    except Exception as e: LOG(f'[rs] live driver not placed ({e}) — sequence mode')  # noqa: BLE001

    LEVELS.save_current_level()
    EAL.save_directory(CONTENT_ROOT, only_if_is_dirty=True, recursive=True)
    LOG(f'[rs] done in {time.time() - t_start:.0f}s → level {LEVEL_PATH}, sequence {SEQ_PATH}. Press Play.')

if __name__ == '__main__' or True:   # Unreal runs the file as a script, not as __main__
    main()
