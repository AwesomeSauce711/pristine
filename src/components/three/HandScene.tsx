'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { subscribeMotion, tiltFor, type Motion } from '@/lib/stage-motion';
import {
  BREATHE_DEG,
  BREATHE_PERIOD_S,
  buildHandRig,
  describeHand,
  placeHand,
  poseHand,
  type HandRig,
} from './hand-pose';

/*
 * The hand that holds the phone.
 *
 * A real hand — the Draco-compressed model in public/models, posed into a
 * grip by hand-pose.ts — rendered by three.js around the DOM phone, and lit
 * the way the painted-hand reference is: a dark, slightly metallic form with
 * a thin-film iridescence, catching cyan from the screen and violet from the
 * room. It is the round-two replacement for the SVG silhouette CompareStage
 * drew in round one.
 *
 * TWO CANVASES, ONE SCENE, ONE EYE
 * The phone is DOM (two playing videos, a slider, a bezel); the hand is WebGL.
 * For fingers to curl round the bezel some of the hand has to be drawn behind
 * the phone and some in front, so the same scene is rendered twice from the
 * same camera. (It was two: `.hand-back` clipped to z ≤ 0 under the phone and
 * `.hand-front` clipped to z ≥ 0 over it, so the fingertips and thumb crossed
 * in front of the bezel. At the tilt's extremes the two halves and the DOM
 * phone disagreed by a pixel or two and the hand showed through the frame, so
 * now there is one un-clipped canvas, `.hand-back`, laid entirely UNDER the
 * phone: whatever the pose puts in front of the screen is simply covered by
 * the bezel, and nothing can ever poke through it.) World units
 * are CSS px, the phone's centre is the origin and its screen is z = 0, the
 * camera sits at z = 1400 with a field of view that maps the canvas height 1:1
 * at z = 0 — the same eye as the DOM's `perspective: 1400px` — and the hand is
 * tilted about the origin by the same `tiltFor` angles the phone uses. The
 * seam where a finger crosses the screen plane is therefore where the bezel
 * is, and nothing in the phone's own 3D context needs to know the hand exists.
 *
 * THE CANVASES ARE NOT REACT'S
 * A canvas keeps one WebGL context for life. Releasing a context on unmount
 * (`forceContextLoss`, as the perf rules ask) would hand React's development
 * double-mount a dead context on its second run. So the two canvases are
 * created inside the effect, given fresh contexts, and removed with it; React
 * renders only the empty, unpositioned root.
 *
 * NO STACKING CONTEXT OF ITS OWN
 * For the DOM phone to sit between the two canvases, their z-indices must
 * resolve in the consumer's stacking context. The root therefore has no
 * opacity, transform, filter or z-index (the fade-in is on each canvas), and
 * the consumer must not wrap this component in an element that creates one.
 * Mount it inside the positioned element whose centre is the phone's centre
 * — the canvases are centred on that box — and put the phone at a z-index
 * between `backZ` (0) and `frontZ` (2), the holograms above `frontZ`.
 *
 * WHEN IT DRAWS
 * Only when something changed: a motion reading moved the tilt target (the
 * ease then runs at the display rate until it settles within 0.002), the
 * screen glow changed, the box changed, the model arrived — and while the
 * idle breathing runs, at 30 fps. Nothing at all off screen (200 px margin),
 * with the tab hidden, before the model is ready, or with a lost context.
 * Reduced motion stops the breathing; the tilt still follows.
 *
 * WHEN IT GIVES UP
 * No WebGL, a software renderer, a model that will not load: nothing is
 * drawn, nothing throws, and the two contexts are released at once. The
 * canvases are `pointer-events: none` and `aria-hidden` throughout.
 */

interface Props {
  /** The phone's box — the bezel — in CSS px. */
  width: number;
  height: number;
  className?: string;
  /** 0–1: how much of the screen is showing Pristine. Drives the cyan light. */
  glow?: number;
  /** z-index of the canvas under the phone and of the one over it; the DOM
   *  phone (and anything that must sit between) goes at a value in between. */
  backZ?: number;
  frontZ?: number;
}

const MODEL_URL = '/models/hand-right.glb';
const DRACO_PATH = '/draco/';

/* The canvases cover this much of the phone's box, centred on it: the hand
 * reaches past the bezel on every side but the top. */
const CANVAS_W = 2.8;
const CANVAS_H = 2.0;
/* Matches the DOM's `perspective: 1400px`. */
const CAMERA_Z = 1400;
const MAX_DPR = 2;
/* A phone's GPU is asked for less: the cap drops on a narrow screen. */
const MAX_DPR_NARROW = 1.25;
const phoneDpr = () => (window.innerWidth < 700 ? MAX_DPR_NARROW : MAX_DPR);
/* Tilt easing per frame, the DOM phone's number. */
const EASE = 0.1;
/* Motion units; below this the tilt is treated as settled. */
const MOTION_EPSILON = 0.002;
const BREATH_FPS = 30;
const FADE_MS = 900;
const IN_VIEW_MARGIN = '200px 0px';

/* The material: near-black with a blue cast, half metal, glossy, with a
 * thin-film sheen that turns the room's white light into the site's palette
 * at grazing angles, and a light clearcoat for the painted look. */
const HAND_COLOUR = 0x0d1020;
const HAND_METALNESS = 0.55;
const HAND_ROUGHNESS = 0.32;
const HAND_IRIDESCENCE_IOR = 1.6;
const HAND_FILM_NM: [number, number] = [120, 480];
const HAND_CLEARCOAT = 0.4;
const HAND_CLEARCOAT_ROUGHNESS = 0.3;
/* RoomEnvironment is white; kept low so the hand stays a dark form lit by
 * colour, not grey plastic. */
const ENV_INTENSITY = 0.6;
const ENV_ROTATION_Y = 0.9;

/* The screen's light: a cyan point a little in front of the screen's centre,
 * moving with the phone. Intensity is candela with inverse-square falloff and
 * world units are px, so it scales with width² to be the same brightness on
 * every phone size; `glow` (how much Pristine shows) sweeps it from MIN to MAX. */
const SCREEN_LIGHT_COLOUR = 0x4ef0ff;
const SCREEN_LIGHT_Z = 0.12;
const SCREEN_LIGHT_MIN = 0.5;
const SCREEN_LIGHT_MAX = 2.2;
/* A violet rim from the upper left and behind, so the edges the reader sees
 * are the lit ones; a faint pink fill from the lower right in front. */
const RIM_COLOUR = 0xb06bff;
const RIM_INTENSITY = 2.4;
const RIM_DIRECTION: [number, number, number] = [-0.8, 0.9, -0.5];
const FILL_COLOUR = 0xff6ad5;
const FILL_INTENSITY = 0.45;
const FILL_DIRECTION: [number, number, number] = [0.7, -0.5, 0.7];

const DEG = Math.PI / 180;

const clampGlow = (g: number) => (Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : 1);

function warn(message: string, detail?: unknown) {
  if (process.env.NODE_ENV !== 'production') console.warn(`HandScene: ${message}`, detail ?? '');
}

/* The model is fetched and decoded once per page and cloned per mount, so a
 * second stage (or React's double-mount) costs no download and no decoder. */
let handAsset: Promise<GLTF> | null = null;
function loadHandAsset(): Promise<GLTF> {
  if (handAsset) return handAsset;
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_PATH);
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  /* The decoder's workers are only needed until the file is parsed. */
  const pending = loader.loadAsync(MODEL_URL).finally(() => draco.dispose());
  pending.catch(() => {
    /* A failed load is not cached, so the next mount can try again. */
    if (handAsset === pending) handAsset = null;
  });
  handAsset = pending;
  return pending;
}

function makeRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    /* A software renderer skinning an iridescent mesh twice a frame would be
     * slower than no hand at all. */
    failIfMajorPerformanceCaveat: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  return renderer;
}

function release(renderer: THREE.WebGLRenderer) {
  renderer.dispose();
  renderer.forceContextLoss();
}

/* The room, baked to a prefiltered environment for one renderer. A render
 * target belongs to the context that made it, so each canvas needs its own. */
function makeEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const target = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  return target;
}

interface Controls {
  resize: () => void;
  wake: () => void;
  layer: () => void;
}

export default function HandScene({ width, height, className, glow = 1, backZ = 0, frontZ = 2 }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ width, height });
  const glowRef = useRef(clampGlow(glow));
  const layerRef = useRef({ backZ, frontZ });
  const controlsRef = useRef<Controls | null>(null);

  /* Prop changes reach the scene through refs, so nothing here ever rebuilds
   * a context: the box re-places the hand, the glow re-lights it. */
  useEffect(() => {
    sizeRef.current = { width, height };
    controlsRef.current?.resize();
  }, [width, height]);
  useEffect(() => {
    glowRef.current = clampGlow(glow);
    controlsRef.current?.wake();
  }, [glow]);
  useEffect(() => {
    layerRef.current = { backZ, frontZ };
    controlsRef.current?.layer();
  }, [backZ, frontZ]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    /* ----------------------------------------------------- canvases -- */
    const back = document.createElement('canvas');
    for (const [canvas, name] of [[back, 'hand-back']] as const) {
      canvas.className = name;
      canvas.setAttribute('aria-hidden', 'true');
      const s = canvas.style;
      s.position = 'absolute';
      s.left = '50%';
      s.top = '50%';
      s.display = 'block';
      s.pointerEvents = 'none';
      s.opacity = '0';
      s.transition = `opacity ${FADE_MS}ms ease`;
      root.appendChild(canvas);
    }
    const applyLayer = () => {
      back.style.zIndex = String(layerRef.current.backZ);
    };
    applyLayer();

    let rBack: THREE.WebGLRenderer;
    try {
      rBack = makeRenderer(back);
    } catch (err) {
      warn('no usable WebGL; the hand is not drawn', err);
      back.remove();
      return;
    }
    /* No clipping plane: the whole hand is drawn, and the DOM phone above the
     * canvas covers whatever the pose puts in front of the screen. */

    /* -------------------------------------------------------- scene -- */
    const scene = new THREE.Scene();
    scene.environmentRotation.set(0, ENV_ROTATION_Y, 0);
    const camera = new THREE.PerspectiveCamera(30, 1, CAMERA_Z * 0.25, CAMERA_Z * 2.2);
    camera.position.set(0, 0, CAMERA_Z);
    camera.lookAt(0, 0, 0);

    /* Everything that turns with the phone: the hand and the screen's light. */
    const tiltGroup = new THREE.Group();
    scene.add(tiltGroup);

    const screenLight = new THREE.PointLight(SCREEN_LIGHT_COLOUR, 0, 0, 2);
    tiltGroup.add(screenLight);
    const rim = new THREE.DirectionalLight(RIM_COLOUR, RIM_INTENSITY);
    rim.position.set(...RIM_DIRECTION).multiplyScalar(CAMERA_Z);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(FILL_COLOUR, FILL_INTENSITY);
    fill.position.set(...FILL_DIRECTION).multiplyScalar(CAMERA_Z);
    scene.add(fill);

    const material = new THREE.MeshPhysicalMaterial({
      color: HAND_COLOUR,
      metalness: HAND_METALNESS,
      roughness: HAND_ROUGHNESS,
      iridescence: 1,
      iridescenceIOR: HAND_IRIDESCENCE_IOR,
      iridescenceThicknessRange: HAND_FILM_NM,
      clearcoat: HAND_CLEARCOAT,
      clearcoatRoughness: HAND_CLEARCOAT_ROUGHNESS,
      envMapIntensity: ENV_INTENSITY,
    });

    let envBack: THREE.WebGLRenderTarget | null = null;
    try {
      envBack = makeEnvironment(rBack);
    } catch (err) {
      /* Without the room the sheen is gone but the lights still work. */
      warn('environment could not be generated', err);
    }

    /* -------------------------------------------------------- state -- */
    let rig: HandRig | null = null;
    let disposed = false;
    let ready = false;
    let revealed = false;
    let inView = false;
    let hidden = document.hidden;
    let lostBack = false;
    let needsRender = true;
    let raf = 0;
    let lastBreathAt = 0;
    let breath = 0;
    let dpr = 0;
    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };
    let source: Motion['source'] = 'none';

    const motionMq =
      typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    let reduced = motionMq?.matches ?? false;

    const active = () => ready && inView && !hidden && !lostBack && !disposed;

    /* ------------------------------------------------------- sizing -- */
    const applySize = () => {
      const { width: W, height: H } = sizeRef.current;
      const cw = Math.max(1, Math.round(CANVAS_W * W));
      const ch = Math.max(1, Math.round(CANVAS_H * H));
      for (const canvas of [back]) {
        canvas.style.width = `${cw}px`;
        canvas.style.height = `${ch}px`;
        canvas.style.marginLeft = `${-cw / 2}px`;
        canvas.style.marginTop = `${-ch / 2}px`;
      }
      /* The canvas height is exactly the visible height at z = 0, so CSS px
       * and world units agree on the screen plane. */
      camera.fov = (2 * Math.atan(ch / 2 / CAMERA_Z)) / DEG;
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
      dpr = Math.min(window.devicePixelRatio || 1, phoneDpr());
      for (const r of [rBack]) {
        r.setPixelRatio(dpr);
        r.setSize(cw, ch, false);
      }
      screenLight.position.set(0, 0, SCREEN_LIGHT_Z * W);
      if (rig) {
        placeHand(rig, W, H);
        if (process.env.NODE_ENV !== 'production') {
          console.info('[HandScene] hand placed (phone px, centre origin, screen z=0)', describeHand(rig, W, H));
        }
      }
      needsRender = true;
    };

    /* ------------------------------------------------------ drawing -- */
    const applyTilt = () => {
      const { rx, ry } = tiltFor({ x: current.x, y: current.y, source });
      /* CSS rotateX leans the top away for a positive angle; three's y-up
       * frame leans it toward the reader, so x flips and y does not. */
      tiltGroup.rotation.set(-rx * DEG, ry * DEG, 0, 'XYZ');
    };
    const applyGlow = () => {
      const W = sizeRef.current.width;
      const g = glowRef.current;
      screenLight.intensity = W * W * (SCREEN_LIGHT_MIN + (SCREEN_LIGHT_MAX - SCREEN_LIGHT_MIN) * g);
    };
    const render = () => {
      applyTilt();
      applyGlow();
      scene.environment = envBack ? envBack.texture : null;
      rBack.render(scene, camera);
      if (!revealed) {
        /* Only after a real frame is in the buffer. */
        revealed = true;
        back.style.opacity = '1';
      }
    };

    const frame = (now: number) => {
      raf = 0;
      if (!active()) return;

      const dx = target.x - current.x;
      const dy = target.y - current.y;
      const settling = Math.abs(dx) > MOTION_EPSILON || Math.abs(dy) > MOTION_EPSILON;
      if (settling) {
        current.x += dx * EASE;
        current.y += dy * EASE;
        needsRender = true;
      } else if (dx !== 0 || dy !== 0) {
        current.x = target.x;
        current.y = target.y;
        needsRender = true;
      }

      const hand = rig;
      const breathing = !reduced && hand !== null;
      if (hand && breathing && now - lastBreathAt >= 1000 / BREATH_FPS) {
        lastBreathAt = now;
        breath = BREATHE_DEG * Math.sin(((now / 1000) * 2 * Math.PI) / BREATHE_PERIOD_S);
        poseHand(hand, breath);
        needsRender = true;
      }

      if (needsRender) {
        needsRender = false;
        render();
      }
      if (settling || breathing) raf = requestAnimationFrame(frame);
    };

    const kick = () => {
      if (!raf && active()) raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    /* ------------------------------------------------------- inputs -- */
    const unsubscribe = subscribeMotion((m) => {
      target.x = m.x;
      target.y = m.y;
      source = m.source;
      kick();
    });

    const onVisibility = () => {
      hidden = document.hidden;
      if (hidden) stop();
      else {
        needsRender = true;
        kick();
      }
    };
    const onReduce = () => {
      reduced = motionMq?.matches ?? false;
      if (reduced && rig) {
        breath = 0;
        poseHand(rig, 0);
      }
      needsRender = true;
      kick();
    };
    const onResize = () => {
      /* Layout changes arrive as props; this catches a DPR change alone. */
      if (Math.min(window.devicePixelRatio || 1, phoneDpr()) !== dpr) {
        applySize();
        kick();
      }
    };

    /* A lost context stops the loop; a restored one gets its room back
     * (render targets do not survive) and a fresh frame. */
    const onLost = () => {
      lostBack = true;
      stop();
    };
    const onRestored = () => {
      if (disposed) return;
      try {
        envBack?.dispose();
        envBack = makeEnvironment(rBack);
        lostBack = false;
      } catch (err) {
        warn('environment could not be rebuilt after a context restore', err);
      }
      needsRender = true;
      kick();
    };
    const lostBackHandler = onLost;
    const restoredBackHandler = onRestored;
    back.addEventListener('webglcontextlost', lostBackHandler);
    back.addEventListener('webglcontextrestored', restoredBackHandler);

    document.addEventListener('visibilitychange', onVisibility);
    motionMq?.addEventListener?.('change', onReduce);
    window.addEventListener('resize', onResize);

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          inView = entries.some((entry) => entry.isIntersecting);
          if (inView) {
            needsRender = true;
            kick();
          } else stop();
        },
        { rootMargin: IN_VIEW_MARGIN },
      );
      io.observe(back);
    } else {
      inView = true;
    }

    controlsRef.current = {
      resize: () => {
        applySize();
        kick();
      },
      wake: () => {
        needsRender = true;
        kick();
      },
      layer: applyLayer,
    };

    applySize();

    /* -------------------------------------------------------- model -- */
    loadHandAsset().then(
      (gltf) => {
        if (disposed) return;
        try {
          const model = cloneSkinned(gltf.scene);
          const built = buildHandRig(model);
          if (!built) {
            warn('model is not the expected hand (joints or skin missing); nothing drawn');
            return;
          }
          rig = built;
          rig.mesh.material = material;
          /* The rest-pose bounding sphere does not cover the curled fingers at
           * the canvas edge; one mesh is not worth culling anyway. */
          rig.mesh.frustumCulled = false;
          tiltGroup.add(rig.root);
          poseHand(rig, 0);
          applySize();
          ready = true;
          kick();
        } catch (err) {
          warn('the hand could not be posed; nothing drawn', err);
        }
      },
      (err: unknown) => {
        if (!disposed) warn(`could not load ${MODEL_URL}; the hand is not drawn`, err);
      },
    );

    return () => {
      disposed = true;
      stop();
      controlsRef.current = null;
      unsubscribe();
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motionMq?.removeEventListener?.('change', onReduce);
      window.removeEventListener('resize', onResize);
      back.removeEventListener('webglcontextlost', lostBackHandler);
      back.removeEventListener('webglcontextrestored', restoredBackHandler);
      if (rig) {
        rig.root.removeFromParent();
        rig.mesh.skeleton.dispose();
        /* Frees this instance's GPU copies; the decoded arrays stay in the
         * module cache for the next mount. */
        rig.mesh.geometry.dispose();
      }
      material.dispose();
      envBack?.dispose();
      release(rBack);
      back.remove();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className={`hand-scene${className ? ` ${className}` : ''}`}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    />
  );
}
